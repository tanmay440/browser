// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";

const PREF_ENABLED = "vapor.filter.enabled";
const FILTER_PERMISSION = "vapor-filter";
const BLOCKLIST_DIRECTORY = "vapor-blocklists";
const ELEMENT_FILTERS = "element-filters.txt";
const OVERLAY_PHRASES = "overlay-phrases.txt";
const OVERLAY_MEMORY = "overlay-memory.json";
const FILTER_LOG = "filter-log.json";
const ELEMENT_FILTERS_URI = "chrome://vapor/content/element-filters.txt";
const OVERLAY_PHRASES_URI = "chrome://vapor/content/overlay-phrases.txt";
const MAX_LOG_ENTRIES = 1_000;
const UNKNOWN_PERMISSION = 0;

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/^\.+|\.+$/g, "");
}

function scopeMatches(host, scope) {
  host = normalizeHost(host);
  scope = String(scope || "").trim().toLowerCase();
  if (!scope || scope === "*" || scope === "||*") {
    return true;
  }
  scope = scope.replace(/^\|\|/, "");
  if (scope.startsWith("*.")) {
    scope = scope.slice(2);
  }
  return host === scope || host.endsWith(`.${scope}`);
}

function parseElementRules(text, host = "") {
  const rules = [];
  for (const original of String(text || "").split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    const exception = line.startsWith("@@");
    const rule = (exception ? line.slice(2) : line).trim();
    const separator = rule.indexOf("##");
    if (separator < 0) {
      continue;
    }
    const scope = rule.slice(0, separator).trim();
    const selector = rule.slice(separator + 2).trim();
    if (!selector || (scope && !scope.split(",").some(item => scopeMatches(host, item)))) {
      continue;
    }
    rules.push({ exception, selector, scope });
  }
  return rules;
}

function permissionURI(uri) {
  if (uri?.schemeIs("ws") || uri?.schemeIs("wss")) {
    return Services.io.newURI(uri.spec.replace(/^ws/i, "http"));
  }
  return uri;
}

/**
 * Parent-process storage and settings service for the document filter and
 * Shield Breaker. Content processes only receive the small, site-scoped
 * configuration returned by getConfiguration().
 */
class VaporFilterService {
  #initialized = false;
  #windows = new Set();
  #loadPromise = null;
  #elementRules = "";
  #overlayPhrases = [];
  #overlayMemory = {};
  #logs = [];
  #writeQueue = Promise.resolve();

