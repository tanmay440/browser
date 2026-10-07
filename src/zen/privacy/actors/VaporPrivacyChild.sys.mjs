// This Source Code Form is subject to the terms of the Mozilla Public
// License, Version 2.0. If a copy of the MPL was not distributed with this
// file, see http://mozilla.org/MPL/2.0/.

const FILTERED_ATTRIBUTE = "data-vapor-speculative-blocked";
const SAFE_FONTS = new Set([
  "arial",
  "helvetica",
  "times new roman",
  "courier new",
  "georgia",
  "verdana",
  "tahoma",
  "trebuchet ms",
  "serif",
  "sans-serif",
  "monospace",
]);
const INVISIBLE_COPY_CHARS = /[\u200B\u200C\u200D\uFEFF\u202A-\u202E\u2060\u2061\u2062\u2063\u2064\u2066\u2067\u2068\u2069\uFE00-\uFE0F\u{E0000}-\u{E007F}]/gu;
const GENERIC_RENDERER = "Generic WebGL Renderer";
const REFLEX_TRACKING_COOKIES = [
  /^_ga(?:$|_)/i, /^_gid$/i, /^_gat(?:$|_)/i, /^_fbp$/i, /^_fbc$/i,
  /^_gcl(?:$|_)/i, /^_tt/i, /^_uetsid$/i, /^_uetvid$/i, /^fr$/i,
  /^ide$/i, /^test_cookie$/i, /^nid$/i, /^consent$/i, /^_pk_/i,
  /^__hstc$/i, /^__hssc$/i, /^__hssrc$/i, /^hubspotutk$/i, /^intercom-id/i,
  /^ajs_/i, /^amplitude_/i, /^mp_/i, /^_mkto_/i, /^pardot/i,
  /^drift_/i, /^optimizely/i,
];
const REFLEX_REJECT_WORDS = /(?:reject|decline|deny|refuse|essential|necessary|no thanks|nur notwendige|ablehnen|refuser|rechazar|rifiuta|weigeren|odrzuć)/i;
const REFLEX_CUSTOMIZE_WORDS = /(?:customi[sz]e|preferences?|settings|manage|options|einstellungen|paramètres|preferencias|impostazioni|voorkeuren|ustawienia)/i;
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function sanitizeClipboardText(value) {
  return String(value).replace(INVISIBLE_COPY_CHARS, "");
}

