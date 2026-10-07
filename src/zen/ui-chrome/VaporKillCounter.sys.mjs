/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";

const FILE_NAME = "vapor-kill-counter.json";
const MAX_DAYS = 14;

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

class VaporKillCounterService {
  #dataPromise = null;

  async #load() {
    if (!this.#dataPromise) {
      this.#dataPromise = IOUtils.readUTF8(
        PathUtils.join(PathUtils.profileDir, FILE_NAME)
      )
        .then(text => JSON.parse(text))
        .catch(() => ({ days: {}, total: 0 }));
    }
    return this.#dataPromise;
  }

  async #save(data) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - MAX_DAYS);
    for (const key of Object.keys(data.days || {})) {
      if (key < dayKey(cutoff)) {
        delete data.days[key];
      }
    }
    data.total = Number(data.total) || 0;
    await IOUtils.writeUTF8(
      PathUtils.join(PathUtils.profileDir, FILE_NAME),
      `${JSON.stringify(data, null, 2)}\n`
    );
    this.#dataPromise = Promise.resolve(data);
    return data;
  }

  async record(amount = 1, _source = "laser") {
    const data = await this.#load();
    const key = dayKey();
    data.days ||= {};
    data.days[key] = (Number(data.days[key]) || 0) + Math.max(0, Number(amount) || 0);
    data.total = (Number(data.total) || 0) + Math.max(0, Number(amount) || 0);
    await this.#save(data);
    return data.days[key];
  }

  async getWeeklyCount() {
    const data = await this.#load();
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 6);
    const start = dayKey(cutoff);
    return Object.entries(data.days || {})
      .filter(([key]) => key >= start)
      .reduce((total, [, count]) => total + (Number(count) || 0), 0);
  }

  async getTotal() {
    return Number((await this.#load()).total) || 0;
  }
}

export const VaporKillCounter = new VaporKillCounterService();