  init(window) {
    this.#windows.add(window);
    window.addEventListener("unload", () => this.#windows.delete(window), {
      once: true,
    });
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    Services.prefs.addObserver(PREF_ENABLED, this);
    this.#loadPromise = this.reload();
  }

  observe(_subject, topic) {
    if (topic === "nsPref:changed") {
      for (const window of this.#windows) {
        window.dispatchEvent(new window.CustomEvent("vapor-filter-settings-changed"));
      }
    }
  }

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  }

  toggleGlobal() {
    Services.prefs.setBoolPref(PREF_ENABLED, !this.enabled);
  }

  async activateShieldBreaker(window = null) {
    const browserWindow = window || this.#windows.values().next().value;
    const browser = browserWindow?.gBrowser?.selectedBrowser;
    if (!browser) {
      return false;
    }
    try {
      browser.browsingContext.currentWindowGlobal
        .getActor("VaporFilter")
        .sendAsyncMessage("VaporFilter:Activate");
      return true;
    } catch {
      return false;
    }
  }

  getSitePermission(uri) {
    try {
      const principal = Services.scriptSecurityManager.createContentPrincipal(
        permissionURI(uri),
        {},
      );
      return Services.perms.testPermissionFromPrincipal(principal, FILTER_PERMISSION);
    } catch {
      return UNKNOWN_PERMISSION;
    }
  }

  setSitePermission(uri, enabled) {
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      permissionURI(uri),
      {},
    );
    Services.perms.addFromPrincipal(
      principal,
      FILTER_PERMISSION,
      enabled
        ? Ci.nsIPermissionManager.ALLOW_ACTION
        : Ci.nsIPermissionManager.DENY_ACTION,
    );
    for (const window of this.#windows) {
      window.dispatchEvent(new window.CustomEvent("vapor-filter-settings-changed"));
    }
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

    const elementPath = PathUtils.join(directory, ELEMENT_FILTERS);
    const phrasePath = PathUtils.join(directory, OVERLAY_PHRASES);
    const memoryPath = PathUtils.join(directory, OVERLAY_MEMORY);
    const logPath = PathUtils.join(directory, FILTER_LOG);

    if (!(await IOUtils.exists(elementPath))) {
      await this.#writeChromeText(elementPath, ELEMENT_FILTERS_URI);
    }
    if (!(await IOUtils.exists(phrasePath))) {
      await this.#writeChromeText(phrasePath, OVERLAY_PHRASES_URI);
    }
    if (!(await IOUtils.exists(memoryPath))) {
      await IOUtils.writeUTF8(memoryPath, "{}\n");
    }

    const [rules, phrases, memory, logs] = await Promise.all([
      IOUtils.readUTF8(elementPath).catch(() => ""),
      IOUtils.readUTF8(phrasePath).catch(() => ""),
      IOUtils.readUTF8(memoryPath).catch(() => "{}"),
      IOUtils.readUTF8(logPath).catch(() => "[]"),
    ]);
    this.#elementRules = rules;
    this.#overlayPhrases = phrases
      .split(/\r?\n/)
      .map(line => line.trim().toLowerCase())
      .filter(line => line && !line.startsWith("#") && !line.startsWith("!"));
    try {
      this.#overlayMemory = JSON.parse(memory) || {};
    } catch {
      this.#overlayMemory = {};
    }
    try {
      this.#logs = Array.isArray(JSON.parse(logs)) ? JSON.parse(logs) : [];
    } catch {
      this.#logs = [];
    }
    this.#loadPromise = null;
    return this.#elementRules;
  }

  async getConfiguration(host, uriSpec = "") {
    await this.#ensureLoaded();
    let sitePermission = UNKNOWN_PERMISSION;
    try {
      sitePermission = this.getSitePermission(Services.io.newURI(uriSpec || `https://${host}/`));
    } catch {}
    const enabled =
      sitePermission === Ci.nsIPermissionManager.ALLOW_ACTION ||
      (this.enabled && sitePermission !== Ci.nsIPermissionManager.DENY_ACTION);
    return {
      enabled,
      rules: parseElementRules(this.#elementRules, host),
      overlayPhrases: [...this.#overlayPhrases],
      overlayMemory: this.#overlayMemory[normalizeHost(host)] || null,
    };
  }

  async getElementFilterRules() {
    await this.#ensureLoaded();
    return this.#elementRules;
  }

  async setElementFilterRules(text) {
    const directory = PathUtils.join(PathUtils.profileDir, BLOCKLIST_DIRECTORY);
    await IOUtils.makeDirectory(directory, { createAncestors: true, ignoreExisting: true });
    const clean = String(text || "").replace(/^\uFEFF/, "");
    await IOUtils.writeUTF8(PathUtils.join(directory, ELEMENT_FILTERS), clean.endsWith("\n") ? clean : `${clean}\n`);
    await this.reload();
    return this.#elementRules;
  }

  async getOverlayPhrases() {
    await this.#ensureLoaded();
    return this.#overlayPhrases.join("\n");
  }

  async setOverlayPhrases(text) {
    const directory = PathUtils.join(PathUtils.profileDir, BLOCKLIST_DIRECTORY);
    await IOUtils.makeDirectory(directory, { createAncestors: true, ignoreExisting: true });
    const clean = String(text || "").replace(/^\uFEFF/, "");
    await IOUtils.writeUTF8(PathUtils.join(directory, OVERLAY_PHRASES), clean.endsWith("\n") ? clean : `${clean}\n`);
    await this.reload();
  }

  async rememberOverlay(host, selectors, bodyFixes = [], watchdogTypes = []) {
    await this.#ensureLoaded();
    const key = normalizeHost(host);
    if (!key || !Array.isArray(selectors) || !selectors.length) {
      return;
    }
    this.#overlayMemory[key] = {
      last_killed: new Date().toISOString(),
      selectors: [...new Set(selectors.filter(Boolean))].slice(0, 30),
      body_fixes: [...new Set(bodyFixes.filter(Boolean))].slice(0, 20),
      watchdog_types: [...new Set(watchdogTypes.filter(Boolean))].slice(0, 10),
    };
    await this.#writeJSON(OVERLAY_MEMORY, this.#overlayMemory);
  }

  async getOverlayMemory() {
    await this.#ensureLoaded();
    return structuredClone(this.#overlayMemory);
  }

  async clearOverlayMemory(host = "") {
    await this.#ensureLoaded();
    if (host) {
      delete this.#overlayMemory[normalizeHost(host)];
    } else {
      this.#overlayMemory = {};
    }
    await this.#writeJSON(OVERLAY_MEMORY, this.#overlayMemory);
  }

  async recordFilter(entry) {
    return this.#record({
      kind: "DOM Filter",
      time: new Date().toISOString(),
      ...entry,
    });
  }

  async recordOverlay(entry) {
    return this.#record({
      kind: "Shield Breaker",
      time: new Date().toISOString(),
      ...entry,
    });
  }

  async getActivityLog() {
    await this.#ensureLoaded();
    return structuredClone(this.#logs);
  }

  async clearActivityLog() {
    await this.#ensureLoaded();
    this.#logs = [];
    await this.#writeJSON(FILTER_LOG, this.#logs);
  }

  async #record(entry) {
    await this.#ensureLoaded();
    this.#logs.unshift(entry);
    this.#logs = this.#logs.slice(0, MAX_LOG_ENTRIES);
    await this.#writeJSON(FILTER_LOG, this.#logs);
  }

  async #writeJSON(name, value) {
    const directory = PathUtils.join(PathUtils.profileDir, BLOCKLIST_DIRECTORY);
    const path = PathUtils.join(directory, name);
    this.#writeQueue = this.#writeQueue
      .catch(() => {})
      .then(() => IOUtils.writeUTF8(path, `${JSON.stringify(value, null, 2)}\n`));
    return this.#writeQueue;
  }

  async #writeChromeText(path, uri) {
    const text = await new Promise((resolve, reject) => {
      const channel = NetUtil.newChannel({ uri, loadUsingSystemPrincipal: true });
      const chunks = [];
      channel.asyncOpen({
        QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
        onStartRequest() {},
        onDataAvailable(request, stream, _offset, count) {
          chunks.push(NetUtil.readInputStream(stream, count));
        },
        onStopRequest(_request, status) {
          Components.isSuccessCode(status) ? resolve(chunks.join("")) : reject(new Error(`Unable to read ${uri}`));
        },
      });
    });
    await IOUtils.writeUTF8(path, text);
  }
}

export const VaporFilter = new VaporFilterService();
export {
  PREF_ENABLED as VAPOR_FILTER_ENABLED_PREF,
  FILTER_PERMISSION as VAPOR_FILTER_PERMISSION,
  ELEMENT_FILTERS,
  OVERLAY_PHRASES,
  OVERLAY_MEMORY,
  FILTER_LOG,
};
