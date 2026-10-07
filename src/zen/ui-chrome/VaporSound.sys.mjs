/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Services } from "resource://gre/modules/Services.sys.mjs";

const SOUND_PREF = "vapor.sound.";
const DEFINITIONS = Object.freeze({
  laser: { duration: 0.1, from: 1_200, to: 240, type: "square" },
  shield: { duration: 0.4, from: 180, to: 55, type: "sawtooth" },
  tabClose: { duration: 0.2, from: 420, to: 90, type: "sine" },
  workspace: { duration: 0.05, from: 620, to: 620, type: "triangle" },
  tor: { duration: 0.5, from: 90, to: 55, type: "sine" },
  killSwitch: { duration: 0.3, from: 740, to: 120, type: "square" },
  milestone: { duration: 0.15, from: 880, to: 1_320, type: "sine" },
});

class VaporSoundService {
  #windows = new Set();
  #contexts = new WeakMap();

  init(window) {
    if (!window || this.#windows.has(window)) return;
    this.#windows.add(window);
    window.addEventListener("TabClose", () => this.play("tabClose", window));
    window.addEventListener("TabOpen", event => {
      if (event.target?.getAttribute("vapor-tab-type") === "tor") this.play("tor", window);
    });
    const workspace = window.gZenWorkspaces;
    if (workspace?.addChangeListeners) {
      const listener = () => this.play("workspace", window);
      workspace.addChangeListeners(listener);
      window.addEventListener("unload", () => workspace.removeChangeListeners(listener), { once: true });
    }
    window.addEventListener("unload", () => this.#windows.delete(window), { once: true });
  }

  observe(_subject, topic) {
    const sound = {
      "vapor-laser-zap": "laser",
      "vapor-shield-breaker": "shield",
      "vapor-kill-switch": "killSwitch",
      "vapor-adblocker-milestone": "milestone",
    }[topic];
    if (!sound) return;
    for (const window of this.#windows) this.play(sound, window);
  }

  #context(window) {
    let context = this.#contexts.get(window);
    if (context) return context;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext || Services.appShell.hiddenDOMWindow.AudioContext;
      context = new AudioContext();
      this.#contexts.set(window, context);
      return context;
    } catch {
      return null;
    }
  }

  play(name, window = this.#windows.values().next().value) {
    const definition = DEFINITIONS[name];
    if (!definition || !window) return;
    if (!Services.prefs.getBoolPref(`${SOUND_PREF}${name}`, true)) return;
    const master = Math.max(0, Math.min(1, Services.prefs.getIntPref(`${SOUND_PREF}master-volume`, 30) / 100));
    if (!master) return;
    const context = this.#context(window);
    if (!context) return;
    const start = context.currentTime;
    const gain = context.createGain();
    const oscillator = context.createOscillator();
    oscillator.type = definition.type;
    oscillator.frequency.setValueAtTime(definition.from, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, definition.to), start + definition.duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.18 * master, start + Math.min(0.015, definition.duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + definition.duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + definition.duration + 0.02);
    context.resume?.().catch(() => {});
  }
}

export const VaporSound = new VaporSoundService();
export { DEFINITIONS };
