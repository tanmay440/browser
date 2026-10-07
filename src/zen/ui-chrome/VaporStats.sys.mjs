/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";

const FILE_NAME = "vapor-stats.json";
const MAX_EVENTS = 2_000;
const MAX_PAGES = 250;
const SESSION_STARTED = Date.now();

function dayKey(time = Date.now()) {
  return new Date(time).toISOString().slice(0, 10);
}

function hourKey(time = Date.now()) {
  return new Date(time).toISOString().slice(0, 13);
}

function hostFor(url) {
  try {
    return new URL(url).hostname || "local";
  } catch {
    return "local";
  }
}

function emptyData() {
  return {
    version: 1,
    totals: { blocked: 0, bandwidth: 0, timeSaved: 0 },
    days: {},
    domains: {},
    types: {},
    events: [],
    laser: [],
    routes: {},
    workspaces: {},
    pages: {},
    memory: { peak: 0, samples: [] },
  };
}

function mergeData(value) {
  const base = emptyData();
  if (!value || typeof value !== "object") {
    return base;
  }
  base.totals = { ...base.totals, ...(value.totals || {}) };
  base.days = value.days || {};
  base.domains = value.domains || {};
  base.types = value.types || {};
  base.events = Array.isArray(value.events) ? value.events.slice(-MAX_EVENTS) : [];
  base.laser = Array.isArray(value.laser) ? value.laser.slice(-MAX_EVENTS) : [];
  base.routes = value.routes || {};
  base.workspaces = value.workspaces || {};
  base.pages = value.pages || {};
  base.memory = { ...base.memory, ...(value.memory || {}) };
  return base;
}

function pageKey(url) {
  return String(url || "about:blank").slice(0, 1_000);
}

