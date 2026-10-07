// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";

const BLOCKLIST_DIRECTORY = "vapor-blocklists";
const URL_STRIP_FILE = "url-strip-list.txt";
const HTTPS_EXCEPTIONS_FILE = "https-exceptions.txt";
const UA_OVERRIDES_FILE = "vapor-ua-overrides.txt";
const SCRIPT_STATES_FILE = "script-states.json";
const URL_STRIP_URI = "chrome://vapor/content/url-strip-list.txt";
const PRIVACY_LOG_FILE = "privacy-log.json";
const MAX_LOG_ENTRIES = 2_000;
const CNAME_CACHE_MS = 60 * 60 * 1_000;
const DEFAULT_SCRIPT_STATE = "first-party";
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VaporStats: "resource:///modules/zen/uichrome/VaporStats.sys.mjs",
});

export const PREF_URL_STRIPPING = "vapor.privacy.url-stripping.enabled";
export const PREF_CNAME_UNCLOAKING = "vapor.privacy.cname-uncloaking.enabled";
export const PREF_REFERRER_POLICY = "vapor.privacy.referrer-policy";
export const PREF_DOH_ENABLED = "vapor.privacy.doh.enabled";
export const PREF_DOH_RESOLVER = "vapor.privacy.doh.resolver";
export const PREF_SPECULATIVE_LOADING =
  "vapor.privacy.speculative-loading.enabled";
export const PREF_FINGERPRINTING = "vapor.privacy.fingerprinting.enabled";
export const PREF_EXTENDED_PROTECTIONS =
  "vapor.privacy.fingerprinting.extended";
export const PREF_TIMEZONE = "vapor.privacy.fingerprinting.timezone";
export const PREF_LANGUAGE = "vapor.privacy.fingerprinting.language";
export const PREF_CLIPBOARD = "vapor.privacy.clipboard.enabled";
export const PREF_SCRIPT_BLOCKING = "vapor.privacy.script-blocking.enabled";
export const PREF_SCRIPT_DEFAULT_STATE = "vapor.privacy.script-blocking.default-state";

export const URL_STRIPPING_PERMISSION = "vapor-url-stripping";
export const REFERRER_PERMISSION = "vapor-referrer";
export const HTTPS_EXCEPTION_PERMISSION = "vapor-https-only-exception";
export const FINGERPRINTING_PERMISSION = "vapor-fingerprinting";
export const CLIPBOARD_PERMISSION = "vapor-clipboard";
export const SCRIPT_PERMISSION = "vapor-script";

export const DOH_RESOLVERS = Object.freeze({
  mullvad: {
    label: "Mullvad DNS",
    uri: "https://doh.mullvad.net/dns-query",
  },
  quad9: {
    label: "Quad9",
    uri: "https://dns.quad9.net/dns-query",
  },
  nextdns: {
    label: "NextDNS",
    uri: "https://dns.nextdns.io/dns-query",
  },
});

const DEFAULT_RESOLVER = "mullvad";
const DEFAULT_STRIP_LIST = `# Vapor URL stripping list. Only names in this file are removed.
utm_*
utm_source
utm_medium
utm_campaign
utm_term
utm_content
fbclid
gclid
gclsrc
dclid
msclkid
twclid
mc_cid
mc_eid
_hsenc
_hsmi
__s
__hsfp
__hssc
__hstc
vero_id
_branch_match_id
mkt_tok
igshid
si
ref
ref_src
ref_url
`;
const TRACKING_PREFIXES = ["utm_"];
const REFERRER_ONLY_NAMES = new Set(["ref", "ref_src", "ref_url"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/^\.+|\.+$/g, "");
}

