/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Services } from "resource://gre/modules/Services.sys.mjs";
import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { CustomizableUI } from "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs";
import { VaporScramjetClient } from "./VaporScramjetClient.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

const TAB_TYPE_ATTRIBUTE = "vapor-tab-type";
const TAB_STATUS_ATTRIBUTE = "vapor-route-status";
const TOR_PORT = 9050;
const TOR_BINARY = "C:\\Program Files\\Vapor\\tor\\tor.exe";
const TOR_IDENTITY_NAME = "Vapor Tor";
const SCRAMJET_IDENTITY_NAME = "Vapor Scramjet";
const OPENVPN_WIDGET_ID = "vapor-openvpn-button";
const ROUTING_PREF = "vapor.routing.";
const TOR_HEARTBEAT_MS = 3500;
const SCRAMJET_HEARTBEAT_MS = 5000;

const TAB_TYPES = new Set(["regular", "tor", "scramjet"]);
const TAB_TYPE_INFO = {
  regular: { label: "+ New Tab", icon: "", menuIcon: "🟢", color: "green" },
  tor: { label: "+ New Tor Tab", icon: "🧅", menuIcon: "🟣", color: "purple" },
  scramjet: {
    label: "+ New Scramjet Tab",
    icon: "🚀",
    menuIcon: "🔵",
    color: "blue",
  },
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Browser-chrome routing controller. Routing is selected by contextual
 * identity, then by a channel proxy filter, so selecting Tor or Scramjet never
 * changes network.proxy.* for regular tabs or for another browser window.
 */
export class VaporRoutingService {
  #initializedWindows = new Set();
  #contextRoutes = new Map();
  #identities = new Map();
  #proxyService = null;
  #proxyFilter = null;
  #torProcess = null;
  #torProcessOwned = false;
  #torStarting = null;
  #torOnline = false;
  #scramjetOnline = false;
  #scramjetLatency = null;
  #heartbeatTimer = null;
  #vpnState = "disconnected";
  #vpnProfile = "default.ovpn";
  #vpnWidgetRegistered = false;
  #vpnNotFoundShown = new WeakSet();
  #updatingLabels = new WeakSet();

  init(window) {
    if (!window?.gBrowser || this.#initializedWindows.has(window)) {
      return;
    }
    this.#initializedWindows.add(window);
    this.#registerProxyFilter();
    this.#registerOpenVPNWidget();
    this.#installNewTabMenus(window);
    this.#installContextMenus(window);

    window.addEventListener("keydown", this, true);
    window.addEventListener("TabOpen", this);
    window.addEventListener("TabClose", this);
    window.addEventListener("TabMove", this);
    window.addEventListener("TabSelect", this);
    window.addEventListener("TabAttrModified", this);

    for (const tab of window.gBrowser.tabs) {
      let type = tab.getAttribute(TAB_TYPE_ATTRIBUTE) || "regular";
      try {
        type =
          lazy.SessionStore.getCustomTabValue(tab, TAB_TYPE_ATTRIBUTE) || type;
      } catch {}
      this.#trackTab(tab, TAB_TYPES.has(type) ? type : "regular");
    }

    window.addEventListener(
      "unload",
      () => {
        window.removeEventListener("keydown", this, true);
        for (const eventName of [
          "TabOpen",
          "TabClose",
          "TabMove",
          "TabSelect",
          "TabAttrModified",
        ]) {
          window.removeEventListener(eventName, this);
        }
        this.#initializedWindows.delete(window);
        if (!this.#initializedWindows.size) {
          if (this.#heartbeatTimer) {
            clearTimeout(this.#heartbeatTimer);
            this.#heartbeatTimer = null;
          }
          this.#stopTorIfOwned();
        }
      },
      { once: true },
    );

    if (
      Services.prefs.getBoolPref(`${ROUTING_PREF}openvpn.auto-connect`, false)
    ) {
      window.setTimeout(() => this.connectOpenVPN(window), 0);
    }
    this.#startHeartbeat();
  }

  handleEvent(event) {
    const window =
      event.currentTarget?.window === event.currentTarget
        ? event.currentTarget
        : event.target?.ownerGlobal;
    switch (event.type) {
      case "keydown":
        this.#handleShortcut(event, window || event.view);
        break;
      case "TabOpen":
        this.#onTabOpen(event.target, window || event.target?.ownerGlobal);
        break;
      case "TabClose":
        this.#onTabClose(event.target);
        break;
      case "TabMove":
        this.#warnIfMixedWorkspace(
          event.target,
          window || event.target?.ownerGlobal,
        );
        break;
      case "TabSelect":
        this.#updateSelectedStatus(window || event.target?.ownerGlobal);
        break;
      case "TabAttrModified":
        if (event.detail?.changed?.includes("label")) {
          this.#updateTabAppearance(event.target);
        }
        break;
    }
  }

  /**
   * Hook for workspace templates. Templates are intentionally not implemented
   * in Round 8; a workspace may provide `defaultTabType`, or callers can use
   * this local-first preference hook for one workspace at a time.
   */
  setWorkspaceDefaultTabType(workspaceId, type) {
    if (!workspaceId || !TAB_TYPES.has(type)) {
      throw new Error("A workspace id and a valid tab type are required");
    }
    Services.prefs.setStringPref(
      `${ROUTING_PREF}workspace.${workspaceId}.default-tab-type`,
      type,
    );
  }

  getTabType(tab) {
    const type = tab?.getAttribute(TAB_TYPE_ATTRIBUTE);
    return TAB_TYPES.has(type) ? type : "regular";
  }

  openTab(window, type = null, url = "about:newtab", options = {}) {
    if (!window?.gBrowser) {
      return null;
    }
    type = type || this.#defaultTabType(window);
    if (type === "private") {
      return window.OpenBrowserWindow?.({ private: true });
    }
    if (!TAB_TYPES.has(type)) {
      type = "regular";
    }
    if (url === "about:newtab") {
      const workspace =
        window.gZenWorkspaces?.getActiveWorkspace?.() ||
        window.gZenWorkspaces?.getActiveWorkspaceFromCache?.();
      url = workspace?.defaultNewTabUrl || url;
    }

    const identity = type === "regular" ? null : this.#ensureIdentity(type);
    const proxyURL = type === "scramjet" ? this.#scramjetProxyURL() : "";
    if (type === "scramjet" && url && !url.startsWith("about:")) {
      url = VaporScramjetClient.rewriteURL(
        url,
        proxyURL,
        Services.prefs.getStringPref(
          `${ROUTING_PREF}scramjet.url-template`,
          "",
        ),
      );
    }

    const tab = window.gBrowser.addTrustedTab(url, {
      userContextId: identity?.userContextId || options.userContextId || 0,
      inBackground: false,
      skipRoute: true,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      ...options,
    });
    window.gBrowser.selectedTab = tab;
    this.#trackTab(tab, type, proxyURL);
    if (type === "tor") {
      this.#ensureTor().catch((error) =>
        console.error("Vapor Tor startup failed", error),
      );
    } else if (type === "scramjet") {
      this.#warnIfVPNIsDisconnected(window, type);
    } else {
      this.#warnIfVPNIsDisconnected(window, type);
    }
    return tab;
  }

  async connectOpenVPN(window, force = false) {
    if (this.#vpnState === "connected" || this.#vpnState === "connecting") {
      return true;
    }
    const executable = this.#findOpenVPNExecutable();
    if (!executable) {
      this.#vpnState = "disconnected";
      this.#updateVPNWidgets();
      if (!force || !this.#vpnNotFoundShown.has(window)) {
        this.#vpnNotFoundShown.add(window);
        this.#showToast(window, "vapor-openvpn-not-found", {
          buttons: [
            {
              id: "vapor-openvpn-download",
              l10nId: "vapor-openvpn-download",
              command: () =>
                window.gBrowser.addTrustedTab(
                  "https://openvpn.net/community-downloads/",
                ),
            },
          ],
        });
      }
      return false;
    }

    this.#vpnState = "connecting";
    this.#vpnProfile =
      Services.prefs
        .getStringPref(`${ROUTING_PREF}openvpn.profile`, "default.ovpn")
        .trim() || "default.ovpn";
    this.#updateVPNWidgets();
    try {
      const process = Cc["@mozilla.org/process/util;1"].createInstance(
        Ci.nsIProcess,
      );
      process.init(executable);
      process.startHidden = true;
      process.noShell = true;
      const args = ["--connect", this.#vpnProfile];
      process.runwAsync(
        args,
        args.length,
        {
          observe: (_subject, topic) => {
            if (
              topic === "process-finished" &&
              this.#vpnState !== "disconnected"
            ) {
              this.#vpnState = "disconnected";
              this.#updateVPNWidgets();
            }
          },
        },
        false,
      );
      await delay(1500);
      if (this.#vpnState === "connecting") {
        this.#vpnState = "connected";
        this.#updateVPNWidgets();
      }
      return true;
    } catch (error) {
      console.error("OpenVPN launch failed", error);
      this.#vpnState = "disconnected";
      this.#updateVPNWidgets();
      this.#showToast(window, "vapor-openvpn-not-found");
      return false;
    }
  }

  async disconnectOpenVPN(window) {
    if (this.#vpnState === "disconnected") {
      return;
    }
    const executable = this.#findOpenVPNExecutable();
    this.#vpnState = "disconnected";
    this.#updateVPNWidgets();
    if (!executable) {
      return;
    }
    try {
      const process = Cc["@mozilla.org/process/util;1"].createInstance(
        Ci.nsIProcess,
      );
      process.init(executable);
      const args = ["--command", "disconnect", this.#vpnProfile];
      process.runwAsync(args, args.length, null, false);
    } catch (error) {
      console.error("OpenVPN disconnect failed", error);
    }
    this.#showToast(window, "vapor-openvpn-disconnected");
  }

  #handleShortcut(event, window) {
    if (!window || event.defaultPrevented || !event.ctrlKey || event.metaKey) {
      return;
    }
    const key = event.key.toLowerCase();
    let type = null;
    if (key === "t" && event.shiftKey && !event.altKey) {
      type = "tor";
    } else if (key === "t" && event.altKey && !event.shiftKey) {
      type = "scramjet";
    } else if (key === "p" && event.shiftKey && !event.altKey) {
      type = "private";
    } else if (key === "t" && !event.shiftKey && !event.altKey) {
      type = "regular";
    }
    if (!type) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.openTab(window, type);
  }

  #defaultTabType(window) {
    const workspace =
      window.gZenWorkspaces?.getActiveWorkspace?.() ||
      window.gZenWorkspaces?.getActiveWorkspaceFromCache?.();
    if (TAB_TYPES.has(workspace?.defaultTabType)) {
      return workspace.defaultTabType;
    }
    const workspaceId = workspace?.uuid || workspace?.id;
    if (workspaceId) {
      const value = Services.prefs.getStringPref(
        `${ROUTING_PREF}workspace.${workspaceId}.default-tab-type`,
        "",
      );
      if (TAB_TYPES.has(value)) {
        return value;
      }
    }
    const value = Services.prefs.getStringPref(
      `${ROUTING_PREF}default-tab-type`,
      "regular",
    );
    return TAB_TYPES.has(value) ? value : "regular";
  }

  #trackTab(tab, type, proxyURL = "") {
    if (!tab || !TAB_TYPES.has(type)) {
      return;
    }
    tab.setAttribute(TAB_TYPE_ATTRIBUTE, type);
    try {
      lazy.SessionStore.setCustomTabValue(tab, TAB_TYPE_ATTRIBUTE, type);
    } catch {}
    if (type !== "regular") {
      const userContextId = tab.userContextId || 0;
      this.#contextRoutes.set(userContextId, { type, proxyURL });
    }
    this.#updateTabAppearance(tab);
    this.#sendRouteToActor(tab, type, proxyURL);
  }

  #onTabOpen(tab, window) {
    if (!tab || !window) {
      return;
    }
    let type = this.getTabType(tab);
    let proxyURL = "";
    if (
      type === "regular" &&
      tab.owner &&
      this.getTabType(tab.owner) === "tor"
    ) {
      // Firefox's normal middle-click path supplies ownerTab. Inheriting here
      // keeps Tor tabs isolated without changing the global new-tab command.
      type = "tor";
      proxyURL = "";
    }
    this.#trackTab(tab, type, proxyURL);
    this.#warnIfMixedWorkspace(tab, window);
  }

  #onTabClose(tab) {
    if (!tab) {
      return;
    }
    if (this.getTabType(tab) === "tor") {
      // TabClose can fire before the tab is removed from gBrowser.tabs.
      setTimeout(() => {
        if (
          !this.#hasTabType("tor") &&
          Services.prefs.getBoolPref(
            `${ROUTING_PREF}tor.kill-on-last-tab`,
            true,
          )
        ) {
          this.#stopTorIfOwned();
        }
      }, 0);
    }
  }

  #updateSelectedStatus(window) {
    const tab = window?.gBrowser?.selectedTab;
    if (tab) {
      this.#updateTabAppearance(tab);
    }
  }

  #updateTabAppearance(tab) {
    if (!tab || !TAB_TYPES.has(this.getTabType(tab))) {
      return;
    }
    const type = this.getTabType(tab);
    const icon = TAB_TYPE_INFO[type].icon;
    let baseLabel = tab.getAttribute("vapor-route-base-label");
    let label = tab.getAttribute("label");
    if (!baseLabel) {
      baseLabel = label || "";
    } else if (
      !this.#updatingLabels.has(tab) &&
      icon &&
      label &&
      !label.startsWith(`${icon} `)
    ) {
      baseLabel = label;
    }
    tab.setAttribute("vapor-route-base-label", baseLabel);
    this.#updatingLabels.add(tab);
    try {
      if (icon && !label?.startsWith(`${icon} `)) {
        tab.setAttribute("label", `${icon} ${baseLabel}`);
      } else if (!icon && label?.startsWith("🧅 ")) {
        tab.setAttribute("label", baseLabel);
      } else if (!icon && label?.startsWith("🚀 ")) {
        tab.setAttribute("label", baseLabel);
      }
    } finally {
      this.#updatingLabels.delete(tab);
    }
    const status = this.#routeStatus(type);
    tab.setAttribute(TAB_STATUS_ATTRIBUTE, status);
    const oldTooltip = tab.getAttribute("vapor-route-base-tooltip");
    if (!oldTooltip) {
      tab.setAttribute(
        "vapor-route-base-tooltip",
        tab.getAttribute("tooltiptext") || "",
      );
    }
    const baseTooltip = tab.getAttribute("vapor-route-base-tooltip");
    tab.setAttribute("tooltiptext", `${baseTooltip}\n${status}`.trim());
    this.#sendRouteToActor(
      tab,
      type,
      type === "scramjet" ? this.#scramjetProxyURL() : "",
    );
  }

  #routeStatus(type) {
    if (type === "tor") {
      return `TOR | Exit: unknown | Circuit: 3 hops${this.#torOnline ? "" : " | Offline"}`;
    }
    if (type === "scramjet") {
      const proxy = this.#scramjetProxyURL() || "not configured";
      let host = proxy;
      try {
        host = new URL(proxy).host;
      } catch {}
      const latency =
        this.#scramjetLatency === null
          ? "checking"
          : `${this.#scramjetLatency}ms`;
      return `SCRAMJET | Proxy: ${host} | Latency: ${latency}${this.#scramjetOnline ? "" : " | Unreachable"}`;
    }
    return "REGULAR | System network";
  }

  #installNewTabMenus(window) {
    const install = () => {
      const buttons = window.document.querySelectorAll(
        "#tabs-newtab-button, #vertical-tabs-newtab-button",
      );
      for (const button of buttons) {
        if (button.querySelector("menupopup[data-vapor-routing-menu]")) {
          continue;
        }
        button.removeAttribute("command");
        button.setAttribute("type", "menu");
        const popup = window.document.createXULElement("menupopup");
        popup.setAttribute("data-vapor-routing-menu", "true");
        for (const [type, info] of Object.entries(TAB_TYPE_INFO)) {
          const item = window.document.createXULElement("menuitem");
          item.setAttribute("label", `${info.label} ${info.menuIcon}`.trim());
          item.setAttribute("class", `vapor-new-tab-menu-${info.color}`);
          item.addEventListener("command", () => this.openTab(window, type));
          popup.appendChild(item);
        }
        const separator = window.document.createXULElement("menuseparator");
        popup.appendChild(separator);
        const privateItem = window.document.createXULElement("menuitem");
        privateItem.setAttribute("label", "+ New Private Tab ⚫");
        privateItem.addEventListener("command", () =>
          this.openTab(window, "private"),
        );
        popup.appendChild(privateItem);
        button.appendChild(popup);
      }
    };
    install();
    window.addEventListener("DOMContentLoaded", install, { once: true });
    window.setTimeout(install, 0);
  }

  #installContextMenus(window) {
    const install = () => {
      const contentMenu = window.document.getElementById(
        "contentAreaContextMenu",
      );
      if (
        contentMenu &&
        !contentMenu.querySelector("[data-vapor-routing-link-menu]")
      ) {
        const separator = window.document.createXULElement("menuseparator");
        separator.setAttribute("data-vapor-routing-link-menu", "true");
        const tor = window.document.createXULElement("menuitem");
        tor.setAttribute("label", "Open in New Tor Tab 🧅");
        tor.setAttribute("data-vapor-routing-link-menu", "true");
        const regular = window.document.createXULElement("menuitem");
        regular.setAttribute("label", "Open in New Regular Tab ⚠️");
        regular.setAttribute("data-vapor-routing-link-menu", "true");
        const update = () => {
          const isLink = !!window.gContextMenu?.linkURL;
          const inTor = this.getTabType(window.gBrowser.selectedTab) === "tor";
          separator.hidden = !isLink;
          tor.hidden = !isLink;
          regular.hidden = !isLink || !inTor;
        };
        contentMenu.addEventListener("popupshowing", update);
        tor.addEventListener("command", () => {
          const url = window.gContextMenu?.linkURL;
          if (url) this.openTab(window, "tor", url);
        });
        regular.addEventListener("command", () => {
          const url = window.gContextMenu?.linkURL;
          if (url) {
            this.openTab(window, "regular", url);
            this.#showToast(window, "vapor-routing-mixed-warning");
          }
        });
        contentMenu.append(separator, tor, regular);
      }

      const tabMenu = window.document.getElementById("tabContextMenu");
      if (tabMenu && !tabMenu.querySelector("[data-vapor-routing-tab-menu]")) {
        const separator = window.document.createXULElement("menuseparator");
        separator.setAttribute("data-vapor-routing-tab-menu", "true");
        const tor = window.document.createXULElement("menuitem");
        tor.setAttribute("label", "Open Current URL in New Tor Tab 🧅");
        tor.setAttribute("data-vapor-routing-tab-menu", "true");
        const regular = window.document.createXULElement("menuitem");
        regular.setAttribute("label", "Open Current URL in New Regular Tab ⚠️");
        regular.setAttribute("data-vapor-routing-tab-menu", "true");
        const update = () => {
          const tab = window.TabContextMenu?.contextTab;
          const hasURL = !!tab?.linkedBrowser?.currentURI?.spec;
          separator.hidden = !hasURL;
          tor.hidden = !hasURL;
          regular.hidden = !hasURL || this.getTabType(tab) !== "tor";
        };
        tabMenu.addEventListener("popupshowing", update);
        tor.addEventListener("command", () => {
          const tab = window.TabContextMenu?.contextTab;
          const url = tab?.linkedBrowser?.currentURI?.spec;
          if (url) this.openTab(window, "tor", url);
        });
        regular.addEventListener("command", () => {
          const tab = window.TabContextMenu?.contextTab;
          const url = tab?.linkedBrowser?.currentURI?.spec;
          if (url) {
            this.openTab(window, "regular", url);
            this.#showToast(window, "vapor-routing-mixed-warning");
          }
        });
        tabMenu.append(separator, tor, regular);
      }
    };
    install();
    window.addEventListener("DOMContentLoaded", install, { once: true });
    window.setTimeout(install, 0);
  }

  #warnIfMixedWorkspace(tab, window) {
    if (!tab || !window?.gBrowser) {
      return;
    }
    const workspaceId = tab.getAttribute("zen-workspace-id");
    if (!workspaceId) {
      return;
    }
    const types = new Set(
      window.gBrowser.tabs
        .filter(
          (other) => other.getAttribute("zen-workspace-id") === workspaceId,
        )
        .map((other) => this.getTabType(other)),
    );
    if (types.size > 1) {
      this.#showToast(window, "vapor-routing-mixed-warning");
    }
  }

  #warnIfVPNIsDisconnected(window, type) {
    if (
      type === "regular" &&
      Services.prefs.getBoolPref(
        `${ROUTING_PREF}openvpn.warn-disconnected`,
        false,
      ) &&
      this.#vpnState === "disconnected"
    ) {
      this.#showToast(window, "vapor-openvpn-disconnected");
    }
  }

  #showToast(window, id, options = {}) {
    try {
      window.gZenUIManager?.showToast(id, options);
    } catch (error) {
      console.debug(`Vapor routing notification failed: ${id}`, error);
    }
  }

  #registerProxyFilter() {
    if (this.#proxyFilter) {
      return;
    }
    try {
      this.#proxyService = Cc[
        "@mozilla.org/network/protocol-proxy-service;1"
      ].getService(Ci.nsIProtocolProxyService);
      this.#proxyFilter = {
        applyFilter: (channel, proxy, callback) => {
          const contextId =
            channel?.loadInfo?.originAttributes?.userContextId || 0;
          const route = this.#contextRoutes.get(contextId);
          if (!route || route.type === "regular") {
            callback.onProxyFilterResult(proxy);
            return;
          }
          if (route.type === "tor") {
            callback.onProxyFilterResult(
              this.#proxyService.newProxyInfo(
                "socks",
                "127.0.0.1",
                TOR_PORT,
                "",
                `vapor-tor-${contextId}`,
                // SOCKS_V5 plus TRANSPARENT_PROXY_RESOLVES_HOST sends the
                // hostname to Tor for remote DNS. This is per-channel; do
                // not mutate the global network.proxy.socks_remote_dns pref.
                (Ci.nsIProxyInfo.SOCKS_V5 || 5) |
                  (Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST || 1),
                0,
                null,
              ),
            );
            return;
          }
          const parsed = this.#parseProxyURL(
            this.#scramjetProxyURL() || route.proxyURL,
          );
          if (!parsed) {
            // An intentionally invalid proxy is safer than returning the
            // incoming/direct proxy: it makes an unconfigured Scramjet tab
            // fail closed.
            callback.onProxyFilterResult(
              this.#proxyService.newProxyInfo(
                "http",
                "127.0.0.1",
                1,
                "",
                `vapor-scramjet-${contextId}`,
                0,
                0,
                null,
              ),
            );
            return;
          }
          callback.onProxyFilterResult(
            this.#proxyService.newProxyInfo(
              parsed.type,
              parsed.host,
              parsed.port,
              "",
              `vapor-scramjet-${contextId}`,
              parsed.flags,
              0,
              null,
            ),
          );
        },
      };
      this.#proxyService.registerChannelFilter(this.#proxyFilter, 0);
    } catch (error) {
      // Some test shells do not expose the channel-filter service. Routing UI
      // remains usable there, while a full Gecko build registers the filter.
      console.error("Vapor routing proxy filter registration failed", error);
      this.#proxyFilter = null;
    }
  }

  #parseProxyURL(value) {
    try {
      const url = new URL(value);
      if (!["http:", "https:", "socks:", "socks5:"].includes(url.protocol)) {
        return null;
      }
      const socks = url.protocol.startsWith("socks");
      return {
        type: socks ? "socks" : url.protocol.slice(0, -1),
        host: url.hostname,
        port:
          Number(url.port) ||
          (socks ? 1080 : url.protocol === "https:" ? 443 : 80),
        flags: socks
          ? (Ci.nsIProxyInfo.SOCKS_V5 || 5) |
            (Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST || 1)
          : 0,
      };
    } catch {
      return null;
    }
  }

  #ensureIdentity(type) {
    if (this.#identities.has(type)) {
      return this.#identities.get(type);
    }
    const name = type === "tor" ? TOR_IDENTITY_NAME : SCRAMJET_IDENTITY_NAME;
    const existing = lazy.ContextualIdentityService.getPublicIdentities().find(
      (identity) => identity.name === name,
    );
    const identity =
      existing ||
      lazy.ContextualIdentityService.create(
        name,
        "fingerprint",
        type === "tor" ? "purple" : "blue",
      );
    this.#identities.set(type, identity);
    return identity;
  }

  #scramjetProxyURL() {
    return Services.prefs
      .getStringPref(`${ROUTING_PREF}scramjet.proxy`, "")
      .trim();
  }

  #sendRouteToActor(tab, type, proxyURL) {
    try {
      const actor =
        tab.linkedBrowser?.browsingContext?.currentWindowGlobal?.getActor(
          "VaporRouting",
        );
      actor
        ?.sendQuery("VaporRouting:SetRoute", { type, proxyURL })
        .catch(() => {});
    } catch {}
  }

  #hasTabType(type) {
    for (const window of this.#initializedWindows) {
      if (window.gBrowser.tabs.some((tab) => this.getTabType(tab) === type)) {
        return true;
      }
    }
    return false;
  }

  #startHeartbeat() {
    if (this.#heartbeatTimer) {
      return;
    }
    const tick = async () => {
      this.#heartbeatTimer = null;
      if (this.#hasTabType("tor")) {
        const ready = await this.#ensureTor();
        this.#setRouteAvailability("tor", ready);
      } else {
        this.#torOnline = false;
      }
      if (this.#hasTabType("scramjet")) {
        const result = await this.#checkScramjet();
        this.#setRouteAvailability("scramjet", result.online);
        this.#scramjetLatency = result.latency;
      } else {
        this.#scramjetOnline = false;
        this.#scramjetLatency = null;
      }
      for (const window of this.#initializedWindows) {
        for (const tab of window.gBrowser.tabs) {
          if (this.getTabType(tab) !== "regular") {
            this.#updateTabAppearance(tab);
          }
        }
      }
      this.#heartbeatTimer = setTimeout(
        tick,
        Math.max(TOR_HEARTBEAT_MS, SCRAMJET_HEARTBEAT_MS),
      );
    };
    this.#heartbeatTimer = setTimeout(tick, 0);
  }

  #setRouteAvailability(type, online) {
    const wasOnline = type === "tor" ? this.#torOnline : this.#scramjetOnline;
    if (type === "tor") {
      this.#torOnline = online;
    } else {
      this.#scramjetOnline = online;
    }
    // Re-send the offline state on the first heartbeat as well as on a
    // transition. A newly opened tab must fail closed even when the initial
    // observed state was already offline.
    if (wasOnline === online && online) {
      return;
    }
    for (const window of this.#initializedWindows) {
      for (const tab of window.gBrowser.tabs) {
        if (this.getTabType(tab) !== type) {
          continue;
        }
        this.#sendRouteCommand(tab, online ? "Unfreeze" : "Freeze", {
          reason:
            type === "tor"
              ? "TOR CONNECTION LOST — Tab frozen to prevent IP leak."
              : "SCRAMJET PROXY UNREACHABLE — Tab frozen.",
        });
      }
    }
  }

  #sendRouteCommand(tab, command, data = {}) {
    try {
      const actor =
        tab.linkedBrowser?.browsingContext?.currentWindowGlobal?.getActor(
          "VaporRouting",
        );
      actor?.sendQuery(`VaporRouting:${command}`, data).catch(() => {});
    } catch {}
  }

  async #ensureTor() {
    if (this.#torStarting) {
      return this.#torStarting;
    }
    this.#torStarting = (async () => {
      try {
        if (await this.#isPortOpen("127.0.0.1", TOR_PORT)) {
          this.#torOnline = true;
          return true;
        }
        if (
          this.#torProcessOwned &&
          this.#torProcess &&
          !this.#torProcess.isRunning
        ) {
          this.#torProcessOwned = false;
          this.#torProcess = null;
        }
        if (!this.#torProcessOwned) {
          await this.#launchTor();
        }
        for (let attempt = 0; attempt < 24; attempt++) {
          if (await this.#isPortOpen("127.0.0.1", TOR_PORT)) {
            this.#torOnline = true;
            return true;
          }
          await delay(500);
        }
        this.#torOnline = false;
        return false;
      } catch (error) {
        this.#torOnline = false;
        console.error("Vapor Tor startup failed", error);
        return false;
      } finally {
        this.#torStarting = null;
      }
    })();
    return this.#torStarting;
  }

  async #launchTor() {
    const executable = this.#localFile(TOR_BINARY);
    if (!executable?.exists()) {
      throw new Error(`Bundled Tor binary was not found at ${TOR_BINARY}`);
    }
    const torData = PathUtils.join(PathUtils.profileDir, "tor-data");
    await IOUtils.makeDirectory(torData, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const torrc = PathUtils.join(PathUtils.profileDir, "vapor-torrc");
    await IOUtils.writeUTF8(
      torrc,
      [
        "SOCKSPort 9050",
        "ControlPort 9051",
        "CookieAuthentication 1",
        `DataDirectory "${torData}"`,
        "",
      ].join("\n"),
    );
    const process = Cc["@mozilla.org/process/util;1"].createInstance(
      Ci.nsIProcess,
    );
    process.init(executable);
    process.startHidden = true;
    process.noShell = true;
    const args = ["-f", torrc];
    process.runwAsync(args, args.length, null, false);
    this.#torProcess = process;
    this.#torProcessOwned = true;
  }

  #stopTorIfOwned() {
    if (!this.#torProcessOwned || !this.#torProcess) {
      return;
    }
    try {
      if (this.#torProcess.isRunning) {
        this.#torProcess.kill();
      }
    } catch (error) {
      console.debug("Vapor Tor shutdown failed", error);
    }
    this.#torProcess = null;
    this.#torProcessOwned = false;
  }

  #isPortOpen(host, port) {
    return new Promise((resolve) => {
      let transport;
      let stream;
      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          stream?.close();
          transport?.close(0);
        } catch {}
        resolve(result);
      };
      try {
        const service = Cc[
          "@mozilla.org/network/socket-transport-service;1"
        ].getService(Ci.nsISocketTransportService);
        transport = service.createTransport(["tcp"], host, port, null, null);
        transport.setTimeout(transport.TIMEOUT_CONNECT, 1500);
        transport.setEventSink(
          {
            onTransportStatus: (_transport, status) => {
              if (
                status === transport.STATUS_CONNECTED_TO ||
                status === transport.STATUS_SENDING_TO ||
                status === transport.STATUS_RECEIVING_FROM
              ) {
                finish(true);
              }
            },
          },
          Services.tm.currentThread,
        );
        stream = transport.openInputStream(0, 0, 0);
        setTimeout(() => finish(false), 1700);
      } catch {
        finish(false);
      }
    });
  }

  async #checkScramjet() {
    const proxy = this.#scramjetProxyURL();
    if (!proxy) {
      return { online: false, latency: null };
    }
    try {
      const url = new URL(proxy);
      const started = performance.now();
      const online = await this.#isPortOpen(
        url.hostname,
        Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      );
      return {
        online,
        latency: online ? Math.round(performance.now() - started) : null,
      };
    } catch {
      return { online: false, latency: null };
    }
  }

  #localFile(path) {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      return file;
    } catch {
      return null;
    }
  }

  #findOpenVPNExecutable() {
    const override = Services.prefs
      .getStringPref(`${ROUTING_PREF}openvpn.binary`, "")
      .trim();
    const candidates = override
      ? [override]
      : [
          "C:\\Program Files\\OpenVPN\\bin\\openvpn-gui.exe",
          "C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn-gui.exe",
          this.#openVPNRegistryPath(),
        ];
    for (const path of candidates) {
      const file = path && this.#localFile(path);
      if (file?.exists()) {
        return file;
      }
    }
    return null;
  }

  #openVPNRegistryPath() {
    try {
      const key = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
        Ci.nsIWindowsRegKey,
      );
      for (const view of [
        Ci.nsIWindowsRegKey.WOW64_64,
        Ci.nsIWindowsRegKey.WOW64_32,
      ]) {
        try {
          key.open(
            Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE,
            "SOFTWARE\\OpenVPN",
            Ci.nsIWindowsRegKey.ACCESS_READ | view,
          );
          if (key.hasValue("exe_path")) {
            const value = key.readStringValue("exe_path");
            key.close();
            return value;
          }
          key.close();
        } catch {}
      }
    } catch {}
    return "";
  }

  #registerOpenVPNWidget() {
    if (this.#vpnWidgetRegistered) {
      return;
    }
    try {
      if (!CustomizableUI.getWidget(OPENVPN_WIDGET_ID)) {
        CustomizableUI.createWidget({
          id: OPENVPN_WIDGET_ID,
          type: "button",
          defaultArea: CustomizableUI.AREA_NAVBAR,
          removable: true,
          label: "🛡️🔑 OpenVPN",
          tooltiptext: "OpenVPN",
          onCommand: (event) => {
            const window = event?.target?.ownerGlobal;
            if (
              this.#vpnState === "connected" ||
              this.#vpnState === "connecting"
            ) {
              this.disconnectOpenVPN(window);
            } else {
              this.connectOpenVPN(window, true);
            }
          },
          onCreated: (node) => {
            node.classList.add("vapor-openvpn-toolbarbutton");
            this.#updateVPNWidget(node.ownerGlobal);
            return node;
          },
        });
      }
      this.#vpnWidgetRegistered = true;
    } catch (error) {
      console.error("OpenVPN toolbar registration failed", error);
    }
  }

  #updateVPNWidgets() {
    for (const window of this.#initializedWindows) {
      this.#updateVPNWidget(window);
    }
  }

  #updateVPNWidget(window) {
    const button = window?.document?.getElementById(OPENVPN_WIDGET_ID);
    if (!button) {
      return;
    }
    button.setAttribute("vapor-vpn-state", this.#vpnState);
    button.setAttribute("aria-pressed", String(this.#vpnState === "connected"));
    button.setAttribute(
      "tooltiptext",
      this.#vpnState === "connecting"
        ? "OpenVPN — connecting"
        : this.#vpnState === "connected"
          ? "OpenVPN — connected (click to disconnect)"
          : "OpenVPN — disconnected",
    );
  }
}

export const VaporRouting = new VaporRoutingService();
