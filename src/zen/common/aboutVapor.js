// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

"use strict";

const { Services } = ChromeUtils.importESModule(
  "resource://gre/modules/Services.sys.mjs"
);

function buildDateFromBuildID(buildID) {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(buildID || "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "Unavailable";
}

window.addEventListener("DOMContentLoaded", () => {
  const appInfo = Services.appinfo;
  document.title = "Vapor Browser";
  document.getElementById("version").textContent = appInfo.version || "0.1.0-alpha";
  document.getElementById("gecko-version").textContent =
    appInfo.platformVersion || "Unavailable";
  document.getElementById("build-date").textContent = buildDateFromBuildID(
    appInfo.appBuildID
  );
});
