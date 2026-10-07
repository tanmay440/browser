# Vapor Browser

Vapor Browser is a Windows 10/11 x86_64 fork of Zen Browser and Gecko. It
keeps Zen's vertical tabs, workspaces, compact mode, split view, and modern
browser chrome while replacing the product branding and removing Mozilla
telemetry, sponsored content, and Mozilla service UI.

> The web, evaporated of nonsense.

## Current status

The checked-in implementation covers **Rounds 1–11** of
[SPEC.md](SPEC.md), through **Polish and Launch**:

- **Foundation:** Vapor branding, Windows packaging, local profile directories,
  telemetry/service hardening, and the local-only `about:vapor` page.
- **Defense stack:** Shield blank-response adblocking, Laser vaporization,
  Filter DOM blocking, Shield Breaker overlay removal, URL stripping, CNAME
  uncloaking, referrer/privacy controls, DoH, HTTPS-only mode, fingerprinting
  protection, clipboard/script protections, Broom cookie cleanup, and Reflex
  consent handling.
- **Routing and organization:** Regular, Tor, and Scramjet tab types, the
  OpenVPN launcher, the routing kill switch, workspace templates, tab
  hibernation, search, cleanup, global pins, reading list, and UI/chrome
  command surfaces.
- **Round 11 polish:** A local persistent statistics dashboard, per-page Shield
  stats, populated settings pages, optional individually toggleable Web Audio
  effects, workspace and hibernation visual effects, the cracked-glass kill
  switch, all five easter eggs, a seven-screen first-run wizard, and the
  Firefox migration wizard offer for Firefox, Chrome, Edge, and Brave.

This is an active Windows-targeted browser fork, not a claim of completed
Windows compilation or runtime acceptance from this repository checkout. Build
and test it on the supported native Windows toolchain described in
[BUILD.md](BUILD.md).

## Local-first data

Vapor does not require an account or cloud service for these features. Runtime
state is stored in the active Firefox profile. Depending on which features are
used, the profile contains local blocklists, templates, reading-list data,
privacy/filter activity logs, tab crash history, and `vapor-stats.json`.

The statistics dashboard reads that local browser/service data rather than a
remote analytics service. Open `about:vapor` to see blocking totals, daily
activity, domains and resource types, Laser history, privacy and routing logs,
memory/hibernation information, workspace data, and crash history. Click the
Vapor Shield toolbar button for the current page's blocked-request,
parameter-stripping, CNAME, bandwidth, and resource-type summary.

## Build

See [BUILD.md](BUILD.md) for the reproducible Windows x86_64 build
instructions. The short version is:

```sh
npm ci
npm run surfer -- ci --brand release --display-version 0.1.0-alpha
npm run download
# Run build/windows/bootstrap.ps1 after engine exists.
npm run import
npm run bootstrap
cd engine
./mach configure
./mach build
./mach run --noprofile
```

Run these commands from a native MozillaBuild shell on Windows. WSL, MinGW,
Linux, macOS, ARM64, and 32-bit builds are outside the supported target.

## First launch and useful surfaces

- The first launch opens the Vapor setup wizard: Welcome, Adblocker, Privacy,
  Routing, OpenVPN, Templates, and Done.
- The wizard offers Firefox's built-in migration wizard, which can import from
  Firefox, Chrome, Edge, or Brave.
- `about:vapor` is the local stats dashboard.
- `about:laser` is the standalone Laser mini-game.
- `Ctrl+Shift+L` toggles the browser's Laser feature.
- `Ctrl+Shift+B` toggles Shield Breaker where supported by the browser chrome.
- The command palette and shortcut sheet are available from the browser chrome.

## Repository layout

- `src/zen/` contains the Vapor/Zen browser overlay and Gecko integration.
- `src/browser/components/preferences/` contains the settings templates and
  preference integration patches.
- `prefs/vapor/` contains generated preference defaults for the Vapor feature
  bundles.
- `build/windows/` contains Windows bootstrap and profile-directory helpers.
- `SPEC.md` is the product specification; it is not a substitute for the
  round-specific build instructions.
