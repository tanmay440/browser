# Vapor Browser — Windows x86_64 build

This is the Round 1 Foundation build. It produces a native Windows x86_64
Vapor Browser from the checked-in Zen source overlay and the pinned Gecko
source selected by `surfer.json`. macOS, Linux, ARM64, and 32-bit builds are
not supported by this round.

## Supported host

- Windows 10 21H2 or newer, or Windows 11, x86_64.
- At least 16 GB RAM and 40 GB of free disk space for the Gecko checkout,
  object directory, compiler caches, and package. More free space is useful for
  the first build.
- Run every shell command below from a **MozillaBuild shell** unless it is
  explicitly labelled PowerShell. Do not build from WSL: the target compiler
  and Windows SDK must be native MSVC tools.

## Required toolchain versions

These versions are the versions recorded by this checkout:

| Tool | Required version | Source of truth |
| --- | --- | --- |
| MozillaBuild | 4.2.1 or newer; use the current MozillaBuild release | `build/windows/bootstrap.ps1` installs `MozillaBuildSetup-Latest.exe` |
| Node.js | 22.x | `.nvmrc` |
| npm | the npm shipped with Node 22 | `package-lock.json` |
| Python | 3.11.x for repository scripts | `.python-version` |
| Rust | 1.95.0 | `.rust-toolchain` |
| Rust target | `x86_64-pc-windows-msvc` | Windows x86_64 target |
| Windows Rust support | 0.62.2 | `build/windows/.windows-rs-version` |
| MSVC | x64 MSVC toolset 14.51.36231 | `configs/windows/mozconfig` |
| Windows SDK | the SDK selected by Gecko's `vs2026.yaml` | `build/windows/bootstrap.ps1` |

Install Visual Studio Build Tools with the **Desktop development with C++**
workload, the x86/x64 MSVC tools, the Windows 10/11 SDK, and Spectre libraries.
The compiler must be on the path created by MozillaBuild. The build does not
use MinGW or clang-cl as the application compiler.

## First-time environment setup

1. Install Git, Node.js 22.x, Rust 1.95.0, and Visual Studio Build Tools using
the versions above.
2. Install MozillaBuild 4.2.1 or newer from Mozilla's official Windows
   package, then restart the MozillaBuild shell after installation. The
   repository helper also installs the current MozillaBuild package, but it must
   be run only after `engine` exists because it downloads Gecko Visual Studio
   support files from that checkout.
3. Open `C:\mozilla-build\start-shell.bat`. In that shell, verify the tools:

   ```sh
   node --version        # v22.x
   npm --version
   python --version      # 3.11.x (or the compatible MozillaBuild Python)
   rustc --version       # 1.95.0
   rustup target add x86_64-pc-windows-msvc
   ```

4. Clone the repository and install the lockfile dependencies:

   ```sh
   git clone https://github.com/tanmay440/browser.git vapor-browser
   cd vapor-browser
   npm ci
   ```

   For a reproducible release build, check out the Vapor Round 1 commit being
   released before running `npm ci`; the source commit from which the fork was
   created is recorded in Section 0 of `SPEC.md`.

## Download, import, configure, and build

The following is the complete native Windows x86_64 sequence. `surfer ci`
selects the Vapor release branding and the `0.1.0-alpha` display version;
`download` retrieves the Gecko checkout; `import` applies the checked-in source
patches and generates the preference defaults; `bootstrap` installs Gecko's
build dependencies.

```sh
# MozillaBuild shell, repository root
export SURFER_PLATFORM=win32
npm run surfer -- ci --brand release --display-version 0.1.0-alpha
npm run download

# After `engine` exists, install the exact Gecko Windows support files and
# x86_64 Rust target. The helper is PowerShell and may be invoked from the
# MozillaBuild shell:
powershell.exe -ExecutionPolicy Bypass -File .\build\windows\bootstrap.ps1

npm run import
npm run bootstrap

cd engine
./mach configure
./mach build
./mach run --noprofile
```

`./mach run --noprofile` launches the locally built browser. The first build
can take a long time. Subsequent builds can use the incremental command:

```sh
cd engine
./mach build
./mach run --noprofile
```

To make a packaged Windows build, use the same configured tree:

```sh
cd engine
export VAPOR_RELEASE=1
./mach build
./mach package
```

The resulting zip and installer are in the object directory's `dist` folder.
With `binaryName = vapor`, the native artifacts are named with `vapor` rather
than `zen` (for example, `vapor.installer.exe`).

## Profile directories

