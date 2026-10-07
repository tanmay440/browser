// This Source Code Form is subject to the terms of the Mozilla Public
// License, Version 2.0. If a copy of the MPL was not distributed with this
// file, see http://mozilla.org/MPL/2.0/.

"use strict";

window.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const host = params.get("host") || "";
  const httpURL = params.get("url") || `http://${host}/`;
  const hostOutput = document.getElementById("warning-host");
  const confirmation = document.getElementById("warning-confirmation");
  const continueButton = document.getElementById("warning-continue");
  hostOutput.textContent = host;
  const update = () => {
    continueButton.disabled = confirmation.value.trim().toLowerCase() !== host.toLowerCase();
  };
  confirmation.addEventListener("input", update);
  continueButton.addEventListener("click", async () => {
    if (continueButton.disabled) {
      return;
    }
    const { VaporPrivacy } = ChromeUtils.importESModule(
      "resource:///modules/zen/privacy/VaporPrivacy.sys.mjs",
    );
    await VaporPrivacy.addHTTPSException(host);
    window.location.href = httpURL;
  });
});