class VaporStatsService {
  #dataPromise = null;
  #writeQueue = Promise.resolve();
  #session = {
    blocked: 0,
    bandwidth: 0,
    timeSaved: 0,
    laserKills: 0,
    started: SESSION_STARTED,
  };

  async #load() {
    if (!this.#dataPromise) {
      this.#dataPromise = IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, FILE_NAME))
        .then(text => mergeData(JSON.parse(text)))
        .catch(() => emptyData());
    }
    return this.#dataPromise;
  }

  async #save(data) {
    this.#writeQueue = this.#writeQueue.then(async () => {
      await IOUtils.writeUTF8(
        PathUtils.join(PathUtils.profileDir, FILE_NAME),
        `${JSON.stringify(data, null, 2)}\n`,
      );
      this.#dataPromise = Promise.resolve(data);
    });
    return this.#writeQueue;
  }

  async recordBlock({ url = "", type = "other", bytes = 0, workspace = "" } = {}) {
    const data = await this.#load();
    const amount = Math.max(0, Number(bytes) || 0);
    const host = hostFor(url);
    const now = Date.now();
    const day = dayKey(now);
    const hour = hourKey(now);
    data.totals.blocked++;
    data.totals.bandwidth += amount;
    data.totals.timeSaved += amount ? 0.35 : 0.1;
    data.days[day] ||= { blocked: 0, bandwidth: 0, hours: {} };
    data.days[day].hours ||= {};
    data.days[day].blocked++;
    data.days[day].bandwidth += amount;
    data.days[day].hours[hour] = (data.days[day].hours[hour] || 0) + 1;
    data.domains[host] = (data.domains[host] || 0) + 1;
    data.types[type] = (data.types[type] || 0) + 1;
    const workspaceKey = workspace || "Default";
    data.workspaces[workspaceKey] ||= { blocked: 0, tabs: 0 };
    data.workspaces[workspaceKey].blocked++;
    data.events.push({ kind: "Blocked Requests", time: now, host, url, type, bytes: amount, workspace: workspaceKey });
    data.events = data.events.slice(-MAX_EVENTS);
    this.#session.blocked++;
    this.#session.bandwidth += amount;
    this.#session.timeSaved += amount ? 0.35 : 0.1;
    await this.#save(data);
    return data.totals;
  }

  async recordLaser({ url = "", source = "Laser", domains = [], count = 1 } = {}) {
    const data = await this.#load();
    const now = Date.now();
    const host = hostFor(url);
    const normalizedDomains = [...new Set((domains.length ? domains : [host]).filter(Boolean))];
    const entry = { time: now, url, source, domains: normalizedDomains, count: Number(count) || 1 };
    data.laser.push(entry);
    data.laser = data.laser.slice(-MAX_EVENTS);
    data.events.push({ kind: "Laser History", ...entry });
    data.events = data.events.slice(-MAX_EVENTS);
    this.#session.laserKills += entry.count;
    await this.#save(data);
    return entry;
  }

  async recordPageStats(url, stats = {}) {
    const data = await this.#load();
    const key = pageKey(url);
    const current = data.pages[key] || {
      url: key,
      blocked: 0,
      stripped: 0,
      uncloaked: 0,
      bandwidth: 0,
      types: {},
    };
    data.pages[key] = {
      ...current,
      url: key,
      blocked: Math.max(current.blocked || 0, Number(stats.blocked) || 0),
      requests: Math.max(current.requests || 0, Number(stats.requests) || 0),
      stripped: Math.max(current.stripped || 0, Number(stats.stripped) || 0),
      uncloaked: Math.max(current.uncloaked || 0, Number(stats.uncloaked) || 0),
      bandwidth: Math.max(current.bandwidth || 0, Number(stats.bandwidth) || 0),
      jsMs: Math.max(current.jsMs || 0, Number(stats.jsMs) || 0),
      types: { ...(current.types || {}), ...(stats.types || {}) },
      time: Date.now(),
    };
    const keys = Object.keys(data.pages);
    if (keys.length > MAX_PAGES) {
      keys.sort((a, b) => (data.pages[b].time || 0) - (data.pages[a].time || 0));
      for (const old of keys.slice(MAX_PAGES)) delete data.pages[old];
    }
    await this.#save(data);
  }

  async recordPrivacy(action, detail = {}) {
    const data = await this.#load();
    const actionName = String(action || "").toLowerCase();
    const url = detail.url || detail.before || detail.after || (detail.host ? `https://${detail.host}/` : "");
    const key = pageKey(url);
    const current = data.pages[key] || { url: key, blocked: 0, requests: 0, stripped: 0, uncloaked: 0, bandwidth: 0, types: {} };
    if (actionName.includes("strip")) current.stripped = (current.stripped || 0) + (detail.removed?.length || 1);
    if (actionName.includes("cname") || actionName.includes("uncloak")) current.uncloaked = (current.uncloaked || 0) + 1;
    current.time = Date.now();
    data.pages[key] = current;
    await this.#save(data);
  }

  async recordRoute(type, { bytes = 0, duration = 0 } = {}) {
    const data = await this.#load();
    const route = data.routes[type || "regular"] ||= { time: 0, bytes: 0, visits: 0 };
    route.time += Math.max(0, Number(duration) || 0);
    route.bytes += Math.max(0, Number(bytes) || 0);
    route.visits++;
    await this.#save(data);
  }

  async recordMemory(resident, hibernated = 0) {
    const data = await this.#load();
    const value = Math.max(0, Number(resident) || 0);
    data.memory.peak = Math.max(data.memory.peak || 0, value);
    data.memory.samples = [...(data.memory.samples || []).slice(-99), { time: Date.now(), resident: value, hibernated }];
    await this.#save(data);
  }

  async recordWorkspace(workspace, tabs = 0) {
    const data = await this.#load();
    const key = workspace || "Default";
    data.workspaces[key] ||= { blocked: 0, tabs: 0 };
    data.workspaces[key].tabs = Number(tabs) || 0;
    await this.#save(data);
  }

  async getPageStats(url) {
    const data = await this.#load();
    const exact = data.pages[pageKey(url)];
    if (exact) return exact;
    const host = hostFor(url);
    const sameHost = Object.values(data.pages).filter(entry => hostFor(entry.url) === host);
    return sameHost.reduce((total, entry) => ({
      ...total,
      blocked: Math.max(total.blocked, entry.blocked || 0),
      requests: Math.max(total.requests, entry.requests || 0),
      stripped: total.stripped + (entry.stripped || 0),
      uncloaked: total.uncloaked + (entry.uncloaked || 0),
      bandwidth: Math.max(total.bandwidth, entry.bandwidth || 0),
      jsMs: Math.max(total.jsMs, entry.jsMs || 0),
      types: { ...total.types, ...(entry.types || {}) },
    }), { url: pageKey(url), blocked: 0, requests: 0, stripped: 0, uncloaked: 0, bandwidth: 0, jsMs: 0, types: {} });
  }

  async getDashboardData() {
    const data = await this.#load();
    const today = data.days[dayKey()] || { blocked: 0, bandwidth: 0, hours: {} };
    const hours = Array.from({ length: 24 }, (_, hour) => {
      const key = `${dayKey()}T${String(hour).padStart(2, "0")}`;
      return { hour, blocks: today.hours?.[key] || 0 };
    });
    const domains = Object.entries(data.domains).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([domain, count]) => ({ domain, count }));
    const routeStats = Object.entries(data.routes).map(([route, value]) => ({ route, ...value }));
    const workspaceStats = Object.entries(data.workspaces).map(([workspace, value]) => ({ workspace, ...value }));
    const memory = data.memory.samples?.at(-1) || { resident: 0, hibernated: 0 };
    return {
      overview: {
        allTimeBlocked: data.totals.blocked,
        sessionBlocked: this.#session.blocked,
        bandwidthSaved: data.totals.bandwidth,
        sessionBandwidthSaved: this.#session.bandwidth,
        timeSaved: data.totals.timeSaved,
        sessionTimeSaved: this.#session.timeSaved,
      },
      activity: hours,
      domains,
      laser: data.laser.slice().reverse(),
      types: data.types,
      routes: routeStats,
      memory: { ...memory, peak: data.memory.peak || 0 },
      workspaces: workspaceStats,
      pageCount: Object.keys(data.pages).length,
    };
  }

  get sessionLaserKills() {
    return this.#session.laserKills;
  }
}

export const VaporStats = new VaporStatsService();
export { dayKey, hostFor };
