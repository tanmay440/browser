/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export class VaporTabManagementChild extends JSWindowActorChild {
  #failedURL = "";

  handleEvent(event) {
    if (event.type !== "DOMContentLoaded" || event.target !== this.contentWindow.document) {
      return;
    }
    this.#addCrashControls();
  }

  #addCrashControls() {
    const doc = this.contentWindow.document;
    if (!this.contentWindow.location.href.startsWith("about:tabcrashed") ||
        doc.getElementById("vapor-crash-recovery")) {
      return;
    }
    const host = doc.querySelector("main") || doc.body;
    if (!host) {
      return;
    }
    const section = doc.createElement("section");
    section.id = "vapor-crash-recovery";
    const heading = doc.createElement("h2");
    heading.textContent = "Vapor crash recovery";
    const description = doc.createElement("p");
    description.textContent = "This tab crashed. Restore it or reload without page scripts.";
    const failedURL =
      doc.querySelector("#failedURLEntry, [data-crash-url]")?.textContent?.trim() ||
      this.contentWindow.location.href;
    this.#failedURL = failedURL;
    const reload = this.#button("Reload", "reload");
    const noScripts = this.#button("Reload Without Scripts", "reload-without-scripts");
    section.append(heading, description, reload, noScripts);
    host.appendChild(section);
    this.sendQuery("VaporTabManagement:Crash", {
      url: failedURL,
      title: doc.title,
    }).catch(() => {});
  }

  #button(label, action) {
    const button = this.contentWindow.document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      this.sendQuery(`VaporTabManagement:${action}`, { url: this.#failedURL }).catch(() => {});
    });
    return button;
  }
}
