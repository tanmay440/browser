/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";

const LOG_FILE = "vapor-redirects.json";
const MAX_HOPS = 12;
const THRESHOLD_PREF = "vapor.ui.redirect-threshold";

class VaporRedirectInspectorService {
  #logPromise = null;

  get threshold() {
    return Math.max(1, Services.prefs.getIntPref(THRESHOLD_PREF, 3));
  }

  async inspect(url) {
    let current = String(url || "");
    const chain = [];
    const seen = new Set();
    for (let hop = 0; hop < MAX_HOPS && /^https?:/i.test(current); hop++) {
      if (seen.has(current)) {
        break;
      }
      seen.add(current);
      let response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
        });
      } catch {
        break;
      }
      const status = response.status || 0;
      const location = response.headers.get("location");
      if (status >= 300 && status < 400 && location) {
        chain.push({ url: current, status });
        current = new URL(location, current).href;
        continue;
      }
      chain.push({ url: current, status });
      break;
    }
    const final = current;
    const redirectCount = chain.filter(hop => hop.status >= 300 && hop.status < 400).length;
    const result = { original: url, chain, redirectCount, final, redirected: redirectCount >= this.threshold };
    if (result.redirected) {
      const { VaporPrivacy } = ChromeUtils.importESModule(
        "resource:///modules/zen/privacy/VaporPrivacy.sys.mjs"
      );
      const cleaned = VaporPrivacy.cleanURL(final, { topLevel: true });
      result.final = cleaned.spec;
      result.removed = cleaned.removed;
      await this.record(result);
    }
    return result;
  }

  async #readLog() {
    if (!this.#logPromise) {
      this.#logPromise = IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, LOG_FILE))
        .then(text => JSON.parse(text))
        .catch(() => []);
    }
    return this.#logPromise;
  }

  async record(result) {
    const entries = await this.#readLog();
    entries.unshift({ kind: "Redirects", ...result, time: Date.now() });
    const trimmed = entries.slice(0, 200);
    await IOUtils.writeUTF8(
      PathUtils.join(PathUtils.profileDir, LOG_FILE),
      `${JSON.stringify(trimmed, null, 2)}\n`
    );
    this.#logPromise = Promise.resolve(trimmed);
    return trimmed[0];
  }

  async getLog() {
    return this.#readLog();
  }
}

export const VaporRedirectInspector = new VaporRedirectInspectorService();
