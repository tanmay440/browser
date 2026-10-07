// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

"use strict";

window.addEventListener("DOMContentLoaded", () => {
  const arena = document.getElementById("laser-arena");
  const scoreNode = document.getElementById("score");
  let score = 0;
  let running = true;
  let last = performance.now();
  const addBanner = () => {
    if (!running) return;
    const banner = document.createElement("button");
    banner.type = "button";
    banner.className = "laser-banner";
    banner.textContent = ["YOU WON!", "FREE COINS", "CLICK NOW", "LIMITED OFFER"][Math.floor(Math.random() * 4)];
    banner.style.left = `${5 + Math.random() * 82}%`;
    banner.style.top = "-44px";
    banner.addEventListener("click", event => {
      event.stopPropagation();
      score += 10;
      scoreNode.textContent = score;
      banner.classList.add("laser-hit");
      window.setTimeout(() => banner.remove(), 180);
    });
    arena.appendChild(banner);
  };
  const reset = () => {
    score = 0;
    scoreNode.textContent = "0";
    arena.replaceChildren();
    running = true;
    arena.focus();
  };
  document.getElementById("laser-reset").addEventListener("click", reset);
  arena.addEventListener("keydown", event => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    const target = [...arena.querySelectorAll(".laser-banner")].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))[0];
    target?.click();
  });
  const frame = now => {
    if (!running) return;
    const elapsed = Math.min(50, now - last);
    last = now;
    for (const banner of arena.querySelectorAll(".laser-banner")) {
      const top = parseFloat(banner.style.top) + elapsed * 0.045;
      banner.style.top = `${top}px`;
      if (top > arena.clientHeight) banner.remove();
    }
    window.requestAnimationFrame(frame);
  };
  window.setInterval(addBanner, 850);
  window.requestAnimationFrame(frame);
  addBanner();
  arena.focus();
});
