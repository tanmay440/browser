/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { Services } = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs");
const { MigrationUtils } = ChromeUtils.importESModule("resource:///modules/MigrationUtils.sys.mjs");
const { VaporRouting } = ChromeUtils.importESModule("resource:///modules/zen/routing/VaporRouting.sys.mjs");
const { VaporWorkspaceTemplates } = ChromeUtils.importESModule("resource:///modules/zen/templates/VaporWorkspaceTemplates.sys.mjs");

const PREF_SEEN = "vapor.first-run.seen";

class VaporSetupWizard {
  #window;
  #root;
  #index = 0;
  #pages = [
    ["Welcome", "Vapor evaporates ads, trackers, and nonsense.", "Choose a local-first setup. You can change everything later in Settings.", "Continue"],
    ["Adblocker", "The Shield is on.", "It serves blank files instead of canceling requests.", "View Blocklist"],
    ["Privacy", "Privacy protection is ready.", "URL params stripped. CNAME uncloaked. Fingerprinting protected. Cookies auto-deleted on leave. Cookie consent auto-declined.", "Customize"],
    ["Routing", "Private routing is available.", "Tor and Scramjet tabs are available from the new tab menu. Set up Tor now?", "Yes, set up Tor"],
    ["OpenVPN", "Use OpenVPN?", "We'll scan for openvpn-gui.exe and add a launcher button.", "Detect"],
    ["Templates", "Pick starter templates.", "Start with a workspace that matches how you browse.", "Continue"],
    ["Done", "Happy browsing.", "Try the laser with Ctrl+Shift+L. Your settings remain local to this profile.", "Start browsing"],
  ];

  constructor(window) {
    this.#window = window;
    this.#root = window.document.createXULElement("vbox");
    this.#root.id = "vapor-setup-wizard";
    this.#root.setAttribute("role", "dialog");
    this.#root.setAttribute("aria-label", "Vapor setup");
    window.document.getElementById("browser")?.appendChild(this.#root);
    this.#render();
  }

  #render() {
    const [title, heading, description, action] = this.#pages[this.#index];
    this.#root.replaceChildren();
    const card = this.#window.document.createXULElement("vbox");
    card.className = "vapor-setup-card";
    const progress = this.#window.document.createXULElement("label");
    progress.setAttribute("value", `Vapor setup · ${this.#index + 1} of ${this.#pages.length}`);
    progress.className = "vapor-setup-progress";
    const titleNode = this.#window.document.createXULElement("label");
    titleNode.setAttribute("value", title);
    titleNode.className = "vapor-setup-title";
    const headingNode = this.#window.document.createXULElement("label");
    headingNode.setAttribute("value", heading);
    headingNode.className = "vapor-setup-heading";
    const descriptionNode = this.#window.document.createXULElement("description");
    descriptionNode.textContent = description;
    descriptionNode.className = "vapor-setup-description";
    card.append(progress, titleNode, headingNode, descriptionNode);
    this.#renderOptions(card);
    const actions = this.#window.document.createXULElement("hbox");
    actions.className = "vapor-setup-actions";
    if (this.#index > 0) {
      const back = this.#button("Back", () => { this.#index--; this.#render(); });
      actions.appendChild(back);
    }
    const primary = this.#button(action, () => this.#advance());
    primary.classList.add("primary");
    actions.appendChild(primary);
    card.appendChild(actions);
    this.#root.appendChild(card);
  }

  #renderOptions(card) {
    if (this.#index === 0) {
      card.appendChild(this.#button("Import from Firefox, Chrome, Edge, or Brave", () => {
        MigrationUtils.showMigrationWizard(this.#window, { isStartupMigration: true });
      }));
    } else if (this.#index === 1) {
      const label = this.#window.document.createXULElement("label");
      label.setAttribute("value", "Shield status: enabled · blank responses · local blocklist");
      card.appendChild(label);
      card.appendChild(this.#button("Open Adblocker Settings", () => this.#window.openPreferences?.("paneVaporShield")));
    } else if (this.#index === 2) {
      card.appendChild(this.#button("Open Privacy Settings", () => this.#window.openPreferences?.("panePrivacy")));
    } else if (this.#index === 3) {
      card.appendChild(this.#button("Later", () => { this.#index++; this.#render(); }));
    } else if (this.#index === 4) {
      card.appendChild(this.#button("Skip", () => { this.#index++; this.#render(); }));
    } else if (this.#index === 5) {
      const row = this.#window.document.createXULElement("hbox");
      row.className = "vapor-setup-template-row";
      for (const template of VaporWorkspaceTemplates.builtInTemplates) {
        const button = this.#button(`${template.icon} ${template.name}`, async () => {
          await VaporWorkspaceTemplates.applyTemplate(template, this.#window, { create: true });
          button.setAttribute("selected", "true");
        });
        row.appendChild(button);
      }
      card.appendChild(row);
      card.appendChild(this.#button("None", () => { this.#index++; this.#render(); }));
    }
  }

  #button(label, command) {
    const button = this.#window.document.createXULElement("button");
    button.setAttribute("label", label);
    button.addEventListener("command", () => Promise.resolve(command()).catch(console.error));
    return button;
  }

  #advance() {
    if (this.#index === 1) {
      this.#window.openPreferences?.("paneVaporShield");
    } else if (this.#index === 2) {
      this.#window.openPreferences?.("panePrivacy");
    } else if (this.#index === 3) {
      VaporRouting.openTab(this.#window, "tor");
    } else if (this.#index === 4) {
      void VaporRouting.connectOpenVPN(this.#window, true);
    } else if (this.#index === this.#pages.length - 1) {
      Services.prefs.setBoolPref(PREF_SEEN, true);
      Services.prefs.setBoolPref("zen.welcome-screen.seen", true);
      this.#root.remove();
      return;
    }
    if (this.#index < this.#pages.length - 1) {
      this.#index++;
      this.#render();
    }
  }
}

function startVaporSetupWizard(window) {
  if (!window || Services.prefs.getBoolPref(PREF_SEEN, false)) return null;
  return new VaporSetupWizard(window);
}
