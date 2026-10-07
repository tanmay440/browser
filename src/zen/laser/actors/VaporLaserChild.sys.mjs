// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const UI_ATTRIBUTE = "data-vapor-laser-ui";
const STYLE_ID = "vapor-laser-content-style";
const HUD_ID = "vapor-laser-hud";
const HIGHLIGHT_ID = "vapor-laser-highlight";
const VIGNETTE_ID = "vapor-laser-vignette";
const PARTICLES_ID = "vapor-laser-particles";
const FLASH_ID = "vapor-laser-flash";
const MAX_UNDO_AGE = 10_000;

const AD_NAME_RE =
  /(?:^|[-_\s])(ad|ads|advert|advertisement|banner|sponsor|sponsored|promoted)(?:[-_\s]|$)/i;
const COMMON_AD_DIMENSIONS = [
  [300, 250],
  [336, 280],
  [728, 90],
  [970, 250],
  [160, 600],
  [300, 600],
  [320, 50],
  [320, 100],
  [468, 60],
  [250, 250],
  [300, 50],
];
const SOURCE_ATTRIBUTES = [
  "src",
  "href",
  "data-src",
  "data-href",
  "poster",
  "srcset",
];

const CONTENT_STYLE = `
  @keyframes vapor-laser-particle {
    from { opacity: 1; transform: translate(0, 0) rotate(0deg) scale(1); }
    to { opacity: 0; transform: translate(var(--vapor-dx), var(--vapor-dy)) rotate(var(--vapor-rotation)) scale(.2); }
  }
  #${VIGNETTE_ID}[${UI_ATTRIBUTE}] {
    position: fixed !important;
    inset: 0 !important;
    z-index: 2147483640 !important;
    pointer-events: none !important;
    box-shadow: inset 0 0 84px rgba(255, 0, 0, .10) !important;
  }
  #${HIGHLIGHT_ID}[${UI_ATTRIBUTE}] {
    position: fixed !important;
    z-index: 2147483641 !important;
    pointer-events: none !important;
    box-sizing: border-box !important;
    border: 2px solid #ff1f1f !important;
    border-radius: 2px !important;
    box-shadow: 0 0 8px rgba(255, 0, 0, .85), inset 0 0 5px rgba(255, 0, 0, .16) !important;
    transition: left 35ms linear, top 35ms linear, width 35ms linear, height 35ms linear !important;
  }
  #${HUD_ID}[${UI_ATTRIBUTE}] {
    position: fixed !important;
    left: 12px !important;
    bottom: 12px !important;
    z-index: 2147483643 !important;
    pointer-events: none !important;
    all: initial !important;
    display: block !important;
    min-width: 245px !important;
    padding: 10px 13px !important;
    color: #fff !important;
    background: rgba(24, 0, 0, .90) !important;
    border: 1px solid rgba(255, 55, 55, .75) !important;
    border-radius: 7px !important;
    box-shadow: 0 3px 18px rgba(0, 0, 0, .35), 0 0 10px rgba(255, 0, 0, .18) !important;
    font: 600 12px/1.35 system-ui, sans-serif !important;
    letter-spacing: .02em !important;
    text-shadow: 0 1px 2px #000 !important;
  }
  #${HUD_ID}[${UI_ATTRIBUTE}] * {
    all: initial !important;
    color: inherit !important;
    font: inherit !important;
  }
  #${HUD_ID} .vapor-laser-title[${UI_ATTRIBUTE}] { display: block !important; }
  #${HUD_ID} .vapor-laser-counter[${UI_ATTRIBUTE}] {
    display: block !important;
    margin-top: 3px !important;
    color: #ff9b9b !important;
    font-weight: 700 !important;
  }
  #${HUD_ID} .vapor-laser-toast[${UI_ATTRIBUTE}] {
    display: block !important;
    margin-top: 5px !important;
    color: #ffd1d1 !important;
  }
  #${FLASH_ID}[${UI_ATTRIBUTE}], #${PARTICLES_ID}[${UI_ATTRIBUTE}] {
    position: fixed !important;
    inset: 0 !important;
    z-index: 2147483642 !important;
    pointer-events: none !important;
  }
  #${FLASH_ID} .vapor-laser-flash-box[${UI_ATTRIBUTE}] {
    all: initial !important;
    position: fixed !important;
    background: rgba(255, 255, 255, .95) !important;
    pointer-events: none !important;
  }
  #${PARTICLES_ID} .vapor-laser-particle[${UI_ATTRIBUTE}] {
    all: initial !important;
    position: fixed !important;
    width: 5px !important;
    height: 5px !important;
    margin: -2px 0 0 -2px !important;
    border-radius: 1px !important;
    background: #ff3939 !important;
    box-shadow: 0 0 5px rgba(255, 255, 255, .9) !important;
    animation: vapor-laser-particle 300ms ease-out forwards !important;
  }
  html[${UI_ATTRIBUTE}] *, html[${UI_ATTRIBUTE}] *::before, html[${UI_ATTRIBUTE}] *::after {
    cursor: url("chrome://vapor/content/laser-cursor.svg") 12 12, crosshair !important;
  }
`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VaporLaserChild extends JSWindowActorChild {
  #active = false;
  #killCount = 0;
  #style = null;
  #hud = null;
  #counter = null;
  #toast = null;
  #highlight = null;
  #vignette = null;
  #lastZap = null;
  #toastTimer = null;
  #vaporizing = false;

  receiveMessage(message) {
    if (message.name === "VaporLaser:State") {
      this.#setActive(!!message.data?.active);
    }
  }

  didDestroy() {
    this.#setActive(false);
  }

  async #setActive(active) {
    if (active === this.#active) {
      if (active && !this.#style && this.document?.documentElement) {
        this.#install();
      } else if (active) {
        this.#updateCounter();
      }
      return;
    }

    this.#active = active;
    if (active) {
      this.#install();
    } else {
      this.#uninstall();
    }
  }

  #install() {
    const document = this.document;
    if (!document?.documentElement) {
      return;
    }

    this.#style = document.createElement("style");
    this.#style.id = STYLE_ID;
    this.#style.setAttribute(UI_ATTRIBUTE, "true");
    this.#style.textContent = CONTENT_STYLE;
    document.documentElement.appendChild(this.#style);
    document.documentElement.setAttribute(UI_ATTRIBUTE, "true");

    this.#vignette = this.#makeUIElement("div", VIGNETTE_ID);
    this.#highlight = this.#makeUIElement("div", HIGHLIGHT_ID);
    this.#hud = this.#makeUIElement("div", HUD_ID);
    this.#hud.setAttribute("role", "status");
    this.#hud.setAttribute("aria-live", "polite");

    const title = this.#makeUIElement("span", "vapor-laser-title");
    title.textContent = "LASER ACTIVE — Click any element to vaporize";
    const counter = this.#makeUIElement("span", "vapor-laser-counter");
    this.#counter = counter;
    const toast = this.#makeUIElement("span", "vapor-laser-toast");
    this.#toast = toast;
    this.#hud.append(title, counter, toast);

    const root = document.body || document.documentElement;
    root.append(this.#vignette, this.#highlight, this.#hud);
    this.#updateCounter();

    document.addEventListener("pointermove", this, true);
    document.addEventListener("click", this, true);
    document.addEventListener("keydown", this, true);
  }

  #uninstall() {
    const document = this.document;
    document?.removeEventListener("pointermove", this, true);
    document?.removeEventListener("click", this, true);
    document?.removeEventListener("keydown", this, true);
    document?.documentElement?.removeAttribute(UI_ATTRIBUTE);

    this.#style?.remove();
    this.#hud?.remove();
    this.#highlight?.remove();
    this.#vignette?.remove();
    this.#style = null;
    this.#hud = null;
    this.#counter = null;
    this.#toast = null;
    this.#highlight = null;
    this.#vignette = null;
    if (this.#toastTimer) {
      clearTimeout(this.#toastTimer);
      this.#toastTimer = null;
    }
  }

  #makeUIElement(tagName, idOrClass) {
    const element = this.document.createElement(tagName);
    element.setAttribute(UI_ATTRIBUTE, "true");
    if (idOrClass.startsWith("vapor-laser-") && idOrClass.endsWith("hud")) {
      element.id = idOrClass;
    } else if (idOrClass === VIGNETTE_ID || idOrClass === HIGHLIGHT_ID) {
      element.id = idOrClass;
    } else {
      element.className = idOrClass;
    }
    return element;
  }

  handleEventForLaser(event) {
    if (!this.#active) {
      return;
    }
    switch (event.type) {
      case "pointermove":
        this.#updateHighlight(event);
        break;
      case "click":
        this.#handleClick(event);
        break;
      case "keydown":
        this.#handleKeydown(event);
        break;
    }
  }

  // JSWindowActorChild's event listener protocol calls handleEvent directly.
  // Keep this small dispatcher separate so the public handleEvent can also
  // handle DOMContentLoaded actor events.
  handleEvent(event) {
    if (event.type === "DOMContentLoaded") {
      this.sendQuery("VaporLaser:GetActive")
        .then((active) => this.#setActive(active))
        .catch(() => {});
      return;
    }
    this.handleEventForLaser(event);
  }

  #handleKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.sendAsyncMessage("VaporLaser:Deactivate");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      if (this.#undo()) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  }

  #updateHighlight(event) {
    const target = this.#eventElement(event);
    if (!target || this.#isUI(target)) {
      this.#hideHighlight();
      return;
    }
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      this.#hideHighlight();
      return;
    }
    this.#highlight.hidden = false;
    this.#highlight.style.left = `${rect.left}px`;
    this.#highlight.style.top = `${rect.top}px`;
    this.#highlight.style.width = `${rect.width}px`;
    this.#highlight.style.height = `${rect.height}px`;
  }

  #hideHighlight() {
    if (this.#highlight) {
      this.#highlight.hidden = true;
    }
  }

  #handleClick(event) {
    if (this.#vaporizing || event.button !== 0 || event.defaultPrevented) {
      return;
    }
    const clicked = this.#eventElement(event);
    if (
      !clicked ||
      this.#isUI(clicked) ||
      clicked === this.document.documentElement
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const target = event.altKey ? clicked : this.#findTarget(clicked);
    if (
      !target ||
      target === this.document.body ||
      target === this.document.documentElement
    ) {
      return;
    }
    this.#vaporize(target);
  }

  #eventElement(event) {
    const path = event.composedPath?.() || [];
    const elementNode = this.document.defaultView.Node.ELEMENT_NODE;
    const candidate = path.find((item) => item?.nodeType === elementNode);
    return (
      candidate ||
      (event.target?.nodeType === elementNode ? event.target : null)
    );
  }

  #isUI(element) {
    return !!element.closest?.(`[${UI_ATTRIBUTE}]`);
  }

  #findTarget(element) {
    let current = element;
    while (current && current !== this.document.documentElement) {
      if (this.#isAdContainer(current)) {
        return current;
      }
      if (current.parentElement) {
        current = current.parentElement;
      } else {
        current = current.getRootNode?.().host || null;
      }
    }
    return element;
  }

  #isAdContainer(element) {
    if (!(element instanceof this.document.defaultView.Element)) {
      return false;
    }
    const name = `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
    if (AD_NAME_RE.test(name) || /(?:advert|banner|sponsor|promot)/i.test(name)) {
      return true;
    }

    if (element.localName === "iframe" && this.#isCrossOriginFrame(element)) {
      return true;
    }

    if (
      ["div", "aside", "section", "article", "figure", "iframe"].includes(
        element.localName,
      )
    ) {
      const rect = element.getBoundingClientRect();
      return COMMON_AD_DIMENSIONS.some(
        ([width, height]) =>
          Math.abs(rect.width - width) <= 8 &&
          Math.abs(rect.height - height) <= 8,
      );
    }
    return false;
  }

  #isCrossOriginFrame(frame) {
    try {
      const source = new URL(
        frame.getAttribute("src") || frame.src,
        this.document.location.href,
      );
      return source.origin !== this.document.location.origin;
    } catch {
      return false;
    }
  }

  async #vaporize(target) {
    if (this.#vaporizing || !target.isConnected || !target.parentNode) {
      return;
    }
    this.#vaporizing = true;

    const rect = target.getBoundingClientRect();
    const originalStyle = target.getAttribute("style");
    const parent = target.parentNode;
    const nextSibling = target.nextSibling;
    const entries = this.#extractRules(target);
    const pageURL = this.document.location?.href || "";
    const notes = [];
    if (!entries.length && target.localName === "canvas") {
      notes.push(
        `canvas on ${pageURL} (${Math.round(rect.width)}x${Math.round(rect.height)})`,
      );
    }

    const addRules = this.sendQuery("VaporLaser:AddRules", {
      entries,
      pageURL,
      notes,
    }).catch(() => []);

    this.#showFlash(rect);
    await wait(50);
    target.style.setProperty("opacity", "0", "important");
    const particles = this.#showParticles(rect);
    await particles;
    target.remove();
    if (originalStyle === null) {
      target.removeAttribute("style");
    } else {
      target.setAttribute("style", originalStyle);
    }

    const addedRules = await addRules;
    this.#lastZap = {
      target,
      parent,
      nextSibling,
      addedRules,
      expires: Date.now() + MAX_UNDO_AGE,
    };
    setTimeout(() => {
      if (
        this.#lastZap?.target === target &&
        Date.now() >= this.#lastZap.expires
      ) {
        this.#lastZap = null;
      }
    }, MAX_UNDO_AGE + 25);

    this.#killCount++;
    this.#updateCounter();
    this.#showToast("Vaporized");
    this.#hideHighlight();
    this.#vaporizing = false;
  }

  #showFlash(rect) {
    const flash = this.document.createElement("div");
    flash.id = FLASH_ID;
    flash.setAttribute(UI_ATTRIBUTE, "true");
    const box = this.document.createElement("div");
    box.className = "vapor-laser-flash-box";
    box.setAttribute(UI_ATTRIBUTE, "true");
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    flash.appendChild(box);
    (this.document.body || this.document.documentElement).appendChild(flash);
    setTimeout(() => flash.remove(), 50);
  }

  #showParticles(rect) {
    const container = this.document.createElement("div");
    container.id = PARTICLES_ID;
    container.setAttribute(UI_ATTRIBUTE, "true");
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    for (let index = 0; index < 20; index++) {
      const particle = this.document.createElement("i");
      particle.className = "vapor-laser-particle";
      particle.setAttribute(UI_ATTRIBUTE, "true");
      const angle = (Math.PI * 2 * index) / 20 + Math.random() * 0.35;
      const distance = 35 + Math.random() * 85;
      particle.style.left = `${centerX}px`;
      particle.style.top = `${centerY}px`;
      particle.style.setProperty(
        "--vapor-dx",
        `${Math.cos(angle) * distance}px`,
      );
      particle.style.setProperty(
        "--vapor-dy",
        `${Math.sin(angle) * distance}px`,
      );
      particle.style.setProperty(
        "--vapor-rotation",
        `${Math.random() * 360 - 180}deg`,
      );
      particle.style.animationDelay = `${Math.random() * 35}ms`;
      container.appendChild(particle);
    }
    (this.document.body || this.document.documentElement).appendChild(
      container,
    );
    return wait(300).then(() => container.remove());
  }

  #extractRules(target) {
    const nodes = [target, ...(target.querySelectorAll?.("*") || [])];
    const urls = new Set();
    for (const node of nodes.slice(0, 300)) {
      for (const attribute of SOURCE_ATTRIBUTES) {
        const raw = node.getAttribute?.(attribute);
        if (!raw) {
          continue;
        }
        if (attribute === "srcset") {
          for (const candidate of raw.split(",")) {
            const source = candidate.trim().split(/\s+/)[0];
            if (source) {
              urls.add(source);
            }
          }
        } else {
          urls.add(raw);
        }
      }

      try {
        const background =
          this.document.defaultView.getComputedStyle(node).backgroundImage;
        for (const match of background.matchAll(
          /url\(["']?([^"')]+)["']?\)/gi,
        )) {
          urls.add(match[1]);
        }
      } catch {}
    }

    const entries = new Map();
    for (const raw of urls) {
      try {
        const url = new URL(raw, this.document.location.href);
        if (
          !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
          !url.hostname
        ) {
          continue;
        }
        const sameOrigin = url.origin === this.document.location.origin;
        const path = url.pathname || "/";
        const rule = sameOrigin
          ? `||${url.host}${path}`
          : url.hostname.toLowerCase();
        entries.set(rule, { rule, sameOrigin, sourceURL: url.href });
      } catch {}
    }
    return [...entries.values()];
  }

  #undo() {
    const zap = this.#lastZap;
    if (!zap || Date.now() > zap.expires) {
      this.#lastZap = null;
      return false;
    }
    if (zap.parent?.isConnected) {
      zap.parent.insertBefore(
        zap.target,
        zap.nextSibling?.parentNode === zap.parent ? zap.nextSibling : null,
      );
    }
    if (zap.addedRules?.length) {
      this.sendQuery("VaporLaser:RemoveRules", { rules: zap.addedRules }).catch(
        () => {},
      );
    }
    this.#lastZap = null;
    this.#killCount = Math.max(0, this.#killCount - 1);
    this.#updateCounter();
    this.#showToast("Restored");
    return true;
  }

  #updateCounter() {
    if (this.#counter) {
      this.#counter.textContent = `Vaporized: ${this.#killCount}`;
    }
  }

  #showToast(message) {
    if (!this.#toast) {
      return;
    }
    this.#toast.textContent = message;
    this.#toast.hidden = false;
    if (this.#toastTimer) {
      clearTimeout(this.#toastTimer);
    }
    this.#toastTimer = setTimeout(
      () => {
        if (this.#toast) {
          this.#toast.textContent = "";
        }
        this.#toastTimer = null;
      },
      message === "Restored" ? 2_000 : 700,
    );
  }
}
