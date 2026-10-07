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

window.addEventListener("DOMContentLoaded", async () => {
  const appInfo = Services.appinfo;
  document.title = "Vapor Browser";
  document.getElementById("version").textContent = appInfo.version || "0.1.0-alpha";
  document.getElementById("gecko-version").textContent =
    appInfo.platformVersion || "Unavailable";
  document.getElementById("build-date").textContent = buildDateFromBuildID(
    appInfo.appBuildID
  );

  const output = document.getElementById("dom-filters-log");
  const summary = document.getElementById("dom-filters-summary");
  try {
    const { VaporFilter } = ChromeUtils.importESModule(
      "resource:///modules/zen/filter/VaporFilter.sys.mjs"
    );
    const entries = await VaporFilter.getActivityLog();
    output.replaceChildren();
    if (!entries.length) {
      output.appendChild(document.createElement("li")).textContent =
        "No local filter or Shield Breaker actions yet.";
      return;
    }
    summary.textContent = `${entries.length} local actions. Nothing is sent off this device.`;
    for (const entry of entries.slice(0, 100)) {
      const item = document.createElement("li");
      const kind = document.createElement("strong");
      kind.textContent = entry.kind || "Vapor";
      const details = document.createElement("span");
      details.textContent = ` ${entry.action || entry.tag || "action"} — ${entry.host || "local page"} (${new Date(entry.time).toLocaleString()})`;
      item.append(kind, details);
      output.appendChild(item);
    }
  } catch {
    output.replaceChildren();
    output.appendChild(document.createElement("li")).textContent =
      "Local activity is unavailable until the profile is ready.";
  }
});
