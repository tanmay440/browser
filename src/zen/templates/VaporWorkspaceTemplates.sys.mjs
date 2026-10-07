/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";
import { Services } from "resource://gre/modules/Services.sys.mjs";

const TEMPLATE_VERSION = "1.0";
const TEMPLATE_DIRECTORY = "vapor-templates";
const TEMPLATE_EXTENSION = ".json";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VaporBroom: "resource:///modules/zen/privacy/VaporBroom.sys.mjs",
  VaporRouting: "resource:///modules/zen/routing/VaporRouting.sys.mjs",
});

/**
 * Built-ins are deliberately data-only. They are returned as fresh objects so
 * the editor cannot mutate the read-only catalogue.
 */
const BUILTIN_TEMPLATES = [
  {
    version: TEMPLATE_VERSION,
    name: "Research",
    description: "For academic research and deep dives",
    icon: "🔬",
    color: "#4A90D9",
    pinned_tabs: [
      "https://perplexity.ai",
      "https://arxiv.org",
      "https://www.semanticscholar.org",
      "https://wikipedia.org",
    ],
    default_new_tab_type: "regular",
    default_new_tab_url: "https://perplexity.ai",
    default_search_engine: {
      name: "Perplexity",
      search_url: "https://perplexity.ai/search?q={searchTerms}",
      suggest_url: "",
    },
    script_blocking_default: "first-party-only",
    adblocker_enabled: true,
    url_stripping_enabled: true,
    cname_uncloaking_enabled: true,
    auto_launch_vpn: false,
    tab_hibernation_timeout_minutes: 15,
    homepage: "https://perplexity.ai",
    remembered_sites: ["github.com", "gmail.com"],
    remembered_sites_scope: "global",
  },
  {
    version: TEMPLATE_VERSION,
    name: "Work",
    description: "Development and project work",
    icon: "💻",
    color: "#34495E",
    pinned_tabs: [
      "https://vscode.dev",
      "https://github.com",
      "https://linear.app",
    ],
    default_new_tab_type: "regular",
    default_new_tab_url: "https://vscode.dev",
    default_search_engine: {
      name: "Default",
      search_url: "",
      suggest_url: "",
    },
    script_blocking_default: "allow-all",
    adblocker_enabled: true,
    url_stripping_enabled: true,
    cname_uncloaking_enabled: true,
    auto_launch_vpn: true,
    tab_hibernation_timeout_minutes: 60,
    homepage: "https://vscode.dev",
    remembered_sites: ["github.com"],
    remembered_sites_scope: "global",
  },
  {
    version: TEMPLATE_VERSION,
    name: "Privacy",
    description: "Private browsing with a short-lived tab set",
    icon: "🕵️",
    color: "#8E44AD",
    pinned_tabs: [
      "https://duckduckgo.com",
      "https://mail.proton.me",
      "https://signal.org",
    ],
    default_new_tab_type: "tor",
    default_new_tab_url: "https://duckduckgo.com",
    default_search_engine: {
      name: "DuckDuckGo",
      search_url: "https://duckduckgo.com/?q={searchTerms}",
      suggest_url: "",
    },
    script_blocking_default: "block-all",
    adblocker_enabled: true,
    url_stripping_enabled: true,
    cname_uncloaking_enabled: true,
    auto_launch_vpn: false,
    tab_hibernation_timeout_minutes: 5,
    homepage: "https://duckduckgo.com",
    remembered_sites: [],
    remembered_sites_scope: "workspace",
  },
  {
    version: TEMPLATE_VERSION,
    name: "Casual",
    description: "Everyday browsing and entertainment",
    icon: "🎮",
    color: "#E67E22",
    pinned_tabs: [
      "https://www.youtube.com",
      "https://www.reddit.com",
      "https://x.com",
    ],
    default_new_tab_type: "regular",
    default_new_tab_url: "about:newtab",
    default_search_engine: {
      name: "Google",
      search_url: "https://www.google.com/search?q={searchTerms}",
      suggest_url: "",
    },
    script_blocking_default: "allow-all",
    adblocker_enabled: true,
    url_stripping_enabled: true,
    cname_uncloaking_enabled: true,
    auto_launch_vpn: false,
    tab_hibernation_timeout_minutes: 30,
    homepage: "about:home",
    remembered_sites: [],
    remembered_sites_scope: "global",
  },
  {
    version: TEMPLATE_VERSION,
    name: "Dev",
    description: "Local development and web platform documentation",
    icon: "🛠️",
    color: "#27AE60",
    pinned_tabs: [
      "http://localhost:3000",
      "https://developer.mozilla.org",
      "https://stackoverflow.com",
      "https://vscode.dev",
    ],
    default_new_tab_type: "regular",
    default_new_tab_url: "http://localhost:3000",
    default_search_engine: {
      name: "MDN",
      search_url: "https://developer.mozilla.org/en-US/search?q={searchTerms}",
      suggest_url: "",
    },
    script_blocking_default: "allow-all",
    adblocker_enabled: false,
    url_stripping_enabled: false,
    cname_uncloaking_enabled: false,
    auto_launch_vpn: false,
    tab_hibernation_timeout_minutes: 0,
    homepage: "http://localhost:3000",
    remembered_sites: ["localhost"],
    remembered_sites_scope: "workspace",
  },
];

