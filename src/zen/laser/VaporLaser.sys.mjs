// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { Services } from "resource://gre/modules/Services.sys.mjs";
import { CustomizableUI } from "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs";

const WIDGET_ID = "vapor-laser-button";
const SHORTCUT_LABEL = "Ctrl+Shift+L";

/**
 * Browser-chrome controller for the Laser. DOM inspection and mutation stay in
 * the content process in VaporLaserChild; this object only controls the
 * selected tab and the customizable toolbar button.
 */
export class VaporLaserService {
  #initialized = false;
  #windows = new Set();
  #activeWindow = null;
  #activeBrowser = null;

  init(window) {
    if (this.#windows.has(window)) {
      this.#updateWidget(window);
      return;
    }

    this.#windows.add(window);
    this.#registerWidget();
    this.#updateWidget(window);

    const onTabSelect = () => {
      if (this.#activeWindow !== window) {
        return;
      }
      const browser = window.gBrowser.selectedBrowser;
      if (browser !== this.#activeBrowser) {
        this.deactivate(window);
      }
    };
    window.gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);

    const onUnload = () => {
      window.gBrowser.tabContainer.removeEventListener(
        "TabSelect",
        onTabSelect,
      );
      this.#windows.delete(window);
      if (this.#activeWindow === window) {
        this.#activeWindow = null;
        this.#activeBrowser = null;
      }
    };
    window.addEventListener("unload", onUnload, { once: true });

    if (!this.#initialized) {
      this.#initialized = true;
      Services.obs.addObserver(this, "vapor-laser-deactivated");
    }
  }

  observe(_subject, topic) {
    if (topic === "vapor-laser-deactivated") {
      const window = this.#activeWindow;
      if (window) {
        this.#activeWindow = null;
        this.#activeBrowser = null;
        this.#updateAllWidgets();
      }
    }
  }

  get active() {
    return !!this.#activeBrowser;
  }

  async toggle(window = null) {
    window ??= this.#windows.values().next().value;
    if (!window?.gBrowser) {
      return false;
    }

    const browser = window.gBrowser.selectedBrowser;
    if (browser === this.#activeBrowser) {
      await this.deactivate(window);
      return false;
    }

    if (this.#activeBrowser) {
      await this.#sendState(this.#activeBrowser, false);
    }
    this.#activeWindow = window;
    this.#activeBrowser = browser;
    await this.#sendState(browser, true);
    this.#updateAllWidgets();
    return true;
  }

  async deactivate(window = null) {
    if (!this.#activeBrowser) {
      return;
    }
    if (window && this.#activeWindow !== window) {
      return;
    }

    const browser = this.#activeBrowser;
    this.#activeWindow = null;
    this.#activeBrowser = null;
    await this.#sendState(browser, false);
    this.#updateAllWidgets();
  }

  #registerWidget() {
    try {
      if (CustomizableUI.getWidget(WIDGET_ID)) {
        return;
      }
      CustomizableUI.createWidget({
        id: WIDGET_ID,
        type: "button",
        defaultArea: CustomizableUI.AREA_NAVBAR,
        removable: true,
        label: "Laser",
        tooltiptext: `Laser (${SHORTCUT_LABEL})`,
        onCommand: (event) => {
          this.toggle(event?.target?.ownerGlobal || null);
        },
        onCreated: (node) => {
          node.classList.add("vapor-laser-toolbarbutton");
          this.#updateWidget(node.ownerGlobal);
          return node;
        },
      });
    } catch (error) {
      // CustomizableUI can be initializing when the first preloaded script
      // runs. init() retries registration for every browser window.
      console.error("Vapor Laser toolbar registration failed", error);
    }
  }

  async #sendState(browser, active) {
    try {
      const actor =
        browser.browsingContext.currentWindowGlobal.getActor("VaporLaser");
      await actor.sendQuery("VaporLaser:SetActive", { active });
    } catch (error) {
      // about:blank and teardown races can have no current WindowGlobal. The
      // toolbar still reflects the requested state and the next page will
      // receive the state from its actor's DOMContentLoaded handler.
      console.debug("Vapor Laser actor unavailable", error);
    }
  }

  #updateAllWidgets() {
    for (const window of this.#windows) {
      this.#updateWidget(window);
    }
  }

  #updateWidget(window) {
    const button = window?.document?.getElementById(WIDGET_ID);
    if (!button) {
      return;
    }
    const active = this.#activeWindow === window && !!this.#activeBrowser;
    button.toggleAttribute("laser-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute(
      "tooltiptext",
      active
        ? "Laser active — Escape to deactivate"
        : `Laser (${SHORTCUT_LABEL})`,
    );
  }
}

export const VaporLaser = new VaporLaserService();
