// This Source Code Form is subject to the terms of the Mozilla Public
// License, Version 2.0. If a copy of the MPL was not distributed with this
// file, see http://mozilla.org/MPL/2.0/.

const FILTERED_ATTRIBUTE = "data-vapor-speculative-blocked";

export class VaporPrivacyChild extends JSWindowActorChild {
  #installed = false;
  #enabled = true;
  #observer = null;

  handleEvent(event) {
    if (event.type === "DOMDocElementInserted") {
      this.#install();
    }
  }

  didDestroy() {
    this.#observer?.disconnect();
  }

  #install() {
    if (this.#installed || !this.document?.documentElement) {
      return;
    }
    this.#installed = true;
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
          this.#scan(node);
        }
      }
    });
    // Deliberately childList-only: attributes are not observed and no page
    // attribute mutation can turn this into a general-purpose script blocker.
    this.#observer.observe(this.document, { childList: true, subtree: true });
    this.document.addEventListener("DOMContentLoaded", () => this.#scan(this.document), {
      once: true,
      capture: true,
    });
    this.sendQuery("VaporPrivacy:GetConfig", {
      href: this.document.location?.href || "",
    }).then(config => {
      this.#enabled = config?.enabled !== false;
      if (this.#enabled) {
        this.#scan(this.document);
      }
    }).catch(() => {});
  }

  #scan(root) {
    if (!this.#enabled || !root) {
      return;
    }
    if (root.nodeType === this.document.defaultView.Node.ELEMENT_NODE) {
      this.#inspect(root);
    }
    for (const element of root.querySelectorAll?.("link") || []) {
      this.#inspect(element);
    }
  }

  #inspect(element) {
    if (
      element.localName !== "link" ||
      element.hasAttribute(FILTERED_ATTRIBUTE)
    ) {
      return;
    }
    const rel = (element.getAttribute("rel") || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const href = element.getAttribute("href");
    if (!href) {
      return;
    }
    let destination;
    try {
      destination = new URL(href, this.document.location.href);
    } catch {
      return;
    }
    const speculative = rel.includes("prefetch") || rel.includes("prerender");
    const crossOriginPreload =
      rel.includes("preload") &&
      destination.origin !== this.document.location.origin;
    if (!speculative && !crossOriginPreload) {
      return;
    }
    element.setAttribute(FILTERED_ATTRIBUTE, speculative ? "prefetch" : "cross-origin-preload");
    element.removeAttribute("href");
    this.sendQuery("VaporPrivacy:Log", {
      kind: "Speculative Loading",
      action: speculative ? "dom-prefetch-blocked" : "dom-cross-origin-preload-blocked",
      url: destination.href,
    }).catch(() => {});
  }
}
