/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VaporNewTab: "resource:///modules/zen/uichrome/VaporNewTab.sys.mjs",
  VaporReadingList: "resource:///modules/zen/uichrome/VaporReadingList.sys.mjs",
  VaporUIChrome: "resource:///modules/zen/uichrome/VaporUIChrome.sys.mjs",
});

export class VaporUIChromeParent extends JSWindowActorParent {
  #browser() {
    return this.browsingContext.top.embedderElement;
  }

  #window() {
    return this.#browser()?.ownerGlobal;
  }

  async receiveMessage(message) {
    const browser = this.#browser();
    const window = this.#window();
    switch (message.name) {
      case "VaporUI:PageMetrics":
        lazy.VaporUIChrome.recordPageMetrics(browser, message.data);
        return true;
      case "VaporUI:SaveReadingList":
        return lazy.VaporReadingList.saveSnapshot(message.data);
      case "VaporUI:FollowLink":
        return lazy.VaporUIChrome.handleRedirectRequest(window, message.data?.url || "");
      case "VaporNewTab:GetData":
        return lazy.VaporNewTab.getData(window);
      case "VaporNewTab:Search":
        return lazy.VaporNewTab.search(window, message.data?.query || "");
      case "VaporNewTab:ApplyTemplate":
        return lazy.VaporNewTab.applyTemplate(window, message.data?.name || "");
      case "VaporNewTab:SetBackground":
        return lazy.VaporNewTab.setBackground(message.data?.value || "");
    }
    return null;
  }
}
