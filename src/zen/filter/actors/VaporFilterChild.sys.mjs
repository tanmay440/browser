// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const UI_ATTRIBUTE = "data-vapor-filter-ui";
const TOAST_ID = "vapor-shield-breaker-toast";
const KILL_STYLE_ID = "vapor-shield-breaker-kill-style";
const SHATTER_ID = "vapor-shield-breaker-shatter";

const DEFAULT_SELECTORS = [
  "ad-slot",
  "ad-banner",
  "ad-container",
  "ads-by-google",
  "google-ad",
  "amp-ad",
  "amp-auto-ads",
  "gpt-ad",
  "display-ad",
  "sponsor-ad",
  "advertisement-container",
  "dfp-ad",
  "outbrain-widget",
  "taboola-widget",
  "yandex_rtb",
  "[data-ad]",
  "[data-advertisement]",
  "[data-ad-slot]",
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="adnxs.com"]',
  'iframe[src*="adform.net"]',
  'iframe[src*="adsystem.com"]',
  'script[src*="doubleclick.net"]',
  'script[src*="googlesyndication.com"]',
  'script[src*="adnxs.com"]',
  'script[src*="connect.facebook.net"]',
  'script[src*="google-analytics.com"]',
  'script[src*="googletagmanager.com"]',
  'object[data*="ads"]',
  'object[data*="doubleclick"]',
  "object[data]",
  'embed[src*="ads"]',
  'embed[src*="doubleclick"]',
  'video[src*="ads"]',
  'audio[src*="ads"]',
  'source[src*="ads"]',
  'track[src*="ads"]',
  'link[rel="preload"][as="script"]',
  'link[rel="prefetch"]',
];

