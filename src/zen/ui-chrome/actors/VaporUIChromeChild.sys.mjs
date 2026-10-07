/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export class VaporUIChromeChild extends JSWindowActorChild {
  #contextTarget = null;
  #contextLinkURL = "";
  #installed = false;

  handleEvent(event) {
    if (event.type === "contextmenu" || event.type === "click") {
      this.handleEventForPage(event);
      return;
    }
    if (event.type !== "DOMContentLoaded" || event.target !== this.contentWindow.document) {
      return;
    }
    if (this.contentWindow.location.href.startsWith("about:newtab") ||
        this.contentWindow.location.href.startsWith("about:home")) {
      this.#renderNewTab();
      return;
    }
    this.#installPageHooks();
    this.#sendMetrics();
  }

  didDestroy() {
    this.#removePageHooks();
  }

  receiveQuery(message) {
    switch (message.name) {
      case "VaporUI:VaporizeElement":
        return this.#vaporizeContextTarget();
      case "VaporUI:SaveReadingList":
        return this.#readingSnapshot();
    }
    return null;
  }

  #installPageHooks() {
    if (this.#installed || !this.document?.documentElement) {
      return;
    }
    this.#installed = true;
    this.document.addEventListener("contextmenu", this, true);
    this.document.addEventListener("click", this, true);
  }

  #removePageHooks() {
    this.document?.removeEventListener("contextmenu", this, true);
    this.document?.removeEventListener("click", this, true);
    this.#installed = false;
  }

  handleEventForPage(event) {
    if (event.type === "contextmenu") {
      let target = event.target;
      if (target?.nodeType !== Node.ELEMENT_NODE) {
        target = target?.parentElement;
      }
      this.#contextTarget = target || null;
      this.#contextLinkURL = target?.closest?.("a[href]")?.href || "";
      return;
    }
    if (event.type === "click") {
      this.#followThroughInspector(event);
    }
  }

  #sendMetrics() {
    try {
      const resources = this.contentWindow.performance?.getEntriesByType("resource") || [];
      const bytes = resources.reduce((sum, item) => sum + (item.transferSize || item.encodedBodySize || 0), 0);
      const scripts = resources.filter(item => item.initiatorType === "script");
      const longTasks = this.contentWindow.performance?.getEntriesByType("longtask") || [];
      const jsMs = longTasks.reduce((sum, item) => sum + (item.duration || 0), 0) || scripts.reduce((sum, item) => sum + (item.duration || 0), 0);
      this.sendAsyncMessage("VaporUI:PageMetrics", {
        bytes,
        requests: resources.length,
        jsMs,
      });
    } catch {}
  }

  async #followThroughInspector(event) {
    if (event.button !== 0 || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    let anchor = event.target?.closest?.("a[href]");
    if (!anchor || anchor.target && anchor.target !== "_self" || anchor.hasAttribute("download")) {
      return;
    }
    const url = anchor.href;
    if (!/^https?:/i.test(url) || url === this.contentWindow.location.href) {
      return;
    }
    event.preventDefault();
    const result = await this.sendQuery("VaporUI:FollowLink", { url }).catch(() => ({ allow: true, url }));
    if (result?.allow !== false) {
      this.contentWindow.location.href = result?.url || url;
    }
  }

  #vaporizeContextTarget() {
    if (!this.#contextTarget?.isConnected || this.#contextTarget === this.document.documentElement) {
      return false;
    }
    this.#contextTarget.remove();
    this.#contextTarget = null;
    return true;
  }

  #readingSnapshot() {
    const source = this.document.querySelector("article, main") || this.document.body;
    if (!source) {
      return null;
    }
    const clone = source.cloneNode(true);
    for (const node of clone.querySelectorAll("script, style, iframe, object, embed, video, audio, canvas, [data-ad], [data-ad-slot], [id^='ad' i], [id*='-ad' i], [id*='_ad' i], [class^='ad' i], [class*=' ad' i], [class*='-ad' i], [class*='_ad' i]")) {
      node.remove();
    }
    const thumbnail = clone.querySelector("img")?.src || this.document.querySelector("meta[property='og:image']")?.content || "";
    return {
      url: this.contentWindow.location.href,
      title: this.document.title || "Untitled article",
      html: clone.innerHTML,
      text: clone.textContent || "",
      thumbnail,
    };
  }

  async #renderNewTab() {
    const data = await this.sendQuery("VaporNewTab:GetData").catch(() => null);
    if (!data || !this.document.body) {
      return;
    }
    this.#removePageHooks();
    const doc = this.document;
    doc.body.replaceChildren();
    doc.body.className = "vapor-newtab-body";
    const root = doc.createElement("main");
    root.id = "vapor-newtab";
    if (/^(?:#|rgb|hsl|oklch|lab|color\(|linear-gradient|radial-gradient)/i.test(data.background || "")) {
      root.style.backgroundColor = data.background;
    } else if (data.background) {
      root.style.backgroundImage = `url("${String(data.background).replaceAll('"', '\\"')}")`;
    }
    const header = doc.createElement("header");
    const brand = doc.createElement("div");
    brand.className = "vapor-newtab-brand";
    brand.textContent = "VAPOR";
    const subtitle = doc.createElement("p");
    subtitle.textContent = "The web, evaporated of nonsense.";
    header.append(brand, subtitle);
    const form = doc.createElement("form");
    form.className = "vapor-newtab-search";
    const input = doc.createElement("input");
    input.type = "search";
    input.autocomplete = "off";
    input.placeholder = `Search with ${data.search?.name || "your workspace engine"}`;
    const button = doc.createElement("button");
    button.type = "submit";
    button.textContent = "Search";
    form.append(input, button);
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (input.value.trim()) this.sendQuery("VaporNewTab:Search", { query: input.value.trim() });
    });
    const sites = doc.createElement("section");
    sites.className = "vapor-newtab-sites";
    for (const site of data.sites || []) {
      const link = doc.createElement("a");
      link.href = site.url;
      link.textContent = site.title || site.url;
      sites.appendChild(link);
    }
    const templates = doc.createElement("section");
    templates.className = "vapor-newtab-templates";
    const templateTitle = doc.createElement("h2");
    templateTitle.textContent = "Workspace templates";
    templates.appendChild(templateTitle);
    for (const template of data.templates || []) {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = `${template.icon} ${template.name}`;
      button.title = template.description;
      button.addEventListener("click", () => this.sendQuery("VaporNewTab:ApplyTemplate", { name: template.name }));
      templates.appendChild(button);
    }
    const footer = doc.createElement("footer");
    footer.textContent = `You've vaporized ${data.killCount || 0} ads this week`;
    const customize = doc.createElement("details");
    const summary = doc.createElement("summary");
    summary.textContent = "Customize background";
    const background = doc.createElement("input");
    background.type = "text";
    background.placeholder = "Image URL or CSS color";
    background.value = data.background || "";
    background.addEventListener("change", () => this.sendQuery("VaporNewTab:SetBackground", { value: background.value }));
    customize.append(summary, background);
    root.append(header, form, sites, templates, footer, customize);
    doc.body.appendChild(root);
    input.focus();
  }
}
