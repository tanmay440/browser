// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { IOUtils } from "resource://gre/modules/IOUtils.sys.mjs";
import { PathUtils } from "resource://gre/modules/PathUtils.sys.mjs";

const VAPOR_PROFILE_DIRECTORIES = [
  "vapor-blocklists",
  "vapor-templates",
  "vapor-reading-list",
];

/**
 * Create Vapor's local-first directories on first launch. PathUtils.profileDir
 * is the active profile below %APPDATA%\\Vapor\\Profiles on Windows; using it
 * also works for profiles selected by the normal Firefox profile manager.
 */
export async function ensureVaporProfileDirectories() {
  await Promise.all(
    VAPOR_PROFILE_DIRECTORIES.map(name =>
      IOUtils.makeDirectory(PathUtils.join(PathUtils.profileDir, name), {
        createAncestors: true,
        ignoreExisting: true,
      })
    )
  );
}
