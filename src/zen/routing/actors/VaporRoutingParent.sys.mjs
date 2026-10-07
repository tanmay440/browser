/* This Source Code Form is subject to the terms of the Mozilla Public
 * License.  You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Services } from "resource://gre/modules/Services.sys.mjs";

export class VaporRoutingParent extends JSWindowActorParent {
  #route = { type: "regular", proxyURL: "" };

  didDestroy() {
    this.#route = { type: "regular", proxyURL: "" };
  }

  receiveMessage(message) {
    switch (message.name) {
      case "VaporRouting:SetRoute":
        this.#route = {
          type: message.data?.type || "regular",
          proxyURL: message.data?.proxyURL || "",
        };
        this.sendAsyncMessage("VaporRouting:Route", this.#route);
        return true;
      case "VaporRouting:GetRoute": {
        // A new WindowGlobal gets a new actor parent. Read the route from the
        // browser tab as well as the message state so navigation cannot reset
        // Tor WebRTC protection to regular browsing.
        try {
          const browser = this.browsingContext.top.embedderElement;
          const tab = browser?.ownerGlobal?.gBrowser?.getTabForBrowser(browser);
          const type = tab?.getAttribute("vapor-tab-type") || this.#route.type;
          const proxyURL =
            type === "scramjet"
              ? Services.prefs.getStringPref("vapor.routing.scramjet.proxy", "")
              : this.#route.proxyURL;
          return { type, proxyURL };
        } catch {
          return this.#route;
        }
      }
      case "VaporRouting:Freeze":
        this.sendAsyncMessage("VaporRouting:Freeze", {
          reason: message.data?.reason || "Routing connection lost",
        });
        return true;
      case "VaporRouting:Unfreeze":
        this.sendAsyncMessage("VaporRouting:Unfreeze");
        return true;
      case "VaporRouting:CloseTab": {
        const browser = this.browsingContext.top.embedderElement;
        const win = browser?.ownerGlobal;
        const tab = win?.gBrowser?.getTabForBrowser(browser);
        if (tab) {
          win.gBrowser.removeTab(tab, { animate: true });
        }
        return true;
      }
      case "VaporRouting:Retry":
        // The browser-chrome heartbeat owns connectivity checks. The message
        // is deliberately acknowledged so the overlay button is responsive.
        return true;
    }
    return null;
  }
}
