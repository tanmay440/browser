// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";
import { CustomizableUI } from "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs";

const PREF_ENABLED = "vapor.shield.enabled";
const PREF_CONSENT = "vapor.shield.block-consent-popups";
const PREF_MINERS = "vapor.shield.block-crypto-miners";
const SITE_PERMISSION = "vapor-shield";
const BLOCKLIST_DIRECTORY = "vapor-blocklists";
const DEFAULT_BLOCKLIST = "default.txt";
const USER_BLOCKLIST = "user.txt";
const DEFAULT_BLOCKLIST_URI = "chrome://vapor/content/default.txt";
const SITE_PERMISSION_UNKNOWN = 0;

const BLANK_PNG =
  "\x89PNG\x0d\x0a\x1a\x0a\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDATx\xdacd\xf8\x0f\x00\x01\x05\x01\x01'\x18\xe3f\x00\x00\x00\x00IEND\xaeB`\x82";

const EMPTY_RESPONSES = Object.freeze({
  script: {
    body: "",
    contentType: "application/javascript; charset=utf-8",
    finalURL: "chrome://vapor/content/blank.js",
  },
  stylesheet: {
    body: "",
    contentType: "text/css; charset=utf-8",
    finalURL: "chrome://vapor/content/blank.css",
  },
  image: {
    body: BLANK_PNG,
    contentType: "image/png",
    finalURL: "chrome://vapor/content/blank.png",
  },
  subdocument: {
    body: "<!doctype html><html><head></head><body></body></html>",
    contentType: "text/html; charset=utf-8",
    finalURL: "chrome://vapor/content/blank.html",
  },
  other: {
    body: "",
    contentType: "application/octet-stream",
    finalURL: "",
  },
});

const IMAGE_TYPES = [
  "TYPE_IMAGE",
  "TYPE_INTERNAL_IMAGE",
  "TYPE_INTERNAL_IMAGE_PRELOAD",
  "TYPE_INTERNAL_IMAGE_FAVICON",
];
const SCRIPT_TYPES = [
  "TYPE_SCRIPT",
  "TYPE_INTERNAL_SCRIPT",
  "TYPE_INTERNAL_SCRIPT_PRELOAD",
  "TYPE_INTERNAL_MODULE",
  "TYPE_INTERNAL_MODULE_PRELOAD",
  "TYPE_INTERNAL_WORKER_IMPORT_SCRIPTS",
  "TYPE_INTERNAL_WORKER_STATIC_MODULE",
];
const STYLESHEET_TYPES = [
  "TYPE_STYLESHEET",
  "TYPE_INTERNAL_STYLESHEET",
  "TYPE_INTERNAL_STYLESHEET_PRELOAD",
];
const SUBDOCUMENT_TYPES = [
  "TYPE_SUBDOCUMENT",
  "TYPE_INTERNAL_FRAME",
  "TYPE_INTERNAL_IFRAME",
  "TYPE_INTERNAL_FRAME_PRELOAD",
];

