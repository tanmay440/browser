// This Source Code Form is subject to the terms of the Mozilla Public
// License, Version 2.0. If a copy of the MPL was not distributed with this
// file, see http://mozilla.org/MPL/2.0/.

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";

const PROFILE_DIRECTORY = "vapor-blocklists";
const REMEMBERED_SITES_FILE = "remembered-sites.txt";
const CONSENT_PHRASES_FILE = "consent-phrases.json";
const DEFAULT_DELAY = 2_000;
const BROOM_FLAG_COOKIES = Ci.nsIClearDataService.CLEAR_COOKIES;
const BROOM_FLAG_STORAGE = Ci.nsIClearDataService.CLEAR_DOM_QUOTA;
const DEFAULT_CONSENT_PHRASES = Object.freeze({
  en: [
    "accept all",
    "accept cookies",
    "reject all",
    "decline all",
    "cookie preferences",
    "we use cookies",
    "consent",
    "strictly necessary",
  ],
  de: ["alle akzeptieren", "alle ablehnen", "nur notwendige", "datenschutz"],
  fr: ["tout accepter", "tout refuser", "préférences des cookies", "consentement"],
  es: ["aceptar todo", "rechazar todo", "solo necesarias", "consentimiento"],
  it: ["accetta tutto", "rifiuta tutto", "solo necessarie", "consenso"],
  nl: ["alles accepteren", "alles weigeren", "alleen noodzakelijke", "toestemming"],
  pt: ["aceitar tudo", "rejeitar tudo", "apenas necessárias", "consentimento"],
  pl: ["zaakceptuj wszystko", "odrzuć wszystko", "tylko niezbędne", "zgoda"],
});
const LOGIN_COOKIE_PATTERN = /(?:^|[_-])(auth|login|session|sess|sid|token|jwt|account)(?:$|[_-])/i;
const TRACKING_COOKIE_PATTERNS = [
  /^_ga(?:$|_)/i,
  /^_gid$/i,
  /^_gat(?:$|_)/i,
  /^_fbp$/i,
  /^_fbc$/i,
  /^_gcl(?:$|_)/i,
  /^_tt/i,
  /^_uetsid$/i,
  /^_uetvid$/i,
  /^fr$/i,
  /^IDE$/i,
  /^test_cookie$/i,
  /^NID$/i,
  /^CONSENT$/i,
  /^_pk_/i,
  /^__hstc$/i,
  /^__hssc$/i,
  /^__hssrc$/i,
  /^hubspotutk$/i,
  /^intercom-id/i,
  /^ajs_/i,
  /^amplitude_/i,
  /^mp_/i,
  /^_mkto_/i,
  /^pardot/i,
  /^drift_/i,
  /^optimizely/i,
];

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/^\.+|\.+$/g, "");
}

function isHTTPURI(uri) {
  return uri?.schemeIs?.("http") || uri?.schemeIs?.("https");
}

function siteForHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized || normalized === "localhost" || /^\d+(?:\.\d+){3}$/.test(normalized)) {
    return normalized;
  }
  try {
    return Services.eTLD.getBaseDomainFromHost(normalized);
  } catch {
    return normalized;
  }
}

function hostBelongsToSite(host, site) {
  const normalized = normalizeHost(host);
  return normalized === site || normalized.endsWith(`.${site}`);
}

function callbackPromise(action) {
  return new Promise(resolve => {
    action({
      onDataDeleted(failedFlags) {
        resolve(failedFlags || 0);
      },
    });
  });
}

class VaporBroomService {
  #initialized = false;
  #loadPromise = null;
  #windows = new Set();
  #tabStates = new Map();
  #domainTabs = new Map();
  #pendingDeletes = new Map();
  #rememberedSites = new Set();
  #consentPhrases = DEFAULT_CONSENT_PHRASES;
  #loginSeen = new Set();

  init(window) {
    if (!window?.gBrowser || this.#windows.has(window)) {
      return;
    }
    this.#windows.add(window);
    if (!this.#initialized) {
      this.#initialized = true;
      Services.obs.addObserver(this, "quit-application-requested");
      Services.prefs.addObserver("vapor.broom.enabled", this);
      this.#loadPromise = this.#reload();
    }
    this.#installWindow(window);
  }

  observe(_subject, topic) {
    if (topic === "quit-application-requested") {
      this.#cleanAllSites();
    } else if (topic === "nsPref:changed") {
      this.#updateAllIndicators();
    }
  }