function hashHost(host) {
  let hash = 0x811c9dc5;
  for (const character of normalizeHost(host)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isHTTPURI(uri) {
  return uri?.schemeIs("http") || uri?.schemeIs("https");
}

function permissionURI(uri) {
  if (uri?.schemeIs("ws") || uri?.schemeIs("wss")) {
    return Services.io.newURI(uri.spec.replace(/^ws/i, "http"));
  }
  return uri;
}

function isTopLevelDocument(channel) {
  const type = channel?.loadInfo?.externalContentPolicyType;
  return (
    type === Ci.nsIContentPolicy.TYPE_DOCUMENT ||
    channel?.loadInfo?.isTopLevelLoad === true
  );
}

function getTopLevelURI(channel) {
  try {
    return channel?.loadInfo?.topLevelPrincipal?.URI || channel?.URI || null;
  } catch {
    return channel?.URI || null;
  }
}

function getOrigin(uri) {
  try {
    return new URL(uri.spec).origin;
  } catch {
    return "";
  }
}

function isSpeculativeChannel(channel) {
  const loadInfo = channel?.loadInfo;
  const policyType = loadInfo?.externalContentPolicyType;
  const speculativeTypes = [
    "TYPE_DOCUMENT_PRELOAD",
    "TYPE_INTERNAL_DOCUMENT_PRELOAD",
    "TYPE_INTERNAL_SCRIPT_PRELOAD",
    "TYPE_INTERNAL_IMAGE_PRELOAD",
    "TYPE_INTERNAL_STYLESHEET_PRELOAD",
    "TYPE_INTERNAL_FRAME_PRELOAD",
  ];
  if (speculativeTypes.some(name => Ci.nsIContentPolicy[name] === policyType)) {
    return true;
  }
  try {
    return (
      loadInfo?.isFromPredictor === true ||
      channel.getRequestHeader("X-Moz")?.toLowerCase().includes("prefetch")
    );
  } catch {
    return false;
  }
}

/**
 * Network privacy policy and local profile storage. VaporShield calls
 * prepareChannel before it runs the request blocklist, so CNAME results are
 * available to the Shield matcher without moving profile I/O into content.
 */
class VaporPrivacyService {
  #initialized = false;
  #windows = new Set();
  #loadPromise = null;
  #stripRules = new Set();
  #httpsExceptions = new Set();
  #uaOverrides = new Set();
  #scriptStates = new Map();
  #sessionDeviceSeeds = new Map();
  #logs = [];
  #cnameCache = new Map();
  #cnameRequests = new Map();
  #warningChannels = new WeakSet();
  #browserWindows = new Map();
  #temporaryScriptAllow = new Map();
  #writeQueue = Promise.resolve();

  init(window) {
    this.#windows.add(window);
    window.addEventListener("unload", () => this.#windows.delete(window), {
      once: true,
    });
    if (this.#initialized) {
      this.configureDoH();
      this.#installBrowserPrivacyUI(window);
      return;
    }
    this.#initialized = true;
    Services.obs.addObserver(this, "http-on-stop-request");
    for (const pref of [
      PREF_DOH_ENABLED,
      PREF_DOH_RESOLVER,
      PREF_URL_STRIPPING,
      PREF_CNAME_UNCLOAKING,
      PREF_REFERRER_POLICY,
      PREF_SPECULATIVE_LOADING,
      PREF_FINGERPRINTING,
      PREF_EXTENDED_PROTECTIONS,
      PREF_TIMEZONE,
      PREF_LANGUAGE,
      PREF_CLIPBOARD,
      PREF_SCRIPT_BLOCKING,
    ]) {
      Services.prefs.addObserver(pref, this);
    }
    this.#loadPromise = this.reload();
    this.configureDoH();
    this.#installBrowserPrivacyUI(window);
  }

  observe(subject, topic, data) {
    if (topic === "http-on-stop-request") {
      this.#maybeShowHTTPSWarning(subject);
      return;
    }
    if (topic !== "nsPref:changed") {
      return;
    }
    if (data === PREF_DOH_ENABLED || data === PREF_DOH_RESOLVER) {
      this.configureDoH();
    }
    for (const window of this.#windows) {
      window.dispatchEvent(new window.CustomEvent("vapor-privacy-settings-changed"));
    }
  }

  get urlStrippingEnabled() {
    return Services.prefs.getBoolPref(PREF_URL_STRIPPING, true);
  }

  get cnameUncloakingEnabled() {
    return Services.prefs.getBoolPref(PREF_CNAME_UNCLOAKING, true);
  }

  get dohEnabled() {
    return Services.prefs.getBoolPref(PREF_DOH_ENABLED, true);
  }

  get speculativeLoadingBlocked() {
    return Services.prefs.getBoolPref(PREF_SPECULATIVE_LOADING, true);
  }

  get referrerPolicy() {
    return Services.prefs.getStringPref(
      PREF_REFERRER_POLICY,
      "strict-origin-when-cross-origin",
    );
  }

  async #ensureLoaded() {
    if (!this.#initialized && !this.#loadPromise) {
      this.#initialized = true;
      this.#loadPromise = this.reload();
    }
    await this.#loadPromise?.catch(() => {});
  }

  async reload() {
    const directory = PathUtils.join(PathUtils.profileDir, BLOCKLIST_DIRECTORY);
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const stripPath = PathUtils.join(directory, URL_STRIP_FILE);
    const exceptionsPath = PathUtils.join(directory, HTTPS_EXCEPTIONS_FILE);
    const uaPath = PathUtils.join(PathUtils.profileDir, UA_OVERRIDES_FILE);
    const scriptPath = PathUtils.join(directory, SCRIPT_STATES_FILE);
    const logPath = PathUtils.join(directory, PRIVACY_LOG_FILE);

    if (!(await IOUtils.exists(stripPath))) {
      const shipped = await this.#readChromeText(URL_STRIP_URI).catch(
        () => DEFAULT_STRIP_LIST,
      );
      await IOUtils.writeUTF8(stripPath, shipped);
    }
    if (!(await IOUtils.exists(exceptionsPath))) {
      await IOUtils.writeUTF8(exceptionsPath, "");
    }
    if (!(await IOUtils.exists(uaPath))) {
      await IOUtils.writeUTF8(uaPath, "");
    }
    if (!(await IOUtils.exists(scriptPath))) {
      await IOUtils.writeUTF8(scriptPath, "{}\n");
    }

    const [stripText, exceptionText, uaText, scriptText, logText] = await Promise.all([
      IOUtils.readUTF8(stripPath).catch(() => DEFAULT_STRIP_LIST),
      IOUtils.readUTF8(exceptionsPath).catch(() => ""),
      IOUtils.readUTF8(uaPath).catch(() => ""),
      IOUtils.readUTF8(scriptPath).catch(() => "{}"),
      IOUtils.readUTF8(logPath).catch(() => "[]"),
    ]);
    this.#stripRules = this.#parseStripRules(stripText);
    this.#httpsExceptions = this.#parseHosts(exceptionText);
    this.#uaOverrides = this.#parseHosts(uaText);
    try {
      const parsedScripts = JSON.parse(scriptText);
      this.#scriptStates = new Map(
        Object.entries(parsedScripts || {}).filter(([, state]) =>
          ["allow-all", "first-party", "block-all"].includes(state),
        ),
      );
    } catch {
      this.#scriptStates = new Map();
    }
    try {
      const parsed = JSON.parse(logText);
      this.#logs = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.#logs = [];
    }
    this.#loadPromise = null;
    return this.#stripRules.size;
  }

  #parseStripRules(text) {
    return new Set(
      String(text || "")
        .split(/\r?\n/)
        .map(line => line.trim().toLowerCase())
        .filter(line => line && !line.startsWith("#") && !line.startsWith("!")),
    );
  }

  #parseHosts(text) {
    return new Set(
      String(text || "")
        .split(/\r?\n/)
        .map(line => normalizeHost(line.trim()))
        .filter(Boolean),
    );
  }

  async getURLStripList() {
    await this.#ensureLoaded();
    return [...this.#stripRules].join("\n");
  }

  async setURLStripList(text) {
    await this.#ensureLoaded();
    const directory = PathUtils.join(PathUtils.profileDir, BLOCKLIST_DIRECTORY);
    const clean = String(text || "").replace(/^\uFEFF/, "");
    await IOUtils.writeUTF8(
      PathUtils.join(directory, URL_STRIP_FILE),
      clean.endsWith("\n") ? clean : `${clean}\n`,
    );
    await this.reload();
  }

  async getHTTPSExceptions() {
    await this.#ensureLoaded();
    return [...this.#httpsExceptions].join("\n");
  }

  async setHTTPSExceptions(text) {
    await this.#ensureLoaded();
    const directory = PathUtils.join(PathUtils.profileDir, BLOCKLIST_DIRECTORY);
    const clean = String(text || "")
      .split(/\r?\n/)
      .map(line => normalizeHost(line.trim()))
      .filter(Boolean)
      .join("\n");
    await IOUtils.writeUTF8(
      PathUtils.join(directory, HTTPS_EXCEPTIONS_FILE),
      clean ? `${clean}\n` : "",
    );
    await this.reload();
  }

  async addHTTPSException(host) {
    await this.#ensureLoaded();
    const normalized = normalizeHost(host);
    if (!normalized) {
      return;
    }
    this.#httpsExceptions.add(normalized);
    await this.setHTTPSExceptions([...this.#httpsExceptions].join("\n"));
    await this.record("HTTPS-Only", "exception-added", { host: normalized });
  }

  async getUAOverrides() {
    await this.#ensureLoaded();
    return [...this.#uaOverrides].join("\n");
  }

  async setUAOverrides(text) {
    await this.#ensureLoaded();
    const clean = [...this.#parseHosts(text)].join("\n");
    await IOUtils.writeUTF8(
      PathUtils.join(PathUtils.profileDir, UA_OVERRIDES_FILE),
      clean ? `${clean}\n` : "",
    );
    await this.reload();
  }

  async setUAOverride(host, enabled) {
    await this.#ensureLoaded();
    const normalized = normalizeHost(host);
    if (!normalized) {
      return;
    }
    if (enabled) {
      this.#uaOverrides.add(normalized);
    } else {
      this.#uaOverrides.delete(normalized);
    }
    await this.setUAOverrides([...this.#uaOverrides].join("\n"));
    await this.record("User-Agent Overrides", enabled ? "enabled" : "disabled", {
      host: normalized,
    });
    this.#updateAllBrowserPrivacyUI();
  }

  isUAOverride(host) {
    return this.#uaOverrides.has(normalizeHost(host));
  }

  getScriptState(host) {
    return this.#scriptStates.get(normalizeHost(host)) ||
      Services.prefs.getStringPref(PREF_SCRIPT_DEFAULT_STATE, DEFAULT_SCRIPT_STATE);
  }

  getEffectiveScriptState(uri) {
    const permission = this.getSitePermission(uri, SCRIPT_PERMISSION);
    if (permission === Ci.nsIPermissionManager.ALLOW_ACTION) return "allow-all";
    if (permission === Ci.nsIPermissionManager.DENY_ACTION) return "block-all";
    return this.getScriptState(uri?.host);
  }

  async setScriptState(host, state) {
    await this.#ensureLoaded();
    const normalized = normalizeHost(host);
    if (!normalized || !["allow-all", "first-party", "block-all"].includes(state)) {
      return;
    }
    this.#scriptStates.set(normalized, state);
    const directory = PathUtils.join(PathUtils.profileDir, BLOCKLIST_DIRECTORY);
    await IOUtils.writeUTF8(
      PathUtils.join(directory, SCRIPT_STATES_FILE),
      `${JSON.stringify(Object.fromEntries(this.#scriptStates), null, 2)}\n`,
    );
    await this.record("Script Blocking", "state-changed", {
      host: normalized,
      state,
    });
    this.#updateAllBrowserPrivacyUI();
  }

  async cycleScriptState(window = null) {
    const browserWindow = window || this.#browserWindows.keys().next().value;
    const host = normalizeHost(browserWindow?.gBrowser?.selectedBrowser?.currentURI?.host);
    if (!host) {
      return DEFAULT_SCRIPT_STATE;
    }
    const uri = browserWindow.gBrowser.selectedBrowser.currentURI;
    const states = ["allow-all", "first-party", "block-all"];
    const next = states[(states.indexOf(this.getEffectiveScriptState(uri)) + 1) % states.length];
    if (next === "first-party") {
      this.clearSitePermission(uri, SCRIPT_PERMISSION);
    } else {
      this.setSitePermission(uri, SCRIPT_PERMISSION, next === "allow-all");
    }
    await this.setScriptState(host, next);
    browserWindow.gBrowser.reloadTab(browserWindow.gBrowser.selectedTab);
    return next;
  }

  allowTemporaryScripts(host) {
    this.#temporaryScriptAllow.set(normalizeHost(host), Date.now() + 15_000);
  }

  async getBrowserPrivacyConfiguration(host, href = "") {
    await this.#ensureLoaded();
    const normalized = normalizeHost(host);
    let fingerprintPermission = 0;
    let clipboardPermission = 0;
    let scriptPermission = 0;
    try {
      const uri = Services.io.newURI(href || `https://${normalized}/`);
      fingerprintPermission = this.getSitePermission(uri, FINGERPRINTING_PERMISSION);
      clipboardPermission = this.getSitePermission(uri, CLIPBOARD_PERMISSION);
      scriptPermission = this.getSitePermission(uri, SCRIPT_PERMISSION);
    } catch {}
    const fingerprintingEnabled =
      fingerprintPermission === Ci.nsIPermissionManager.ALLOW_ACTION ||
      (fingerprintPermission !== Ci.nsIPermissionManager.DENY_ACTION &&
        Services.prefs.getBoolPref(PREF_FINGERPRINTING, true));
    const scriptEnabled = Services.prefs.getBoolPref(PREF_SCRIPT_BLOCKING, true);
    const configuredScriptState =
      scriptPermission === Ci.nsIPermissionManager.ALLOW_ACTION
        ? "allow-all"
        : scriptPermission === Ci.nsIPermissionManager.DENY_ACTION
          ? "block-all"
          : this.getScriptState(normalized);
    const temporaryUntil = this.#temporaryScriptAllow.get(normalized) || 0;
    const temporary = temporaryUntil > Date.now();
    let deviceSeed = this.#sessionDeviceSeeds.get(normalized);
    if (!deviceSeed) {
      deviceSeed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      this.#sessionDeviceSeeds.set(normalized, deviceSeed);
    }
    return {
      speculativeLoadingBlocked: this.speculativeLoadingBlocked,
      fingerprintingEnabled,
      extendedProtections: Services.prefs.getBoolPref(PREF_EXTENDED_PROTECTIONS, true),
      siteSeed: hashHost(normalized),
      deviceSeed,
      timezone: Services.prefs.getStringPref(PREF_TIMEZONE, "UTC"),
      language: Services.prefs.getStringPref(PREF_LANGUAGE, "en-US"),
      clipboardEnabled: Services.prefs.getBoolPref(PREF_CLIPBOARD, true),
      clipboardPermission,
      scriptEnabled,
      scriptState: temporary ? "allow-all" : configuredScriptState,
      temporaryScripts: temporary,
      uaOverride: this.isUAOverride(normalized),
    };
  }

  getSitePermission(uri, permission) {
    try {
      const principal = Services.scriptSecurityManager.createContentPrincipal(
        permissionURI(uri),
        {},
      );
      return Services.perms.testPermissionFromPrincipal(principal, permission);
    } catch {
      return 0;
    }
  }

  setSitePermission(uri, permission, enabled) {
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      permissionURI(uri),
      {},
    );
    Services.perms.addFromPrincipal(
      principal,
      permission,
      enabled
        ? Ci.nsIPermissionManager.ALLOW_ACTION
        : Ci.nsIPermissionManager.DENY_ACTION,
    );
    for (const window of this.#windows) {
      window.dispatchEvent(new window.CustomEvent("vapor-privacy-settings-changed"));
    }
  }

  clearSitePermission(uri, permission) {
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      permissionURI(uri),
      {},
    );
    Services.perms.removeFromPrincipal(principal, permission);
    for (const window of this.#windows) {
      window.dispatchEvent(new window.CustomEvent("vapor-privacy-settings-changed"));
    }
  }

  async requestClipboardPermission(host, href) {
    await this.#ensureLoaded();
    if (!Services.prefs.getBoolPref(PREF_CLIPBOARD, true)) {
      return { allowed: false, once: false };
    }
    let uri;
    try {
      uri = Services.io.newURI(href || `https://${host}/`);
    } catch {
      return { allowed: false, once: false };
    }
    const permission = this.getSitePermission(uri, CLIPBOARD_PERMISSION);
    if (permission === Ci.nsIPermissionManager.ALLOW_ACTION) {
      return { allowed: true, once: false };
    }
    if (permission === Ci.nsIPermissionManager.DENY_ACTION) {
      return { allowed: false, once: false };
    }
    const window = [...this.#windows][0];
    if (!window) {
      return { allowed: false, once: false };
    }
    const flags =
      Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0 +
      Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_1 +
      Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_2;
    const result = Services.prompt.confirmEx(
      window,
      "Clipboard access",
      `${host} wants to read your clipboard.`,
      flags,
      "Allow Once",
      "Allow Always",
      "Block",
      null,
      {},
    );
    if (result === 1) {
      this.setSitePermission(uri, CLIPBOARD_PERMISSION, true);
      await this.record("Clipboard", "allow-always", { host });
      return { allowed: true, once: false };
    }
    if (result === 0) {
      await this.record("Clipboard", "allow-once", { host });
      return { allowed: true, once: true };
    }
    this.setSitePermission(uri, CLIPBOARD_PERMISSION, false);
    await this.record("Clipboard", "blocked", { host });
    return { allowed: false, once: false };
  }

  #installBrowserPrivacyUI(window) {
    if (this.#browserWindows.has(window) || !window.gBrowser) {
      return;
    }
    const onLocationChange = (_webProgress, _request, location) => {
      if (location?.schemeIs?.("http") || location?.schemeIs?.("https")) {
        this.#updateBrowserPrivacyUI(window);
      }
    };
    const onTabSelect = () => this.#updateBrowserPrivacyUI(window);
    const onCommand = event => {
      const target = event.target;
      const command = target?.id || target?.getAttribute?.("command") || "";
      if (!event.shiftKey || !String(command).toLowerCase().includes("reload")) {
        return;
      }
      const host = normalizeHost(window.gBrowser.selectedBrowser?.currentURI?.host);
      if (host) {
        this.allowTemporaryScripts(host);
      }
    };
    const contextMenu = window.document.getElementById("contentAreaContextMenu");
    const onContextMenuShowing = () => this.#updatePrivacyContextMenu(window);
    const progress = { onLocationChange };
    window.gBrowser.addTabsProgressListener(progress);
    window.gBrowser.tabContainer?.addEventListener("TabSelect", onTabSelect);
    window.addEventListener("command", onCommand, true);
    contextMenu?.addEventListener("popupshowing", onContextMenuShowing);
    const onUnload = () => {
      window.gBrowser.removeTabsProgressListener(progress);
      window.gBrowser.tabContainer?.removeEventListener("TabSelect", onTabSelect);
      window.removeEventListener("command", onCommand, true);
      contextMenu?.removeEventListener("popupshowing", onContextMenuShowing);
      this.#browserWindows.delete(window);
    };
    window.addEventListener("unload", onUnload, { once: true });
    this.#browserWindows.set(window, { progress, onTabSelect, contextMenu, onContextMenuShowing });
    this.#updateBrowserPrivacyUI(window);
  }

  #updateAllBrowserPrivacyUI() {
    for (const window of this.#browserWindows.keys()) {
      this.#updateBrowserPrivacyUI(window);
    }
  }

  async #updateBrowserPrivacyUI(window) {
    const document = window.document;
    const identityBox = document.getElementById("identity-icon-box");
    if (!identityBox) {
      return;
    }
    let button = document.getElementById("vapor-privacy-indicator");
    if (!button) {
      button = document.createXULElement("toolbarbutton");
      button.id = "vapor-privacy-indicator";
      button.className = "identity-box-button vapor-privacy-indicator";
      button.setAttribute("type", "button");
      button.setAttribute("aria-label", "Vapor privacy protections");
      const dot = document.createXULElement("label");
      dot.className = "vapor-privacy-dot";
      dot.value = "●";
      button.append(dot);
      button.addEventListener("command", () => this.cycleScriptState(window));
      identityBox.before(button);
    }
    const browser = window.gBrowser.selectedBrowser;
    const host = normalizeHost(browser?.currentURI?.host);
    if (!host) {
      button.hidden = true;
      return;
    }
    await this.#ensureLoaded();
    const state = this.getEffectiveScriptState(browser.currentURI);
    button.hidden = false;
    button.setAttribute("script-state", state);
    button.setAttribute("ua-override", this.isUAOverride(host) ? "true" : "false");
    button.setAttribute("tooltiptext", `Scripts: ${state}; click to change${this.isUAOverride(host) ? "; Chrome UA active" : ""}`);
  }

  #updatePrivacyContextMenu(window) {
    const menu = window.document.getElementById("contentAreaContextMenu");
    if (!menu) {
      return;
    }
    let item = window.document.getElementById("vapor-spoof-chrome");
    if (!item) {
      item = window.document.createXULElement("menuitem");
      item.id = "vapor-spoof-chrome";
      item.addEventListener("command", () => {
        const browser = window.gBrowser.selectedBrowser;
        const host = normalizeHost(browser?.currentURI?.host);
        if (host) {
          this.setUAOverride(host, !this.isUAOverride(host)).then(() => {
            window.gBrowser.reloadTab(window.gBrowser.selectedTab);
          });
        }
      });
      menu.append(item);
    }
    const host = normalizeHost(window.gBrowser.selectedBrowser?.currentURI?.host);
    item.hidden = !host;
    item.setAttribute("label", this.isUAOverride(host) ? "Stop Spoofing Chrome for This Site" : "Spoof as Chrome for This Site");
  }

  #featureEnabled(channel, pref, permission) {
    const sitePermission = this.getSitePermission(
      getTopLevelURI(channel),
      permission,
    );
    if (sitePermission === Ci.nsIPermissionManager.DENY_ACTION) {
      return false;
    }
    if (sitePermission === Ci.nsIPermissionManager.ALLOW_ACTION) {
      return true;
    }
    return Services.prefs.getBoolPref(pref, true);
  }

  #isTrustedReferrerSite(channel) {
    return (
      this.getSitePermission(getTopLevelURI(channel), REFERRER_PERMISSION) ===
      Ci.nsIPermissionManager.ALLOW_ACTION
    );
  }

  #referrerPolicyEnabled(_channel) {
    // A site-level BLOCK means "remove the trusted full-referrer override";
    // the hardened global policy remains active.
    return this.referrerPolicy !== "off";
  }

  isHTTPSException(uriOrHost) {
    const host = normalizeHost(
      typeof uriOrHost === "string" ? uriOrHost : uriOrHost?.host,
    );
    if (!host) {
      return false;
    }
    if (
      LOCAL_HOSTS.has(host) ||
      host.endsWith(".onion") ||
      this.#httpsExceptions.has(host)
    ) {
      return true;
    }
    try {
      return (
        this.getSitePermission(
          typeof uriOrHost === "string"
            ? Services.io.newURI(`https://${host}/`)
            : uriOrHost,
          HTTPS_EXCEPTION_PERMISSION,
        ) === Ci.nsIPermissionManager.ALLOW_ACTION
      );
    } catch {
      return false;
    }
  }

  #isTrackingParameter(name) {
    const lower = name.toLowerCase();
    return [...this.#stripRules].some(rule =>
      rule.endsWith("*")
        ? lower.startsWith(rule.slice(0, -1))
        : lower === rule,
    );
  }

  cleanURL(spec, { topLevel = false } = {}) {
    let parsed;
    try {
      parsed = new URL(spec);
    } catch {
      return { spec, removed: [] };
    }
    if (!/^https?:$/i.test(parsed.protocol)) {
      return { spec, removed: [] };
    }
    const removed = [];
    for (const [name] of [...parsed.searchParams.entries()]) {
      if (
        REFERRER_ONLY_NAMES.has(name.toLowerCase()) &&
        topLevel &&
        ![...parsed.searchParams.keys()].some(key =>
          this.#isTrackingParameter(key) &&
          !REFERRER_ONLY_NAMES.has(key.toLowerCase()),
        )
      ) {
        continue;
      }
      if (this.#isTrackingParameter(name)) {
        removed.push(name);
        parsed.searchParams.delete(name);
      }
    }
    return { spec: removed.length ? parsed.toString() : spec, removed };
  }

  async prepareChannel(channel) {
    await this.#ensureLoaded();
    let uri = channel?.URI;
    if (!isHTTPURI(uri)) {
      return { cnameHost: "" };
    }

    const topLevel = isTopLevelDocument(channel);
    const topURI = getTopLevelURI(channel);
    if (this.#featureEnabled(channel, PREF_URL_STRIPPING, URL_STRIPPING_PERMISSION)) {
      const cleaned = this.cleanURL(uri.spec, { topLevel });
      if (cleaned.removed.length) {
        try {
          const cleanedURI = Services.io.newURI(cleaned.spec);
          channel.redirectTo(cleanedURI);
          uri = cleanedURI;
          await this.record("URL Stripping", "stripped", {
            host: uri.host,
            removed: cleaned.removed,
            before: uri.spec,
            after: cleaned.spec,
          });
        } catch (error) {
          await this.record("URL Stripping", "redirect-failed", {
            host: uri.host,
            error: String(error),
          });
        }
      }
    }

    if (this.#featureEnabled(channel, PREF_SPECULATIVE_LOADING, "vapor-speculative-loading")) {
      this.#blockSpeculativeChannel(channel, uri, topURI);
    }
    if (this.#referrerPolicyEnabled(channel)) {
      this.#hardenReferrer(channel);
    }
    this.record("DNS", "query", {
      host: uri.host,
      resolver: this.dohEnabled
        ? (DOH_RESOLVERS[Services.prefs.getStringPref(PREF_DOH_RESOLVER, DEFAULT_RESOLVER)] || DOH_RESOLVERS[DEFAULT_RESOLVER]).label
        : "system",
    }).catch(() => {});
    let cnameHost = "";
    if (this.#featureEnabled(channel, PREF_CNAME_UNCLOAKING, "vapor-cname-uncloaking")) {
      cnameHost = await this.#getCNAME(uri.host);
    }
    this.#applyUAOverride(channel);
    if (!this.isHTTPSException(uri) && uri.schemeIs("http")) {
      this.#upgradeHTTP(channel, uri);
    }
    return { cnameHost };
  }

  #blockSpeculativeChannel(channel, uri, topURI) {
    if (!isSpeculativeChannel(channel)) {
      return;
    }
    const requestSpec = uri.spec.toLowerCase();
    const isPrefetch = (() => {
      try {
        return channel.getRequestHeader("X-Moz")?.toLowerCase().includes("prefetch");
      } catch {
        return false;
      }
    })();
    if (isPrefetch || /(?:^|[?&])(?:prefetch|prerender)=/i.test(requestSpec)) {
      channel.cancel(Cr.NS_BINDING_ABORTED);
      this.record("Speculative Loading", "blocked", { url: uri.spec });
      return;
    }
    const topOrigin = getOrigin(topURI);
    if (topOrigin && topOrigin !== getOrigin(uri)) {
      const type = channel.loadInfo?.externalContentPolicyType;
      const preload =
        type === Ci.nsIContentPolicy.TYPE_INTERNAL_DOCUMENT_PRELOAD ||
        type === Ci.nsIContentPolicy.TYPE_INTERNAL_SCRIPT_PRELOAD ||
        type === Ci.nsIContentPolicy.TYPE_INTERNAL_IMAGE_PRELOAD ||
        type === Ci.nsIContentPolicy.TYPE_INTERNAL_STYLESHEET_PRELOAD;
      if (preload) {
        channel.cancel(Cr.NS_BINDING_ABORTED);
        this.record("Speculative Loading", "cross-origin-preload-blocked", {
          url: uri.spec,
        });
      }
    }
  }

  #hardenReferrer(channel) {
    let referrer;
    try {
      referrer = channel.referrer;
    } catch {
      return;
    }
    if (!referrer || this.#isTrustedReferrerSite(channel)) {
      return;
    }
    const target = channel.URI;
    let referrerURL;
    let targetURL;
    try {
      referrerURL = new URL(referrer.spec);
      targetURL = new URL(target.spec);
    } catch {
      return;
    }
    const sameOrigin = referrerURL.origin === targetURL.origin;
    const downgrade = referrerURL.protocol === "https:" && targetURL.protocol === "http:";
    let value = referrer.spec;
    if (this.referrerPolicy === "no-referrer" || (downgrade && !sameOrigin)) {
      value = "";
    } else if (!sameOrigin || this.referrerPolicy === "strict-origin") {
      value = `${referrerURL.origin}/`;
    }
    if (value === referrer.spec) {
      return;
    }
    try {
      channel.setRequestHeader("Referer", value, false);
      this.record("Referrer Policy", "hardened", {
        from: referrer.spec,
        to: value,
        destination: target.spec,
      });
    } catch {}
  }

  #applyUAOverride(channel) {
    const topHost = normalizeHost(getTopLevelURI(channel)?.host || "");
    if (!topHost || !this.#uaOverrides.has(topHost)) {
      return;
    }
    try {
      channel.setRequestHeader("User-Agent", CHROME_USER_AGENT, false);
      this.record("User-Agent Overrides", "applied", { host: topHost }).catch(() => {});
    } catch {}
  }

  #upgradeHTTP(channel, uri) {
    if (!uri.schemeIs("http")) {
      return;
    }
    try {
      const httpsURI = Services.io.newURI(uri.spec.replace(/^http:/i, "https:"));
      channel.QueryInterface(Ci.nsIWritablePropertyBag).setPropertyAsBool(
        "vapor-https-upgraded",
        true,
      );
      channel.QueryInterface(Ci.nsIWritablePropertyBag).setPropertyAsAString(
        "vapor-https-original-url",
        uri.spec,
      );
      channel.redirectTo(httpsURI);
      this.record("HTTPS-Only", "upgraded", {
        from: uri.spec,
        to: httpsURI.spec,
      });
    } catch (error) {
      this.record("HTTPS-Only", "upgrade-failed", {
        url: uri.spec,
        error: String(error),
      });
    }
  }

  async #getCNAME(host) {
    host = normalizeHost(host);
    if (!host || LOCAL_HOSTS.has(host) || !this.cnameUncloakingEnabled) {
      return "";
    }
    const cached = this.#cnameCache.get(host);
    if (cached && cached.expires > Date.now()) {
      return cached.target;
    }
    if (this.#cnameRequests.has(host)) {
      return this.#cnameRequests.get(host);
    }
    const request = new Promise(resolve => {
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIDNSListener"]),
        onLookupComplete: (_request, record, status) => {
          let target = "";
          try {
            if (Components.isSuccessCode(status)) {
              const canonical = normalizeHost(record?.canonicalName || "");
              if (canonical && canonical !== host) {
                target = canonical;
              }
            }
          } catch {}
          this.#cnameCache.set(host, {
            target,
            expires: Date.now() + CNAME_CACHE_MS,
          });
          this.record("DNS", "cname-resolved", {
            host,
            cname: target || null,
            trr: !!record?.IsTRR?.(),
          });
          resolve(target);
        },
      };
      try {
        Services.dns.asyncResolve(
          host,
          Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT,
          Ci.nsIDNSService.RESOLVE_CANONICAL_NAME,
          null,
          listener,
          Services.tm.mainThread,
          null,
        );
      } catch (error) {
        this.#cnameCache.set(host, { target: "", expires: Date.now() + CNAME_CACHE_MS });
        this.record("DNS", "cname-error", { host, error: String(error) });
        resolve("");
      }
    });
    this.#cnameRequests.set(host, request);
    request.finally(() => this.#cnameRequests.delete(host));
    return request;
  }

  shouldBlockCNAME(spec, matcher) {
    if (!this.cnameUncloakingEnabled || typeof matcher !== "function") {
      return false;
    }
    let host;
    try {
      host = normalizeHost(new URL(spec).hostname);
    } catch {
      return false;
    }
    const target = this.#cnameCache.get(host)?.target;
    return !!target && matcher(`https://${target}/`);
  }

  #maybeShowHTTPSWarning(subject) {
    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }
    if (channel.status === Cr.NS_OK || !isTopLevelDocument(channel)) {
      return;
    }
    let upgraded = false;
    let originalURL = channel.URI?.spec || "";
    try {
      const properties = channel.QueryInterface(Ci.nsIPropertyBag2);
      upgraded = properties.getPropertyAsBool("vapor-https-upgraded");
      originalURL = properties.getPropertyAsAString("vapor-https-original-url");
    } catch {
      return;
    }
    if (!upgraded || this.#warningChannels.has(channel)) {
      return;
    }
    let docShell;
    try {
      docShell = channel.notificationCallbacks?.getInterface(Ci.nsIDocShell);
    } catch {
      return;
    }
    if (!docShell) {
      return;
    }
    const host = normalizeHost(channel.URI?.host || "");
    if (!host || this.isHTTPSException(host)) {
      return;
    }
    this.#warningChannels.add(channel);
    const warningURL = `chrome://vapor/content/https-warning.xhtml?host=${encodeURIComponent(host)}&url=${encodeURIComponent(originalURL)}`;
    try {
      docShell.loadURI(warningURL, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      this.record("HTTPS-Only", "warning-shown", {
        host,
        url: originalURL,
      });
    } catch (error) {
      this.record("HTTPS-Only", "warning-failed", {
        host,
        error: String(error),
      });
    }
  }

  configureDoH() {
    const enabled = this.dohEnabled;
    const resolver = DOH_RESOLVERS[
      Services.prefs.getStringPref(PREF_DOH_RESOLVER, DEFAULT_RESOLVER)
    ] || DOH_RESOLVERS[DEFAULT_RESOLVER];
    Services.prefs.setIntPref("network.trr.mode", enabled ? 3 : 5);
    Services.prefs.setBoolPref("network.trr.wait-for-portal", false);
    Services.prefs.setBoolPref("network.trr.disable-ECS", true);
    Services.prefs.setStringPref("network.trr.uri", resolver.uri);
    Services.prefs.setStringPref("network.trr.custom_uri", resolver.uri);
    this.record("DNS", enabled ? "doh-configured" : "doh-disabled", {
      resolver: enabled ? resolver.label : "system DNS disabled by user",
    }).catch(() => {});
  }

  async getActivityLog() {
    await this.#ensureLoaded();
    return structuredClone(this.#logs);
  }

  async clearActivityLog() {
    await this.#ensureLoaded();
    this.#logs = [];
    await this.#writeJSON(this.#logs);
  }

  async record(kind, action, detail = {}) {
    await this.#ensureLoaded();
    this.#logs.unshift({
      kind,
      action,
      time: new Date().toISOString(),
      ...detail,
    });
    this.#logs = this.#logs.slice(0, MAX_LOG_ENTRIES);
    await this.#writeJSON(this.#logs);
    lazy.VaporStats.recordPrivacy(action, detail).catch(() => {});
  }

  async #readChromeText(uri) {
    return new Promise((resolve, reject) => {
      const channel = NetUtil.newChannel({
        uri,
        loadUsingSystemPrincipal: true,
      });
      const chunks = [];
      channel.asyncOpen({
        QueryInterface: ChromeUtils.generateQI([
          "nsIStreamListener",
          "nsIRequestObserver",
        ]),
        onStartRequest() {},
        onDataAvailable(_request, stream, _offset, count) {
          chunks.push(NetUtil.readInputStream(stream, count));
        },
        onStopRequest(_request, status) {
          if (Components.isSuccessCode(status)) {
            resolve(chunks.join(""));
          } else {
            reject(new Error(`Unable to read ${uri}`));
          }
        },
      });
    });
  }

  async #writeJSON(value) {
    const path = PathUtils.join(
      PathUtils.profileDir,
      BLOCKLIST_DIRECTORY,
      PRIVACY_LOG_FILE,
    );
    this.#writeQueue = this.#writeQueue
      .catch(() => {})
      .then(() => IOUtils.writeUTF8(path, `${JSON.stringify(value, null, 2)}\n`));
    return this.#writeQueue;
  }
}

export const VaporPrivacy = new VaporPrivacyService();
