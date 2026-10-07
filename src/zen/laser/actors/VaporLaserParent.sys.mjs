// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { Services } from "resource://gre/modules/Services.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VaporShield: "resource:///modules/zen/shield/VaporShield.sys.mjs",
  VaporKillCounter: "resource:///modules/zen/uichrome/VaporKillCounter.sys.mjs",
  VaporStats: "resource:///modules/zen/uichrome/VaporStats.sys.mjs",
});

/**
 * Parent half of the Laser actor. It owns the local blocklist write so page
 * content never receives profile-file access.
 */
export class VaporLaserParent extends JSWindowActorParent {
  #active = false;

  didDestroy() {
    this.#active = false;
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "VaporLaser:SetActive": {
        this.#active = !!message.data?.active;
        this.#broadcastState(this.#active);
        return this.#active;
      }
      case "VaporLaser:GetActive":
        return this.#active;
      case "VaporLaser:Deactivate":
        this.#active = false;
        this.#broadcastState(false);
        Services.obs.notifyObservers(null, "vapor-laser-deactivated");
        return false;
      case "VaporLaser:AddRules": {
        const { entries, pageURL, notes } = message.data || {};
        const added = await lazy.VaporShield.addLaserRules(entries, pageURL, notes);
        if (Array.isArray(added) && added.length) {
          await lazy.VaporKillCounter.record(added.length, "laser");
          await lazy.VaporStats.recordLaser({
            url: pageURL,
            source: "Laser",
            domains: added.map(rule => String(rule).replace(/^\|\|/, "").split(/[\^/]/, 1)[0]),
            count: added.length,
          });
          Services.obs.notifyObservers(null, "vapor-laser-zap", JSON.stringify({
            url: pageURL,
            count: added.length,
          }));
        }
        return added;
      }
      case "VaporLaser:RemoveRules":
        return lazy.VaporShield.removeUserRules(message.data?.rules || []);
    }
    return null;
  }

  #broadcastState(active) {
    this.sendAsyncMessage("VaporLaser:State", { active });
    this.#broadcastToDescendants(this.browsingContext, active);
  }

  #broadcastToDescendants(context, active) {
    for (const child of context.children || []) {
      try {
        child.currentWindowGlobal
          ?.getActor("VaporLaser")
          .sendAsyncMessage("VaporLaser:State", { active });
      } catch {}
      this.#broadcastToDescendants(child, active);
    }
  }
}