function isContentType(type, names) {
  return names.some((name) => Ci.nsIContentPolicy[name] === type);
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function wildcardRegex(value) {
  return new RegExp(value.split("*").map(escapeRegex).join(".*"), "i");
}

function normalizeHost(host) {
  return host.toLowerCase().replace(/^\.+|\.+$/g, "");
}

function permissionURI(uri) {
  if (uri?.schemeIs("ws") || uri?.schemeIs("wss")) {
    return Services.io.newURI(uri.spec.replace(/^ws/i, "http"));
  }
  return uri;
}

function hostMatches(host, ruleHost) {
  host = normalizeHost(host);
  ruleHost = normalizeHost(ruleHost);
  if (!host || !ruleHost) {
    return false;
  }
  if (ruleHost.includes("*")) {
    return wildcardRegex(ruleHost).test(host);
  }
  return host === ruleHost || host.endsWith(`.${ruleHost}`);
}

/**
 * The Shield deliberately implements a small, auditable ABP subset. It is
 * not intended to be a replacement for uBlock Origin's full parser.
 */
class ShieldRules {
  #domainRules = [];
  #urlRules = [];
  #exceptions = [];

  load(...texts) {
    this.#domainRules = [];
    this.#urlRules = [];
    this.#exceptions = [];

    for (const text of texts) {
      for (const original of text.split(/\r?\n/)) {
        const line = original.trim();
        if (!line || line.startsWith("#") || line.startsWith("!")) {
          continue;
        }

        const exception = line.startsWith("@@");
        const rule = (exception ? line.slice(2) : line).trim();
        if (!rule) {
          continue;
        }

        const entry = this.#compile(rule);
        if (!entry) {
          continue;
        }
        (exception
          ? this.#exceptions
          : entry.domain
            ? this.#domainRules
            : this.#urlRules
        ).push(entry);
      }
    }
  }

  get size() {
    return this.#domainRules.length + this.#urlRules.length;
  }

  matches(spec) {
    let uri;
    try {
      uri = Services.io.newURI(spec);
    } catch {
      return false;
    }

    const host = normalizeHost(uri.host || "");
    if (!host || ["localhost", "127.0.0.1", "::1"].includes(host)) {
      return false;
    }

    if (this.#exceptions.some((rule) => rule.matches(spec, host))) {
      return false;
    }
    return (
      this.#domainRules.some((rule) => rule.matches(spec, host)) ||
      this.#urlRules.some((rule) => rule.matches(spec, host))
    );
  }

  #compile(rule) {
    // Ignore cosmetic and unsupported option syntax in this intentionally
    // small network-only parser. The supported syntax is documented in SPEC.
    const withoutOptions = rule.split("$")[0];
    if (!withoutOptions) {
      return null;
    }

    if (withoutOptions.startsWith("||")) {
      const body = withoutOptions.slice(2);
      const slash = body.search(/[\\/\^]/);
      const hostPart = slash === -1 ? body : body.slice(0, slash);
      const pathPart = slash === -1 ? "" : body.slice(slash);
      if (!hostPart) {
        return null;
      }
      return {
        domain: !pathPart,
        matches: (spec, host) => {
          if (hostPart.startsWith("*.")) {
            if (!hostMatches(host, hostPart.slice(2))) {
              return false;
            }
          } else if (!hostMatches(host, hostPart)) {
            return false;
          }
          if (!pathPart) {
            return true;
          }
          return wildcardRegex(pathPart.replace(/\^/g, "")).test(spec);
        },
      };
    }

    // A bare hostname blocks the host and all of its subdomains.
    if (/^[a-z0-9_*.-]+$/i.test(withoutOptions)) {
      return {
        domain: !withoutOptions.includes("*") && withoutOptions.includes("."),
        matches: (_spec, host) => hostMatches(host, withoutOptions),
      };
    }

    const pattern = withoutOptions
      .replace(/^\|\|/, "")
      .replace(/^\|/, "")
      .replace(/\|$/, "");
    return {
      domain: false,
      matches: (spec) => wildcardRegex(pattern).test(spec),
    };
  }
}