const VALID_TAB_TYPES = new Set(["regular", "tor", "scramjet"]);
const VALID_SCRIPT_MODES = new Set([
  "allow-all",
  "first-party-only",
  "block-all",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slug(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "template"
  );
}

function defaultTemplate() {
  return clone(BUILTIN_TEMPLATES[0]);
}

export function validateTemplate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("A workspace template must be a JSON object");
  }
  const required = [
    "version", "name", "description", "icon", "color", "pinned_tabs",
    "default_new_tab_type", "default_new_tab_url", "default_search_engine",
    "script_blocking_default", "adblocker_enabled", "url_stripping_enabled",
    "cname_uncloaking_enabled", "auto_launch_vpn",
    "tab_hibernation_timeout_minutes", "homepage", "remembered_sites",
    "remembered_sites_scope",
  ];
  for (const property of required) {
    if (!Object.prototype.hasOwnProperty.call(input, property)) {
      throw new Error(`Workspace template is missing required property: ${property}`);
    }
  }
  const allowed = new Set([
    "version", "name", "description", "icon", "color", "pinned_tabs",
    "default_new_tab_type", "default_new_tab_url", "default_search_engine",
    "script_blocking_default", "adblocker_enabled", "url_stripping_enabled",
    "cname_uncloaking_enabled", "auto_launch_vpn",
    "tab_hibernation_timeout_minutes", "homepage", "remembered_sites",
    "remembered_sites_scope", "builtIn", "readOnly", "fileName",
  ]);
  for (const property of Object.keys(input)) {
    if (!allowed.has(property)) {
      throw new Error(`Unknown workspace template property: ${property}`);
    }
  }
  for (const property of Object.keys(input.default_search_engine || {})) {
    if (!["name", "search_url", "suggest_url"].includes(property)) {
      throw new Error(`Unknown search engine property: ${property}`);
    }
  }
  const cleanInput = { ...input };
  for (const metadata of ["builtIn", "readOnly", "fileName"]) {
    delete cleanInput[metadata];
  }
  const template = {
    ...defaultTemplate(),
    ...cleanInput,
    default_search_engine: {
      ...defaultTemplate().default_search_engine,
      ...(cleanInput.default_search_engine || {}),
    },
  };
  if (template.version !== TEMPLATE_VERSION) {
    throw new Error(`Unsupported workspace template version: ${template.version}`);
  }
  if (!String(template.name || "").trim()) {
    throw new Error("Workspace templates need a name");
  }
  if (!VALID_TAB_TYPES.has(template.default_new_tab_type)) {
    throw new Error("default_new_tab_type must be regular, tor, or scramjet");
  }
  if (!VALID_SCRIPT_MODES.has(template.script_blocking_default)) {
    throw new Error("script_blocking_default is not a supported script mode");
  }
  if (!Array.isArray(template.pinned_tabs) || template.pinned_tabs.some(url => typeof url !== "string")) {
    throw new Error("pinned_tabs must be an array of URLs");
  }
  if (!Array.isArray(template.remembered_sites) || template.remembered_sites.some(site => typeof site !== "string")) {
    throw new Error("remembered_sites must be an array of domains");
  }
  if (typeof template.default_search_engine !== "object" || template.default_search_engine === null) {
    throw new Error("default_search_engine must be an object");
  }
  if (typeof template.tab_hibernation_timeout_minutes !== "number" || !Number.isFinite(template.tab_hibernation_timeout_minutes)) {
    throw new Error("tab_hibernation_timeout_minutes must be a number");
  }
  for (const key of [
    "adblocker_enabled",
    "url_stripping_enabled",
    "cname_uncloaking_enabled",
    "auto_launch_vpn",
  ]) {
    if (typeof template[key] !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
  }
  template.tab_hibernation_timeout_minutes = Math.max(
    0,
    Number(template.tab_hibernation_timeout_minutes) || 0
  );
  template.remembered_sites_scope =
    template.remembered_sites_scope === "workspace" ? "workspace" : "global";
  template.default_new_tab_url = String(template.default_new_tab_url || "about:newtab");
  template.homepage = String(template.homepage || "about:home");
  template.description = String(template.description || "");
  template.icon = String(template.icon || "📁");
  template.color = String(template.color || "#4A90D9");
  template.default_search_engine.name = String(template.default_search_engine.name || "");
  template.default_search_engine.search_url = String(template.default_search_engine.search_url || "");
  template.default_search_engine.suggest_url = String(template.default_search_engine.suggest_url || "");
  for (const key of [
    "adblocker_enabled",
    "url_stripping_enabled",
    "cname_uncloaking_enabled",
    "auto_launch_vpn",
  ]) {
    template[key] = Boolean(template[key]);
  }
  return template;
}

