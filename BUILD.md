# Vapor Browser — Windows x86_64 build

This document describes the native Windows build for the current Vapor
implementation, through **Round 11 — Polish and Launch**. It produces a
Windows x86_64 Vapor Browser from the checked-in Zen source overlay and the
pinned Gecko source selected by `surfer.json`.

Vapor is intentionally a Windows-only fork in this project. macOS, Linux,
ARM64, and 32-bit builds are not supported targets.

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
The build does not use MinGW or clang-cl as the application compiler.

## First-time environment setup

1. Install Git, Node.js 22.x, Rust 1.95.0, and Visual Studio Build Tools using
   the versions above.
2. Install MozillaBuild 4.2.1 or newer from Mozilla's official Windows
   package, then restart the MozillaBuild shell after installation. The
   repository helper also installs the current MozillaBuild package, but it
   must be run only after `engine` exists because it downloads Gecko Visual
   Studio support files from that checkout.
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

   For a reproducible build, check out the exact Vapor commit or release tag
   you intend to build before running `npm ci`. The current development branch
   may contain source changes that are not yet part of a packaged release.

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

The first build can take a long time. `npm run import` is important: it applies
the Vapor overlay, including the Round 11 dashboard, settings templates,
sound service, first-run wizard, and `about:laser` resources. Running Gecko's
`./mach build` before importing the overlay does not produce the Vapor feature
set.

For incremental builds:

```sh
# MozillaBuild shell, repository root
npm run import                 # repeat after changing checked-in overlays
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

## Optional checks

After `engine` has been downloaded and imported, run the repository lint task
from the repository root:

```sh
npm run lint
```

This invokes Gecko's `mach lint zen` against the imported source. The repository
also uses the following lightweight checks during development:

```sh
# MozillaBuild shell or another shell with Node.js available
node --check src/zen/ui-chrome/VaporStats.sys.mjs
node --check src/zen/ui-chrome/VaporSound.sys.mjs
node --check src/zen/ui-chrome/VaporSetupWizard.mjs
node --check src/zen/ui-chrome/VaporUIChrome.sys.mjs
node --check src/zen/common/aboutVapor.js
node --check src/zen/ui-chrome/aboutLaser.js
```

A syntax check is not a substitute for `mach build`, browser startup, or
Windows runtime testing. The Linux checkout used by automated agents does not
provide the Windows compiler, Gecko object directory, or browser runtime.

## Profile directories and local data

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
the three `vapor-*` directories below the active profile as well. Runtime
services add local files as they are used, including:

```text
<profile>\vapor-blocklists\        Shield, Filter, and privacy list data
<profile>\vapor-templates\         workspace templates
<profile>\vapor-reading-list\      local reading-list entries
<profile>\vapor-stats.json          local blocking/page/routing/memory statistics
<profile>\vapor-blocklists\privacy-log.json
                                   privacy, DNS, Broom, Reflex, and URL activity
<profile>\vapor-crashes.json        local tab crash history
```

These files are local profile data; no cloud account or analytics endpoint is
required.

## Implemented product surface

The source overlay currently includes the following rounds and major surfaces:

- **Rounds 1–3:** Vapor branding and Foundation hardening; Shield
  blank-response adblocking with local lists and site permissions; Laser
  browser/content actors, Ctrl+Shift+L activation, HUD, targeting, local rules,
  and undo.
- **Rounds 4–6:** Filter DOM element blocking and Shield Breaker overlay
  removal; regular/Tor/Scramjet routing, kill switch, OpenVPN launcher;
  URL stripping, CNAME uncloaking, referrer policy, DoH, HTTPS-only,
  fingerprinting protection, clipboard/script controls, and prefetch hardening.
- **Rounds 7–9:** Broom cookie/storage cleanup, remembered sites, Reflex
  consent handling, workspace templates, tab hibernation, tab search/cleanup,
  global pins, and related settings.
- **Round 10:** command palette, shortcut sheet, status bar, routing/context
  menus, new-tab UI, redirect inspection, reading list, and related chrome.
- **Round 11:**
  - `about:vapor` local stats dashboard backed by `vapor-stats.json` and the
    existing browser/service activity logs;
  - per-page Shield popup with blocked requests, stripped parameters, CNAME
    uncloaking, bandwidth, and resource-type breakdown;
  - General, Privacy, Adblocker, Cookies, Routing, Workspaces, Tabs,
    Appearance, Sound, and Advanced settings access;
  - optional per-effect Web Audio sounds with a 30% default master volume;
  - workspace slide transition, hibernated-tab favicon treatment, and the
    dark-red cracked-glass routing overlay;
  - the `about:vapor` dissolve/reassemble animation, Century Club, Konami CRT
    mode, `about:laser`, and the 50+ tabs toast;
  - the seven-screen first-run wizard and Firefox's built-in migration wizard
    offer for Firefox, Chrome, Edge, and Brave.

## First launch and verification checklist

After `./mach run --noprofile`, verify the following on Windows:

### Foundation and privacy

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

### Defense and browser features

8. Verify `vapor-blocklists\default.txt` contains at least 5,000 rules and
   `user.txt` survives a restart. Use Settings → Adblocker to import and export
   a `.txt` list, then use the Shield toolbar button and the site permissions
   panel to test global and per-site switches.
9. In the network inspector, a blocked image/script/stylesheet/frame should show
   a synthesized `200 OK` response with `X-Vapor-Shield: blank-response`, not a
   canceled request. WebSocket handshakes and service-worker fetches use the
   same interception controller; DNS prefetch and predictor prefetch are locked
   off for the Windows build.
10. Exercise regular, Tor, and Scramjet tabs, OpenVPN detection, workspace
    switching, workspace templates, tab hibernation/wake, tab search, reading
    list actions, and the routing kill switch.

### Round 11 polish and launch

11. On the first profile launch, complete the seven wizard screens: Welcome,
    Adblocker, Privacy, Routing, OpenVPN, Templates, and Done. The Welcome
    screen must offer Firefox's built-in migration wizard and list Firefox,
    Chrome, Edge, and Brave as migration sources where installed.
12. Generate a blocked request, visit pages with tracking parameters, trigger
    privacy/Broom/Reflex/DNS actions, switch route types, and open
    `about:vapor`. Confirm that the dashboard contains local activity rather
    than placeholder-only values. Confirm `vapor-stats.json` is created in the
    active profile.
13. Click the Shield toolbar button and verify the current-page popup shows
    blocked requests, stripped parameters, uncloaked CNAMEs, bandwidth, and a
    resource-type breakdown.
14. Open Preferences and verify General, Privacy, Adblocker, Cookies, Routing,
    Workspaces, Tabs, Appearance, Sound, and Advanced are populated. In Sound,
    change master volume and independently toggle each effect: Laser zap,
    Shield Breaker, tab close, workspace switch, Tor open, kill switch, and the
    100-block adblocker milestone.
15. Verify the visual polish: switch workspaces for the slide transition,
    hibernate and wake a tab to see favicon grayscale/recolorization, and
    disconnect a Tor/Scramjet route to exercise the dark-red cracked-glass
    kill-switch overlay.
16. Verify the five easter eggs: open `about:vapor` for dissolve/reassemble,
    reach 100 Laser kills in one session for Century Club, enter
    Up Up Down Down Left Right Left Right B A for the 30-second CRT scanlines,
    open `about:laser` for the mini-game, and open more than 50 tabs for the
    toast.

The repository's checked-in source is ready for this Windows build workflow,
but Windows compilation and browser/runtime acceptance must still be performed
on the supported native Windows environment.
