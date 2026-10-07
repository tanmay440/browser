/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";

const TAB_HIBERNATED_ATTRIBUTE = "vapor-hibernated";
const HIBERNATION_PREF = "vapor.tabs.hibernation-timeout-minutes";
const SNAPSHOT_DIRECTORY = "vapor-snapshots";
const CRASH_LOG_FILE = "vapor-crashes.json";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VaporBroom: "resource:///modules/zen/privacy/VaporBroom.sys.mjs",
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

function routeIcon(type) {
  return { tor: "🧅", scramjet: "🚀", regular: "🟢" }[type] || "";
}

function isUsableURL(url) {
  return url && !url.startsWith("about:tabcrashed");
}

class VaporTabManagementService {
  #windows = new Set();
  #lastFocused = new WeakMap();
  #hibernationTimer = null;
  #searchPanels = new WeakMap();
  #workspaceListeners = new WeakSet();
  #crashLogPromise = null;

  init(window) {
    if (!window?.gBrowser || this.#windows.has(window)) {
      return;
    }
    this.#windows.add(window);
    for (const tab of window.gBrowser.tabs) {
      this.#lastFocused.set(tab, Date.now());
      try {
        if (lazy.SessionStore.getCustomTabValue(tab, "vapor-global-pin") === "true") {
          tab.setAttribute("vapor-global-pin", "true");
        }
      } catch {}
    }
    window.addEventListener("keydown", this, true);
    window.addEventListener("TabSelect", this);
    window.addEventListener("TabOpen", this);
    window.addEventListener("TabClose", this);
    this.#installContextMenu(window);
    this.#installWorkspaceListener(window);
    window.setTimeout(() => this.#installWorkspaceListener(window), 0);
    this.#startHibernationTimer();
    window.addEventListener("unload", () => {
      window.removeEventListener("keydown", this, true);
      for (const type of ["TabSelect", "TabOpen", "TabClose"]) {
        window.removeEventListener(type, this);
      }
      this.#windows.delete(window);
      if (!this.#windows.size && this.#hibernationTimer) {
        clearInterval(this.#hibernationTimer);
        this.#hibernationTimer = null;
      }
    }, { once: true });
  }

  #installWorkspaceListener(window) {
    if (this.#workspaceListeners.has(window) || !window.gZenWorkspaces?.addChangeListeners) {
      return;
    }
    this.#workspaceListeners.add(window);
    window.gZenWorkspaces.addChangeListeners(async ({ workspace }) => {
      if (workspace?.rememberedSitesScope === "workspace") {
        await lazy.VaporBroom.setRememberedSites((workspace.rememberedSites || []).join("\n"));
      }
    });
  }

  handleEvent(event) {
    const window = event.currentTarget?.window === event.currentTarget
      ? event.currentTarget
      : event.target?.ownerGlobal;
    switch (event.type) {
      case "keydown":
        if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "a") {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.openTabSearch(window || event.view);
        }
        break;
      case "TabSelect":
        if (event.target?.hasAttribute(TAB_HIBERNATED_ATTRIBUTE)) {
          this.#wakeTab(event.target);
        }
        this.#lastFocused.set(event.target, Date.now());
        break;
      case "TabOpen":
        this.#lastFocused.set(event.target, Date.now());
        break;
      case "TabClose":
        if (event.target?.hasAttribute("vapor-global-pin") && !event.target._vaporClosingCopies) {
          const url = event.target.linkedBrowser?.currentURI?.spec;
          const copies = (window?.gBrowser?.tabs || []).filter(tab =>
            tab !== event.target &&
            tab.hasAttribute("vapor-global-pin") &&
            tab.linkedBrowser?.currentURI?.spec === url
          );
          for (const copy of copies) {
            copy._vaporClosingCopies = true;
            window.gBrowser.removeTab(copy);
          }
        }
        this.#lastFocused.delete(event.target);
        break;
    }
  }

  getTabType(window, tab) {
    return window?.VaporRouting?.getTabType(tab) ||
      tab?.getAttribute("vapor-tab-type") ||
      "regular";
  }

  hibernateTab(window, tab = window?.TabContextMenu?.contextTab) {
    if (!window?.gBrowser || !tab || tab.closing) {
      return false;
    }
    if (tab.selected || tab.pinned || tab.hasAttribute("zen-essential")) {
      return false;
    }
    if (tab.hasAttribute("soundplaying") || tab.hasAttribute("pending")) {
      return false;
    }
    if (this.#hasUnsavedFormData(tab)) {
      return false;
    }
    try {
      window.gBrowser.discardBrowser(tab);
      tab.setAttribute(TAB_HIBERNATED_ATTRIBUTE, "true");
      tab.setAttribute("vapor-hibernated-at", String(Date.now()));
      return true;
    } catch (error) {
      console.error("Vapor tab hibernation failed", error);
      return false;
    }
  }

