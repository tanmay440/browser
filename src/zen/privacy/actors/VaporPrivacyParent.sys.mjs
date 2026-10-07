// This Source Code Form is subject to the terms of the Mozilla Public
// License, Version 2.0. If a copy of the MPL was not distributed with this
// file, see http://mozilla.org/MPL/2.0/.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VaporPrivacy: "resource:///modules/zen/privacy/VaporPrivacy.sys.mjs",
});

export class VaporPrivacyParent extends JSWindowActorParent {
  async receiveMessage(message) {
    switch (message.name) {
      case "VaporPrivacy:GetConfig":
        return lazy.VaporPrivacy.getBrowserPrivacyConfiguration(
          message.data?.host || "",
          message.data?.href || "",
        );
      case "VaporPrivacy:ClipboardReadRequest":
        return lazy.VaporPrivacy.requestClipboardPermission(
          message.data?.host || "",
          message.data?.href || "",
        );
      case "VaporPrivacy:TemporaryScripts":
        lazy.VaporPrivacy.allowTemporaryScripts(message.data?.host || "");
        return true;
      case "VaporPrivacy:Log":
        return lazy.VaporPrivacy.record(
          message.data?.kind || "Browser Privacy",
          message.data?.action || "action",
          message.data || {},
        );
    }
    return null;
  }
}
