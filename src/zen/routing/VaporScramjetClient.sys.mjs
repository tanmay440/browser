/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Small integration point for the bundled Scramjet client. The actual client
 * can replace the URL template preference without changing tab routing. A
 * Scramjet deployment that exposes its client on the origin can also listen
 * for the `vapor-scramjet-configure` event sent by VaporRoutingChild.
 */
export const VaporScramjetClient = {
  rewriteURL(url, proxyURL, template = "") {
    if (!proxyURL || !/^https?:\/\//i.test(url)) {
      return url;
    }

    if (template.includes("{url}")) {
      return template.replaceAll("{url}", encodeURIComponent(url));
    }

    // This is the conventional, server-side Scramjet integration endpoint.
    // Deployments with a different endpoint set the template preference.
    return `${proxyURL.replace(/\/$/, "")}/scramjet?url=${encodeURIComponent(url)}`;
  },

  configure(document, proxyURL) {
    document?.dispatchEvent(
      new CustomEvent("vapor-scramjet-configure", {
        bubbles: false,
        detail: { proxyURL },
      }),
    );
  },
};