  hibernateOtherTabs(window, tab = window?.TabContextMenu?.contextTab) {
    const workspaceId = tab?.getAttribute("zen-workspace-id");
    let count = 0;
    for (const candidate of window?.gBrowser?.tabs || []) {
      if (candidate === tab || candidate.getAttribute("zen-workspace-id") !== workspaceId) {
        continue;
      }
      count += this.hibernateTab(window, candidate) ? 1 : 0;
    }
    return count;
  }

  closeDuplicateTabs(window) {
    const seen = new Map();
    const duplicates = [];
    for (const tab of window?.gBrowser?.tabs || []) {
      if (tab.pinned || tab.hasAttribute("zen-essential") || tab.hasAttribute("zen-empty-tab")) {
        continue;
      }
      const url = tab.linkedBrowser?.currentURI?.spec;
      if (!isUsableURL(url)) {
        continue;
      }
      if (seen.has(url)) {
        duplicates.push(tab);
      } else {
        seen.set(url, tab);
      }
    }
    if (duplicates.length) {
      window.gBrowser.removeTabs(duplicates, { closeWindowWithLastTab: false });
    }
    return duplicates.length;
  }

  async closeAllTabsInWorkspace(window, workspaceId = window?.gZenWorkspaces?.activeWorkspace) {
    const confirmed = Services.prompt.confirm(
      window,
      "Close workspace tabs",
      "Close all tabs in this workspace?"
    );
    if (!confirmed) {
      return 0;
    }
    const tabs = (window.gZenWorkspaces?.allStoredTabs || window.gBrowser.tabs).filter(tab =>
      tab.getAttribute("zen-workspace-id") === workspaceId &&
      !tab.hasAttribute("zen-empty-tab") &&
      !tab.hasAttribute("zen-essential")
    );
    if (tabs.length) {
      window.gBrowser.removeTabs(tabs, { closeWindowWithLastTab: false });
    }
    return tabs.length;
  }

  closeAllNonTorTabs(window) {
    const tabs = window?.gBrowser?.tabs.filter(tab =>
      !tab.hasAttribute("zen-essential") &&
      !tab.hasAttribute("zen-empty-tab") &&
      this.getTabType(window, tab) !== "tor"
    ) || [];
    if (tabs.length) {
      window.gBrowser.removeTabs(tabs, { closeWindowWithLastTab: false });
    }
    return tabs.length;
  }

  pinGlobally(window, tab = window?.TabContextMenu?.contextTab) {
    if (!tab || tab.hasAttribute("zen-essential")) {
      return false;
    }
    const manager = window.gZenPinnedTabManager;
    if (!manager?.addToEssentials(tab)) {
      return false;
    }
    tab.setAttribute("vapor-global-pin", "true");
    try {
      lazy.SessionStore.setCustomTabValue(tab, "vapor-global-pin", "true");
    } catch {}
    return true;
  }

  async openTabSearch(window) {
    if (!window?.gBrowser) {
      return;
    }
    let panel = this.#searchPanels.get(window);
    if (!panel) {
      panel = this.#createSearchPanel(window);
      this.#searchPanels.set(window, panel);
    }
    panel.input.value = "";
    this.#renderSearchResults(window, panel, "");
    panel.panel.openPopup(window.gBrowser.selectedTab, "after_start", 0, 0, false, false);
    panel.input.focus();
  }

  #createSearchPanel(window) {
    const panel = window.document.createXULElement("panel");
    panel.id = "vapor-tab-search-panel";
    panel.setAttribute("orient", "vertical");
    panel.setAttribute("noautofocus", "true");
    const input = window.document.createXULElement("textbox");
    input.id = "vapor-tab-search-input";
    input.setAttribute("placeholder", "Search all tabs");
    const results = window.document.createXULElement("richlistbox");
    results.id = "vapor-tab-search-results";
    results.setAttribute("flex", "1");
    panel.append(input, results);
    window.document.getElementById("mainPopupSet")?.appendChild(panel);
    input.addEventListener("input", () => this.#renderSearchResults(window, { panel, input, results }, input.value));
    return { panel, input, results };
  }

