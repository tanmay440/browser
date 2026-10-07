/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If you use this file, you may use, modify, and distribute
 * it only under the terms of the Mozilla Public License. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VaporTabManagement: "resource:///modules/zen/tabmanagement/VaporTabManagement.sys.mjs",
  VaporPrivacy: "resource:///modules/zen/privacy/VaporPrivacy.sys.mjs",
});

export class VaporTabManagementParent extends JSWindowActorParent {
  async receiveMessage(message) {
    const browser = this.browsingContext.top.embedderElement;
    const window = browser?.ownerGlobal;
    const tab = window?.gBrowser?.getTabForBrowser(browser);
    switch (message.name) {
      case "VaporTabManagement:Crash": {
        let memory = "unknown";
        try {
          const resident = Cc["@mozilla.org/memory-reporter-manager;1"]
            .getService(Ci.nsIMemoryReporterManager).resident;
          memory = `${Math.round(resident / (1024 * 1024))} MB resident`;
        } catch {}
        let url = message.data?.url || "";
        try {
          url = new URL(url).searchParams.get("url") || url;
        } catch {}
        return lazy.VaporTabManagement.logCrash({
          ...message.data,
          url,
          memory,
          cause: "content process crash",
        });
      }
      case "VaporTabManagement:reload":
        tab?.linkedBrowser?.reload();
        return true;
      case "VaporTabManagement:reload-without-scripts": {
        // Set a host-scoped script blocker rather than changing
        // javascript.enabled globally. The privacy actor consumes this state
        // at document start on the next load.
        let host = tab?.linkedBrowser?.currentURI?.host;
        if (!host) {
          try {
            host = new URL(message.data?.url || "").hostname;
          } catch {}
        }
        if (host) {
          await lazy.VaporPrivacy.setScriptState(host, "block-all");
        }
        tab?.setAttribute("vapor-reload-without-scripts", "true");
        tab?.linkedBrowser?.reload();
        return true;
      }
    }
    return false;
  }
}