class VaporWorkspaceTemplatesService {
  #directoryPromise = null;

  get builtInTemplates() {
    return BUILTIN_TEMPLATES.map(template => ({
      ...clone(template),
      builtIn: true,
      readOnly: true,
    }));
  }

  #directory() {
    if (!this.#directoryPromise) {
      this.#directoryPromise = (async () => {
        const directory = PathUtils.join(PathUtils.profileDir, TEMPLATE_DIRECTORY);
        await IOUtils.makeDirectory(directory, {
          createAncestors: true,
          ignoreExisting: true,
        });
        return directory;
      })();
    }
    return this.#directoryPromise;
  }

  async listTemplates() {
    const directory = await this.#directory();
    const templates = this.builtInTemplates;
    let children = [];
    try {
      children = await IOUtils.getChildren(directory);
    } catch {}
    for (const path of children.filter(path => path.endsWith(TEMPLATE_EXTENSION))) {
      try {
        const data = validateTemplate(JSON.parse(await IOUtils.readUTF8(path)));
        templates.push({
          ...data,
          builtIn: false,
          readOnly: false,
          fileName: PathUtils.filename(path),
        });
      } catch (error) {
        console.error(`Ignoring invalid workspace template ${path}`, error);
      }
    }
    return templates;
  }

  async saveTemplate(input, fileName = null) {
    const template = validateTemplate(input);
    const directory = await this.#directory();
    fileName ||= `${slug(template.name)}-${Date.now()}.json`;
    if (!fileName.endsWith(TEMPLATE_EXTENSION)) {
      fileName += TEMPLATE_EXTENSION;
    }
    fileName = PathUtils.filename(fileName);
    await IOUtils.writeUTF8(
      PathUtils.join(directory, fileName),
      `${JSON.stringify(template, null, 2)}\n`
    );
    return { ...template, builtIn: false, readOnly: false, fileName };
  }

  async deleteTemplate(template) {
    if (!template?.fileName || template.builtIn || template.readOnly) {
      return false;
    }
    await IOUtils.remove(PathUtils.join(await this.#directory(), template.fileName));
    return true;
  }

  async importTemplate(path) {
    return this.saveTemplate(
      JSON.parse(await IOUtils.readUTF8(path)),
      `${slug(PathUtils.filename(path).replace(/\.json$/i, ""))}-${Date.now()}.json`
    );
  }

  async exportTemplate(template, path) {
    const clean = validateTemplate(template);
    await IOUtils.writeUTF8(path, `${JSON.stringify(clean, null, 2)}\n`);
    return path;
  }

  async createFromCurrentWorkspace(window) {
    if (window?.gZenWorkspaces?.promiseInitialized) {
      await window.gZenWorkspaces.promiseInitialized;
    }
    const workspace = window.gZenWorkspaces?.getActiveWorkspace?.();
    const tabs = window.gZenWorkspaces?.allStoredTabs || window.gBrowser.tabs;
    const workspaceId = workspace?.uuid;
    const pinned = tabs
      .filter(tab =>
        tab.pinned &&
        !tab.hasAttribute("zen-essential") &&
        (!workspaceId || tab.getAttribute("zen-workspace-id") === workspaceId)
      )
      .map(tab => tab.linkedBrowser?.currentURI?.spec)
      .filter(url => url && !url.startsWith("about:"));
    const remembered = await lazy.VaporBroom.getRememberedSites().catch(() => "");
    const template = validateTemplate({
      ...defaultTemplate(),
      name: workspace?.name || "New Workspace Template",
      icon: workspace?.icon || "📁",
      pinned_tabs: pinned,
      default_new_tab_type: workspace?.defaultTabType || "regular",
      default_new_tab_url: workspace?.defaultNewTabUrl || "about:newtab",
      default_search_engine: workspace?.defaultSearchEngine || defaultTemplate().default_search_engine,
      script_blocking_default: workspace?.scriptBlockingDefault ||
        ({
          "allow-all": "allow-all",
          "first-party": "first-party-only",
          "block-all": "block-all",
        }[Services.prefs.getStringPref(
          "vapor.privacy.script-blocking.default-state",
          Services.prefs.getBoolPref("vapor.privacy.script-blocking.enabled", true)
            ? "first-party"
            : "allow-all"
        )] || "first-party-only"),
      adblocker_enabled: Services.prefs.getBoolPref("vapor.shield.enabled", true),
      url_stripping_enabled: Services.prefs.getBoolPref("vapor.privacy.url-stripping.enabled", true),
      cname_uncloaking_enabled: Services.prefs.getBoolPref("vapor.privacy.cname-uncloaking.enabled", true),
      auto_launch_vpn: Services.prefs.getBoolPref("vapor.routing.openvpn.auto-connect", false),
      tab_hibernation_timeout_minutes: workspace?.tabHibernationTimeoutMinutes ??
        Services.prefs.getIntPref("vapor.tabs.hibernation-timeout-minutes", 15),
      homepage: workspace?.homepage || Services.prefs.getStringPref("browser.startup.homepage", "about:home"),
      remembered_sites: workspace?.rememberedSites || remembered.split(/\r?\n/).filter(Boolean),
      remembered_sites_scope: workspace?.rememberedSitesScope || "global",
    });
    return template;
  }

  async applyTemplate(input, window, { workspace = null, create = false } = {}) {
    const template = validateTemplate(input);
    if (!window?.gZenWorkspaces) {
      throw new Error("Workspace templates require a browser window");
    }
    await window.gZenWorkspaces.promiseInitialized;
    if (create || !workspace) {
      workspace = await window.gZenWorkspaces.createAndSaveWorkspace(
        template.name,
        template.icon,
        false,
        0
      );
    }
    if (!workspace) {
      throw new Error("The target workspace no longer exists");
    }
    Object.assign(workspace, {
      templateName: template.name,
      templateIcon: template.icon,
      defaultTabType: template.default_new_tab_type,
      defaultNewTabUrl: template.default_new_tab_url,
      defaultSearchEngine: template.default_search_engine,
      scriptBlockingDefault: template.script_blocking_default,
      adblockerEnabled: template.adblocker_enabled,
      urlStrippingEnabled: template.url_stripping_enabled,
      cnameUncloakingEnabled: template.cname_uncloaking_enabled,
      autoLaunchVPN: template.auto_launch_vpn,
      tabHibernationTimeoutMinutes: template.tab_hibernation_timeout_minutes,
      homepage: template.homepage,
      rememberedSites: template.remembered_sites,
      rememberedSitesScope: template.remembered_sites_scope,
    });
    window.gZenWorkspaces.saveWorkspace(workspace);
    lazy.VaporRouting.setWorkspaceDefaultTabType(workspace.uuid, template.default_new_tab_type);

    for (const url of template.pinned_tabs) {
      if (!/^https?:\/\//i.test(url) && !/^about:/i.test(url) && !/^file:/i.test(url)) {
        continue;
      }
      const existing = window.gBrowser.tabs.find(
        tab =>
          tab.pinned &&
          tab.getAttribute("zen-workspace-id") === workspace.uuid &&
          tab.linkedBrowser?.currentURI?.spec === url
      );
      if (existing) {
        continue;
      }
      const tab = window.gBrowser.addTrustedTab(url, {
        inBackground: true,
        userContextId: workspace.containerTabId || 0,
        skipRoute: true,
      });
      window.gZenWorkspaces.moveTabToWorkspace(tab, workspace.uuid);
      window.gBrowser.pinTab(tab);
    }

    Services.prefs.setBoolPref("vapor.shield.enabled", template.adblocker_enabled);
    Services.prefs.setBoolPref("vapor.privacy.url-stripping.enabled", template.url_stripping_enabled);
    Services.prefs.setBoolPref("vapor.privacy.cname-uncloaking.enabled", template.cname_uncloaking_enabled);
    Services.prefs.setBoolPref(
      "vapor.privacy.script-blocking.enabled",
      template.script_blocking_default !== "allow-all"
    );
    Services.prefs.setStringPref(
      "vapor.privacy.script-blocking.default-state",
      template.script_blocking_default === "first-party-only"
        ? "first-party"
        : template.script_blocking_default
    );
    Services.prefs.setBoolPref("vapor.routing.openvpn.auto-connect", template.auto_launch_vpn);
    Services.prefs.setStringPref("browser.startup.homepage", template.homepage);
    if (
      template.remembered_sites_scope === "global" ||
      window.gZenWorkspaces.activeWorkspace === workspace.uuid
    ) {
      await lazy.VaporBroom.setRememberedSites(template.remembered_sites.join("\n"));
    }

    if (template.default_search_engine?.name) {
      try {
        let engine = await Services.search.getEngineByName(template.default_search_engine.name);
        if (!engine && template.default_search_engine.search_url && Services.search.addEngineWithDetails) {
          engine = await Services.search.addEngineWithDetails(
            template.default_search_engine.name,
            {
              template: template.default_search_engine.search_url,
              suggestTemplate: template.default_search_engine.suggest_url || undefined,
            }
          );
        }
        if (engine) {
          await Services.search.setDefault(engine, { private: false });
        }
      } catch (error) {
        console.debug("Workspace template search engine could not be installed", error);
      }
    }
    if (template.auto_launch_vpn) {
      void lazy.VaporRouting.connectOpenVPN(window);
    }
    window.dispatchEvent(new CustomEvent("VaporWorkspaceTemplateApplied", {
      detail: { workspace, template },
    }));
    return workspace;
  }
}

export const VaporWorkspaceTemplates = new VaporWorkspaceTemplatesService();