The browser creates the directories on first startup. To create a named
`default` profile before launch, run this in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\build\windows\create-profile-directories.ps1
```

That creates:

```text
%APPDATA%\Vapor\Profiles\
%APPDATA%\Vapor\Profiles\default\vapor-blocklists\
%APPDATA%\Vapor\Profiles\default\vapor-templates\
%APPDATA%\Vapor\Profiles\default\vapor-reading-list\
```

For a profile selected by Firefox's profile manager, the startup module creates
the three `vapor-*` directories below the active profile as well.

## Round 1 source/configuration changes

- `surfer.json` changes the product name, app id, binary name, display version,
  source repository metadata, and release branding to Vapor / `0.1.0-alpha`.
- `configs/common/mozconfig` sets `Vapor` as the application basename/vendor,
  keeps `firefox` as the Gecko product, disables the crash reporter at
  configure time, and clears data-reporting/telemetry build variables.
- `src/external-patches/manifest.json` uses the checked-in local
  `librewolf/firefox-in-ua.patch`, which forces the compatibility UA application
  token to `Firefox`. No `Vapor/1.0` token is added.
- `prefs/vapor/foundation.yaml` locks browser-wide AI/chat/sidebar controls off
  in accordance with Section 0.2, and the existing privacy bundle locks telemetry,
  health reporting, crash submissions, Normandy/studies, Pocket, Firefox
  Accounts/Sync, extension recommendations, sponsored new-tab/URL-bar results,
  Relay/breach and VPN promotional surfaces off.
- The Activity Stream patch keeps sponsored top sites disabled. User-created
  top sites remain enabled; the Pocket/top-stories feed is disabled.
- `src/zen/common/aboutVapor.xhtml` implements `about:vapor` with the Vapor
  name, `0.1.0-alpha` fallback, runtime Gecko version, build date, and tagline.
  `about:telemetry` is redirected to a static page stating that telemetry is
  disabled.
- The about dialog, localized UI strings, application window branding, and
  Windows branding assets use Vapor. `configs/branding/*/content/vapor-crosshair.svg`
  is the Round 1 placeholder icon, with matching PNG/ICO assets for the
  Windows installer and Start menu.
- `VaporProfileDirectories.sys.mjs` creates the local-first profile folders at
  startup. The PowerShell helper is provided for deterministic pre-creation.
- Round 2 adds `src/zen/shield/VaporShield.sys.mjs`, a local 12,000+ domain
  default blocklist, persistent `user.txt`, blank response assets, the toolbar
  switch, per-site Shield permission, and the Adblocker settings pane. Its
  parser intentionally implements only the simplified Section 1.2 syntax.
- Later-round features from Sections 2–18 are deliberately not added.

## Verification checklist

After `./mach run --noprofile`:

1. The title bar and About dialog say **Vapor Browser**.
2. Open `about:vapor`; verify `0.1.0-alpha`, the Gecko version, a build date,
   and **The web, evaporated of nonsense.**.
3. Open `about:telemetry`; it must show the Vapor disabled page. In
   `about:config`, the locked values `toolkit.telemetry.enabled` and
   `datareporting.policy.dataSubmissionEnabled` must both be `false`.
4. In `about:config`, verify `extensions.pocket.enabled`,
   `identity.fxaccounts.enabled`, and `services.sync.enabled` are locked
   `false`; verify `extensions.htmlaboutaddons.recommendations.enabled` and
   `browser.newtabpage.activity-stream.showSponsoredTopSites` are locked
   `false`.
5. Open a new tab: only local/user top sites are available; no Pocket/top-story
   feed or sponsored tile appears.
6. Open `about:support` and inspect **User Agent**. It must contain the normal
   `Mozilla/5.0 ... Firefox/<Gecko version>` token and must not contain
   `Vapor/1.0`.
7. Check `%APPDATA%\Vapor\Profiles\<active-profile>` for
   `vapor-blocklists`, `vapor-templates`, and `vapor-reading-list`.
8. Verify `vapor-blocklists\default.txt` contains at least 5,000 rules and
   `user.txt` survives a restart. Use Settings → Adblocker to import and export
   a `.txt` list, then use the Shield toolbar button and the site permissions
   panel to test global and per-site switches.
9. In the network inspector, a blocked image/script/stylesheet/frame should show
   a synthesized `200 OK` response with `X-Vapor-Shield: blank-response`, not a
   canceled request. WebSocket handshakes and service-worker fetches use the
   same interception controller; DNS prefetch and predictor prefetch are locked
   off for the Windows build.