  #renderSearchResults(window, panel, query) {
    panel.results.replaceChildren();
    const matches = (window.gZenWorkspaces?.allStoredTabs || window.gBrowser.tabs)
      .filter(tab => !tab.closing && !tab.hasAttribute("zen-empty-tab"))
      .map(tab => {
        const title = tab.getAttribute("label") || tab.linkedBrowser?.contentTitle || "Untitled";
        const url = tab.linkedBrowser?.currentURI?.spec || "";
        const workspace = window.gZenWorkspaces?.getWorkspaceFromId(tab.getAttribute("zen-workspace-id"));
        const text = `${title} ${url} ${workspace?.name || ""}`.toLowerCase();
        return { tab, title, url, workspace, score: this.#fuzzyScore(query, text) };
      })
      .filter(item => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 80);
    for (const item of matches) {
      const row = window.document.createXULElement("richlistitem");
      row.className = "vapor-tab-search-result";
      row.setAttribute("label", `${routeIcon(this.getTabType(window, item.tab))} ${item.title}`);
      row.setAttribute("description", `${item.url} · ${item.workspace?.name || "Workspace"}`);
      row.tab = item.tab;
      let activated = false;
      const activate = async () => {
        if (activated) {
          return;
        }
        activated = true;
        if (item.workspace?.uuid && window.gZenWorkspaces.activeWorkspace !== item.workspace.uuid) {
          await window.gZenWorkspaces.changeWorkspaceWithID(item.workspace.uuid);
        }
        window.gBrowser.selectedTab = item.tab;
        panel.panel.hidePopup();
      };
      row.addEventListener("command", activate);
      row.addEventListener("click", activate);
      panel.results.appendChild(row);
    }
  }