function getResponseForChannel(channel, spec) {
  const loadInfo = channel?.loadInfo;
  const type =
    loadInfo?.externalContentPolicyType ?? loadInfo?.contentPolicyType;
  if (
    isContentType(type, IMAGE_TYPES) ||
    /\.(?:png|jpe?g|gif|webp|svg|ico)(?:[?#]|$)/i.test(spec)
  ) {
    return EMPTY_RESPONSES.image;
  }
  if (
    isContentType(type, SCRIPT_TYPES) ||
    /\.(?:m?js|json)(?:[?#]|$)/i.test(spec)
  ) {
    return EMPTY_RESPONSES.script;
  }
  if (isContentType(type, STYLESHEET_TYPES) || /\.css(?:[?#]|$)/i.test(spec)) {
    return EMPTY_RESPONSES.stylesheet;
  }
  if (
    isContentType(type, SUBDOCUMENT_TYPES) ||
    /(?:frame|iframe|embed|adframe)/i.test(spec)
  ) {
    return EMPTY_RESPONSES.subdocument;
  }
  return EMPTY_RESPONSES.other;
}

function makeByteString(bytes) {
  if (typeof bytes === "string") {
    return bytes;
  }
  return String.fromCharCode(...bytes);
}

function makeStream(body) {
  const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
    Ci.nsIStringInputStream,
  );
  stream.setByteStringData(makeByteString(body));
  return stream;
}

export class VaporShieldService {
  #initialized = false;
  #windows = new Set();
  #wrappedChannels = new WeakSet();
  #rules = new ShieldRules();
  #loadPromise = null;
  #blockedCount = 0;

  init(window) {
    this.#windows.add(window);
    window.addEventListener("unload", () => this.uninit(window), {
      once: true,
    });
    if (!this.#initialized) {
      this.#initialized = true;
      Services.obs.addObserver(this, "http-on-modify-request");
      Services.prefs.addObserver(PREF_ENABLED, this);
      Services.prefs.addObserver(PREF_CONSENT, this);
      Services.prefs.addObserver(PREF_MINERS, this);
      this.#loadPromise = this.reload();
    }
    this.#registerWidget();
    this.#updateWidget(window);
  }

  uninit(window) {
    this.#windows.delete(window);
  }

  observe(subject, topic) {
    if (topic === "http-on-modify-request") {
      this.#prepareChannel(subject);
    }
    if (topic === "nsPref:changed") {
      for (const window of this.#windows) {
        this.#updateWidget(window);
      }
    }
  }

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  }

  get blockConsentPopups() {
    return Services.prefs.getBoolPref(PREF_CONSENT, true);
  }

  get blockCryptoMiners() {
    return Services.prefs.getBoolPref(PREF_MINERS, true);
  }

  toggleGlobal() {
    Services.prefs.setBoolPref(PREF_ENABLED, !this.enabled);
    for (const window of this.#windows) {
      this.#updateWidget(window);
    }
  }

  get blockCount() {
    return this.#blockedCount;
  }

  get ruleCount() {
    return this.#rules.size;
  }

  async reload() {
    const directory = PathUtils.join(PathUtils.profileDir, BLOCKLIST_DIRECTORY);
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
    });

    const defaultPath = PathUtils.join(directory, DEFAULT_BLOCKLIST);
    const userPath = PathUtils.join(directory, USER_BLOCKLIST);
    if (!(await IOUtils.exists(defaultPath))) {
      const shipped = await this.#readChromeText(DEFAULT_BLOCKLIST_URI);
      await IOUtils.writeUTF8(defaultPath, shipped);
    }
    if (!(await IOUtils.exists(userPath))) {
      await IOUtils.writeUTF8(userPath, "");
    }

    const [defaultText, userText] = await Promise.all([
      IOUtils.readUTF8(defaultPath).catch(() => ""),
      IOUtils.readUTF8(userPath).catch(() => ""),
    ]);
    this.#rules.load(defaultText, userText);
    this.#loadPromise = null;
    for (const window of this.#windows) {
      this.#updateWidget(window);
    }
    return this.#rules.size;
  }

  async importUserRules(text) {
    const directory = PathUtils.join(PathUtils.profileDir, BLOCKLIST_DIRECTORY);
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const path = PathUtils.join(directory, USER_BLOCKLIST);
    await IOUtils.writeUTF8(path, text.replace(/^\uFEFF/, ""));
    await this.reload();
  }

  async resetUserRules() {
    await this.importUserRules("");
  }

  async getUserRules() {
    const path = PathUtils.join(
      PathUtils.profileDir,
      BLOCKLIST_DIRECTORY,
      USER_BLOCKLIST,
    );
    return IOUtils.readUTF8(path).catch(() => "");
  }

  async getAllRules() {
    const directory = PathUtils.join(PathUtils.profileDir, BLOCKLIST_DIRECTORY);
    const [defaults, user] = await Promise.all([
      IOUtils.readUTF8(PathUtils.join(directory, DEFAULT_BLOCKLIST)).catch(
        () => "",
      ),
      IOUtils.readUTF8(PathUtils.join(directory, USER_BLOCKLIST)).catch(
        () => "",
      ),
    ]);
    return `${defaults}${defaults && user ? "\n" : ""}${user}`;
  }

  getSitePermission(uri) {
    try {
      const principal = Services.scriptSecurityManager.createContentPrincipal(
        permissionURI(uri),
        {},
      );
      return Services.perms.testPermissionFromPrincipal(
        principal,
        SITE_PERMISSION,
      );
    } catch {
      return SITE_PERMISSION_UNKNOWN;
    }
  }

  setSitePermission(uri, enabled) {
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      permissionURI(uri),
      {},
    );
    Services.perms.addFromPrincipal(
      principal,
      SITE_PERMISSION,
      enabled
        ? Ci.nsIPermissionManager.ALLOW_ACTION
        : Ci.nsIPermissionManager.DENY_ACTION,
    );
    for (const window of this.#windows) {
      window.dispatchEvent(
        new window.CustomEvent("vapor-shield-site-permission-changed"),
      );
    }
  }

  #getRequestSitePermission(channel, fallbackURI) {
    const principal =
      channel?.loadInfo?.topLevelPrincipal ||
      channel?.loadInfo?.loadingPrincipal;
    if (principal && !principal.isSystemPrincipal) {
      try {
        return Services.perms.testPermissionFromPrincipal(
          principal,
          SITE_PERMISSION,
        );
      } catch {}
    }
    return this.getSitePermission(fallbackURI);
  }

  shouldBlock(uriOrSpec, channel = null) {
    const spec = typeof uriOrSpec === "string" ? uriOrSpec : uriOrSpec?.spec;
    if (!spec || !/^(?:https?|wss?):/i.test(spec)) {
      return false;
    }

    let sitePermission = SITE_PERMISSION_UNKNOWN;
    try {
      const uri =
        typeof uriOrSpec === "string" ? Services.io.newURI(spec) : uriOrSpec;
      sitePermission = this.#getRequestSitePermission(channel, uri);
    } catch {}
    if (sitePermission === Ci.nsIPermissionManager.DENY_ACTION) {
      return false;
    }
    // An explicit per-site ALLOW is also a force-enable exception. This is
    // checked before the global switch so a user can enable Shield for one
    // site while keeping it off everywhere else.
    if (
      !this.enabled &&
      sitePermission !== Ci.nsIPermissionManager.ALLOW_ACTION
    ) {
      return false;
    }
    if (!this.#rules.matches(spec)) {
      return false;
    }

    // These controls are intentionally narrow switches over the local list.
    // The URL classifier keeps the optional categories local and deterministic;
    // disabling either preference leaves the matching category unblocked.
    if (
      !this.blockConsentPopups &&
      /consent|cookiebot|onetrust|trustarc/i.test(spec)
    ) {
      return false;
    }
    if (
      !this.blockCryptoMiners &&
      /coinhive|cryptominer|mining|miner/i.test(spec)
    ) {
      return false;
    }
    return true;
  }

  #prepareChannel(subject) {
    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIChannel);
    } catch {
      return;
    }
    const spec = channel.URI?.spec || "";
    if (
      !/^(?:https?|ws|wss):/i.test(spec) ||
      this.#wrappedChannels.has(channel)
    ) {
      return;
    }

    // Rule loading is asynchronous. Until it completes, leave requests alone;
    // this avoids blocking navigation on profile I/O during browser startup.
    if (!this.#loadPromise && !this.shouldBlock(spec, channel)) {
      return;
    }
    if (this.#loadPromise) {
      this.#loadPromise
        .then(() => this.#prepareChannelAfterLoad(channel))
        .catch(console.error);
      return;
    }
    this.#prepareChannelAfterLoad(channel);
  }

  #prepareChannelAfterLoad(channel) {
    const spec = channel.URI?.spec || "";
    if (
      !this.shouldBlock(spec, channel) ||
      this.#wrappedChannels.has(channel)
    ) {
      return;
    }

    const originalCallbacks = channel.notificationCallbacks;
    let originalController = null;
    try {
      originalController = originalCallbacks?.getInterface(
        Ci.nsINetworkInterceptController,
      );
    } catch {}

    const wrapper = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIInterfaceRequestor",
        "nsINetworkInterceptController",
      ]),
      getInterface: (iid) => {
        if (iid.equals(Ci.nsINetworkInterceptController)) {
          return wrapper;
        }
        return originalCallbacks?.getInterface(iid);
      },
      shouldPrepareForIntercept: (uri, interceptedChannel) => {
        const requestSpec = uri?.spec || spec;
        if (this.shouldBlock(requestSpec, interceptedChannel?.channel)) {
          return true;
        }
        return (
          originalController?.shouldPrepareForIntercept(
            uri,
            interceptedChannel,
          ) ?? false
        );
      },
      channelIntercepted: (interceptedChannel) => {
        const requestSpec =
          interceptedChannel.secureUpgradedChannelURI?.spec || spec;
        if (this.shouldBlock(requestSpec, interceptedChannel?.channel)) {
          this.#synthesize(interceptedChannel, requestSpec).catch((error) => {
            console.error("Vapor Shield synthesis failed", error);
            try {
              interceptedChannel.resetInterception(false);
            } catch {}
          });
          return;
        }
        if (originalController) {
          originalController.channelIntercepted(interceptedChannel);
        } else {
          interceptedChannel.resetInterception(false);
        }
      },
    };

    try {
      channel.notificationCallbacks = wrapper;
      this.#wrappedChannels.add(channel);
    } catch (error) {
      console.error("Vapor Shield could not wrap channel", error);
    }
  }

  async #synthesize(interceptedChannel, spec) {
    const response = getResponseForChannel(interceptedChannel.channel, spec);
    const body = response.body;
    const byteLength = body.length;
    const stream = makeStream(body);
    interceptedChannel.synthesizeStatus(200, "OK");
    interceptedChannel.synthesizeHeader("Content-Type", response.contentType);
    interceptedChannel.synthesizeHeader("Content-Length", String(byteLength));
    interceptedChannel.synthesizeHeader("Cache-Control", "no-store");
    interceptedChannel.synthesizeHeader("X-Vapor-Shield", "blank-response");
    interceptedChannel.startSynthesizedResponse(
      stream,
      null,
      null,
      response.finalURL || spec,
      false,
    );
    interceptedChannel.finishSynthesizedResponse();
    this.#blockedCount++;
    for (const window of this.#windows) {
      window.dispatchEvent(
        new window.CustomEvent("vapor-shield-blocked", {
          detail: { spec, type: response.contentType },
        }),
      );
      this.#updateWidget(window);
    }
  }

  #registerWidget() {
    try {
      if (CustomizableUI.getWidget("vapor-shield-button")) {
        return;
      }
      CustomizableUI.createWidget({
        id: "vapor-shield-button",
        type: "button",
        defaultArea: CustomizableUI.AREA_NAVBAR,
        removable: true,
        label: "Vapor Shield",
        tooltiptext: "Toggle Vapor Shield",
        onCommand: () => this.toggleGlobal(),
        onCreated: (node) => {
          node.classList.add("vapor-shield-toolbarbutton");
          return node;
        },
      });
    } catch (error) {
      // CustomizableUI may not be initialized in the first preloaded script.
      // The next browser window retries registration.
      console.error("Vapor Shield toolbar registration failed", error);
    }
  }

  #updateWidget(window) {
    const button = window.document.getElementById("vapor-shield-button");
    if (!button) {
      return;
    }
    button.setAttribute("aria-pressed", this.enabled);
    button.setAttribute("shield-enabled", this.enabled);
    button.setAttribute(
      "tooltiptext",
      `Vapor Shield: ${this.enabled ? "On" : "Off"}`,
    );
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
        onDataAvailable(request, stream, _offset, count) {
          chunks.push(NetUtil.readInputStream(stream, count));
        },
        onStopRequest(_request, status) {
          if (!Components.isSuccessCode(status)) {
            reject(new Error(`Unable to read ${uri}: ${status}`));
          } else {
            resolve(chunks.join(""));
          }
        },
      });
    });
  }
}

export const VaporShield = new VaporShieldService();
export { PREF_ENABLED, PREF_CONSENT, PREF_MINERS, SITE_PERMISSION };
