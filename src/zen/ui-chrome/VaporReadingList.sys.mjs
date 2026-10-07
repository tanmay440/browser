/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";

const DIRECTORY = "vapor-reading-list";
const INDEX = "index.json";
const DEFAULT_AUTO_DELETE_DAYS = 0;

function safeName(value) {
  return (
    String(value || "article")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "article"
  );
}

function idFor(entry) {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${safeName(entry.title)}`;
}

function cleanHTML(html, title = "") {
  let content = String(html || "");
  content = content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/<\/?(?:meta|link|base|form|input|button)\b[^>]*>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:src|href)\s*=\s*(["'])javascript:[\s\S]*?\1/gi, "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${String(title)
    .replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])}</title><style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font:17px/1.65 system-ui,sans-serif;color:#202124}img{max-width:100%;height:auto}</style></head><body>${content}</body></html>`;
}

class VaporReadingListService {
  #directoryPromise = null;
  #indexPromise = null;

  async #directory() {
    if (!this.#directoryPromise) {
      this.#directoryPromise = PathUtils.join(PathUtils.profileDir, DIRECTORY);
      await IOUtils.makeDirectory(this.#directoryPromise, {
        createAncestors: true,
        ignoreExisting: true,
      });
    }
    return this.#directoryPromise;
  }

  async #readIndex() {
    if (!this.#indexPromise) {
      this.#indexPromise = IOUtils.readUTF8(
        PathUtils.join(await this.#directory(), INDEX)
      )
        .then(text => JSON.parse(text))
        .catch(() => []);
    }
    return this.#indexPromise;
  }

  async #writeIndex(entries) {
    await IOUtils.writeUTF8(
      PathUtils.join(await this.#directory(), INDEX),
      `${JSON.stringify(entries, null, 2)}\n`
    );
    this.#indexPromise = Promise.resolve(entries);
  }

  async #prune(entries) {
    const days = Services.prefs.getIntPref(
      "vapor.reading-list.auto-delete-days",
      DEFAULT_AUTO_DELETE_DAYS
    );
    if (days <= 0) {
      return entries;
    }
    const cutoff = Date.now() - days * 86_400_000;
    const kept = [];
    for (const entry of entries) {
      if (Number(entry.date) >= cutoff) {
        kept.push(entry);
      } else {
        await IOUtils.remove(PathUtils.join(await this.#directory(), entry.file)).catch(() => {});
      }
    }
    if (kept.length !== entries.length) {
      await this.#writeIndex(kept);
    }
    return kept;
  }

  async saveSnapshot({ url = "", title = "Untitled", html = "", text = "", thumbnail = "" } = {}) {
    const entries = await this.#prune(await this.#readIndex());
    const id = idFor({ title });
    const file = `${id}.html`;
    const entry = {
      id,
      file,
      url: String(url),
      title: String(title || "Untitled"),
      date: Date.now(),
      text: String(text || "").slice(0, 100_000),
      thumbnail: String(thumbnail || ""),
    };
    await IOUtils.writeUTF8(
      PathUtils.join(await this.#directory(), file),
      cleanHTML(html, entry.title)
    );
    entries.unshift(entry);
    await this.#writeIndex(entries.slice(0, 500));
    return entry;
  }

  async list(query = "") {
    const entries = await this.#prune(await this.#readIndex());
    const needle = String(query || "").trim().toLowerCase();
    return entries.filter(entry =>
      !needle || `${entry.title} ${entry.url} ${entry.text}`.toLowerCase().includes(needle)
    );
  }

  async read(id) {
    const entry = (await this.list()).find(item => item.id === id);
    if (!entry) {
      return null;
    }
    return {
      ...entry,
      html: await IOUtils.readUTF8(PathUtils.join(await this.#directory(), entry.file)).catch(() => ""),
    };
  }

  async remove(id) {
    const entries = await this.list();
    const entry = entries.find(item => item.id === id);
    if (!entry) {
      return false;
    }
    await IOUtils.remove(PathUtils.join(await this.#directory(), entry.file)).catch(() => {});
    await this.#writeIndex(entries.filter(item => item.id !== id));
    return true;
  }

  get autoDeleteDays() {
    return Services.prefs.getIntPref("vapor.reading-list.auto-delete-days", DEFAULT_AUTO_DELETE_DAYS);
  }

  async setAutoDeleteDays(days) {
    Services.prefs.setIntPref("vapor.reading-list.auto-delete-days", Math.max(0, Number(days) || 0));
    await this.list();
  }
}

export const VaporReadingList = new VaporReadingListService();
export { cleanHTML };