  async #ensureLoaded() {
    if (!this.#initialized) {
      this.#initialized = true;
      this.#loadPromise = this.#reload();
    }
    await this.#loadPromise?.catch(() => {});
  }

  async #reload() {
    const directory = PathUtils.join(PathUtils.profileDir, PROFILE_DIRECTORY);
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const rememberedPath = PathUtils.join(directory, REMEMBERED_SITES_FILE);
    const phrasesPath = PathUtils.join(directory, CONSENT_PHRASES_FILE);
    if (!(await IOUtils.exists(rememberedPath))) {
      await IOUtils.writeUTF8(rememberedPath, "");
    }
    if (!(await IOUtils.exists(phrasesPath))) {
      const shipped = await this.#readChromeText(
        "chrome://vapor/content/consent-phrases.json",
      ).catch(() => `${JSON.stringify(DEFAULT_CONSENT_PHRASES, null, 2)}\n`);
      await IOUtils.writeUTF8(phrasesPath, shipped);
    }
    const [remembered, phrases] = await Promise.all([
      IOUtils.readUTF8(rememberedPath).catch(() => ""),
      IOUtils.readUTF8(phrasesPath).catch(() => "{}"),
    ]);
    this.#rememberedSites = new Set(
      remembered
        .split(/\r?\n/)
        .map(line => siteForHost(line.trim()))
        .filter(Boolean),
    );
    try {
      const parsed = JSON.parse(phrases);
      this.#consentPhrases = this.#normalizePhrases(parsed);
    } catch {
      this.#consentPhrases = DEFAULT_CONSENT_PHRASES;
    }
    this.#loadPromise = null;
  }

  #normalizePhrases(value) {
    const normalized = {};
    for (const language of ["en", "de", "fr", "es", "it", "nl", "pt", "pl"]) {
      const phrases = Array.isArray(value?.[language]) ? value[language] : DEFAULT_CONSENT_PHRASES[language];
      normalized[language] = phrases
        .filter(phrase => typeof phrase === "string")
        .map(phrase => phrase.trim().toLowerCase())
        .filter(Boolean);
    }
    return normalized;
  }

  async getActivityLog() {
    try {
      const { VaporPrivacy } = ChromeUtils.importESModule(
        "resource:///modules/zen/privacy/VaporPrivacy.sys.mjs",
      );
      return (await VaporPrivacy.getActivityLog()).filter(entry => entry.kind === "Broom");
    } catch {
      return [];
    }
  }

  async getRememberedSites() {
    await this.#ensureLoaded();
    return [...this.#rememberedSites].join("\n");
  }

  async setRememberedSites(text) {
    await this.#ensureLoaded();
    const sites = [...new Set(
      String(text || "")
        .split(/\r?\n/)
        .map(line => siteForHost(line.trim()))
        .filter(Boolean),
    )];
    const path = PathUtils.join(PathUtils.profileDir, PROFILE_DIRECTORY, REMEMBERED_SITES_FILE);
    await IOUtils.writeUTF8(path, sites.length ? `${sites.join("\n")}\n` : "");
    this.#rememberedSites = new Set(sites);
    this.#updateAllIndicators();
  }

  async toggleRemembered(host, force = undefined) {
    await this.#ensureLoaded();
    const site = siteForHost(host);
    if (!site) return false;
    const remember = force === undefined ? !this.#rememberedSites.has(site) : force;
    if (remember) this.#rememberedSites.add(site);
    else this.#rememberedSites.delete(site);
    await this.setRememberedSites([...this.#rememberedSites].join("\n"));
    await this.#record("Broom", remember ? "remembered-site" : "forgotten-site", { host: site });
    return remember;
  }

  isRemembered(host) {
    const normalized = normalizeHost(host);
    return [...this.#rememberedSites].some(site => hostBelongsToSite(normalized, site));
  }

  async getConsentPhrases() {
    await this.#ensureLoaded();
    return JSON.stringify(this.#consentPhrases, null, 2);
  }

  async setConsentPhrases(text) {
    await this.#ensureLoaded();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid consent-phrases.json: ${error}`);
    }
    this.#consentPhrases = this.#normalizePhrases(parsed);
    await IOUtils.writeUTF8(
      PathUtils.join(PathUtils.profileDir, PROFILE_DIRECTORY, CONSENT_PHRASES_FILE),
      `${JSON.stringify(this.#consentPhrases, null, 2)}\n`,
    );
  }

  async getReflexConfig() {
    await this.#ensureLoaded();
    const languages = Services.prefs
      .getStringPref("vapor.reflex.languages", "en,de,fr,es,it,nl,pt,pl")
      .split(",")
      .map(language => language.trim().toLowerCase())
      .filter(language => this.#consentPhrases[language]);
    return {
      enabled: Services.prefs.getBoolPref("vapor.reflex.enabled", true),
      mode: Services.prefs.getStringPref("vapor.reflex.mode", "aggressive"),
      preConsent: Services.prefs.getBoolPref("vapor.reflex.pre-consent", true),
      languages,
      phrases: this.#consentPhrases,
      useCMPAPI: Services.prefs.getBoolPref("vapor.reflex.cmp-api", true),
      failureNotifications: Services.prefs.getBoolPref("vapor.reflex.failure-notifications", true),
    };
  }

  async deleteTrackingCookies(host) {
    await this.#ensureLoaded();
    const site = siteForHost(host);
    let deleted = 0;
    for (const cookie of Services.cookies.cookies) {
      if (!hostBelongsToSite(cookie.rawHost || cookie.host, site)) continue;
      if (cookie.name.toLowerCase() === "__cf_bm") continue;
      if (!TRACKING_COOKIE_PATTERNS.some(pattern => pattern.test(cookie.name))) continue;
      try {
        Services.cookies.remove(cookie.host, cookie.name, cookie.path, cookie.originAttributes);
        deleted++;
      } catch {}
    }
    if (deleted) {
      await this.#record("Consent Actions", "pre-consent-cookies-deleted", { host: site, count: deleted });
    }
    return deleted;
  }

  async hasLoginCookie(host) {
    await this.#ensureLoaded();
    const site = siteForHost(host);
    return Services.cookies.cookies.some(cookie =>
      hostBelongsToSite(cookie.rawHost || cookie.host, site) && LOGIN_COOKIE_PATTERN.test(cookie.name),
    );
  }

  runManualReflex(window) {
    const browser = window?.gBrowser?.selectedBrowser;
    try {
      browser?.browsingContext?.currentWindowGlobal
        ?.getActor("VaporPrivacy")
        ?.sendAsyncMessage("VaporBroom:RunReflex");
    } catch {}
  }

  async notifyConsentFailure(host) {
    if (!Services.prefs.getBoolPref("vapor.reflex.failure-notifications", true)) return;
    for (const window of this.#windows) {
      window.gZenUIManager?.showToast?.("vapor-reflex-failure", {
        l10nArgs: { host },
      });
    }
  }

  async logConsent(action, host, detail = {}) {
    await this.#record("Consent Actions", action, { host: siteForHost(host), ...detail });
  }

  async #record(kind, action, detail = {}) {
    try {
      const { VaporPrivacy } = ChromeUtils.importESModule(
        "resource:///modules/zen/privacy/VaporPrivacy.sys.mjs",
      );
      await VaporPrivacy.record(kind, action, detail);
    } catch {}
  }

  #removeCookiesForSite(site) {
    let deleted = 0;
    for (const cookie of Services.cookies.cookies) {
      if (!hostBelongsToSite(cookie.rawHost || cookie.host, site)) continue;
      try {
        Services.cookies.remove(cookie.host, cookie.name, cookie.path, cookie.originAttributes);
        deleted++;
      } catch {}
    }
    return deleted;
  }

  async deleteSite(host, mode = Services.prefs.getStringPref("vapor.broom.mode", "full"), reason = "trigger") {
    await this.#ensureLoaded();
    const site = siteForHost(host);
    if (!site || this.isRemembered(site) || mode === "keep-all") {
      return false;
    }
    let deleted = false;
    if (mode === "trackers-only") {
      await this.deleteTrackingCookies(site);
      deleted = true;
    } else {
      this.#removeCookiesForSite(site);
      const flags = mode === "cookies-only"
        ? BROOM_FLAG_COOKIES
        : BROOM_FLAG_COOKIES | BROOM_FLAG_STORAGE;
      const failedFlags = await callbackPromise(callback =>
        Services.clearData.deleteDataFromSite(site, {}, false, flags, callback),
      );
      deleted = failedFlags === 0;
    }
    await this.#record("Broom", deleted ? "site-cleaned" : "site-cleanup-failed", {
      host: site,
      mode,
      reason,
    });
    for (const window of this.#windows) {
      this.#showCleanupToast(window, site, deleted);
    }
    return deleted;
  }

  async #cleanAllSites() {
    await this.#ensureLoaded();
    const sites = new Set([
      ...this.#domainTabs.keys(),
      ...this.#pendingDeletes.keys(),
    ]);
    for (const timer of this.#pendingDeletes.values()) clearTimeout(timer);
    this.#pendingDeletes.clear();
    for (const site of sites) {
      await this.deleteSite(site, Services.prefs.getStringPref("vapor.broom.mode", "full"), "browser-exit");
    }
  }

  #installWindow(window) {
    const progress = {
      onLocationChange: (webProgress, _request, location) => {
        if (!webProgress?.isTopLevel) return;
        const browser = webProgress.browser || webProgress.browsingContext?.embedderElement;
        const tab = browser && window.gBrowser.getTabForBrowser(browser);
        if (tab) this.#handleNavigation(tab, location);
      },
    };
    const onTabOpen = event => this.#registerTab(event.target, event.target.linkedBrowser?.currentURI);
    const onTabClose = event => this.#releaseTab(event.target, "tab-close");
    const onTabSelect = () => this.#updateIndicator(window);
    const contextMenu = window.document.getElementById("contentAreaContextMenu");
    const onContextMenuShowing = () => this.#cleanContextMenu(window);
    window.gBrowser.addTabsProgressListener(progress);
    window.gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen);
    window.gBrowser.tabContainer.addEventListener("TabClose", onTabClose);
    window.gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
    contextMenu?.addEventListener("popupshowing", onContextMenuShowing);
    const observer = new window.MutationObserver(records => {
      for (const record of records) {
        if (record.target.localName !== "tab") continue;
        if (record.target.hasAttribute("pending")) this.#hibernateTab(record.target);
        else if (this.#tabStates.get(record.target)?.hibernated) {
          this.#registerTab(record.target, record.target.linkedBrowser?.currentURI);
        }
      }
    });
    observer.observe(window.gBrowser.tabContainer, { attributes: true, attributeFilter: ["pending"], subtree: true });
    for (const tab of window.gBrowser.tabs) this.#registerTab(tab, tab.linkedBrowser?.currentURI);
    window.addEventListener("unload", () => {
      observer.disconnect();
      window.gBrowser.removeTabsProgressListener(progress);
      window.gBrowser.tabContainer.removeEventListener("TabOpen", onTabOpen);
      window.gBrowser.tabContainer.removeEventListener("TabClose", onTabClose);
      window.gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
      contextMenu?.removeEventListener("popupshowing", onContextMenuShowing);
      this.#windows.delete(window);
    }, { once: true });
    this.#installIndicator(window);
  }

  #registerTab(tab, uriOrHost) {
    if (!tab || tab.closing) return;
    const host = typeof uriOrHost === "string" ? uriOrHost : uriOrHost?.host;
    const site = siteForHost(host);
    const old = this.#tabStates.get(tab);
    if (old?.domain === site && !old.hibernated) return;
    if (old?.domain) this.#removeTabFromDomain(tab, old.domain, "navigation");
    const state = { domain: site, hibernated: false };
    this.#tabStates.set(tab, state);
    if (!site) return;
    if (!this.#domainTabs.has(site)) this.#domainTabs.set(site, new Set());
    this.#domainTabs.get(site).add(tab);
    this.#cancelPending(site);
  }

  #handleNavigation(tab, location) {
    const newSite = siteForHost(location?.host);
    const oldSite = this.#tabStates.get(tab)?.domain;
    if (oldSite && oldSite !== newSite) this.#removeTabFromDomain(tab, oldSite, "navigation");
    this.#registerTab(tab, location);
    const window = tab.ownerGlobal;
    this.#updateIndicator(window);
    if (newSite) {
      this.#maybeLoginPrompt(window, newSite);
      window.setTimeout(() => this.#maybeLoginPrompt(window, newSite), 1_000);
    }
  }

  #removeTabFromDomain(tab, site, reason) {
    const tabs = this.#domainTabs.get(site);
    tabs?.delete(tab);
    if (tabs?.size === 0) {
      this.#domainTabs.delete(site);
      this.#scheduleDelete(site, reason);
    }
  }

  #releaseTab(tab, reason) {
    const state = this.#tabStates.get(tab);
    if (!state) return;
    if (state.domain) this.#removeTabFromDomain(tab, state.domain, reason);
    this.#tabStates.delete(tab);
  }

  #hibernateTab(tab) {
    const state = this.#tabStates.get(tab);
    if (!state || state.hibernated) return;
    if (state.domain) this.#removeTabFromDomain(tab, state.domain, "hibernation");
    state.domain = "";
    state.hibernated = true;
  }

  #scheduleDelete(site, reason) {
    if (!site || this.isRemembered(site) || !Services.prefs.getBoolPref("vapor.broom.enabled", true)) return;
    this.#cancelPending(site);
    const delay = reason === "tab-close"
      ? Math.max(0, Services.prefs.getIntPref("vapor.broom.delay-ms", DEFAULT_DELAY))
      : 0;
    const timer = setTimeout(() => {
      this.#pendingDeletes.delete(site);
      if (!this.#domainTabs.has(site)) this.deleteSite(site, undefined, reason);
    }, delay);
    this.#pendingDeletes.set(site, timer);
  }

  #cancelPending(site) {
    const timer = this.#pendingDeletes.get(site);
    if (timer) clearTimeout(timer);
    this.#pendingDeletes.delete(site);
  }

  async #maybeLoginPrompt(window, site) {
    if (!Services.prefs.getBoolPref("vapor.broom.login-detection", true) || this.#loginSeen.has(site)) return;
    if (!(await this.hasLoginCookie(site))) return;
    this.#loginSeen.add(site);
    const manager = window.gZenUIManager;
    if (!manager?.showToast) return;
    await manager.showToast("vapor-broom-login", {
      l10nArgs: { host: site },
      buttons: [
        {
          id: "vapor-broom-remember-login",
          l10nId: "vapor-broom-remember-login",
          command: () => this.toggleRemembered(site, true),
        },
        {
          id: "vapor-broom-forget-login",
          l10nId: "vapor-broom-forget-login",
          command: () => this.toggleRemembered(site, false),
        },
      ],
    });
  }

  #installIndicator(window) {
    const identityBox = window.document.getElementById("identity-icon-box");
    if (!identityBox || window.document.getElementById("vapor-broom-indicator")) return;
    const button = window.document.createXULElement("toolbarbutton");
    button.id = "vapor-broom-indicator";
    button.className = "identity-box-button vapor-broom-indicator";
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", "Vapor Broom");
    const label = window.document.createXULElement("label");
    label.className = "vapor-broom-symbol";
    button.append(label);
    button.addEventListener("command", () => {
      if (Services.prefs.getStringPref("vapor.reflex.mode", "aggressive") === "manual") {
        this.runManualReflex(window);
        return;
      }
      const host = window.gBrowser.selectedBrowser?.currentURI?.host;
      this.toggleRemembered(host).then(() => this.#updateIndicator(window));
    });
    identityBox.before(button);
    this.#updateIndicator(window);
  }

  async #updateIndicator(window) {
    const button = window.document.getElementById("vapor-broom-indicator");
    if (!button) return;
    const uri = window.gBrowser.selectedBrowser?.currentURI;
    if (!isHTTPURI(uri) || !Services.prefs.getBoolPref("vapor.broom.enabled", true)) {
      button.hidden = true;
      return;
    }
    await this.#ensureLoaded();
    const host = uri.host;
    const remembered = this.isRemembered(host);
    button.hidden = false;
    button.setAttribute("broom-state", remembered ? "remembered" : "active");
    button.setAttribute("tooltiptext", remembered ? "Forget This Site's Cookies" : "Remember This Site's Cookies");
    button.querySelector(".vapor-broom-symbol").value = remembered ? "🔒" : "🧹";
  }

  #updateAllIndicators() {
    for (const window of this.#windows) this.#updateIndicator(window);
  }

  #showCleanupToast(window, site, success) {
    if (!success || !Services.prefs.getBoolPref("vapor.broom.toast", false)) return;
    window.gZenUIManager?.showToast?.("vapor-broom-cleaned", { l10nArgs: { host: site } });
  }

  #cleanContextMenu(window) {
    const menu = window.document.getElementById("contentAreaContextMenu");
    if (!menu) return;
    let item = window.document.getElementById("vapor-broom-remember-site");
    if (!item) {
      item = window.document.createXULElement("menuitem");
      item.id = "vapor-broom-remember-site";
      item.addEventListener("command", () => {
        const host = window.gBrowser.selectedBrowser?.currentURI?.host;
        this.toggleRemembered(host).then(() => this.#updateIndicator(window));
      });
      menu.append(item);
    }
    const host = window.gBrowser.selectedBrowser?.currentURI?.host;
    item.hidden = !host;
    item.setAttribute("label", this.isRemembered(host) ? "Forget This Site's Cookies" : "Remember This Site's Cookies");
  }

  async #readChromeText(uri) {
    return new Promise((resolve, reject) => {
      const channel = NetUtil.newChannel({ uri, loadUsingSystemPrincipal: true });
      const chunks = [];
      channel.asyncOpen({
        QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
        onStartRequest() {},
        onDataAvailable(_request, stream, _offset, count) {
          chunks.push(NetUtil.readInputStream(stream, count));
        },
        onStopRequest(_request, status) {
          if (Components.isSuccessCode(status)) resolve(chunks.join(""));
          else reject(new Error(`Unable to read ${uri}`));
        },
      });
    });
  }
}

export const VaporBroom = new VaporBroomService();
export { DEFAULT_CONSENT_PHRASES, TRACKING_COOKIE_PATTERNS };
