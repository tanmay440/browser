/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If applicable, you may use, modify, and distribute this
 * file under the terms of the Mozilla Public License. */

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";

const FILE_NAME = "vapor-newtab.json";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VaporKillCounter: "resource:///modules/zen/uichrome/VaporKillCounter.sys.mjs",
  VaporWorkspaceTemplates: "resource:///modules/zen/templates/VaporWorkspaceTemplates.sys.mjs",
});

class VaporNewTabService {
  #dataPromise = null;

  async #data() {
    if (!this.#dataPromise) {
      this.#dataPromise = IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, FILE_NAME))
        .then(text => ({ sites: [], background: "", ...JSON.parse(text) }))
        .catch(() => ({ sites: [], background: "" }));
    }
    return this.#dataPromise;
  }

  async #save(data) {
    await IOUtils.writeUTF8(
      PathUtils.join(PathUtils.profileDir, FILE_NAME),
      `${JSON.stringify(data, null, 2)}\n`
    );
    this.#dataPromise = Promise.resolve(data);
  }

  async recordVisit(url, title = "") {
    if (!/^https?:/i.test(url || "")) {
      return;
    }
    let uri;
    try {
      uri = new URL(url);
    } catch {
      return;
    }
    const data = await this.#data();
    const key = uri.origin;
    const existing = data.sites.find(site => site.url === key);
    if (existing) {
      existing.count = (Number(existing.count) || 0) + 1;
      existing.lastUsed = Date.now();
      existing.title = title || existing.title;
    } else {
      data.sites.push({ url: key, title: title || uri.hostname, count: 1, lastUsed: Date.now() });
    }
    data.sites.sort((a, b) => (b.count - a.count) || (b.lastUsed - a.lastUsed));
    data.sites = data.sites.slice(0, 50);
    await this.#save(data);
  }

  async getData(window) {
    const data = await this.#data();
    const workspace = window?.gZenWorkspaces?.getActiveWorkspace?.();
    let search = workspace?.defaultSearchEngine;
    if (!search?.search_url) {
      try {
        const engine = await Services.search.getDefault();
        search = {
          name: engine?.name || "Search",
          search_url: engine?.getSubmission("{searchTerms}")?.uri?.spec || "",
          suggest_url: "",
        };
      } catch {
        search = { name: "Search", search_url: "https://www.google.com/search?q={searchTerms}", suggest_url: "" };
      }
    }
    return {
      search,
      sites: data.sites.slice(0, 8),
      background: data.background || Services.prefs.getStringPref("vapor.newtab.background", ""),
      killCount: await lazy.VaporKillCounter.getWeeklyCount(),
      templates: lazy.VaporWorkspaceTemplates.builtInTemplates.map(template => ({
        name: template.name,
        icon: template.icon,
        description: template.description,
      })),
    };
  }

  async search(window, query) {
    const data = await this.getData(window);
    const template = data.search?.search_url || "https://www.google.com/search?q={searchTerms}";
    const url = template.replace("{searchTerms}", encodeURIComponent(query));
    window.gBrowser.selectedBrowser.loadURI(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    return url;
  }

  async applyTemplate(window, name) {
    const template = lazy.VaporWorkspaceTemplates.builtInTemplates.find(item => item.name === name);
    if (!template) {
      return false;
    }
    await lazy.VaporWorkspaceTemplates.applyTemplate(template, window, { create: true });
    return true;
  }

  async setBackground(value) {
    const data = await this.#data();
    data.background = String(value || "").slice(0, 2_000);
    await this.#save(data);
    Services.prefs.setStringPref("vapor.newtab.background", data.background);
    return data.background;
  }
}

export const VaporNewTab = new VaporNewTabService();
