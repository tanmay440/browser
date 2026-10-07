/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";

const STATUS_PREF = "vapor.ui.status-bar.enabled";
const PALETTE_FILE = "vapor-command-palette.json";
const PAGE_METRICS_MESSAGE = "VaporUI:PageMetrics";
const UI_ATTRIBUTE = "data-vapor-ui";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  VaporBroom: "resource:///modules/zen/privacy/VaporBroom.sys.mjs",
  VaporFilter: "resource:///modules/zen/filter/VaporFilter.sys.mjs",
  VaporLaser: "resource:///modules/zen/laser/VaporLaser.sys.mjs",
  VaporNewTab: "resource:///modules/zen/uichrome/VaporNewTab.sys.mjs",
  VaporPrivacy: "resource:///modules/zen/privacy/VaporPrivacy.sys.mjs",
  VaporReadingList: "resource:///modules/zen/uichrome/VaporReadingList.sys.mjs",
  VaporRedirectInspector: "resource:///modules/zen/uichrome/VaporRedirectInspector.sys.mjs",
  VaporRouting: "resource:///modules/zen/routing/VaporRouting.sys.mjs",
  VaporShield: "resource:///modules/zen/shield/VaporShield.sys.mjs",
  VaporTabManagement: "resource:///modules/zen/tabmanagement/VaporTabManagement.sys.mjs",
  VaporWorkspaceTemplates: "resource:///modules/zen/templates/VaporWorkspaceTemplates.sys.mjs",
});

function browserForChannel(channel) {
  return channel?.loadInfo?.browsingContext?.top?.embedderElement || null;
}

function currentHost(window) {
  return window?.gBrowser?.selectedBrowser?.currentURI?.host || "";
}

function currentURL(window) {
  return window?.gBrowser?.selectedBrowser?.currentURI?.spec || "";
}

function isTextInput(target) {
  return target?.localName === "input" || target?.localName === "textarea" ||
    target?.isContentEditable || target?.id === "urlbar-input";
}

function safeLabel(value) {
  return String(value || "").replace(/[\r\n]/g, " ").slice(0, 200);
}

class VaporUIChromeService {
  #windows = new Set();
  #palettePanels = new WeakMap();
  #shortcutPanels = new WeakMap();
  #statusBars = new WeakMap();
  #stats = new WeakMap();
  #channelStats = new WeakMap();
  #downloadTimers = new WeakMap();
  #paletteDataPromise = null;
  #paletteDataCache = null;
  #observingNetwork = false;

  init(window) {
    if (!window?.gBrowser || this.#windows.has(window)) {
      return;
    }
    this.#windows.add(window);
    window.addEventListener("keydown", this, true);
    window.addEventListener("TabSelect", this);
    window.addEventListener("DOMContentLoaded", this, true);
    window.addEventListener("vapor-shield-blocked", this);
    window.addEventListener("unload", () => this.#uninit(window), { once: true });
    window.gBrowser.addTabsProgressListener(this);
    this.#installContextMenu(window);
    this.#installStatusBar(window);
    this.#observeNetwork();
    for (const tab of window.gBrowser.tabs) {
      this.#stats.set(tab.linkedBrowser, this.#newStats());
    }
  }

  #uninit(window) {
    window.removeEventListener("keydown", this, true);
    window.removeEventListener("TabSelect", this);
    window.removeEventListener("DOMContentLoaded", this, true);
    window.removeEventListener("vapor-shield-blocked", this);
    window.gBrowser.removeTabsProgressListener(this);
    const timer = this.#downloadTimers.get(window);
    if (timer) {
      window.clearInterval(timer);
    }
    this.#windows.delete(window);
    if (!this.#windows.size && this.#observingNetwork) {
      Services.obs.removeObserver(this, "http-on-modify-request");
      Services.obs.removeObserver(this, "http-on-stop-request");
      this.#observingNetwork = false;
    }
  }