function safeDefine(target, property, descriptor) {
  try {
    Object.defineProperty(target, property, {
      ...descriptor,
      configurable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function originOf(value, base) {
  try {
    return new URL(value, base).origin;
  } catch {
    return "";
  }
}

export class VaporPrivacyChild extends JSWindowActorChild {
  #installed = false;
  #fingerprintingInstalled = false;
  #enabled = true;
  #extended = true;
  #fingerprintSeed = "00000000";
  #deviceSeed = "session";
  #timezone = "UTC";
  #language = "en-US";
  #uaOverride = false;
  #clipboardEnabled = true;
  #clipboardPermission = 0;
  #clipboardRequest = null;
  #scriptEnabled = true;
  #scriptState = "first-party";
  #observer = null;
  #scriptHandler = null;
  #copyHandler = null;
  #deviceIds = new Map();
  #fontProxy = null;
  #reflex = {
    enabled: true,
    mode: "aggressive",
    preConsent: true,
    languages: ["en", "de", "fr", "es", "it", "nl", "pt", "pl"],
    phrases: {},
    useCMPAPI: true,
    failureNotifications: true,
  };
  #reflexHandled = false;

  receiveMessage(message) {
    if (message.name === "VaporPrivacy:ScriptState") {
      this.#scriptState = message.data?.state || this.#scriptState;
    } else if (message.name === "VaporBroom:RunReflex") {
      this.#reflexHandled = false;
      this.#runReflexSweep("manual-trigger");
    }
  }

  handleEvent(event) {
    if (event.type === "DOMDocElementInserted") {
      this.#install();
      return;
    }
    if (event.type === "keydown" && event.shiftKey && event.key === "F5") {
      this.sendQuery("VaporPrivacy:TemporaryScripts", {
        host: this.document.location?.hostname || "",
      }).catch(() => {});
      this.#scriptState = "allow-all";
      this.#log("Script Blocking", "temporary-allow");
    }
  }

  didDestroy() {
    this.#observer?.disconnect();
    if (this.#scriptHandler) {
      this.document?.removeEventListener("beforescriptexecute", this.#scriptHandler, true);
    }
    if (this.#copyHandler) {
      this.document?.removeEventListener("copy", this.#copyHandler, true);
    }
  }

  #install() {
    if (this.#installed || !this.document?.documentElement) {
      return;
    }
    this.#installed = true;
    this.#installSpeculativeObserver();
    this.#installScriptGate();
    this.#installClipboard();
    this.#installReflex();
    this.sendQuery("VaporPrivacy:GetConfig", {
      host: this.document.location?.hostname || "",
      href: this.document.location?.href || "",
    }).then(config => {
      this.#enabled = config?.speculativeLoadingBlocked !== false;
      this.#extended = config?.extendedProtections !== false;
      this.#fingerprintSeed = config?.siteSeed || this.#fingerprintSeed;
      this.#deviceSeed = config?.deviceSeed || this.#deviceSeed;
      this.#timezone = config?.timezone || "UTC";
      this.#language = config?.language || "en-US";
      this.#uaOverride = config?.uaOverride === true;
      this.#clipboardEnabled = config?.clipboardEnabled !== false;
      this.#clipboardPermission = config?.clipboardPermission || 0;
      this.#scriptEnabled = config?.scriptEnabled !== false;
      this.#scriptState = config?.scriptState || "first-party";
      this.#reflex = config?.reflex || this.#reflex;
      if (config?.fingerprintingEnabled !== false && !this.#fingerprintingInstalled) {
        this.#installFingerprinting();
        this.#fingerprintingInstalled = true;
      }
      this.#applyLanguageAndTimezone();
    }).catch(() => {});
  }

  #installReflex() {
    const window = this.document.defaultView;
    if (window.top !== window) {
      return;
    }
    this.#deletePreConsentCookies();
    this.document.addEventListener(
      "DOMContentLoaded",
      () => window.setTimeout(() => this.#runReflexSweep("dom-content-loaded"), 500),
      { once: true, capture: true },
    );
    window.addEventListener(
      "load",
      () => window.setTimeout(() => this.#runReflexSweep("window-load"), 1_000),
      { once: true },
    );
    window.setTimeout(() => this.#runReflexSweep("final-sweep"), 5_000);
  }

  #isTrackingCookie(name) {
    return name.toLowerCase() !== "__cf_bm" && REFLEX_TRACKING_COOKIES.some(pattern => pattern.test(name));
  }

  #deletePreConsentCookies() {
    if (!this.#reflex.enabled || !this.#reflex.preConsent || this.#reflex.mode === "manual") {
      return;
    }
    const cookieNames = this.document.cookie
      .split(";")
      .map(cookie => cookie.split("=", 1)[0].trim())
      .filter(name => name && this.#isTrackingCookie(name));
    const host = this.document.location.hostname;
    for (const name of cookieNames) {
      this.document.cookie = `${name}=; Max-Age=0; path=/`;
      if (host.includes(".")) {
        this.document.cookie = `${name}=; Max-Age=0; path=/; domain=${host}`;
      }
    }
    this.sendQuery("VaporBroom:DeleteTrackingCookies", { host }).catch(() => {});
    if (cookieNames.length) {
      this.#logConsent("pre-consent-cookies-deleted", { count: cookieNames.length });
    }
  }

  #consentPhrases() {
    const phrases = [];
    for (const language of this.#reflex.languages || []) {
      for (const phrase of this.#reflex.phrases?.[language] || []) {
        phrases.push(String(phrase).toLowerCase());
      }
    }
    return phrases.length ? phrases : ["accept all", "reject all", "cookie preferences", "we use cookies", "consent"];
  }

  #bannerText(element) {
    return (element?.innerText || element?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 4_000).toLowerCase();
  }

  #hasConsentText(element) {
    const text = this.#bannerText(element);
    return this.#consentPhrases().some(phrase => phrase && text.includes(phrase));
  }

  #hasConsentPosition(element) {
    try {
      const style = this.document.defaultView.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const zIndex = Number.parseInt(style.zIndex, 10);
      const edge = rect.top <= 12 || rect.bottom >= this.document.defaultView.innerHeight - 12;
      return ["fixed", "sticky"].includes(style.position) || (edge && zIndex >= 100);
    } catch {
      return false;
    }
  }

  #findConsentBanner() {
    const selectors = [
      "#onetrust-banner-sdk", "#CybotCookiebotDialog", "#cookie-notice",
      "#gdpr-cookie-notice", "#sp-cc", "#usercentrics-root", "#truste-consent-track",
      ".cc-window", "#hs-eu-cookie-confirmation", "#tarteaucitronRoot",
      "[id*='cookie' i]", "[class*='cookie' i]", "[id*='consent' i]", "[class*='consent' i]",
    ];
    const candidates = [];
    for (const selector of selectors) {
      try {
        for (const element of this.document.querySelectorAll(selector)) {
          if (!candidates.includes(element)) candidates.push(element);
          if (candidates.length >= 300) break;
        }
      } catch {}
      if (candidates.length >= 300) break;
    }
    if (candidates.length < 300) {
      for (const element of this.document.querySelectorAll("body > div, body > section, [role='dialog'], dialog")) {
        if (!candidates.includes(element)) candidates.push(element);
        if (candidates.length >= 300) break;
      }
    }
    const cmpObject = ["__cmp", "__tcfapi", "__uspapi", "OnetrustActiveGroups", "Cookiebot", "gdprframework", "consentManager"]
      .some(name => this.document.defaultView[name]);
    for (const element of candidates) {
      const idOrClass = `${element.id || ""} ${element.className || ""}`.toLowerCase();
      const domPattern = /cookie|consent|gdpr|onetrust|cookiebot|usercentrics|tarteaucitron/.test(idOrClass);
      const score = Number(cmpObject) + Number(domPattern) + Number(this.#hasConsentText(element)) + Number(this.#hasConsentPosition(element));
      if (score >= 2) return element;
    }
    return null;
  }

  #actionText(element) {
    return `${element.innerText || element.textContent || ""} ${element.getAttribute?.("aria-label") || ""} ${element.value || ""}`
      .replace(/\\s+/g, " ").trim().toLowerCase();
  }

  #findAction(root, expression) {
    const elements = root?.querySelectorAll?.("button, [role='button'], input[type='button'], input[type='submit'], a") || [];
    return [...elements].find(element => expression.test(this.#actionText(element)) && !element.disabled);
  }

  #callCMPAPI() {
    if (!this.#reflex.useCMPAPI) return false;
    const window = this.document.defaultView;
    try {
      if (typeof window.__tcfapi === "function") {
        window.__tcfapi("rejectAll", 2, () => {});
        this.#logConsent("tcf-v2-reject-all");
        return true;
      }
      if (typeof window.OneTrust?.RejectAll === "function") {
        window.OneTrust.RejectAll();
        this.#logConsent("onetrust-reject-all");
        return true;
      }
      if (typeof window.Cookiebot?.decline === "function") {
        window.Cookiebot.decline();
        this.#logConsent("cookiebot-decline");
        return true;
      }
      if (typeof window.CookieConsent?.denyAll === "function") {
        window.CookieConsent.denyAll();
        this.#logConsent("cookieconsent-deny-all");
        return true;
      }
    } catch (error) {
      this.#logConsent("cmp-api-failed", { error: String(error) });
    }
    return false;
  }

  async #customizeAndReject(root) {
    const customize = this.#findAction(root, REFLEX_CUSTOMIZE_WORDS);
    if (customize) {
      customize.click();
      await new Promise(resolve => this.document.defaultView.setTimeout(resolve, 80));
    }
    const checkboxes = root.querySelectorAll?.("input[type='checkbox'], [role='checkbox']") || [];
    let changed = false;
    for (const checkbox of checkboxes) {
      const label = this.#actionText(checkbox.closest("label, li, div") || checkbox);
      if (!/necessary|essential|required|strictly|nécessaire|notwendig|necesari/.test(label)) {
        if (checkbox.checked || checkbox.getAttribute("aria-checked") === "true") {
          checkbox.click();
          changed = true;
        }
      }
    }
    const save = this.#findAction(root, /save|confirm|submit|continue|apply|done|save preferences|speichern|enregistrer|guardar|salvar/i);
    if (save) {
      save.click();
      return true;
    }
    return changed;
  }

  #hideBanner(root) {
    if (!root) return;
    root.setAttribute("data-vapor-reflex-hidden", "true");
    root.style.setProperty("display", "none", "important");
    root.style.setProperty("visibility", "hidden", "important");
    root.setAttribute("aria-hidden", "true");
  }

  async #runReflexSweep(phase) {
    if (!this.#reflex.enabled) return;
    if (phase === "final-sweep") this.#deletePreConsentCookies();
    if (this.#reflexHandled) return;
    const banner = this.#findConsentBanner();
    if (!banner) return;
    this.#reflexHandled = true;
    const clear = () => this.document.defaultView.setTimeout(() => {
      this.sendQuery("VaporBroom:DeleteTrackingCookies", {
        host: this.document.location.hostname,
      }).catch(() => {});
    }, 500);
    const manualTrigger = phase === "manual-trigger";
    if (this.#reflex.mode === "manual" && !manualTrigger) {
      this.#hideBanner(banner);
      this.#logConsent("manual-banner-hidden", { phase });
      return;
    }
    const reject = this.#findAction(banner, REFLEX_REJECT_WORDS);
    if (this.#reflex.mode === "polite" && !reject) {
      this.#hideBanner(banner);
      this.#logConsent("polite-banner-hidden", { phase });
      return;
    }
    if (this.#callCMPAPI()) {
      this.#hideBanner(banner);
      clear();
      return;
    }
    if (reject) {
      reject.click();
      this.#hideBanner(banner);
      this.#logConsent("reject-button-clicked", { phase });
      clear();
      return;
    }
    if ((this.#reflex.mode === "aggressive" || manualTrigger) && await this.#customizeAndReject(banner)) {
      this.#hideBanner(banner);
      this.#logConsent("customize-rejected", { phase });
      clear();
      return;
    }
    this.#hideBanner(banner);
    this.#logConsent("fallback-banner-hidden", { phase, warning: true });
    this.sendQuery("VaporBroom:ConsentFailure", { host: this.document.location.hostname }).catch(() => {});
    clear();
  }

  #logConsent(action, detail = {}) {
    this.sendQuery("VaporBroom:ConsentAction", {
      action,
      host: this.document.location.hostname,
      ...detail,
    }).catch(() => {});
  }

  #installSpeculativeObserver() {
    const NativeMutationObserver = this.document.defaultView.MutationObserver;
    if (typeof NativeMutationObserver !== "function") {
      return;
    }
    this.#observer = new NativeMutationObserver(records => {
      if (!this.#enabled) {
        return;
      }
      for (const record of records) {
        for (const node of record.addedNodes) {
          this.#scanLinks(node);
        }
      }
    });
    // Speculative loading protection is intentionally childList-only.
    this.#observer.observe(this.document, { childList: true, subtree: true });
    this.document.addEventListener("DOMContentLoaded", () => this.#scanLinks(this.document), {
      once: true,
      capture: true,
    });
  }

  #scanLinks(root) {
    if (!this.#enabled || !root) {
      return;
    }
    if (root.nodeType === this.document.defaultView.Node.ELEMENT_NODE) {
      this.#inspectLink(root);
    }
    for (const link of root.querySelectorAll?.("link") || []) {
      this.#inspectLink(link);
    }
  }

  #inspectLink(element) {
    if (element.localName !== "link" || element.hasAttribute(FILTERED_ATTRIBUTE)) {
      return;
    }
    const rel = (element.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    const href = element.getAttribute("href");
    if (!href) {
      return;
    }
    const destination = originOf(href, this.document.location.href);
    const speculative = rel.includes("prefetch") || rel.includes("prerender");
    const crossOriginPreload = rel.includes("preload") && destination !== this.document.location.origin;
    if (!speculative && !crossOriginPreload) {
      return;
    }
    element.setAttribute(FILTERED_ATTRIBUTE, speculative ? "prefetch" : "cross-origin-preload");
    element.removeAttribute("href");
    this.#log("Speculative Loading", speculative ? "dom-prefetch-blocked" : "dom-cross-origin-preload-blocked", { url: href });
  }

  #installScriptGate() {
    this.#scriptHandler = event => {
      if (!this.#scriptEnabled || this.#scriptState === "allow-all") {
        return;
      }
      const script = event.target;
      if (!(script instanceof this.document.defaultView.HTMLScriptElement)) {
        return;
      }
      const source = script.src || "";
      const thirdParty = source && originOf(source, this.document.location.href) !== this.document.location.origin;
      if (this.#scriptState === "block-all" || (this.#scriptState === "first-party" && thirdParty)) {
        event.preventDefault();
        event.stopPropagation();
        this.#log("Script Blocking", "blocked", { src: source || "inline" });
      }
    };
    this.document.addEventListener("beforescriptexecute", this.#scriptHandler, true);
  }

  #installFingerprinting() {
    const window = this.document.defaultView;
    const navigator = window.navigator;
    const seed = this.#fingerprintSeed;
    const noise = index => {
      let value = Number.parseInt(seed.slice(0, 8), 16) || 1;
      value ^= index + 0x9e3779b9;
      value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
      return ((value ^ (value >>> 16)) & 3) - 1;
    };

    this.#patchCanvas(window, noise);
    this.#patchWebGL(window);
    if (this.#extended) {
      this.#patchAudio(window, noise);
    }
    this.#patchFonts(window);
    this.#patchNavigator(window, navigator);
    this.#patchScreen(window);
    this.#patchTimeAndLanguage(window);
    this.#patchPerformance(window);
    this.#patchSharedArrayBuffer(window);
  }

  #patchCanvas(window, noise) {
    const canvasPrototype = window.HTMLCanvasElement?.prototype;
    const contextPrototype = window.CanvasRenderingContext2D?.prototype;
    if (!canvasPrototype || !contextPrototype) {
      return;
    }
    const nativeGetImageData = contextPrototype.getImageData;
    const nativePutImageData = contextPrototype.putImageData;
    const nativeToDataURL = canvasPrototype.toDataURL;
    const nativeToBlob = canvasPrototype.toBlob;
    if (nativeGetImageData && !contextPrototype.getImageData.__vaporPrivacy) {
      const getImageData = function (...args) {
        const image = nativeGetImageData.apply(this, args);
        for (let index = 0; index < image.data.length; index += 4) {
          const delta = noise(index);
          image.data[index] = Math.max(0, Math.min(255, image.data[index] + delta));
          image.data[index + 1] = Math.max(0, Math.min(255, image.data[index + 1] - delta));
        }
        return image;
      };
      getImageData.__vaporPrivacy = true;
      safeDefine(contextPrototype, "getImageData", { value: getImageData, writable: true });
      const toDataURL = function (...args) {
        let context;
        let original;
        try {
          context = this.getContext("2d");
          original = context && nativeGetImageData.call(context, 0, 0, this.width, this.height);
          if (context && original) {
            const noisy = nativeGetImageData.call(context, 0, 0, this.width, this.height);
            for (let index = 0; index < noisy.data.length; index += 4) {
              const delta = noise(index);
              noisy.data[index] = Math.max(0, Math.min(255, noisy.data[index] + delta));
              noisy.data[index + 1] = Math.max(0, Math.min(255, noisy.data[index + 1] - delta));
            }
            nativePutImageData.call(context, noisy, 0, 0);
          }
          return nativeToDataURL.apply(this, args);
        } finally {
          if (context && original) {
            nativePutImageData.call(context, original, 0, 0);
          }
        }
      };
      toDataURL.__vaporPrivacy = true;
      safeDefine(canvasPrototype, "toDataURL", { value: toDataURL, writable: true });
      if (nativeToBlob) {
        const toBlob = function (callback, ...args) {
          const dataURL = toDataURL.call(this, "image/png");
          const bytes = atob(dataURL.split(",")[1] || "");
          const blob = new Blob([Uint8Array.from(bytes, character => character.charCodeAt(0))], { type: "image/png" });
          callback(blob);
          void args;
        };
        toBlob.__vaporPrivacy = true;
        safeDefine(canvasPrototype, "toBlob", { value: toBlob, writable: true });
      }
    }
  }

  #patchWebGL(window) {
    for (const prototype of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean)) {
      const nativeParameter = prototype.getParameter;
      const nativeExtension = prototype.getExtension;
      const nativeSupported = prototype.getSupportedExtensions;
      if (nativeParameter && !nativeParameter.__vaporPrivacy) {
        const getParameter = function (parameter) {
          if (parameter === 0x1f01 || parameter === 0x9246) {
            return GENERIC_RENDERER;
          }
          if (parameter === 0x1f00 || parameter === 0x9245) {
            return "Generic WebGL Vendor";
          }
          return nativeParameter.call(this, parameter);
        };
        getParameter.__vaporPrivacy = true;
        safeDefine(prototype, "getParameter", { value: getParameter, writable: true });
      }
      if (nativeExtension) {
        safeDefine(prototype, "getExtension", {
          value(name) {
            if (name === "WEBGL_debug_renderer_info") {
              return null;
            }
            return nativeExtension.call(this, name);
          },
          writable: true,
        });
      }
      if (nativeSupported) {
        safeDefine(prototype, "getSupportedExtensions", {
          value() {
            return (nativeSupported.call(this) || []).filter(name => name !== "WEBGL_debug_renderer_info");
          },
          writable: true,
        });
      }
    }
  }

  #patchAudio(window, noise) {
    for (const prototype of [window.OfflineAudioContext?.prototype, window.webkitOfflineAudioContext?.prototype].filter(Boolean)) {
      const nativeStart = prototype.startRendering;
      if (!nativeStart || nativeStart.__vaporPrivacy) {
        continue;
      }
      const startRendering = function (...args) {
        return Promise.resolve(nativeStart.apply(this, args)).then(buffer => {
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const data = buffer.getChannelData(channel);
            for (let index = 0; index < data.length; index += 97) {
              data[index] += noise(index + channel * 31) * 0.0000001;
            }
          }
          return buffer;
        });
      };
      startRendering.__vaporPrivacy = true;
      safeDefine(prototype, "startRendering", { value: startRendering, writable: true });
    }
  }

  #patchFonts(window) {
    const prototype = window.FontFaceSet?.prototype;
    if (!prototype || prototype.check?.__vaporPrivacy) {
      return;
    }
    const nativeCheck = prototype.check;
    const check = function (font, text) {
      const value = String(font).toLowerCase();
      if (![...SAFE_FONTS].some(family => value.includes(family))) {
        return false;
      }
      return nativeCheck.call(this, font, text);
    };
    check.__vaporPrivacy = true;
    safeDefine(prototype, "check", { value: check, writable: true });
    const documentDescriptor = Object.getOwnPropertyDescriptor(window.Document.prototype, "fonts");
    if (documentDescriptor?.get) {
      const nativeFonts = documentDescriptor.get;
      const child = this;
      const getFonts = function () {
        const fonts = nativeFonts.call(this);
        if (child.#fontProxy) {
          return child.#fontProxy;
        }
        child.#fontProxy = new Proxy(fonts, {
          get(target, property) {
            if (property === "size") return SAFE_FONTS.size;
            if (property === "check") return (font => [...SAFE_FONTS].some(family => String(font).toLowerCase().includes(family)));
            if (property === "values") return function* () { for (const family of SAFE_FONTS) yield { family, status: "loaded" }; };
            if (property === "keys") return function* () { for (const family of SAFE_FONTS) yield family; };
            if (property === "entries") return function* () { for (const family of SAFE_FONTS) yield [family, { family, status: "loaded" }]; };
            if (property === "forEach") return callback => { for (const family of SAFE_FONTS) callback({ family, status: "loaded" }, family, fonts); };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return child.#fontProxy;
      };
      safeDefine(window.Document.prototype, "fonts", { get: getFonts });
    }
  }

  #patchNavigator(window, navigator) {
    const prototype = window.Navigator?.prototype;
    if (!prototype) return;
    const getter = (property, value) => safeDefine(prototype, property, { get: () => value });
    getter("hardwareConcurrency", 4);
    getter("deviceMemory", 8);
    getter("language", this.#language);
    if (this.#uaOverride) {
      getter("userAgent", CHROME_USER_AGENT);
      getter("appVersion", CHROME_USER_AGENT.slice(CHROME_USER_AGENT.indexOf("5.0")));
    }
    getter("languages", [this.#language]);
    getter("plugins", []);
    getter("mimeTypes", [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
      { type: "text/plain", suffixes: "txt", description: "Plain text", enabledPlugin: null },
      { type: "image/png", suffixes: "png", description: "PNG image", enabledPlugin: null },
      { type: "image/jpeg", suffixes: "jpg,jpeg", description: "JPEG image", enabledPlugin: null },
    ]);
    safeDefine(prototype, "getBattery", { value: () => undefined, writable: true });
    safeDefine(prototype, "getGamepads", { value: () => [], writable: true });
    const connection = { effectiveType: "4g", downlink: 10, rtt: 50, saveData: false, type: "wifi" };
    getter("connection", connection);
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices?.enumerateDevices) {
      const nativeEnumerate = mediaDevices.enumerateDevices.bind(mediaDevices);
      safeDefine(Object.getPrototypeOf(mediaDevices), "enumerateDevices", {
        value: () => nativeEnumerate().then(devices => devices.map(device => {
          let id = this.#deviceIds.get(device.deviceId);
          if (!id) {
            id = `${this.#deviceSeed}-${this.#deviceIds.size}`;
            this.#deviceIds.set(device.deviceId, id);
          }
          return { deviceId: id, groupId: `${this.#deviceSeed}-group`, kind: device.kind, label: device.kind === "audioinput" ? "Microphone" : device.kind === "videoinput" ? "Camera" : "Speaker" };
        })),
        writable: true,
      });
    }
  }

  #patchScreen(window) {
    const prototype = window.Screen?.prototype;
    if (!prototype) return;
    for (const property of ["width", "availWidth"]) {
      safeDefine(prototype, property, { get: () => window.innerWidth });
    }
    for (const property of ["height", "availHeight"]) {
      safeDefine(prototype, property, { get: () => window.innerHeight });
    }
    safeDefine(prototype, "colorDepth", { get: () => 24 });
    safeDefine(prototype, "pixelDepth", { get: () => 24 });
    safeDefine(window, "devicePixelRatio", { get: () => 1 });
  }

  #patchTimeAndLanguage(window) {
    const nativeResolved = window.Intl.DateTimeFormat.prototype.resolvedOptions;
    if (!nativeResolved.__vaporPrivacy) {
      const resolvedOptions = function (...args) {
        return { ...nativeResolved.apply(this, args), timeZone: "UTC" };
      };
      resolvedOptions.__vaporPrivacy = true;
      resolvedOptions.__vaporPrivacyBase = nativeResolved;
      safeDefine(window.Intl.DateTimeFormat.prototype, "resolvedOptions", { value: resolvedOptions, writable: true });
    }
    safeDefine(window.Date.prototype, "getTimezoneOffset", { value: () => 0, writable: true });
  }

  #applyLanguageAndTimezone() {
    const window = this.document.defaultView;
    safeDefine(window.Navigator?.prototype, "language", { get: () => this.#language });
    safeDefine(window.Navigator?.prototype, "languages", { get: () => [this.#language] });
    const current = window.Intl.DateTimeFormat.prototype.resolvedOptions;
    const base = current.__vaporPrivacyBase || current;
    const child = this;
    const resolvedOptions = function (...args) {
      return { ...base.apply(this, args), timeZone: child.#timezone };
    };
    resolvedOptions.__vaporPrivacy = true;
    resolvedOptions.__vaporPrivacyBase = base;
    safeDefine(window.Intl.DateTimeFormat.prototype, "resolvedOptions", { value: resolvedOptions, writable: true });
  }

  #patchPerformance(window) {
    const prototype = window.Performance?.prototype;
    const nativeNow = prototype?.now;
    if (nativeNow && !nativeNow.__vaporPrivacy) {
      const now = function (...args) { return Math.round(nativeNow.apply(this, args)); };
      now.__vaporPrivacy = true;
      safeDefine(prototype, "now", { value: now, writable: true });
    }
  }

  #patchSharedArrayBuffer(window) {
    if (window.crossOriginIsolated) return;
    try {
      window.SharedArrayBuffer = undefined;
    } catch {
      try { Object.defineProperty(window, "SharedArrayBuffer", { value: undefined, configurable: true }); } catch {}
    }
  }

  #installClipboard() {
    const clipboard = this.document.defaultView.navigator.clipboard;
    if (!clipboard) return;
    const nativeReadText = clipboard.readText?.bind(clipboard);
    const nativeRead = clipboard.read?.bind(clipboard);
    const nativeWriteText = clipboard.writeText?.bind(clipboard);
    const nativeWrite = clipboard.write?.bind(clipboard);
    const clipboardPrototype = Object.getPrototypeOf(clipboard);
    const replaceClipboardMethod = (name, value) =>
      safeDefine(clipboard, name, { value, writable: true }) ||
      safeDefine(clipboardPrototype, name, { value, writable: true });
    const request = async () => {
      if (!this.#clipboardEnabled) return true;
      if (this.#clipboardPermission === 1) return true;
      if (!this.#clipboardRequest) {
        this.#clipboardRequest = this.sendQuery("VaporPrivacy:ClipboardReadRequest", {
          host: this.document.location?.hostname || "",
          href: this.document.location?.href || "",
        }).then(decision => {
          this.#clipboardPermission = decision?.allowed ? 1 : 2;
          return !!decision?.allowed;
        }).finally(() => {
          this.#clipboardRequest = null;
        });
      }
      return this.#clipboardRequest;
    };
    if (nativeReadText) {
      replaceClipboardMethod("readText", async () => {
        if (await request()) return nativeReadText();
        throw new DOMException("Clipboard read blocked", "NotAllowedError");
      });
    }
    if (nativeRead) {
      replaceClipboardMethod("read", async () => {
        if (await request()) return nativeRead();
        throw new DOMException("Clipboard read blocked", "NotAllowedError");
      });
    }
    if (nativeWriteText) {
      replaceClipboardMethod("writeText", text => nativeWriteText(sanitizeClipboardText(text)));
    }
    if (nativeWrite) {
      replaceClipboardMethod("write", async items => {
        const ClipboardItem = this.document.defaultView.ClipboardItem;
        if (!ClipboardItem || !Array.isArray(items)) return nativeWrite(items);
        const sanitized = await Promise.all(items.map(async item => {
          const data = {};
          for (const type of item.types || []) {
            const blob = await item.getType(type);
            data[type] = type === "text/plain"
              ? new this.document.defaultView.Blob([sanitizeClipboardText(await blob.text())], { type })
              : blob;
          }
          return new ClipboardItem(data);
        }));
        return nativeWrite(sanitized);
      });
    }
    this.#copyHandler = event => {
      const text = this.document.defaultView.getSelection()?.toString();
      if (!text || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", sanitizeClipboardText(text));
      event.preventDefault();
    };
    this.document.addEventListener("copy", this.#copyHandler, true);
  }

  #log(kind, action, detail = {}) {
    this.sendQuery("VaporPrivacy:Log", { kind, action, ...detail }).catch(() => {});
  }
}