  #fuzzyScore(query, text) {
    query = query.trim().toLowerCase();
    if (!query) {
      return 0;
    }
    if (text.includes(query)) {
      return 1000 - text.indexOf(query);
    }
    let index = 0;
    let score = 0;
    for (const character of query) {
      index = text.indexOf(character, index);
      if (index === -1) {
        return -1;
      }
      score += 10 - Math.min(index, 9);
      index++;
    }
    return score;
  }

  async saveSnapshot(window, path = null) {
    const browserWindow = this.#browserWindow(window);
    const directory = PathUtils.join(PathUtils.profileDir, SNAPSHOT_DIRECTORY);
    await IOUtils.makeDirectory(directory, { createAncestors: true, ignoreExisting: true });
    path ||= PathUtils.join(directory, `snapshot-${Date.now()}.json`);
    const tabs = browserWindow.gZenWorkspaces?.allStoredTabs || browserWindow.gBrowser.tabs;
    const snapshot = {
      version: "1.0",
      saved_at: new Date().toISOString(),
      workspaces: browserWindow.gZenWorkspaces?.getWorkspaces?.() || [],
      tabs: tabs
        .filter(tab => !tab.hasAttribute("zen-empty-tab") && !tab.closing)
        .map(tab => this.#snapshotTab(browserWindow, tab)),
    };
    await IOUtils.writeUTF8(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    return path;
  }

  #snapshotTab(window, tab) {
    let scroll = null;
    try {
      const state = JSON.parse(lazy.SessionStore.getTabState(tab));
      const entry = state.entries?.[state.index - 1] || state.entries?.[0];
      scroll = entry?.scroll || null;
    } catch {}
    return {
      url: tab.linkedBrowser?.currentURI?.spec || "about:blank",
      title: tab.getAttribute("label") || "",
      workspace_id: tab.getAttribute("zen-workspace-id") || null,
      pinned: Boolean(tab.pinned),
      routing: window.VaporRouting?.getTabType(tab) || tab.getAttribute("vapor-tab-type") || "regular",
      scroll,
    };
  }

  async restoreSnapshot(window, path) {
    const browserWindow = this.#browserWindow(window);
    const snapshot = JSON.parse(await IOUtils.readUTF8(path));
    let restored = 0;
    for (const item of snapshot.tabs || []) {
      if (!isUsableURL(item.url)) {
        continue;
      }
      let tab;
      if (browserWindow.VaporRouting && ["tor", "scramjet", "regular"].includes(item.routing)) {
        tab = browserWindow.VaporRouting.openTab(browserWindow, item.routing, item.url, { inBackground: true });
      } else {
        tab = browserWindow.gBrowser.addTrustedTab(item.url, { inBackground: true, skipRoute: true });
      }
      if (item.workspace_id && browserWindow.gZenWorkspaces.getWorkspaceFromId(item.workspace_id)) {
        browserWindow.gZenWorkspaces.moveTabToWorkspace(tab, item.workspace_id);
      }
      if (item.pinned) {
        browserWindow.gBrowser.pinTab(tab);
      }
      if (item.scroll) {
        const scroll = item.scroll;
        tab.linkedBrowser?.addEventListener("load", () => {
          try {
            tab.linkedBrowser.contentWindow.scrollTo(Number(scroll.x) || 0, Number(scroll.y) || 0);
          } catch {}
        }, { once: true });
      }
      restored++;
    }
    return restored;
  }

  async logCrash(data = {}) {
    const path = PathUtils.join(PathUtils.profileDir, CRASH_LOG_FILE);
    if (!this.#crashLogPromise) {
      this.#crashLogPromise = IOUtils.readUTF8(path)
        .then(text => JSON.parse(text))
        .catch(() => []);
    }
    const entries = await this.#crashLogPromise;
    entries.unshift({
      time: Date.now(),
      url: data.url || "",
      title: data.title || "",
      memory: data.memory || "unknown",
      cause: data.cause || "content process crash",
      kind: "Crashes",
    });
    this.#crashLogPromise = IOUtils.writeUTF8(path, JSON.stringify(entries.slice(0, 100), null, 2)).then(() => entries);
    await this.#crashLogPromise;
    return entries[0];
  }

  async getCrashLog() {
    const path = PathUtils.join(PathUtils.profileDir, CRASH_LOG_FILE);
    try {
      return JSON.parse(await IOUtils.readUTF8(path));
    } catch {
      return [];
    }
  }

  #startHibernationTimer() {
    if (this.#hibernationTimer) {
      return;
    }
    this.#hibernationTimer = setInterval(() => this.#hibernateIdleTabs(), 30_000);
  }

  #hibernateIdleTabs() {
    const now = Date.now();
    for (const window of this.#windows) {
      for (const tab of window.gBrowser.tabs) {
        const timeout = this.#timeoutFor(window, tab);
        if (!timeout || now - (this.#lastFocused.get(tab) || now) < timeout) {
          continue;
        }
        this.hibernateTab(window, tab);
      }
    }
  }

  #timeoutFor(window, tab) {
    const workspace = window.gZenWorkspaces?.getWorkspaceFromId(tab.getAttribute("zen-workspace-id"));
    const configured = workspace?.tabHibernationTimeoutMinutes;
    const minutes = configured === undefined
      ? Services.prefs.getIntPref(HIBERNATION_PREF, 15)
      : Number(configured);
    return minutes > 0 ? minutes * 60_000 : 0;
  }

  #hasUnsavedFormData(tab) {
    try {
      const state = JSON.parse(lazy.SessionStore.getTabState(tab));
      return state.entries?.some(entry => entry.formdata && Object.keys(entry.formdata).length);
    } catch {
      return false;
    }
  }

  #wakeTab(tab) {
    tab.removeAttribute(TAB_HIBERNATED_ATTRIBUTE);
    tab.removeAttribute("vapor-hibernated-at");
    try {
      tab.ownerGlobal.gBrowser.reloadTab(tab);
    } catch {}
  }

  #installContextMenu(window) {
    const install = () => {
      const menu = window.document.getElementById("tabContextMenu");
      if (!menu || menu.querySelector("[data-vapor-tab-management]")) {
        return;
      }
      const separator = window.document.createXULElement("menuseparator");
      separator.setAttribute("data-vapor-tab-management", "true");
      const actions = [
        ["vapor-hibernate-tab", "Hibernate Tab", () => this.hibernateTab(window)],
        ["vapor-hibernate-other-tabs", "Hibernate Other Tabs", () => this.hibernateOtherTabs(window)],
        ["vapor-close-duplicate-tabs", "Close Duplicate Tabs", () => this.closeDuplicateTabs(window)],
        ["vapor-close-workspace-tabs", "Close All Tabs in This Workspace", () => this.closeAllTabsInWorkspace(window)],
        ["vapor-close-non-tor-tabs", "Close All Non-Tor Tabs", () => this.closeAllNonTorTabs(window)],
        ["vapor-pin-global-tab", "Pin Globally (All Workspaces)", () => this.pinGlobally(window)],
        ["vapor-close-global-tab", "Close Global Pinned Tab", () => {
          const tab = window.TabContextMenu?.contextTab;
          if (tab?.hasAttribute("vapor-global-pin")) {
            window.gBrowser.removeTab(tab);
          }
        }],
      ];
      menu.appendChild(separator);
      for (const [id, label, command] of actions) {
        const item = window.document.createXULElement("menuitem");
        item.id = id;
        item.setAttribute("label", label);
        item.setAttribute("data-vapor-tab-management", "true");
        item.addEventListener("command", command);
        menu.appendChild(item);
      }
      menu.addEventListener("popupshowing", () => {
        const tab = window.TabContextMenu?.contextTab;
        const pinned = Boolean(tab?.pinned);
        window.document.getElementById("vapor-pin-global-tab").hidden =
          !pinned || tab.hasAttribute("zen-essential");
        window.document.getElementById("vapor-close-global-tab").hidden =
          !tab?.hasAttribute("vapor-global-pin");
      });
    };
    install();
    window.addEventListener("DOMContentLoaded", install, { once: true });
    window.setTimeout(install, 0);
  }

  #browserWindow(window) {
    return window?.gBrowser ? window : lazy.BrowserWindowTracker.getTopWindow();
  }
}

export const VaporTabManagement = new VaporTabManagementService();
