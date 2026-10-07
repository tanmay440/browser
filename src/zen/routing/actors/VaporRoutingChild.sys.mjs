/* This Source Code Form is subject to the terms of the Mozilla Public
 * License.  You can obtain one at http://mozilla.org/MPL/2.0/. */

const FREEZE_ID = "vapor-routing-kill-switch";
const ROUTE_EVENT = "vapor-scramjet-configure";

export class VaporRoutingChild extends JSWindowActorChild {
  handleEvent(event) {
    if (
      event.type === "DOMContentLoaded" &&
      event.target === this.contentWindow.document
    ) {
      this.sendQuery("VaporRouting:GetRoute")
        .then((route) => this.#applyRoute(route))
        .catch(() => {});
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "VaporRouting:Route":
        this.#applyRoute(message.data);
        break;
      case "VaporRouting:Freeze":
        this.#showFreeze(message.data?.reason);
        break;
      case "VaporRouting:Unfreeze":
        this.#removeFreeze();
        break;
    }
  }

  #applyRoute(route = {}) {
    if (route.type === "tor") {
      this.#disableWebRTC();
    }
    if (route.type === "scramjet") {
      this.contentWindow.document.dispatchEvent(
        new this.contentWindow.CustomEvent(ROUTE_EVENT, {
          detail: { proxyURL: route.proxyURL || "" },
        }),
      );
    }
  }

  #disableWebRTC() {
    const win = this.contentWindow;
    const blocked = () => {
      throw new win.DOMException(
        "WebRTC is disabled in Tor tabs",
        "NotAllowedError",
      );
    };
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
      try {
        Object.defineProperty(win, name, {
          configurable: true,
          writable: false,
          value: blocked,
        });
      } catch {}
    }
    try {
      if (win.navigator.mediaDevices) {
        Object.defineProperty(win.navigator.mediaDevices, "getUserMedia", {
          configurable: true,
          value: blocked,
        });
      }
    } catch {}
  }

  #showFreeze(reason) {
    this.#removeFreeze();
    const doc = this.contentWindow.document;
    if (!doc.documentElement) {
      return;
    }
    const overlay = doc.createElement("div");
    overlay.id = FREEZE_ID;
    overlay.setAttribute("role", "alertdialog");
    const card = doc.createElement("div");
    card.className = "vapor-routing-kill-switch-card";
    const message = doc.createElement("strong");
    message.textContent = reason || "Routing connection lost";
    card.appendChild(message);
    const actions = doc.createElement("div");
    actions.className = "vapor-routing-kill-switch-actions";
    for (const [action, label] of [
      ["retry", "Reconnect"],
      ["close", "Close Tab"],
    ]) {
      const button = doc.createElement("button");
      button.dataset.vaporRoutingAction = action;
      button.textContent = label;
      actions.appendChild(button);
    }
    card.appendChild(actions);
    overlay.appendChild(card);
    overlay.addEventListener("click", (event) => {
      const action = event.target.closest("[data-vapor-routing-action]")
        ?.dataset.vaporRoutingAction;
      if (action === "retry") {
        this.sendQuery("VaporRouting:Retry").catch(() => {});
      } else if (action === "close") {
        this.sendQuery("VaporRouting:CloseTab").catch(() => {});
      }
    });
    doc.documentElement.appendChild(overlay);
  }

  #removeFreeze() {
    this.contentWindow.document.getElementById(FREEZE_ID)?.remove();
  }
}
