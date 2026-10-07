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

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(seconds) {
  const value = Number(seconds) || 0;
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}

function renderEntries(output, entries, emptyText = "No activity recorded yet.") {
  output.replaceChildren();
  if (!entries?.length) {
    output.appendChild(document.createElement("li")).textContent = emptyText;
    return;
  }
  for (const entry of entries.slice(0, 100)) {
    const item = document.createElement("li");
    const kind = document.createElement("strong");
    kind.textContent = entry.kind || entry.source || "Vapor";
    const details = document.createElement("span");
    const time = entry.time ? new Date(entry.time).toLocaleString() : "unknown time";
    const subject = entry.chain
      ? `${entry.original || "unknown"} → ${entry.final || "unknown"} (${entry.redirectCount || 0} redirects)`
      : entry.domains
        ? `${entry.domains.join(", ")} · ${entry.source || "Laser"} · ${entry.url || "local page"}`
        : entry.url || entry.host || entry.domain || entry.action || entry.tag || "local activity";
    details.textContent = ` ${subject} · ${time}`;
    item.append(kind, details);
    output.appendChild(item);
  }
}

function renderList(output, rows, emptyText = "No activity recorded yet.") {
  renderEntries(output, rows.map(row => ({ kind: row.kind || "Vapor", action: row.text || row.domain || row.workspace || row.route, time: row.time })), emptyText);
}

window.addEventListener("DOMContentLoaded", async () => {
  const appInfo = Services.appinfo;
  document.title = "Vapor Browser";
  document.getElementById("version").textContent = appInfo.version || "0.1.0-alpha";
  document.getElementById("gecko-version").textContent = appInfo.platformVersion || "Unavailable";
  document.getElementById("build-date").textContent = buildDateFromBuildID(appInfo.appBuildID);

  // A small, local-only easter egg: the dashboard dissolves and reassembles.
  const dashboard = document.getElementById("vapor-dashboard");
  dashboard.classList.add("vapor-reassembling");
  window.setTimeout(() => dashboard.classList.add("vapor-dissolve"), 100);
  window.setTimeout(() => dashboard.classList.remove("vapor-dissolve"), 3_100);

  try {
    const { VaporStats } = ChromeUtils.importESModule("resource:///modules/zen/uichrome/VaporStats.sys.mjs");
    const { VaporFilter } = ChromeUtils.importESModule("resource:///modules/zen/filter/VaporFilter.sys.mjs");
    const { VaporPrivacy } = ChromeUtils.importESModule("resource:///modules/zen/privacy/VaporPrivacy.sys.mjs");
    const { VaporTabManagement } = ChromeUtils.importESModule("resource:///modules/zen/tabmanagement/VaporTabManagement.sys.mjs");
    const { VaporRedirectInspector } = ChromeUtils.importESModule("resource:///modules/zen/uichrome/VaporRedirectInspector.sys.mjs");
    const [stats, filterEntries, privacyEntries, crashEntries, redirectEntries] = await Promise.all([
      VaporStats.getDashboardData(),
      VaporFilter.getActivityLog(),
      VaporPrivacy.getActivityLog(),
      VaporTabManagement.getCrashLog(),
      VaporRedirectInspector.getLog(),
    ]);

    const overview = stats.overview;
    document.getElementById("all-time-blocked").textContent = overview.allTimeBlocked.toLocaleString();
    document.getElementById("session-blocked").textContent = overview.sessionBlocked.toLocaleString();
    document.getElementById("bandwidth-saved").textContent = formatBytes(overview.bandwidthSaved);
    document.getElementById("time-saved").textContent = formatTime(overview.timeSaved);

    const chart = document.getElementById("activity-chart");
    const max = Math.max(1, ...stats.activity.map(item => item.blocks));
    for (const item of stats.activity) {
      const bar = document.createElement("span");
      bar.title = `${item.hour}:00 — ${item.blocks} blocks`;
      bar.style.height = `${Math.max(3, (item.blocks / max) * 100)}%`;
      bar.dataset.blocks = item.blocks;
      chart.appendChild(bar);
    }

    const domains = document.getElementById("top-domains");
    for (const item of stats.domains) {
      const row = document.createElement("li");
      row.textContent = `${item.domain} — ${item.count}`;
      domains.appendChild(row);
    }
    if (!domains.children.length) domains.appendChild(document.createElement("li")).textContent = "No blocked domains yet.";
    const types = document.getElementById("resource-types");
    for (const [type, count] of Object.entries(stats.types)) {
      const row = document.createElement("li"); row.textContent = `${type}: ${count}`; types.appendChild(row);
    }
    if (!types.children.length) types.appendChild(document.createElement("li")).textContent = "No resource data yet.";

    renderEntries(document.getElementById("laser-history"), stats.laser, "No Laser zaps recorded yet.");
    renderEntries(document.getElementById("dom-filters-log"), filterEntries.filter(entry => entry.kind === "DOM Filter" || entry.kind === "Shield Breaker"));
    renderEntries(document.getElementById("cname-log"), privacyEntries.filter(entry => String(entry.action || "").toLowerCase().includes("cname")));
    renderEntries(document.getElementById("url-strip-log"), privacyEntries.filter(entry => entry.kind === "URL Stripping"));
    renderEntries(document.getElementById("consent-log"), privacyEntries.filter(entry => entry.kind === "Consent Actions"));
    renderEntries(document.getElementById("cookie-log"), privacyEntries.filter(entry => entry.kind === "Broom"));
    renderEntries(document.getElementById("dns-log"), privacyEntries.filter(entry => entry.kind === "DNS"));
    renderEntries(document.getElementById("redirects-log"), redirectEntries);
    renderList(document.getElementById("routing-stats"), stats.routes.map(item => ({ ...item, text: `${item.route}: ${formatTime(item.time / 1000)} · ${formatBytes(item.bytes)} · ${item.visits} visits` })), "No routing data yet.");
    const latestMemory = stats.memory.resident ? formatBytes(stats.memory.resident) : "No samples yet";
    document.getElementById("memory-stats").textContent = `${latestMemory}; peak ${formatBytes(stats.memory.peak)}; hibernated tabs ${stats.memory.hibernated || 0}`;
    renderList(document.getElementById("workspace-breakdown"), stats.workspaces.map(item => ({ ...item, text: `${item.workspace}: ${item.blocked || 0} blocks · ${item.tabs || 0} tabs` })), "No workspace data yet.");
    renderEntries(document.getElementById("crashes-log"), crashEntries, "No tab crashes recorded yet.");
  } catch (error) {
    console.error("Vapor dashboard failed to load", error);
    for (const output of document.querySelectorAll(".stats-section ol")) {
      output.replaceChildren();
      output.appendChild(document.createElement("li")).textContent = "Local activity is unavailable until the profile is ready.";
    }
  }
});
