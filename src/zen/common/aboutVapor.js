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

function renderEntries(output, entries, emptyText) {
  output.replaceChildren();
  if (!entries.length) {
    output.appendChild(document.createElement("li")).textContent = emptyText;
    return;
  }
  for (const entry of entries.slice(0, 100)) {
    const item = document.createElement("li");
    const kind = document.createElement("strong");
    kind.textContent = entry.kind || "Vapor";
    const details = document.createElement("span");
    details.textContent = entry.chain
      ? ` ${entry.original || "unknown URL"} → ${entry.final || "unknown destination"} (${entry.redirectCount || 0} redirects, ${new Date(entry.time).toLocaleString()})`
      : entry.kind === "Crashes"
        ? ` ${entry.url || "unknown URL"} — memory: ${entry.memory || "unknown"}; cause: ${entry.cause || "unknown"} (${new Date(entry.time).toLocaleString()})`
        : ` ${entry.action || entry.tag || "action"} — ${entry.host || "local page"} (${new Date(entry.time).toLocaleString()})`;
    item.append(kind, details);
    output.appendChild(item);
  }
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

  try {
    const { VaporFilter } = ChromeUtils.importESModule(
      "resource:///modules/zen/filter/VaporFilter.sys.mjs"
    );
    const { VaporPrivacy } = ChromeUtils.importESModule(
      "resource:///modules/zen/privacy/VaporPrivacy.sys.mjs"
    );
    const { VaporTabManagement } = ChromeUtils.importESModule(
      "resource:///modules/zen/tabmanagement/VaporTabManagement.sys.mjs"
    );
    const { VaporRedirectInspector } = ChromeUtils.importESModule(
      "resource:///modules/zen/uichrome/VaporRedirectInspector.sys.mjs"
    );
    const [filterEntries, privacyEntries, crashEntries, redirectEntries] = await Promise.all([
      VaporFilter.getActivityLog(),
      VaporPrivacy.getActivityLog(),
      VaporTabManagement.getCrashLog(),
      VaporRedirectInspector.getLog(),
    ]);
    renderEntries(
      document.getElementById("dom-filters-log"),
      filterEntries,
      "No local filter or Shield Breaker actions yet.",
    );
    renderEntries(
      document.getElementById("privacy-log"),
      privacyEntries.filter(entry => entry.kind !== "DNS" && entry.kind !== "Consent Actions"),
      "No local network privacy actions yet.",
    );
    renderEntries(
      document.getElementById("consent-log"),
      privacyEntries.filter(entry => entry.kind === "Consent Actions"),
      "No local consent actions yet.",
    );
    const dnsEntries = privacyEntries.filter(entry => entry.kind === "DNS");
    renderEntries(
      document.getElementById("dns-log"),
      dnsEntries,
      "No local DNS activity yet.",
    );
    renderEntries(
      document.getElementById("redirects-log"),
      redirectEntries,
      "No redirect chains have been recorded.",
    );
    renderEntries(
      document.getElementById("crashes-log"),
      crashEntries,
      "No tab crashes have been recorded.",
    );
    document.getElementById("redirects-summary").textContent =
      `${redirectEntries.length} local redirect chains.`;
    document.getElementById("crashes-summary").textContent =
      `${crashEntries.length} local tab crashes.`;
    document.getElementById("dom-filters-summary").textContent =
      `${filterEntries.length} local filter actions. Nothing is sent off this device.`;
    document.getElementById("privacy-summary").textContent =
      `${privacyEntries.filter(entry => entry.kind !== "DNS" && entry.kind !== "Consent Actions").length} local network privacy actions.`;
    document.getElementById("consent-summary").textContent =
      `${privacyEntries.filter(entry => entry.kind === "Consent Actions").length} local consent actions.`;
    document.getElementById("dns-summary").textContent =
      `${dnsEntries.length} local DNS and CNAME events.`;
  } catch {
    for (const id of ["dom-filters-log", "privacy-log", "consent-log", "dns-log", "redirects-log", "crashes-log"]) {
      const output = document.getElementById(id);
      output.replaceChildren();
      output.appendChild(document.createElement("li")).textContent =
        "Local activity is unavailable until the profile is ready.";
    }
  }
});
