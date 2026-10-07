// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, see http://mozilla.org/MPL/2.0/.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VaporPrivacy: "resource:///modules/zen/privacy/VaporPrivacy.sys.mjs",
});

export class VaporPrivacyParent extends JSWindowActorParent {
  async receiveMessage(message) {
    switch (message.name) {
      case "VaporPrivacy:GetConfig":
        return {
          enabled: lazy.VaporPrivacy.speculativeLoadingBlocked,
          href: message.data?.href || "",
        };
      case "VaporPrivacy:Log":
        return lazy.VaporPrivacy.record(
          message.data?.kind || "Speculative Loading",
          message.data?.action || "blocked",
          message.data || {},
        );
    }
    return null;
  }
}
