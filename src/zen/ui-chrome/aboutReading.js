/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { VaporReadingList } = ChromeUtils.importESModule(
  "resource:///modules/zen/uichrome/VaporReadingList.sys.mjs"
);

window.addEventListener("DOMContentLoaded", async () => {
  const search = document.getElementById("reading-search");
  const list = document.getElementById("reading-list");
  const view = document.getElementById("reading-view");
  const autoDelete = document.getElementById("reading-auto-delete");
  autoDelete.value = VaporReadingList.autoDeleteDays;
  const render = async () => {
    list.replaceChildren();
    const entries = await VaporReadingList.list(search.value);
    if (!entries.length) {
      list.textContent = "No saved articles yet.";
      return;
    }
    for (const entry of entries) {
      const card = document.createElement("article");
      card.className = "reading-card";
      const button = document.createElement("button");
      if (entry.thumbnail) {
        const image = document.createElement("img");
        image.src = entry.thumbnail;
        image.alt = "";
        image.loading = "lazy";
        button.appendChild(image);
      }
      const title = document.createElement("h2");
      title.textContent = entry.title;
      const date = document.createElement("p");
      date.textContent = new Date(entry.date).toLocaleString();
      button.append(title, date);
      button.addEventListener("click", async () => {
        const article = await VaporReadingList.read(entry.id);
        view.replaceChildren();
        if (!article) return;
        const heading = document.createElement("h2");
        heading.textContent = article.title;
        const source = document.createElement("p");
        source.textContent = article.url;
        const body = document.createElement("article");
        body.innerHTML = article.html;
        view.append(heading, source, body);
        view.scrollIntoView({ behavior: "smooth" });
      });
      const remove = document.createElement("button");
      remove.textContent = "Delete";
      remove.addEventListener("click", async event => {
        event.stopPropagation();
        await VaporReadingList.remove(entry.id);
        await render();
      });
      card.append(button, remove);
      list.appendChild(card);
    }
  };
  search.addEventListener("input", render);
  autoDelete.addEventListener("change", () => VaporReadingList.setAutoDeleteDays(autoDelete.value));
  await render();
});