  observe(subject, topic) {
    if (topic !== "http-on-modify-request" && topic !== "http-on-stop-request") {
      return;
    }
    let channel = subject;
    try {
      channel = subject?.QueryInterface?.(Ci.nsIChannel) || subject;
    } catch {
      return;
    }
    const browser = browserForChannel(channel);
    if (!browser) {
      return;
    }
    const stats = this.#statsFor(browser);
    if (topic === "http-on-modify-request") {
      stats.requests++;
      this.#channelStats.set(channel, stats);
    } else {
      try {
        const length = Number(channel.contentLength);
        if (length > 0) {
          stats.bytes += length;
        }
      } catch {}
      this.#channelStats.delete(channel);
    }
    this.#updateStatus(browser.ownerGlobal);
  }

  #observeNetwork() {
    if (this.#observingNetwork) {
      return;
    }
    this.#observingNetwork = true;
    Services.obs.addObserver(this, "http-on-modify-request");
    Services.obs.addObserver(this, "http-on-stop-request");
  }

  handleEvent(event) {
    const window = event.currentTarget?.window === event.currentTarget
      ? event.currentTarget
      : event.target?.ownerGlobal;
    if (event.type === "keydown") {
      if (event.defaultPrevented || isTextInput(event.target)) {
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.openCommandPalette(window || event.view);
      } else if ((event.key === "?" && !event.ctrlKey) ||
          (event.ctrlKey && !event.altKey && event.key === "/")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.openShortcutSheet(window || event.view);
      }
      return;
    }
    if (event.type === "TabSelect") {
      this.#updateStatus(window);
      this.#recordVisit(window);
      return;
    }
    if (event.type === "vapor-shield-blocked") {
      const browser = window?.gBrowser?.selectedBrowser;
      if (browser) {
        this.#statsFor(browser).blocked++;
        this.#updateStatus(window);
      }
    }
  }

  onStateChange(browser, webProgress, _request, stateFlags) {
    const flags = Ci.nsIWebProgressListener;
    if (!webProgress?.isTopLevel || !(stateFlags & flags.STATE_IS_DOCUMENT)) {
      return;
    }
    if (stateFlags & flags.STATE_START) {
      this.#stats.set(browser, this.#newStats());
      this.#updateStatus(browser.ownerGlobal);
    }
    if (stateFlags & flags.STATE_STOP) {
      this.#updateStatus(browser.ownerGlobal);
    }
  }

  onLocationChange(browser, webProgress, location) {
    if (!webProgress?.isTopLevel) {
      return;
    }
    this.#stats.set(browser, this.#newStats());
    this.#recordVisit(browser.ownerGlobal, location?.spec);
    this.#updateStatus(browser.ownerGlobal);
  }

  #newStats() {
    return { bytes: 0, requests: 0, blocked: 0, jsMs: 0, started: Date.now() };
  }

  #statsFor(browser) {
    if (!this.#stats.has(browser)) {
      this.#stats.set(browser, this.#newStats());
    }
    return this.#stats.get(browser);
  }

  recordPageMetrics(browser, metrics = {}) {
    if (!browser) {
      return;
    }
    const stats = this.#statsFor(browser);
    stats.jsMs = Number(metrics.jsMs) || 0;
    if (Number(metrics.bytes) > stats.bytes) {
      stats.bytes = Number(metrics.bytes);
    }
    if (Number(metrics.requests) > stats.requests) {
      stats.requests = Number(metrics.requests);
    }
    this.#updateStatus(browser.ownerGlobal);
  }

  #recordVisit(window, url = null) {
    const browser = window?.gBrowser?.selectedBrowser;
    const spec = url || browser?.currentURI?.spec;
    if (!browser || !/^https?:/i.test(spec || "")) {
      return;
    }
    lazy.VaporNewTab.recordVisit(spec, browser.contentTitle || "").catch(() => {});
  }

  #installStatusBar(window) {
    let bar = window.document.getElementById("vapor-status-bar");
    if (!bar) {
      bar = window.document.createXULElement("hbox");
      bar.id = "vapor-status-bar";
      bar.setAttribute(UI_ATTRIBUTE, "true");
      bar.setAttribute("role", "status");
      for (const [id, label] of [
        ["vapor-status-routing", "Routing"],
        ["vapor-status-shield", "Shield"],
        ["vapor-status-vpn", "VPN"],
        ["vapor-status-memory", "Memory"],
        ["vapor-status-download", "Downloads"],
        ["vapor-status-page", "Page"],
      ]) {
        const item = window.document.createXULElement("label");
        item.id = id;
        item.setAttribute("value", `${label}: —`);
        item.setAttribute(UI_ATTRIBUTE, "true");
        bar.appendChild(item);
      }
      window.document.getElementById("browser")?.appendChild(bar);
    }
    this.#statusBars.set(window, bar);
    this.#updateStatus(window);
    const timer = window.setInterval(() => this.#updateStatus(window), 1_500);
    this.#downloadTimers.set(window, timer);
  }

  async #updateStatus(window) {
    const bar = this.#statusBars.get(window);
    if (!bar) {
      return;
    }
    const enabled = Services.prefs.getBoolPref(STATUS_PREF, false);
    bar.hidden = !enabled;
    if (!enabled) {
      return;
    }
    const browser = window.gBrowser?.selectedBrowser;
    const tab = window.gBrowser?.selectedTab;
    const stats = this.#statsFor(browser);
    const route = lazy.VaporRouting.getTabType(tab);
    const memory = this.#memoryLabel();
    const downloads = await this.#downloadLabel();
    const bytes = stats.bytes > 1024 * 1024
      ? `${(stats.bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(stats.bytes / 1024)} KB`;
    const set = (id, value) => bar.ownerDocument.getElementById(id)?.setAttribute("value", value);
    set("vapor-status-routing", lazy.VaporRouting.getRouteStatus(tab) || `${route.toUpperCase()} · Exit IP: unavailable`);
    set("vapor-status-shield", `Shield: ${lazy.VaporShield.enabled ? "on" : "off"} · ${lazy.VaporShield.blockCount} blocked`);
    set("vapor-status-vpn", `VPN: ${lazy.VaporRouting.vpnState || "disconnected"}`);
    set("vapor-status-memory", `Memory: ${memory}`);
    set("vapor-status-download", `Downloads: ${downloads}`);
    set("vapor-status-page", `Page: ${bytes} · ${stats.requests} requests · ${stats.blocked} blocked · ${(stats.jsMs / 1000).toFixed(1)}s JS`);
  }

  #memoryLabel() {
    try {
      const resident = Cc["@mozilla.org/memory-reporter-manager;1"]
        .getService(Ci.nsIMemoryReporterManager).resident;
      return `${Math.round(resident / (1024 * 1024))} MB`;
    } catch {
      return "unavailable";
    }
  }

  async #downloadLabel() {
    try {
      const list = await Downloads.getList(Downloads.PUBLIC);
      const downloads = await list.getAll();
      const active = downloads.filter(download => !download.succeeded && !download.error && !download.canceled);
      if (!active.length) {
        return "idle";
      }
      const completed = active.reduce((sum, download) => sum + (download.currentBytes || 0), 0);
      const total = active.reduce((sum, download) => sum + (download.totalBytes || 0), 0);
      return total ? `${Math.round((completed / total) * 100)}%` : `${active.length} active`;
    } catch {
      return "unavailable";
    }
  }

  toggleStatusBar(window) {
    const enabled = !Services.prefs.getBoolPref(STATUS_PREF, false);
    Services.prefs.setBoolPref(STATUS_PREF, enabled);
    this.#updateStatus(window);
    return enabled;
  }

  async openCommandPalette(window) {
    if (!window?.gBrowser) {
      return;
    }
    let palette = this.#palettePanels.get(window);
    if (!palette) {
      palette = this.#createPalette(window);
      this.#palettePanels.set(window, palette);
    }
    palette.input.value = "";
    await this.#renderPalette(window, palette, "");
    palette.panel.openPopup(window.gBrowser.selectedTab, "overlap", 0, 0, false, false);
    palette.input.focus();
  }

  #createPalette(window) {
    const panel = window.document.createXULElement("panel");
    panel.id = "vapor-command-palette";
    panel.setAttribute("orient", "vertical");
    const input = window.document.createXULElement("textbox");
    input.id = "vapor-command-palette-input";
    input.setAttribute("placeholder", "Search Vapor commands, tabs, workspaces, bookmarks, and history");
    const results = window.document.createXULElement("richlistbox");
    results.id = "vapor-command-palette-results";
    results.setAttribute("flex", "1");
    panel.append(input, results);
    window.document.getElementById("mainPopupSet")?.appendChild(panel);
    const palette = { panel, input, results, items: [], selected: 0, renderID: 0 };
    input.addEventListener("input", () => this.#renderPalette(window, palette, input.value));
    input.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        panel.hidePopup();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        palette.selected = Math.max(0, Math.min(palette.items.length - 1, palette.selected + (event.key === "ArrowDown" ? 1 : -1)));
        this.#selectPaletteItem(palette);
      } else if (event.key === "Enter") {
        event.preventDefault();
        palette.items[palette.selected]?.run();
      }
    });
    return palette;
  }

  async #renderPalette(window, palette, query) {
    const id = ++palette.renderID;
    await this.#paletteData();
    const entries = await this.#paletteEntries(window);
    if (id !== palette.renderID) {
      return;
    }
    const needle = String(query || "").toLowerCase().trim();
    palette.items = entries
      .map(item => {
        const score = this.#fuzzyScore(needle, `${item.label} ${item.keywords || ""}`) + this.#rankScore(item.id);
        return {
          ...item,
          score,
          run: async () => {
            await this.#recordPalette(item.id);
            await item.run();
            this.#palettePanels.get(window)?.panel.hidePopup();
          },
        };
      })
      .filter(item => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
    palette.selected = 0;
    palette.results.replaceChildren();
    for (const item of palette.items) {
      const row = window.document.createXULElement("richlistitem");
      row.setAttribute("label", item.label);
      row.setAttribute("description", item.description || "");
      row.addEventListener("click", () => item.run());
      row.addEventListener("command", () => item.run());
      palette.results.appendChild(row);
    }
    this.#selectPaletteItem(palette);
  }

  #selectPaletteItem(palette) {
    palette.results.selectedIndex = palette.selected;
    palette.results.ensureIndexIsVisible(palette.selected);
  }

  #fuzzyScore(query, text) {
    if (!query) {
      return 100;
    }
    text = text.toLowerCase();
    if (text.includes(query)) {
      return 800 - text.indexOf(query);
    }
    let cursor = 0;
    let score = 0;
    for (const char of query) {
      cursor = text.indexOf(char, cursor);
      if (cursor < 0) {
        return -1;
      }
      score += 10;
      cursor++;
    }
    return score;
  }

  #rankScore(id) {
    const data = this.#paletteDataCache;
    const item = data?.items?.[id];
    return item ? Math.min(500, (item.frequency || 0) * 5 + Math.min(100, (Date.now() - item.lastUsed) < 86_400_000 ? 100 : 0)) : 0;
  }

  async #paletteData() {
    if (!this.#paletteDataPromise) {
      this.#paletteDataPromise = IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, PALETTE_FILE))
        .then(text => JSON.parse(text))
        .catch(() => ({ items: {} }))
        .then(data => {
          this.#paletteDataCache = data;
          return data;
        });
    }
    return this.#paletteDataPromise;
  }

  async #recordPalette(id) {
    const data = await this.#paletteData();
    data.items ||= {};
    data.items[id] ||= { frequency: 0, lastUsed: 0 };
    data.items[id].frequency++;
    data.items[id].lastUsed = Date.now();
    await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, PALETTE_FILE), `${JSON.stringify(data, null, 2)}\n`);
    this.#paletteDataCache = data;
    this.#paletteDataPromise = Promise.resolve(data);
  }

  async #paletteEntries(window) {
    const actions = this.#actions(window);
    const entries = [...actions];
    const tabs = window.gZenWorkspaces?.allStoredTabs || window.gBrowser.tabs || [];
    for (const tab of tabs) {
      if (tab.closing || tab.hasAttribute("zen-empty-tab")) continue;
      const workspace = window.gZenWorkspaces?.getWorkspaceFromId(tab.getAttribute("zen-workspace-id"));
      entries.push({
        id: `tab:${tab._tPos || tab.linkedBrowser?.browserId}`,
        label: `Tab: ${safeLabel(tab.getAttribute("label") || tab.linkedBrowser?.contentTitle || "Untitled")}`,
        description: `${tab.linkedBrowser?.currentURI?.spec || ""} · ${workspace?.name || "Workspace"}`,
        keywords: `${tab.linkedBrowser?.currentURI?.spec || ""} ${workspace?.name || ""}`,
        run: async () => {
          if (workspace?.uuid && window.gZenWorkspaces.activeWorkspace !== workspace.uuid) await window.gZenWorkspaces.changeWorkspaceWithID(workspace.uuid);
          window.gBrowser.selectedTab = tab;
          this.#palettePanels.get(window)?.panel.hidePopup();
        },
      });
    }
    for (const workspace of window.gZenWorkspaces?.getWorkspaces?.() || []) {
      entries.push({ id: `workspace:${workspace.uuid}`, label: `Workspace: ${workspace.icon || ""} ${workspace.name}`, keywords: "space workspace", run: async () => {
        await window.gZenWorkspaces.changeWorkspaceWithID(workspace.uuid);
        this.#palettePanels.get(window)?.panel.hidePopup();
      }});
    }
    entries.push(...this.#settingsEntries(window));
    entries.push(...await this.#placeEntries(window));
    return entries;
  }

  #settingsEntries(window) {
    const settings = [
      ["General", "paneGeneral"], ["Privacy", "panePrivacy"], ["Adblocker", "paneVaporShield"],
      ["Routing", "panePrivacy"], ["Workspaces", "paneZenTabManagement"], ["Tabs", "paneZenTabManagement"],
      ["Appearance", "paneZenLooks"], ["Advanced", "paneAdvanced"],
    ];
    return settings.map(([name, pane]) => ({
      id: `settings:${pane}:${name}`,
      label: `Open Settings: ${name}`,
      keywords: "preferences settings",
      run: () => { window.openPreferences?.(pane); this.#palettePanels.get(window)?.panel.hidePopup(); },
    }));
  }

  async #placeEntries(_window) {
    const entries = [];
    try {
      const root = lazy.PlacesUtils.history.getNewQuery();
      const options = lazy.PlacesUtils.history.getNewQueryOptions();
      options.sortingMode = options.SORT_BY_DATE_DESCENDING;
      options.maxResults = 20;
      const result = lazy.PlacesUtils.history.executeQuery(root, options).root;
      result.containerOpen = true;
      for (let i = 0; i < result.childCount; i++) {
        const node = result.getChild(i);
        if (!node.uri) continue;
        entries.push({ id: `history:${node.uri}`, label: `History: ${safeLabel(node.title || node.uri)}`, description: node.uri, keywords: node.uri, run: () => { _window.gBrowser.selectedBrowser.loadURI(node.uri, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); } });
      }
      result.containerOpen = false;
    } catch {}
    try {
      const db = await lazy.PlacesUtils.promiseDBConnection();
      const rows = await db.executeCached(`
        SELECT b.title AS title, p.url AS url
        FROM moz_bookmarks b
        JOIN moz_places p ON p.id = b.fk
        WHERE b.type = 1 AND p.url NOT LIKE 'place:%'
        ORDER BY b.lastModified DESC LIMIT 40
      `);
      for (const row of rows) {
        const url = row.getResultByName("url");
        entries.push({
          id: `bookmark:${url}`,
          label: `Bookmark: ${safeLabel(row.getResultByName("title") || url)}`,
          description: url,
          keywords: `${url} bookmark`,
          run: () => { _window.gBrowser.selectedBrowser.loadURI(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); },
        });
      }
    } catch {}
    return entries;
  }

  #actions(window) {
    const action = (id, label, keywords, run) => ({
      id, label, keywords, run: async () => { await run(); this.#palettePanels.get(window)?.panel.hidePopup(); },
    });
    const current = () => window.gBrowser.selectedBrowser;
    return [
      action("new-tor", "New Tor Tab", "routing onion private", () => lazy.VaporRouting.openTab(window, "tor")),
      action("new-scramjet", "New Scramjet Tab", "routing proxy", () => lazy.VaporRouting.openTab(window, "scramjet")),
      action("toggle-laser", "Toggle Laser", "vaporize ads", () => lazy.VaporLaser.toggle(window)),
      action("toggle-adblocker", "Toggle Adblocker", "shield ads", () => lazy.VaporShield.toggleGlobal()),
      action("hibernate-all", "Hibernate All Tabs", "sleep memory tabs", () => {
        for (const tab of window.gBrowser.tabs) lazy.VaporTabManagement.hibernateTab(window, tab);
      }),
      action("clear-cookies", "Clear Cookies for This Site", "broom privacy cookies", () => lazy.VaporBroom.deleteSite(current().currentURI.host, "full", "command")),
      action("block-domain", "Block This Domain", "shield block domain", () => {
        const host = current().currentURI.host;
        return lazy.VaporShield.addLaserRules([{ rule: `||${host}^` }], currentURL(window), [`Blocked by command palette: ${host}`]);
      }),
      action("toggle-vpn", "Connect/Disconnect VPN", "openvpn network", () => lazy.VaporRouting.vpnState === "connected" ? lazy.VaporRouting.disconnectOpenVPN(window) : lazy.VaporRouting.connectOpenVPN(window, true)),
      action("toggle-remembered", "Remember/Forget Current Site", "broom cookies login", () => lazy.VaporBroom.toggleRemembered(current().currentURI.host)),
      action("toggle-status", "Toggle Status Bar", "appearance chrome", () => this.toggleStatusBar(window)),
      action("open-settings", "Open Settings", "preferences", () => window.openPreferences?.()),
      action("open-about-vapor", "Open about:vapor", "activity dashboard", () => window.gBrowser.addTrustedTab("about:vapor")),
      action("open-reading-list", "Open Reading List", "articles pocket offline", () => window.gBrowser.addTrustedTab("about:reading")),
    ];
  }

  async openShortcutSheet(window) {
    if (!window?.document) return;
    let panel = this.#shortcutPanels.get(window);
    if (!panel) {
      panel = window.document.createXULElement("panel");
      panel.id = "vapor-shortcut-sheet";
      panel.setAttribute("orient", "vertical");
      const title = window.document.createXULElement("label");
      title.setAttribute("value", "Vapor Keyboard Shortcuts");
      title.className = "vapor-shortcut-title";
      const content = window.document.createXULElement("vbox");
      content.id = "vapor-shortcut-content";
      panel.append(title, content);
      window.document.getElementById("mainPopupSet")?.appendChild(panel);
      panel.addEventListener("keydown", event => { if (event.key === "Escape") panel.hidePopup(); });
      panel.addEventListener("popupshown", () => panel.focus());
      this.#shortcutPanels.set(window, panel);
    }
    const content = panel.querySelector("#vapor-shortcut-content");
    content.replaceChildren();
    const groups = {
      Navigation: [["Ctrl+K", "Command Palette"], ["? / Ctrl+/", "Shortcut cheat sheet"]],
      Tabs: [["Ctrl+T", "New tab"], ["Ctrl+Shift+T", "Restore closed tab"], ["Ctrl+Tab", "Next tab"]],
      Vapor: [["Ctrl+Shift+L", "Toggle Laser"], ["Ctrl+Shift+B", "Shield Breaker"], ["Escape", "Close overlays"]],
    };
    for (const [category, shortcuts] of Object.entries(groups)) {
      const heading = window.document.createXULElement("label");
      heading.setAttribute("value", category);
      heading.className = "vapor-shortcut-category";
      content.appendChild(heading);
      for (const [shortcut, label] of shortcuts) {
        const row = window.document.createXULElement("hbox");
        row.append(window.document.createXULElement("label"), window.document.createXULElement("label"));
        row.children[0].setAttribute("value", shortcut);
        row.children[1].setAttribute("value", label);
        row.children[0].className = "vapor-shortcut-key";
        content.appendChild(row);
      }
    }
    panel.openPopup(window.gBrowser?.selectedTab, "overlap", 0, 0, false, false);
  }

  #installContextMenu(window) {
    const install = () => {
      const menu = window.document.getElementById("contentAreaContextMenu");
      if (!menu || menu.querySelector("[data-vapor-ui-context]")) return;
      const separator = window.document.createXULElement("menuseparator");
      separator.setAttribute("data-vapor-ui-context", "true");
      menu.appendChild(separator);
      const make = (id, label, command) => {
        const item = window.document.createXULElement("menuitem");
        item.id = id;
        item.setAttribute("label", label);
        item.setAttribute("data-vapor-ui-context", "true");
        item.addEventListener("command", command);
        menu.appendChild(item);
        return item;
      };
      make("vapor-context-vaporize", "Vaporize This Element", () => this.#contentQuery(window, "VaporUI:VaporizeElement"));
      make("vapor-context-block-domain", "Block This Domain", () => this.#blockCurrentDomain(window));
      make("vapor-context-strip-link", "Strip Tracking Parameters from This Link", () => this.#copyCleanLink(window));
      const existingTor = menu.querySelector("[data-vapor-routing-link-menu][label*='Tor']");
      const tor = existingTor || make("vapor-context-open-tor", "Open in Tor Tab", () => this.#openContextLink(window, "tor"));
      tor.id = "vapor-context-open-tor";
      tor.setAttribute("data-vapor-ui-context", "true");
      if (existingTor) {
        tor.addEventListener("command", () => {
          if (!window.gContextMenu?.onLink) this.#openContextLink(window, "tor");
        });
      } else {
        tor.setAttribute("data-vapor-routing-link-menu", "true");
      }
      make("vapor-context-open-scramjet", "Open in Scramjet Tab", () => this.#openContextLink(window, "scramjet"));
      make("vapor-context-remember", "Remember/Forget This Site's Cookies", () => this.#toggleRemember(window));
      make("vapor-context-copy-clean", "Copy Clean Link", () => this.#copyCleanLink(window));
      make("vapor-context-reading-list", "Save to Reading List", () => this.#contentQuery(window, "VaporUI:SaveReadingList"));
      menu.addEventListener("popupshowing", () => this.#updateContextMenu(window));
    };
    install();
    window.setTimeout(install, 0);
    window.addEventListener("DOMContentLoaded", install, { once: true });
  }

  #updateContextMenu(window) {
    const context = window.gContextMenu;
    const onLink = !!context?.onLink;
    const showPage = !onLink;
    const showLink = onLink;
    const set = (id, hidden) => { const node = window.document.getElementById(id); if (node) node.hidden = hidden; };
    set("vapor-context-vaporize", false);
    set("vapor-context-block-domain", !currentHost(window));
    set("vapor-context-strip-link", !showLink);
    set("vapor-context-copy-clean", !showLink);
    set("vapor-context-open-tor", false);
    set("vapor-context-open-scramjet", false);
    set("vapor-context-remember", !showPage || !currentHost(window));
    set("vapor-context-reading-list", !showPage || !/^https?:/i.test(currentURL(window)));
    window.document.getElementById("vapor-context-open-tor")?.setAttribute("label", onLink ? "Open in New Tor Tab" : "Open in Tor Tab");
    window.document.getElementById("vapor-context-open-scramjet")?.setAttribute("label", onLink ? "Open in New Scramjet Tab" : "Open in Scramjet Tab");
    const remember = window.document.getElementById("vapor-context-remember");
    if (remember) remember.setAttribute("label", lazy.VaporBroom.isRemembered(currentHost(window)) ? "Forget This Site's Cookies" : "Remember This Site's Cookies");
    const clean = window.document.getElementById("vapor-context-strip-link");
    if (clean) clean.setAttribute("label", "Strip Tracking Parameters from This Link");
  }

  #contentQuery(window, name, data = {}) {
    try {
      const actor = window.gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor("VaporUIChrome");
      return actor.sendQuery(name, data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #blockCurrentDomain(window) {
    const host = currentHost(window);
    if (!host) return;
    return lazy.VaporShield.addLaserRules([{ rule: `||${host}^` }], currentURL(window), [`Blocked by context menu: ${host}`]);
  }

  #openContextLink(window, type) {
    const url = window.gContextMenu?.onLink ? window.gContextMenu.linkURL : currentURL(window);
    if (/^https?:/i.test(url || "")) lazy.VaporRouting.openTab(window, type, url);
  }

  #toggleRemember(window) {
    return lazy.VaporBroom.toggleRemembered(currentHost(window));
  }

  async #copyCleanLink(window) {
    const url = window.gContextMenu?.linkURL || currentURL(window);
    const clean = lazy.VaporPrivacy.cleanURL(url, { topLevel: true });
    Services.clipboard.copyString(clean.spec);
    if (clean.removed.length) {
      await lazy.VaporPrivacy.record("URL Stripping", "copied-clean-link", { removed: clean.removed, before: url, after: clean.spec });
    }
  }

  async handleRedirectRequest(window, url) {
    const browser = window?.gBrowser?.selectedBrowser;
    const tab = browser && window.gBrowser.getTabForBrowser(browser);
    if (lazy.VaporRouting.getTabType(tab) !== "regular") {
      return { allow: true, url };
    }
    const result = await lazy.VaporRedirectInspector.inspect(url);
    if (!result.redirected) {
      return { allow: true, url: result.final || url };
    }
    const panel = this.#makeRedirectPanel(window, result);
    return new Promise(resolve => {
      panel._vaporResolve = resolve;
      panel.openPopup(window.gBrowser.selectedTab, "overlap", 0, 0, false, false);
    });
  }

  #makeRedirectPanel(window, result) {
    let panel = window.document.getElementById("vapor-redirect-inspector");
    panel?.remove();
    panel = window.document.createXULElement("panel");
    panel.id = "vapor-redirect-inspector";
    panel.setAttribute("orient", "vertical");
    const title = window.document.createXULElement("label");
    title.setAttribute("value", `Redirect chain (${result.redirectCount || 0} redirects)`);
    panel.appendChild(title);
    const list = window.document.createXULElement("vbox");
    for (const hop of result.chain) {
      const row = window.document.createXULElement("label");
      row.setAttribute("value", `${hop.status || "?"} · ${hop.url}`);
      list.appendChild(row);
    }
    const final = window.document.createXULElement("label");
    final.setAttribute("value", `Final: ${result.final}`);
    panel.append(list, final);
    const buttons = window.document.createXULElement("hbox");
    const follow = window.document.createXULElement("button");
    follow.setAttribute("label", "Follow to Final");
    const copy = window.document.createXULElement("button");
    copy.setAttribute("label", "Copy Final URL");
    const cancel = window.document.createXULElement("button");
    cancel.setAttribute("label", "Cancel");
    buttons.append(follow, copy, cancel);
    panel.appendChild(buttons);
    follow.addEventListener("command", () => { panel.hidePopup(); panel._vaporResolve?.({ allow: true, url: result.final }); });
    copy.addEventListener("command", () => Services.clipboard.copyString(result.final));
    cancel.addEventListener("command", () => { panel.hidePopup(); panel._vaporResolve?.({ allow: false, url: result.original }); });
    window.document.getElementById("mainPopupSet")?.appendChild(panel);
    return panel;
  }
}

export const VaporUIChrome = new VaporUIChromeService();
export { PAGE_METRICS_MESSAGE };
