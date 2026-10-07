// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VaporFilter: "resource:///modules/zen/filter/VaporFilter.sys.mjs",
});

/**
 * Profile I/O and site settings stay in the parent process. The actor only
 * forwards the content-side filter's small, local configuration and activity
 * records; web content never receives a profile path.
 */
export class VaporFilterParent extends JSWindowActorParent {
  async receiveMessage(message) {
    switch (message.name) {
      case "VaporFilter:GetConfig":
        return lazy.VaporFilter.getConfiguration(
          message.data?.host || "",
          message.data?.href || "",
        );
      case "VaporFilter:LogFilter":
        return lazy.VaporFilter.recordFilter(message.data || {});
      case "VaporFilter:LogOverlay":
        return lazy.VaporFilter.recordOverlay(message.data || {});
      case "VaporFilter:RememberOverlay":
        return lazy.VaporFilter.rememberOverlay(
          message.data?.host || "",
          message.data?.selectors || [],
          message.data?.bodyFixes || [],
          message.data?.watchdogTypes || [],
        );
    }
    return null;
  }
}