const CONTENT_STYLE = `
  @keyframes vapor-shield-crack {
    0% { opacity: .95; transform: scale(1); filter: brightness(1.8); }
    100% { opacity: 0; transform: scale(1.025); filter: brightness(1); }
  }
  @keyframes vapor-shield-shard {
    from { opacity: .95; transform: translate(0, 0) rotate(0); }
    to { opacity: 0; transform: translate(var(--vapor-shard-x), var(--vapor-shard-y)) rotate(var(--vapor-shard-r)); }
  }
  #${TOAST_ID}[${UI_ATTRIBUTE}] {
    all: initial !important;
    position: fixed !important;
    right: 18px !important;
    bottom: 18px !important;
    z-index: 2147483646 !important;
    display: flex !important;
    align-items: center !important;
    gap: 12px !important;
    max-width: min(440px, calc(100vw - 36px)) !important;
    padding: 12px 14px !important;
    border: 1px solid rgba(125, 214, 255, .72) !important;
    border-radius: 9px !important;
    color: #f4fbff !important;
    background: rgba(8, 24, 38, .96) !important;
    box-shadow: 0 7px 28px rgba(0, 0, 0, .42), 0 0 14px rgba(67, 196, 255, .25) !important;
    font: 600 13px/1.35 system-ui, sans-serif !important;
  }
  #${TOAST_ID}[${UI_ATTRIBUTE}] span { all: initial !important; color: inherit !important; font: inherit !important; }
  #${TOAST_ID}[${UI_ATTRIBUTE}] button {
    all: initial !important;
    cursor: pointer !important;
    padding: 6px 9px !important;
    border-radius: 5px !important;
    color: #04131e !important;
    background: #7dd6ff !important;
    font: 800 12px/1 system-ui, sans-serif !important;
    white-space: nowrap !important;
  }
  #${SHATTER_ID}[${UI_ATTRIBUTE}] {
    position: fixed !important;
    inset: 0 !important;
    z-index: 2147483645 !important;
    pointer-events: none !important;
    overflow: hidden !important;
  }
  #${SHATTER_ID} .vapor-shield-crack[${UI_ATTRIBUTE}] {
    position: fixed !important;
    border: 1px solid rgba(220, 248, 255, .92) !important;
    box-shadow: 0 0 6px rgba(118, 217, 255, .8) !important;
    animation: vapor-shield-crack 200ms ease-out forwards !important;
  }
  #${SHATTER_ID} .vapor-shield-shard[${UI_ATTRIBUTE}] {
    position: fixed !important;
    width: 7px !important;
    height: 2px !important;
    background: #bdeeff !important;
    animation: vapor-shield-shard 300ms ease-out forwards !important;
  }
`;

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) {
    return CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`);
}

export class VaporFilterChild extends JSWindowActorChild {
  #installed = false;
  #configured = false;
  #enabled = false;
  #rules = DEFAULT_SELECTORS.map(selector => ({ exception: false, selector }));
  #phrases = [];
  #memory = null;
  #observer = null;
  #observedRoots = new WeakSet();
  #nativeMutationObserver = null;
  #wrappedMutationObserver = null;
  #nativeAttachShadow = null;
  #wrappedAttachShadow = null;
  #nativeWrite = null;
  #wrappedWrite = null;
  #nativeWriteln = null;
  #wrappedWriteln = null;
  #nativeTimers = null;
  #wrappedSetInterval = null;
  #wrappedSetTimeout = null;
  #wrappedClearInterval = null;
  #wrappedClearTimeout = null;
  #wrappedRequestAnimationFrame = null;
  #wrappedCancelAnimationFrame = null;
  #watchdogObservers = new Set();
  #watchdogTimers = new Map();
  #watchdogFrames = new Map();
  #killedWatchdogs = new WeakSet();
  #initialLoadDone = false;
  #addedAfterLoad = new WeakSet();
  #overlayCandidates = new WeakSet();
  #loggedElements = new WeakSet();
  #toast = null;
  #toastTarget = null;
  #vaporizing = false;
  #killCount = 0;
  #laserCounterHandler = null;
  #writeHookInstalled = false;

  receiveMessage(message) {
    if (message.name === "VaporFilter:Activate") {
      this.#activateManual("Ctrl+Shift+B");
    }
  }

  handleEvent(event) {
    if (event.type === "DOMDocElementInserted") {
      this.#install();
      return;
    }
    if (event.type === "DOMContentLoaded") {
      this.#initialLoadDone = true;
      if (this.#enabled) {
        this.#scan(this.document);
      }
      return;
    }
    if (event.type === "keydown") {
      this.#handleKeydown(event);
    }
  }

  didDestroy() {
    this.#uninstallHooks();
  }

  #install() {
    if (this.#installed || !this.document?.documentElement) {
      return;
    }
    this.#installed = true;
    const document = this.document;
    const window = document.defaultView;

    const style = document.createElement("style");
    style.id = "vapor-filter-content-style";
    style.setAttribute(UI_ATTRIBUTE, "true");
    style.textContent = CONTENT_STYLE;
    (document.head || document.documentElement).appendChild(style);

    // Install all hooks before asking the parent for profile data. This is
    // deliberately document-start work: page scripts cannot create an
    // unobserved MutationObserver or bypass document.write sanitization.
    this.#hookMutationObserver(window);
    this.#hookDocumentWrites(document);
    this.#hookTimers(window);
    this.#hookAttachShadow(window);
    this.#observer = new this.#nativeMutationObserver(records => {
      if (!this.#enabled) {
        return;
      }
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (this.#initialLoadDone && node.nodeType === this.document.defaultView.Node.ELEMENT_NODE) {
            this.#addedAfterLoad.add(node);
            for (const descendant of node.querySelectorAll("*")) this.#addedAfterLoad.add(descendant);
          }
          this.#scan(node);
        }
      }
    });
    this.#observeRoot(document);

    document.addEventListener("DOMContentLoaded", this, { once: true, capture: true });
    document.addEventListener("vapor-shield-breaker-target", event => {
      const target = event.detail?.target;
      if (target instanceof window.Element) {
        this.#vaporizeOverlay(target, "Laser target");
      }
    }, true);
    this.#laserCounterHandler = event => {
      this.#killCount += Number(event.detail?.amount || 0);
    };
    document.addEventListener("vapor-shield-breaker-kill", this.#laserCounterHandler);

    this.sendQuery("VaporFilter:GetConfig", {
      host: document.location?.hostname || "",
      href: document.location?.href || "",
    }).then(config => {
      this.#configured = true;
      this.#enabled = !!config?.enabled;
      this.#rules = config?.rules?.length ? config.rules : DEFAULT_SELECTORS.map(selector => ({ exception: false, selector }));
      this.#phrases = Array.isArray(config?.overlayPhrases) ? config.overlayPhrases : [];
      this.#memory = config?.overlayMemory || null;
      if (!this.#enabled) {
        return;
      }
      this.#applyMemory();
      this.#scan(document);
    }).catch(() => {
      // Keep the document-start hooks in place, but do not alter page content
      // if the parent cannot provide a local configuration.
      this.#configured = true;
      this.#enabled = false;
    });
  }

  #uninstallHooks() {
    const document = this.document;
    const window = document?.defaultView;
    if (!document || !window) {
      return;
    }
    try {
      if (this.#wrappedMutationObserver && window.MutationObserver === this.#wrappedMutationObserver) {
        window.MutationObserver = this.#nativeMutationObserver;
      }
      if (this.#nativeAttachShadow && window.Element.prototype.attachShadow === this.#wrappedAttachShadow) {
        window.Element.prototype.attachShadow = this.#nativeAttachShadow;
      }
    } catch {}
    if (this.#nativeWrite && document.write === this.#wrappedWrite) {
      document.write = this.#nativeWrite;
    }
    if (this.#nativeWriteln && document.writeln === this.#wrappedWriteln) {
      document.writeln = this.#nativeWriteln;
    }
    if (this.#nativeTimers) {
      const timerHooks = [
        ["setInterval", this.#wrappedSetInterval],
        ["setTimeout", this.#wrappedSetTimeout],
        ["clearInterval", this.#wrappedClearInterval],
        ["clearTimeout", this.#wrappedClearTimeout],
        ["requestAnimationFrame", this.#wrappedRequestAnimationFrame],
        ["cancelAnimationFrame", this.#wrappedCancelAnimationFrame],
      ];
      for (const [name, wrapped] of timerHooks) {
        try {
          if (wrapped && window[name] === wrapped) window[name] = this.#nativeTimers[name];
        } catch {}
      }
    }
  }

  #hookMutationObserver(window) {
    const Native = window.MutationObserver;
    if (typeof Native !== "function" || Native.__vaporFilterNative) {
      this.#nativeMutationObserver = Native;
      return;
    }
    this.#nativeMutationObserver = Native;
    const state = this;
    const Wrapped = function VaporTrackedMutationObserver(callback) {
      let instance;
      const wrappedCallback = (records, observer) => {
        if (state.#killedWatchdogs.has(instance)) {
          return;
        }
        callback(records, observer);
      };
      instance = new Native(wrappedCallback);
      const entry = { observer: instance, targets: [] };
      state.#watchdogObservers.add(entry);
      const nativeObserve = instance.observe.bind(instance);
      const nativeDisconnect = instance.disconnect.bind(instance);
      instance.observe = (target, options) => {
        entry.targets.push(target);
        return nativeObserve(target, options);
      };
      instance.disconnect = () => {
        state.#watchdogObservers.delete(entry);
        return nativeDisconnect();
      };
      return instance;
    };
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    Wrapped.__vaporFilterNative = true;
    this.#wrappedMutationObserver = Wrapped;
    window.MutationObserver = Wrapped;
  }

  #hookAttachShadow(window) {
    const prototype = window.Element?.prototype;
    const native = prototype?.attachShadow;
    if (typeof native !== "function") {
      return;
    }
    this.#nativeAttachShadow = native;
    const state = this;
    this.#wrappedAttachShadow = function vaporAttachShadow(options) {
      const root = native.call(this, options);
      state.#observeRoot(root);
      state.#scan(root);
      return root;
    };
    prototype.attachShadow = this.#wrappedAttachShadow;
    // Closed roots are still observed when created through the hook, while
    // existing closed roots remain intentionally inaccessible to content.
  }

  #hookDocumentWrites(document) {
    if (this.#writeHookInstalled) {
      return;
    }
    this.#writeHookInstalled = true;
    this.#nativeWrite = document.write.bind(document);
    this.#nativeWriteln = document.writeln.bind(document);
    this.#wrappedWrite = (...args) => this.#nativeWrite(this.#sanitizeWrittenHTML(args.join("")));
    this.#wrappedWriteln = (...args) => this.#nativeWriteln(`${this.#sanitizeWrittenHTML(args.join(""))}\n`);
    document.write = this.#wrappedWrite;
    document.writeln = this.#wrappedWriteln;
  }

  #sanitizeWrittenHTML(html) {
    if ((this.#configured && !this.#enabled) || !html) {
      return html;
    }
    const wasEnabled = this.#enabled;
    try {
      const template = this.document.createElement("template");
      template.innerHTML = html;
      // The default rules are available before the parent query resolves, so
      // parser-time document.write() cannot sneak a known ad script through.
      this.#enabled = true;
      this.#scan(template.content);
      return template.innerHTML;
    } catch {
      return html;
    } finally {
      this.#enabled = wasEnabled;
    }
  }

  #hookTimers(window) {
    const state = this;
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const nativeRequestAnimationFrame = window.requestAnimationFrame?.bind(window);
    const nativeCancelAnimationFrame = window.cancelAnimationFrame?.bind(window);
    this.#nativeTimers = {
      setInterval: window.setInterval,
      setTimeout: window.setTimeout,
      clearInterval: window.clearInterval,
      clearTimeout: window.clearTimeout,
      requestAnimationFrame: window.requestAnimationFrame,
      cancelAnimationFrame: window.cancelAnimationFrame,
    };
    const isWatchdog = handler => {
      const source = typeof handler === "function" ? Function.prototype.toString.call(handler) : String(handler);
      return /adblock|ad blocker|anti.?adblock|overlay|whitelist|disable.?ad/i.test(source);
    };
    this.#wrappedSetInterval = (handler, delay, ...args) => {
      const id = nativeSetInterval(handler, delay, ...args);
      if (isWatchdog(handler)) {
        this.#watchdogTimers.set(id, { kind: "setInterval", source: String(handler) });
      }
      return id;
    };
    this.#wrappedSetTimeout = (handler, delay, ...args) => {
      const id = nativeSetTimeout(handler, delay, ...args);
      if (isWatchdog(handler)) {
        this.#watchdogTimers.set(id, { kind: "setTimeout", source: String(handler) });
      }
      return id;
    };
    this.#wrappedClearInterval = id => {
      this.#watchdogTimers.delete(id);
      return nativeClearInterval(id);
    };
    this.#wrappedClearTimeout = id => {
      this.#watchdogTimers.delete(id);
      return nativeClearTimeout(id);
    };
    window.setInterval = this.#wrappedSetInterval;
    window.setTimeout = this.#wrappedSetTimeout;
    window.clearInterval = this.#wrappedClearInterval;
    window.clearTimeout = this.#wrappedClearTimeout;
    if (nativeRequestAnimationFrame) {
      this.#wrappedRequestAnimationFrame = (handler, ...args) => {
        const id = nativeRequestAnimationFrame(handler, ...args);
        if (isWatchdog(handler)) {
          this.#watchdogFrames.set(id, String(handler));
        }
        return id;
      };
      this.#wrappedCancelAnimationFrame = id => {
        this.#watchdogFrames.delete(id);
        return nativeCancelAnimationFrame(id);
      };
      window.requestAnimationFrame = this.#wrappedRequestAnimationFrame;
      window.cancelAnimationFrame = this.#wrappedCancelAnimationFrame;
    }
  }

  #observeRoot(root) {
    if (!root || this.#observedRoots.has(root) || !this.#observer) {
      return;
    }
    this.#observedRoots.add(root);
    this.#observer.observe(root, { childList: true, subtree: true });
  }

  #scan(root) {
    if (!this.#enabled || !root) {
      return;
    }
    if (root.nodeType === this.document.defaultView.Node.ELEMENT_NODE) {
      this.#inspect(root);
    }
    const walker = this.document.createTreeWalker(
      root,
      this.document.defaultView.NodeFilter.SHOW_ELEMENT,
    );
    let node;
    while ((node = walker.nextNode())) {
      this.#inspect(node);
    }
    for (const element of root.querySelectorAll?.("*") || []) {
      if (element.shadowRoot) {
        this.#observeRoot(element.shadowRoot);
        this.#scan(element.shadowRoot);
      }
    }
  }

  #inspect(element) {
    if (!(element instanceof this.document.defaultView.Element) || element.hasAttribute(UI_ATTRIBUTE)) {
      return;
    }
    if (this.#matches(element)) {
      this.#neutralize(element);
    }
    this.#detectOverlay(element);
    if (element.shadowRoot) {
      this.#observeRoot(element.shadowRoot);
      this.#scan(element.shadowRoot);
    }
  }

  #matches(element) {
    let matched = false;
    let excepted = false;
    for (const rule of this.#rules) {
      try {
        if (!element.matches(rule.selector)) {
          continue;
        }
        if (rule.exception) {
          excepted = true;
        } else {
          matched = true;
        }
      } catch {
        // A malformed user selector must not stop the observer.
      }
    }
    return matched && !excepted;
  }

  #neutralize(element) {
    if (element.hasAttribute("data-vapor-filtered")) {
      return;
    }
    element.setAttribute("data-vapor-filtered", "true");
    const tag = element.localName;
    if (tag === "script") {
      element.removeAttribute("src");
      element.textContent = " ";
      element.setAttribute("type", "application/x-vapor-filtered");
    } else if (tag === "iframe") {
      element.removeAttribute("srcdoc");
      element.setAttribute("src", "about:blank");
      element.setAttribute("data-vapor-neutralized", "iframe");
    } else if (tag === "object" || tag === "embed") {
      element.removeAttribute("data");
      element.removeAttribute("src");
      element.setAttribute("data-vapor-neutralized", tag);
    } else if (tag === "link") {
      element.removeAttribute("href");
      element.removeAttribute("imagesrcset");
      element.setAttribute("data-vapor-neutralized", "preload");
    } else if (["img", "audio", "video", "source", "track"].includes(tag)) {
      element.pause?.();
      element.removeAttribute("src");
      element.removeAttribute("srcset");
      element.setAttribute("preload", "none");
      element.style.visibility = "hidden";
      element.load?.();
    } else if (
      element.localName.includes("-") &&
      (element.localName.includes("ad") || element.localName.includes("sponsor") || element.localName.includes("promot"))
    ) {
      // Keep custom ad elements in the DOM, but remove their payload and
      // source attributes so page code still sees a real custom element.
      element.replaceChildren();
      for (const attribute of ["src", "data-src", "data-url", "url"]) {
        element.removeAttribute(attribute);
      }
    }
    if (!this.#loggedElements.has(element)) {
      this.#loggedElements.add(element);
      this.sendQuery("VaporFilter:LogFilter", {
        host: this.document.location?.hostname || "",
        tag,
        id: element.id || "",
        classes: typeof element.className === "string" ? element.className.slice(0, 300) : "",
        selector: this.#matchingSelector(element),
        url: this.document.location?.href || "",
      }).catch(() => {});
    }
  }

  #matchingSelector(element) {
    for (const rule of this.#rules) {
      try {
        if (!rule.exception && element.matches(rule.selector)) {
          return rule.selector;
        }
      } catch {}
    }
    return "custom rule";
  }

  #overlayScore(element) {
    if (!(element instanceof this.document.defaultView.Element) || element.hasAttribute(UI_ATTRIBUTE)) {
      return { score: 0, criteria: [], text: "" };
    }
    const window = this.document.defaultView;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const criteria = [];
    const zIndex = Number.parseInt(style.zIndex, 10);
    if ((style.position === "fixed" || style.position === "absolute") && Number.isFinite(zIndex) && zIndex > 1000) {
      criteria.push("position");
    }
    if (rect.width > window.innerWidth * 0.8 && rect.height > window.innerHeight * 0.8) {
      criteria.push("coverage");
    }
    if (this.#addedAfterLoad.has(element)) {
      criteria.push("timing");
    }
    const text = (element.innerText || element.textContent || "").slice(0, 12_000).toLowerCase();
    if (this.#phrases.some(phrase => phrase && text.includes(phrase))) {
      criteria.push("content");
    }
    const frozen = [this.document.documentElement, this.document.body].some(node => {
      if (!node) return false;
      const bodyStyle = window.getComputedStyle(node);
      return /hidden|clip/.test(bodyStyle.overflow) || bodyStyle.position === "fixed" || bodyStyle.pointerEvents === "none" || bodyStyle.filter.includes("blur");
    }) || style.pointerEvents === "none" || style.filter.includes("blur");
    if (frozen) {
      criteria.push("page freeze");
    }
    return { score: criteria.length, criteria, text };
  }

  #detectOverlay(element) {
    const result = this.#overlayScore(element);
    if (result.score < 3 || this.#overlayCandidates.has(element)) {
      return;
    }
    this.#overlayCandidates.add(element);
    this.#showToast(element);
    this.sendQuery("VaporFilter:LogOverlay", {
      action: "detected",
      host: this.document.location?.hostname || "",
      url: this.document.location?.href || "",
      criteria: result.criteria,
      selector: this.#selectorFor(element),
    }).catch(() => {});
  }

  #selectorFor(element) {
    if (element.id) return `#${cssEscape(element.id)}`;
    const classes = [...element.classList].filter(Boolean).slice(0, 3).map(cssEscape);
    if (classes.length) return `${element.localName}.${classes.join(".")}`;
    const parts = [];
    let current = element;
    while (current && current !== this.document.body && parts.length < 4) {
      const parent = current.parentElement;
      const index = parent ? [...parent.children].indexOf(current) + 1 : 1;
      parts.unshift(`${current.localName}:nth-child(${index})`);
      current = parent;
    }
    return parts.join(" > ") || element.localName;
  }

  #showToast(target, message = "Anti-adblock overlay detected.") {
    if (!this.document.documentElement) return;
    this.#toastTarget = target;
    this.#toast?.remove();
    const toast = this.document.createElement("div");
    toast.id = TOAST_ID;
    toast.setAttribute(UI_ATTRIBUTE, "true");
    const text = this.document.createElement("span");
    text.setAttribute(UI_ATTRIBUTE, "true");
    text.textContent = message;
    const button = this.document.createElement("button");
    button.setAttribute(UI_ATTRIBUTE, "true");
    button.type = "button";
    button.textContent = "Vaporize It";
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const candidate = this.#toastTarget;
      this.#vaporizeOverlay(candidate, "Toast action");
    });
    toast.append(text, button);
    (this.document.body || this.document.documentElement).appendChild(toast);
    this.#toast = toast;
    setTimeout(() => {
      if (this.#toast === toast && !this.#vaporizing) toast.remove();
    }, 8_000);
  }

  #handleKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "b") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.#activateManual("Ctrl+Shift+B");
  }

  #activateManual(reason) {
    const target = this.#findLikelyOverlay();
    if (target) {
      this.#vaporizeOverlay(target, reason);
    } else {
      this.#showToast(null, "No anti-adblock overlay detected.");
    }
  }

  #findLikelyOverlay() {
    let best = null;
    let bestScore = 2;
    for (const element of this.document.querySelectorAll("body *")) {
      const score = this.#overlayScore(element).score;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best;
  }

  #applyMemory() {
    if (!this.#memory?.selectors?.length) return;
    this.#injectKillRule(this.#memory.selectors);
    for (const selector of this.#memory.selectors) {
      try {
        for (const element of this.document.querySelectorAll(selector)) {
          this.#killWatchdogs(element);
        }
      } catch {}
    }
    this.sendQuery("VaporFilter:LogOverlay", {
      action: "memory-preload",
      host: this.document.location?.hostname || "",
      selectors: this.#memory.selectors,
      url: this.document.location?.href || "",
    }).catch(() => {});
  }

  #injectKillRule(selectors) {
    const safeSelectors = [...new Set((selectors || []).filter(Boolean))].slice(0, 40);
    if (!safeSelectors.length) return;
    let style = this.document.getElementById(KILL_STYLE_ID);
    if (!style) {
      style = this.document.createElement("style");
      style.id = KILL_STYLE_ID;
      style.setAttribute(UI_ATTRIBUTE, "true");
      (this.document.head || this.document.documentElement).appendChild(style);
    }
    style.textContent = `/* Vapor Shield Breaker — injected ${Date.now()} */\n${safeSelectors.join(",\n")} { display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; height:0 !important; z-index:-1 !important; }\nhtml, body { overflow:auto !important; position:static !important; }`;
  }

  #showGlassShatter(rect) {
    const container = this.document.createElement("div");
    container.id = SHATTER_ID;
    container.setAttribute(UI_ATTRIBUTE, "true");
    const crack = this.document.createElement("div");
    crack.className = "vapor-shield-crack";
    crack.setAttribute(UI_ATTRIBUTE, "true");
    crack.style.left = `${rect.left}px`;
    crack.style.top = `${rect.top}px`;
    crack.style.width = `${rect.width}px`;
    crack.style.height = `${rect.height}px`;
    container.appendChild(crack);
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    for (let index = 0; index < 14; index++) {
      const shard = this.document.createElement("i");
      shard.className = "vapor-shield-shard";
      shard.setAttribute(UI_ATTRIBUTE, "true");
      shard.style.left = `${centerX}px`;
      shard.style.top = `${centerY}px`;
      const angle = (Math.PI * 2 * index) / 14;
      const distance = 60 + Math.random() * 160;
      shard.style.setProperty("--vapor-shard-x", `${Math.cos(angle) * distance}px`);
      shard.style.setProperty("--vapor-shard-y", `${Math.sin(angle) * distance}px`);
      shard.style.setProperty("--vapor-shard-r", `${Math.random() * 360}deg`);
      container.appendChild(shard);
    }
    (this.document.body || this.document.documentElement).appendChild(container);
    setTimeout(() => container.remove(), 340);
  }

  #restorePage() {
    const document = this.document;
    const targets = [document.documentElement, document.body, ...document.querySelectorAll("main, [role=main]")].filter(Boolean);
    for (const element of targets) {
      if (!element.hasAttribute("data-vapor-shield-original")) {
        element.setAttribute("data-vapor-shield-original", JSON.stringify({
          overflow: element.style.overflow,
          position: element.style.position,
          pointerEvents: element.style.pointerEvents,
          filter: element.style.filter,
          userSelect: element.style.userSelect,
        }));
      }
      element.style.overflow = "auto";
      if (element === document.documentElement || element === document.body) {
        element.style.position = "static";
      }
      element.style.pointerEvents = "auto";
      element.style.filter = "none";
      element.style.userSelect = "auto";
    }
    document.documentElement.style.overflow = "auto";
    if (document.body) document.body.style.overflow = "auto";
  }

  #killWatchdogs(target) {
    for (const entry of this.#watchdogObservers) {
      if (entry.targets.some(observed => observed === target || observed?.contains?.(target) || target?.contains?.(observed))) {
        this.#killedWatchdogs.add(entry.observer);
        entry.observer.disconnect();
      }
    }
    for (const [id, info] of this.#watchdogTimers) {
      this.#nativeTimers.clearInterval.call(this.document.defaultView, id);
      this.#nativeTimers.clearTimeout.call(this.document.defaultView, id);
      this.#watchdogTimers.delete(id);
    }
    for (const id of this.#watchdogFrames.keys()) {
      this.#nativeTimers.cancelAnimationFrame?.call(this.document.defaultView, id);
      this.#watchdogFrames.delete(id);
    }
  }

  async #vaporizeOverlay(target, reason) {
    if (this.#vaporizing || !target?.isConnected) return;
    const result = this.#overlayScore(target);
    if (result.score < 3) {
      this.#showToast(null, "Shield Breaker needs three overlay signals.");
      return;
    }
    this.#vaporizing = true;
    this.#toast?.remove();
    const rect = target.getBoundingClientRect();
    const selector = this.#selectorFor(target);
    const selectors = [selector];
    if (target.id) selectors.push(`#${cssEscape(target.id)}`);
    for (const className of [...target.classList].slice(0, 4)) selectors.push(`.${cssEscape(className)}`);
    const parent = target.parentElement;
    this.#showGlassShatter(rect);
    await wait(200);
    target.remove();
    this.#restorePage();
    this.#killWatchdogs(parent || target);
    this.#injectKillRule(selectors);
    this.#killCount += 5;
    this.document.dispatchEvent(new CustomEvent("vapor-shield-breaker-kill", { detail: { amount: 5 } }));
    const bodyFixes = ["overflow: hidden", "position: fixed", "pointer-events: none", "filter: blur()", "user-select: none"];
    await this.sendQuery("VaporFilter:RememberOverlay", {
      host: this.document.location?.hostname || "",
      selectors,
      bodyFixes,
      watchdogTypes: ["MutationObserver", "setInterval", "setTimeout", "requestAnimationFrame"],
    }).catch(() => {});
    await this.sendQuery("VaporFilter:LogOverlay", {
      action: "vaporized",
      reason,
      host: this.document.location?.hostname || "",
      url: this.document.location?.href || "",
      selector,
      selectors,
      criteria: result.criteria,
      killCount: this.#killCount,
    }).catch(() => {});
    this.#vaporizing = false;
    this.#showToast(null, "Overlay vaporized. Page restored. 🛡️💥");
    setTimeout(() => this.#toast?.remove(), 3_500);
  }
}
