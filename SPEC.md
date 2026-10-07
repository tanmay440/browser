\# VAPOR BROWSER — MASTER SPECIFICATION



> \*"The web, evaporated of nonsense."\*



\*\*Version:\*\* 1.1-draft

\*\*Base:\*\* Zen Browser (Firefox/Gecko fork)

\*\*Platform:\*\* Windows only (x86\_64)

\*\*Last Updated:\*\* 2025-07-12



\---



\## ⚠️ HOW TO USE THIS DOCUMENT



\*\*This is a reference specification, NOT a build guide.\*\*



\- Do NOT attempt to build the entire browser from this document in a single pass.

\- Do NOT implement features unless explicitly directed by the user in a specific build round.

\- This document defines \*what\* the browser should eventually do. The user will direct \*when\* and \*in what order\* each feature is built.

\- Each build round will reference specific sections of this spec. Only implement the sections cited in the round prompt.

\- If a round prompt says "implement Section 1," you implement Section 1. You do NOT also implement Section 2 because it seems related.

\- When in doubt, ask the user before building anything not explicitly requested in the current round.



\*\*The user is the architect. This document is the blueprint. You are the builder. Build only what you are told to build, when you are told to build it.\*\*



\---



\## TABLE OF CONTENTS



\- \[0. Foundation \& Philosophy](#0-foundation--philosophy)

\- \[1. The Shield (Adblocker)](#1-the-shield-adblocker)

\- \[2. The Laser (Vaporization)](#2-the-laser-vaporization)

\- \[3. The Filter (DOM Element Blocking)](#3-the-filter-dom-element-blocking)

\- \[4. The Shield Breaker (Anti-Adblock Overlay)](#4-the-shield-breaker-anti-adblock-overlay)

\- \[5. Network Routing (Tab Types)](#5-network-routing-tab-types)

\- \[6. OpenVPN Launcher](#6-openvpn-launcher)

\- \[7. Privacy \& Tracking Protection](#7-privacy--tracking-protection)

\- \[8. The Broom (Auto-Delete Cookies)](#8-the-broom-auto-delete-cookies)

\- \[9. The Reflex (Auto-Decline Consent)](#9-the-reflex-auto-decline-consent)

\- \[10. Workspace Templates](#10-workspace-templates)

\- \[11. Tab Management](#11-tab-management)

\- \[12. UI/UX \& Chrome](#12-uiux--chrome)

\- \[13. Stats \& Dashboards](#13-stats--dashboards)

\- \[14. Settings Structure](#14-settings-structure)

\- \[15. Polish \& Delight](#15-polish--delight)

\- \[16. First-Run Experience](#16-first-run-experience)

\- \[17. Out of Scope](#17-out-of-scope)

\- \[18. Defense Stack Summary](#18-defense-stack-summary)



\---



\## 0. FOUNDATION \& PHILOSOPHY



\### 0.1 Base



\- Fork of \*\*Zen Browser\*\* (which is itself a Firefox/Gecko fork)

\- Inherits: vertical tab bar, workspaces, compact mode, split view, modern chrome

\- All Zen-specific features remain functional unless explicitly overridden below



\### 0.2 Core Principles



\- \*\*No browser-wide AI.\*\* No sidebar assistants, no page summarizers, no "ask AI about this page." AI tools are external applications the user runs separately. This is a non-negotiable architectural decision maintained throughout all development.

\- \*\*No telemetry.\*\* Zero. No crash reports to Mozilla, no usage pings, no "help improve Vapor" opt-ins. The `about:telemetry` page is gutted.

\- \*\*No Mozilla services.\*\* No Firefox Sync, no Pocket, no Firefox Relay, no Firefox Monitor, no Mozilla VPN upsells. All stripped.

\- \*\*No sponsored shortcuts.\*\* New tab page top sites are user-generated only. No "sponsored by Booking.com" tiles.

\- \*\*Local-first configuration.\*\* All settings, blocklists, templates, and user data live in the local profile directory. Nothing is cloud-synced by default.

\- \*\*Transparent behavior.\*\* Every blocking, stripping, or routing action is logged and inspectable by the user. No silent modifications.



\### 0.3 Naming \& Branding



\- Browser name: \*\*Vapor\*\* (working title)

\- About page (`about:vapor`) shows version, build date, Gecko version, and tagline

\- Custom icon: Round 1 uses a placeholder crosshair; the final dissolving-element motif remains TBD

\- User-agent string: reports as standard Firefox (for compatibility and fingerprinting uniformity), not "Vapor/1.0"



\### 0.4 Extension Compatibility



\- Fully compatible with Firefox Add-ons (AMO)

\- uBlock Origin, Privacy Badger, etc. can be installed but the built-in adblocker is designed to make them redundant for most users

\- If a user installs uBlock Origin alongside the built-in blocker, both run without conflict (the built-in blocker operates at a lower network layer)

\- Extension recommendations page is removed (no Mozilla-curated suggestions)



\### 0.5 Platform



\- \*\*Windows only.\*\* No macOS, no Linux.

\- Target: Windows 10 (21H2+) and Windows 11

\- Architecture: x86\_64 only (no ARM64, no 32-bit)

\- Build toolchain: MozillaBuild for Windows, MSVC compiler

\- Installer: NSIS or WiX, single `.exe` installer

\- All file paths use Windows conventions (`C:\\`, backslashes)

\- All keyboard shortcuts use `Ctrl` only (no `Cmd` variants)

\- Profile directory: `%APPDATA%\\Vapor\\Profiles\\`

\- Install directory: `C:\\Program Files\\Vapor\\`

\- No macOS-specific APIs, frameworks, or behaviors

\- No Linux-specific APIs, package managers, or display server considerations



\### 0.6 Round 1 implementation notes



\- Vapor is forked from Zen Browser desktop commit `3585fef4f6a76723c00ab6571419c920eda65f4e` (the `dev` branch snapshot used for this Foundation round).

\- The checked-in Zen source overlay is retained under the existing `src/zen` paths so inherited Zen features and patch tooling continue to build; those paths and internal `zen.*` preference/message identifiers are compatibility implementation details, not product branding.

\- The Gecko base selected by `surfer.json` is Firefox `157.0.1`; the Vapor display version is `0.1.0-alpha`.

\- Round 1 adds the Vapor branding configuration, placeholder crosshair assets, `about:vapor`, a gutted `about:telemetry` page, locked no-telemetry/no-Mozilla-service defaults, Firefox-compatible UA configuration, and automatic local profile-directory creation.

\- No implementation from Sections 1–18 has been added. The inherited source still contains its upstream cross-platform build scaffolding, but the documented and supported Vapor target is Windows 10/11 x86\_64 only.



\---



\## 1. THE SHIELD (ADBLOCKER)



\### 1.1 Architecture



\- Operates at the \*\*network channel level\*\* (deeper than WebExtensions API)

\- Intercepts all outgoing HTTP/HTTPS requests before they leave the browser

\- Checks the request URL against the blocklist

\- \*\*Does NOT cancel the request.\*\* Instead, serves a local blank response:

&#x20; - Image requests (`\*.png`, `\*.jpg`, `\*.gif`, `\*.webp`, `\*.svg`): serves 1x1 transparent pixel from `chrome://vapor/content/blank.png`

&#x20; - Script requests (`\*.js`): serves empty JS file from `chrome://vapor/content/blank.js` (valid JS, zero bytes of executable code, prevents `onerror` callbacks)

&#x20; - Iframe requests: serves blank HTML document from `chrome://vapor/content/blank.html`

&#x20; - CSS requests: serves empty stylesheet from `chrome://vapor/content/blank.css`

&#x20; - All other types: serves `200 OK` with zero-byte body

\- \*\*Why serve instead of cancel:\*\* canceling triggers `onerror` events, which ad scripts use to detect adblockers and show "please disable your adblocker" walls. Serving a valid empty response makes the ad script think the ad loaded successfully. The slot just renders nothing.



\### 1.2 Blocklist Format



\- Plain text files, one rule per line

\- Located in `%APPDATA%\\Vapor\\Profiles\\\[profile]\\vapor-blocklists\\`

\- Two files:

&#x20; - `default.txt` — ships with browser, updated via browser updates, read-only to user

&#x20; - `user.txt` — created and modified by user (and by the laser), never overwritten by updates

\- Rule syntax (simplified ABP/uBlock subset):

&#x20; ```

&#x20; # Comments start with hash

&#x20; # Simple domain block (blocks all subdomains)

&#x20; doubleclick.net

&#x20; googlesyndication.com



&#x20; # Exact URL pattern

&#x20; ||example.com/ads/banner.js



&#x20; # Wildcard

&#x20; ||\*.adserver.com/\*



&#x20; # Exception

&#x20; @@||trusted.example.com/

&#x20; ```

\- Full ABP compatibility is explicitly out of scope (use uBlock Origin for that)



\### 1.3 Default Blocklist



\- Ships with \~5,000–10,000 domains covering:

&#x20; - Major ad networks (Google Ads, Meta Ads, Taboola, Outbrain, Criteo, etc.)

&#x20; - Tracking pixels (Facebook Pixel, Google Analytics, Hotjar, Mixpanel, etc.)

&#x20; - Crypto miners (CoinHive and successors)

&#x20; - Malware/phishing domains (from public threat feeds)

&#x20; - Consent management popups (OneTrust, Cookiebot, etc.)

\- Compiled from public lists (EasyList, EasyPrivacy, Peter Lowe's) but curated and deduplicated



\### 1.4 Settings



\- Toggle: Enable/Disable Shield globally

\- Toggle: Enable/Disable per workspace (via template config)

\- Toggle: Enable/Disable per site (via site permissions panel)

\- Toggle: Block consent popups (on/off)

\- Toggle: Block crypto miners (on/off)

\- View blocklist: settings page showing all entries with search/filter

\- Import/Export: import `.txt` file, export `user.txt`

\- Reset: clear `user.txt` back to empty



\### 1.5 Edge Cases



\- \*\*First-party ads:\*\* if a site serves ads from its own domain, the domain-level block won't catch it. The user must use the laser to target the specific URL pattern. The laser adds the full path to `user.txt`.

\- \*\*WebSocket ads:\*\* interceptor checks `ws://` and `wss://` handshake URLs against the blocklist.

\- \*\*Service workers:\*\* ads registered via service workers are intercepted at the fetch event level.

\- \*\*DNS prefetch:\*\* disabled for blocked domains to prevent leaking interest to DNS resolver.



\---



\## 2. THE LASER (VAPORIZATION)



\### 2.1 Activation



\- Toolbar button: crosshair icon (🎯) in top-right chrome, next to URL bar

\- Keyboard shortcut: `Ctrl+Shift+L` (toggle on/off)

\- When activated:

&#x20; - Cursor changes to custom crosshair reticle (red dot with crosshairs, 24x24px)

&#x20; - Subtle red vignette around viewport edges (10% opacity)

&#x20; - Floating HUD in bottom-left: `"LASER ACTIVE — Click any element to vaporize"`

&#x20; - HUD includes session kill counter: `"Vaporized: 3"`



\### 2.2 Targeting Behavior



\- Hovering over elements: red highlight outline (2px solid red with glow) on element bounding box

\- \*\*Smart targeting:\*\* laser identifies the "ad container" rather than just the innermost element:

&#x20; 1. User clicks an element (e.g., `<img>`)

&#x20; 2. Laser walks up DOM tree looking for parent with ad container indicators:

&#x20;    - `id` or `class` containing "ad", "banner", "sponsor", "promoted"

&#x20;    - `<iframe>` with cross-origin `src`

&#x20;    - `<div>` with dimensions matching common ad sizes (300x250, 728x90, 160x600, etc.)

&#x20; 3. If container found, targets the container (removes whole ad unit)

&#x20; 4. If no container found, targets clicked element directly

\- `Alt+Click` forces targeting of exact element under cursor (no parent walking)



\### 2.3 Vaporization Effect



On click, the targeted element:

1\. Flashes white for 50ms (laser hit)

2\. Dissolves into particles over 300ms (\~20 small squares scatter outward and fade)

3\. Element removed from DOM

4\. Space collapses (layout reflows, no empty gap)

5\. Tiny `\*pew\*` sound plays (if sound effects enabled)

6\. Kill counter increments



\### 2.4 Domain Extraction \& Blocklist Addition



After element removal, laser extracts the source:

1\. Checks `src`, `href`, `data-src`, `data-href`, `poster`, `srcset` attributes

2\. If `<iframe>`, checks `src` URL

3\. If `<div>` with CSS background image, extracts `background-image` URL from computed styles

4\. If loaded via script, checks network log for most recent request associated with element's subtree

5\. Extracts \*\*domain\*\* from URL (e.g., `https://ads.evil.com/banner/12345` → `ads.evil.com`)

6\. Appends to `user.txt` with comment:

&#x20;  ```

&#x20;  # Added by laser on 2025-01-15 from https://example.com

&#x20;  ads.evil.com

&#x20;  ```

7\. Skips if domain already in `user.txt` or `default.txt`

8\. If source is \*\*same-origin\*\*, adds full URL path pattern instead:

&#x20;  ```

&#x20;  # Added by laser on 2025-01-15 (same-origin)

&#x20;  ||example.com/assets/sponsored-banner-\*.js

&#x20;  ```



\### 2.5 Undo



\- `Ctrl+Z` within 10 seconds undoes last vaporization:

&#x20; - Element re-inserted into DOM

&#x20; - Domain removed from `user.txt`

&#x20; - Kill counter decrements

&#x20; - "Restored" toast for 2 seconds

\- After 10 seconds, zap is permanent



\### 2.6 Deactivation



\- Click toolbar button, press `Ctrl+Shift+L`, or press `Escape`

\- Cursor returns to normal, vignette fades, HUD disappears

\- Kill counter total preserved in stats dashboard



\### 2.7 Edge Cases



\- \*\*Shadow DOM:\*\* laser pierces shadow DOM boundaries

\- \*\*Canvas ads:\*\* laser removes canvas but cannot extract source URL. Logs page URL and canvas dimensions to `user.txt` as comment for manual review.

\- \*\*Video ads (pre-roll):\*\* pauses video, removes ad overlay, attempts to skip to main content. Best-effort.

\- \*\*Infinite scroll ads:\*\* domain addition blocks on next load; current session may still show until refresh.



\---



\## 3. THE FILTER (DOM ELEMENT BLOCKING)



\### 3.1 Concept



Operates between the Shield (network) and the Laser (manual). Prevents specific HTML element types from ever activating or rendering on a per-site or per-domain basis, regardless of whether their network requests succeeded.



Catches the gap where:

\- Shield served a blank file (200 OK, no error) ✓

\- But the blank file's container element still exists in the DOM

\- And the site's JS checks whether that container has real content

\- And triggers an anti-adblock response when it doesn't



\### 3.2 How It Works



\- `MutationObserver` injected at `document\_start` (before page scripts run)

\- Watches for new DOM nodes, checks against rules

\- When a node matches, \*\*prevents activation\*\*:

&#x20; - `<script>`: `textContent` replaced with single space before parser executes it. Tag exists in DOM but does nothing.

&#x20; - `<iframe>`: `src` removed, replaced with `about:blank`. Element exists but loads nothing.

&#x20; - `<object>` / `<embed>`: `data` or `src` removed. Renders as empty box.

&#x20; - `<link rel="preload">` / `<link rel="prefetch">`: `href` removed. Resource never fetched.

&#x20; - `<img>` / `<video>` / `<audio>`: `src` and `srcset` removed. Element given `visibility: hidden`.

&#x20; - Custom elements (`<ad-slot>`, `<gpt-ad>`): replaced with empty `<div>` of same dimensions.



\### 3.3 Rule Format



Stored in `%APPDATA%\\Vapor\\Profiles\\\[profile]\\vapor-blocklists\\element-filters.txt`:

```

\# Format: \[scope] \[element] \[condition]



\# Block iframes from specific domain on specific site

||example.com##iframe\[src\*="doubleclick.net"]



\# Block scripts containing specific string in src

||example.com##script\[src\*="googletagmanager"]



\# Block all <object> and <embed> on specific site

||example.com##object,embed



\# Block custom ad elements site-wide

\*##gpt-ad,ad-slot,amp-ad,dfp-ad



\# Block iframes matching common ad dimensions

\*##iframe\[width="300"]\[height="250"]

\*##iframe\[width="728"]\[height="90"]



\# Block scripts from specific domain globally

\*##script\[src\*="analytics.evil.com"]



\# Exception: allow YouTube iframes

@@\*##iframe\[src\*="youtube.com"]

```



Syntax modeled after uBlock Origin cosmetic filters (`##`) but simplified.



\### 3.4 Default Element Filter Rules



Ships with curated rules targeting:

\- Known ad container custom elements (`<gpt-ad>`, `<amp-ad>`, `<dfp-ad>`, `<ad-slot>`, `<taboola-block>`)

\- Common ad iframe patterns (iframes with `src` matching known ad networks)

\- Third-party script tags from tracking domains

\- `<object>` and `<embed>` from non-whitelisted domains



\### 3.5 Settings



\- Toggle: Enable/Disable globally

\- Toggle: Enable/Disable per site

\- View/Edit rules: settings page showing all active rules

\- Runs silently — no visual indicator when blocking

\- Logging: all filtered elements logged in `about:vapor` → "DOM Filters"



\### 3.6 Interaction with Shield and Laser



```

Request fires → Shield checks blocklist → serves blank file if matched

&#x20;    ↓

HTML parses → Filter checks element rules → neutralizes element if matched

&#x20;    ↓

Page renders → User sees remaining ads → Laser vaporizes manually

```



The three layers ensure the page's JavaScript sees:

\- Network request succeeded (Shield served 200 OK) ✓

\- DOM element exists (Filter left tag in place) ✓

\- Element has no real content (Filter neutralized payload) ✓



This is the hardest combination for anti-adblock to detect.



\### 3.7 Edge Cases



\- \*\*Dynamically injected elements:\*\* `MutationObserver` catches elements added by JS after page load

\- \*\*Shadow DOM:\*\* Filter pierces shadow roots

\- \*\*`document.write()`:\*\* Filter hooks into `document.write`/`document.writeln` and sanitizes output

\- \*\*Performance:\*\* configured to watch `childList` only. \~50–200 mutations during load, <5ms total

\- \*\*False positives:\*\* right-click broken area → "Report False Positive" → rule temporarily disabled for that site



\---



\## 4. THE SHIELD BREAKER (ANTI-ADBLOCK OVERLAY)



\### 4.1 The Problem



Advanced anti-adblock detection checks beyond failed requests:

\- Whether ad container has real dimensions (blank file makes it 1x1)

\- Whether specific JS variables were set by ad script (blank.js doesn't set them)

\- Whether `onload` callback fired with expected data

\- Whether `window.googletag` or `window.pbjs` exist with expected properties



When checks fail, site deploys a full-screen overlay: "Please disable your adblocker."



\### 4.2 Activation



\- \*\*Automatic:\*\* Filter's `MutationObserver` detects overlay patterns. Toast appears: `"Anti-adblock overlay detected. \[Vaporize It]"`

\- \*\*Manual via Laser:\*\* if laser is active and user clicks an overlay, laser auto-switches to Shield Breaker mode

\- \*\*Keyboard:\*\* `Ctrl+Shift+B` activates Shield Breaker on most likely overlay element



\### 4.3 Overlay Detection Heuristics



Element must match \*\*at least 3 of 5 criteria\*\*:

1\. \*\*Position:\*\* `fixed` or `absolute` with `z-index > 1000`

2\. \*\*Coverage:\*\* dimensions >80% of viewport

3\. \*\*Timing:\*\* added to DOM after initial page load

4\. \*\*Content:\*\* text matching anti-adblock phrases (stored in `%APPDATA%\\Vapor\\Profiles\\\[profile]\\vapor-blocklists\\overlay-phrases.txt`, user-editable):

&#x20;  - "disable your ad blocker", "ad blocker detected", "please whitelist", "turn off your adblocker", "ad blocking software", "content is blocked", "allow ads", "support us by"

5\. \*\*Page freeze:\*\* `<body>`/`<html>` has `overflow: hidden` and/or content has `pointer-events: none` or `filter: blur()`



\### 4.4 Vaporization Sequence (5 Steps)



\*\*Step 1 — Kill overlay element\*\*

\- Overlay DOM node removed with laser dissolve animation

\- If inside iframe, iframe is targeted instead



\*\*Step 2 — Restore scrollability\*\*

\- Scans `<html>` and `<body>` for `overflow: hidden`, `overflow: clip`, `position: fixed`

\- Removes these styles, stores originals in data attribute for undo

\- `document.documentElement.style.overflow = 'auto'`

\- `document.body.style.overflow = 'auto'`



\*\*Step 3 — Restore interaction\*\*

\- Removes `pointer-events: none` applied by overlay script

\- Removes `filter: blur()` from main content

\- Removes `user-select: none`



\*\*Step 4 — Kill watchdogs\*\*

\- Enumerates all active `MutationObserver` instances (via hooked constructor installed at `document\_start`)

\- Identifies observers watching overlay's parent container

\- Calls `.disconnect()` on those observers

\- Kills `setInterval`/`setTimeout` loops re-checking for overlay (via hooked timers)

\- Patches `requestAnimationFrame` callbacks to skip overlay check



\*\*Step 5 — Inject CSS kill rule\*\*

\- Injects `<style>` into `<head>`:

&#x20; ```css

&#x20; /\* Vapor Shield Breaker — injected \[timestamp] \*/

&#x20; .adblock-overlay, .ad-blocker-detected, #adblock-modal {

&#x20;   display: none !important;

&#x20;   visibility: hidden !important;

&#x20;   opacity: 0 !important;

&#x20;   pointer-events: none !important;

&#x20;   height: 0 !important;

&#x20;   z-index: -1 !important;

&#x20; }

&#x20; html, body {

&#x20;   overflow: auto !important;

&#x20;   position: static !important;

&#x20; }

&#x20; ```

\- Class names extracted from killed overlay element

\- Persists for page lifetime, prevents re-creation



\### 4.5 Visual Feedback



\- Overlay shatters like glass (crack lines from click point, 200ms)

\- Shards fall and fade (300ms)

\- Page content "unblurs" (200ms)

\- Toast: `"Overlay vaporized. Page restored. 🛡️💥"`

\- Sound: \*crack-shatter\* (deeper than laser \*pew\*)

\- Kill counter increments by \*\*5\*\*



\### 4.6 Persistent Overlay Memory



\- Saved to `%APPDATA%\\Vapor\\Profiles\\\[profile]\\vapor-blocklists\\overlay-memory.json`:

&#x20; ```json

&#x20; {

&#x20;   "example.com": {

&#x20;     "last\_killed": "2025-01-15T14:30:00Z",

&#x20;     "selectors": \[".adblock-modal", "#overlay-container"],

&#x20;     "body\_fixes": \["overflow: hidden", "filter: blur(5px)"],

&#x20;     "watchdog\_types": \["MutationObserver", "setInterval"]

&#x20;   }

&#x20; }

&#x20; ```

\- On future visits, Filter preemptively applies CSS kill rule and disconnects watchdogs before overlay appears

\- Per-domain, persists across sessions

\- Viewable/clearable in Settings → Adblocker → Overlay Memory



\### 4.7 Edge Cases



\- \*\*Multi-layer overlays:\*\* detects and kills all layers in single pass

\- \*\*Server-side detection:\*\* Filter's preemptive CSS injection hides overlay before render

\- \*\*Paywalls:\*\* Shield Breaker targets adblock overlays only, not paywalls (heuristics distinguish the two)

\- \*\*SPA re-triggers:\*\* patches `popstate`/`hashchange` listeners to skip overlay check

\- \*\*`!important` wars:\*\* injected CSS uses `!important` and is injected after page stylesheets, winning the cascade. Filter re-injects if site dynamically adds new stylesheets.



\---



\## 5. NETWORK ROUTING (TAB TYPES)



\### 5.1 New Tab Menu



The `+` button opens a dropdown:

```

┌─────────────────────────┐

│  + New Tab         🟢   │

│  + New Tor Tab     🟣   │

│  + New Scramjet Tab 🔵  │

│  ─────────────────────  │

│  + New Private Tab  ⚫   │

└─────────────────────────┘

```



Keyboard shortcuts:

\- `Ctrl+T` → New Tab (regular)

\- `Ctrl+Shift+T` → New Tor Tab

\- `Ctrl+Alt+T` → New Scramjet Tab

\- `Ctrl+Shift+P` → New Private Tab



Default new tab type is configurable per workspace via templates.



\### 5.2 Regular Tabs (🟢)



\- Standard browsing, no special routing

\- Uses system's default network interface

\- If OpenVPN launched via launcher button, regular tabs route through VPN (OS-level)

\- Green left border (2px, `#4CAF50`)

\- No special icon



\### 5.3 Tor Tabs (🟣)



\- Route all traffic through local Tor SOCKS5 proxy (`127.0.0.1:9050`)

\- \*\*Tor daemon management:\*\*

&#x20; - On first Tor tab, checks if Tor running on port 9050

&#x20; - If not, launches bundled Tor binary as background subprocess

&#x20; - Bundled at `C:\\Program Files\\Vapor\\tor\\tor.exe`

&#x20; - Minimal `torrc`:

&#x20;   ```

&#x20;   SOCKSPort 9050

&#x20;   ControlPort 9051

&#x20;   CookieAuthentication 1

&#x20;   DataDirectory %APPDATA%\\Vapor\\Profiles\\\[profile]\\tor-data

&#x20;   ```

&#x20; - Tor process killed on browser exit (or when last Tor tab closed, configurable)

\- \*\*DNS:\*\* all resolution through Tor (`network.proxy.socks\_remote\_dns = true`)

\- \*\*WebRTC:\*\* disabled (`media.peerconnection.enabled = false`)

\- \*\*Isolation:\*\* separate cookie jar and storage (dedicated Firefox container)

\- Purple left border (2px, `#9C27B0`), 🧅 icon

\- Status bar: `TOR | Exit: 185.220.101.42 (DE) | Circuit: 3 hops`

\- \*\*Kill switch:\*\* if Tor drops, all Tor tabs freeze. Red overlay: `"TOR CONNECTION LOST — Tab frozen to prevent IP leak. \[Reconnect] \[Close Tab]"`



\### 5.4 Scramjet Tabs (🔵)



\- Route through Scramjet web proxy instance

\- \*\*Configuration:\*\* user sets proxy URL in Settings → Routing → Scramjet

&#x20; - `https://my-scramjet-instance.example.com` or `http://localhost:8080`

\- Browser rewrites URLs using Scramjet client library (bundled)

\- \*\*Use case:\*\* bypassing network-level content filters. NOT an anonymity tool.

\- \*\*DNS:\*\* resolution on Scramjet server

\- Blue left border (2px, `#2196F3`), 🚀 icon

\- Status bar: `SCRAMJET | Proxy: my-scramjet.example.com | Latency: 120ms`

\- \*\*Kill switch:\*\* if proxy unreachable, tabs freeze: `"SCRAMJET PROXY UNREACHABLE — \[Retry] \[Close Tab]"`



\### 5.5 Private Tabs (⚫)



\- Standard Firefox Private Browsing, preserved from Zen

\- No history, no cookies persisted, no cache

\- Same routing as regular tabs



\### 5.6 Mixed Routing Warnings



\- Dragging Tor tab into workspace with regular tabs: warning about not confusing tab types

\- Middle-click link in Tor tab: new tab inherits Tor routing

\- Right-click link in Tor tab: context menu offers "Open in New Tor Tab" and "Open in New Regular Tab" (with ⚠️)



\---



\## 6. OPENVPN LAUNCHER



\### 6.1 Behavior



\- Toolbar button: shield icon with keyhole (🛡️)

\- Click sequence:

&#x20; 1. Search for OpenVPN GUI binary at:

&#x20;    - `C:\\Program Files\\OpenVPN\\bin\\openvpn-gui.exe`

&#x20;    - `C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn-gui.exe`

&#x20;    - Registry key: `HKLM\\SOFTWARE\\OpenVPN\\exe\_path`

&#x20; 2. If found, launch: `openvpn-gui.exe --connect default.ovpn`

&#x20; 3. If not found: notification with link to `https://openvpn.net/community-downloads/`

&#x20; 4. Button states: yellow pulsing (connecting), green solid (connected), gray (disconnected)

&#x20; 5. Click green shield to disconnect



\### 6.2 Configuration



\- Settings → Routing → OpenVPN:

&#x20; - Override binary path (if auto-detect fails)

&#x20; - Override default profile name (if not "default")

&#x20; - Toggle: "Auto-connect on browser launch"

&#x20; - Toggle: "Warn if VPN is disconnected"



\### 6.3 Scope



\- \*\*Launcher only\*\*, not a VPN client. Browser does not manage the tunnel.

\- Regular tabs route through VPN once connected (OS-level).

\- Tor and Scramjet tabs unaffected.



\---



\## 7. PRIVACY \& TRACKING PROTECTION



\### 7.1 URL Parameter Stripping



\- Removes known tracking parameters from URLs \*\*before request is sent\*\*

\- Cleaned URL is what server sees and what appears in address bar

\- Default strip list:

&#x20; ```

&#x20; utm\_source, utm\_medium, utm\_campaign, utm\_term, utm\_content

&#x20; fbclid, gclid, gclsrc, dclid

&#x20; msclkid, twclid

&#x20; mc\_cid, mc\_eid

&#x20; \_hsenc, \_hsmi, \_\_s, \_\_hsfp, \_\_hssc, \_\_hstc

&#x20; vero\_id, \_branch\_match\_id

&#x20; mkt\_tok

&#x20; igshid

&#x20; si (YouTube)

&#x20; ref, ref\_src, ref\_url (when tracking, not navigation)

&#x20; ```

\- User-editable in Settings → Privacy → URL Stripping

\- Toggle: global and per-site

\- Only removes params matching known tracking list; does NOT strip arbitrary query params

\- Cleans final destination URL after redirect chains resolve



\### 7.2 CNAME Uncloaking



\- Before blocklist check, resolves domain's CNAME records

\- If `analytics.mysite.com` CNAMEs to `tracker.evil.com`, blocklist checks `tracker.evil.com`

\- Uses browser DNS resolver; if DoH enabled, CNAME resolution goes through DoH

\- Toggle: Settings → Privacy → CNAME Uncloaking

\- CNAME results cached for 1 hour

\- Events logged in `about:vapor`



\### 7.3 Fingerprinting Protection



| API | What It Reveals | Vapor Default |

|---|---|---|

| Canvas `toDataURL`/`getImageData` | Unique canvas fingerprint | Deterministic noise per-site |

| WebGL `RENDERER` | GPU model | Returns `"Generic WebGL Renderer"` |

| AudioContext | Audio fingerprint | Noise added to `OfflineAudioContext` |

| `document.fonts` | Installed fonts | Returns web-safe set only |

| Screen resolution | Physical screen size | Reports window inner dimensions |

| Timezone | User location | Reports UTC (configurable) |

| Language | User locale | Reports `en-US` (configurable) |

| `navigator.hardwareConcurrency` | CPU cores | Spoof to `4` |

| `navigator.deviceMemory` | RAM | Spoof to `8` |

| `navigator.connection` | Network type | Spoof to `4g` / `10 Mbps` |

| `navigator.getBattery()` | Battery state | Blocked, returns `undefined` |

| `navigator.getGamepads()` | Controllers | Returns empty array |

| `navigator.mediaDevices.enumerateDevices()` | Device IDs | Generic labels, randomized IDs per session |

| `navigator.plugins` | Plugins | Returns empty array |

| `navigator.mimeTypes` | MIME types | Returns standard set |

| `window.screen.colorDepth` | Color depth | Spoof to `24` |

| `window.screen.pixelDepth` | Pixel depth | Spoof to `24` |

| `window.devicePixelRatio` | DPI | Spoof to `1.0` or `2.0` |

| `Performance.now()` | Timing precision | Reduced to 1ms |

| `SharedArrayBuffer` | High-res timers | Disabled unless COOP/COEP headers present |



\- All toggleable per-site via permissions panel

\- Less aggressive than Tor Browser RFP (daily-driver protection, not identical-user protection)

\- Tor tabs get full RFP treatment



\### 7.4 Referrer Policy Hardening



\- Default: `strict-origin-when-cross-origin`

&#x20; - Same-origin: full referrer sent

&#x20; - Cross-origin: only domain sent (e.g., `https://example.com/`), never path or query

\- Per-site override for trusted sites (some SSO flows need full referrer)

\- Settings: Settings → Privacy → Referrer Policy



\### 7.5 DNS-over-HTTPS (DoH)



\- Enabled by default for regular tabs

\- Default resolver: privacy-respecting (Mullvad DNS, Quad9, or NextDNS — user picks during setup)

\- Per-tab-type DNS routing:

&#x20; - Regular tabs → DoH through configured resolver

&#x20; - Tor tabs → DNS through Tor

&#x20; - Scramjet tabs → DNS through Scramjet proxy

&#x20; - VPN tabs → DNS through VPN tunnel

\- \*\*No silent fallback:\*\* if DoH resolver unreachable, show error instead of falling back to system DNS

\- DNS query log in `about:vapor` → "DNS" section

\- Settings: Settings → Privacy → DNS



\### 7.6 HTTPS-Only Mode



\- \*\*Unchangeable default.\*\* All HTTP requests auto-upgraded to HTTPS.

\- If HTTPS doesn't exist: full-page warning requiring domain name confirmation to proceed

\- Auto-excepted: `localhost`, `127.0.0.1`, `.onion` domains

\- Per-site exception list for HTTP-only sites

\- Settings: Settings → Privacy → HTTPS-Only



\### 7.7 Clipboard Protection



\- \*\*Reads blocked by default.\*\* Permission prompt on first read attempt: `"example.com wants to read your clipboard. \[Allow Once] \[Allow Always] \[Block]"`

\- Writes allowed by default

\- Per-site memory in permissions panel

\- \*\*Clipboard sanitization on copy:\*\* strips invisible tracking characters from copied text:

&#x20; - Zero-width spaces (`U+200B`, `U+200C`, `U+200D`, `U+FEFF`)

&#x20; - Unicode direction overrides (`U+202A`–`U+202E`)

&#x20; - Steganographic invisible characters

\- Settings: Settings → Privacy → Clipboard



\### 7.8 Link Prefetch/Prerender Blocking



\- Block `<link rel="prefetch">` and `<link rel="prerender">` by default

\- Allow `<link rel="preload">` only for same-origin resources

\- `network.prefetch-next = false`

\- Settings: Settings → Privacy → "Block speculative loading"



\### 7.9 Per-Site User-Agent Override



\- Right-click → "Spoof as Chrome for This Site"

\- Stored in `%APPDATA%\\Vapor\\Profiles\\\[profile]\\vapor-ua-overrides.txt`

\- Per-domain only; global UA remains Firefox

\- Indicator in URL bar when override active

\- Settings: Settings → Privacy → User-Agent Overrides



\### 7.10 Script Blocking (Simple Mode)



Three states per site:

\- 🟢 \*\*Allow All\*\* — all scripts run

\- 🟡 \*\*First-Party Only\*\* — third-party scripts blocked (default for new sites)

\- 🔴 \*\*Block All\*\* — no scripts, static HTML/CSS only



\- Shown as colored dot in URL bar (click to cycle)

\- Remembered per site across sessions

\- `Shift+Reload` temporarily allows all scripts for current load



\---



\## 8. THE BROOM (AUTO-DELETE COOKIES)



\### 8.1 Concept



Vapor deletes all cookies and site storage \*\*the moment you leave a website\*\*. Not after 7 days, not on exit — immediately. The web is a rental, not a storage unit.



\### 8.2 Trigger Conditions



The Broom fires when:

1\. \*\*Tab navigation to different domain:\*\* new page's registrable domain differs from previous

2\. \*\*Tab close:\*\* after configurable delay (default 2s)

3\. \*\*Tab hibernation:\*\* when tab is hibernated

4\. \*\*Browser exit:\*\* all non-whitelisted domains cleaned on shutdown



\*\*Does NOT trigger on:\*\*

\- Same-domain navigation

\- Subdomain navigation within same registrable domain (eTLD+1)

\- Page reloads / refreshes

\- Back/forward within same domain

\- SPA route changes

\- Workspace switches (explicitly excluded)



\### 8.3 What Gets Deleted



| Storage Type | Deleted? |

|---|---|

| Cookies (session + persistent) | ✅ |

| localStorage | ✅ |

| sessionStorage | ✅ |

| IndexedDB | ✅ |

| Cache API | ✅ |

| Service Worker registrations | ✅ |

| WebSQL | ✅ |

| File System API | ✅ |

| Shared Workers | ✅ Terminated |



\*\*NOT deleted:\*\* bookmarks, history entries, download history, saved passwords (extension-managed), HSTS records, permissions.



\### 8.4 Whitelist — "Remembered Sites"



Exempt domains retain cookies indefinitely.



\*\*How to whitelist:\*\*

1\. URL bar broom icon (🧹/🔒 toggle)

2\. Context menu: "Remember This Site's Cookies"

3\. Command palette: "Remember Current Site"

4\. Settings → Privacy → Remembered Sites

5\. Workspace template `remembered\_sites` array



\*\*Storage:\*\* `%APPDATA%\\Vapor\\Profiles\\\[profile]\\vapor-blocklists\\remembered-sites.txt` (plain text, one domain per line)



\*\*Scope:\*\* whitelisting `example.com` includes all subdomains. Global by default; optional per-workspace via template `"remembered\_sites\_scope": "workspace"`.



\### 8.5 Visual Indicators



\- 🧹 (gray) in URL bar = Broom active

\- 🔒 (green) in URL bar = Site remembered

\- 🔒 icon next to favicon on remembered tabs

\- Toast on leave (toggleable, off by default): `"🧹 Cleaned cookies for example.com"`



\### 8.6 Login Session Handling



\- First-run wizard explains the behavior

\- First login detection: toast `"You just logged into example.com. Remember this site? \[Remember] \[Forget]"`

\- Does NOT interfere with password manager extensions



\### 8.7 Granularity Modes



| Mode | Deleted | Kept |

|---|---|---|

| \*\*Full Clean\*\* (default) | Everything | Nothing |

| \*\*Cookies Only\*\* | Cookies | localStorage, IndexedDB, caches |

| \*\*Trackers Only\*\* | Third-party only | First-party |

| \*\*Keep All\*\* | Nothing | Everything |



Configurable per site via URL bar broom icon (long-press) or Settings.



\### 8.8 Edge Cases



\- \*\*Redirect chains:\*\* tracks final destination domain; redirector cleaned immediately

\- \*\*Cross-domain auth:\*\* suggests whitelisting auth domains (e.g., `login.microsoftonline.com` when whitelisting `office.com`)

\- \*\*Multiple tabs:\*\* Broom only fires when \*\*last tab\*\* for a domain is closed/navigated

\- \*\*Background requests:\*\* service worker unregistration prevents post-close requests

\- \*\*`beforeunload` tricks:\*\* Broom runs after site's `beforeunload` handlers

\- \*\*Performance:\*\* async background thread, <50ms per domain



\### 8.9 Settings



\- Global toggle

\- Default deletion mode

\- Deletion delay (0s / 2s / 5s / 10s)

\- Toast notifications

\- First login detection

\- Cross-domain auth suggestions

\- View/clear remembered sites

\- Deletion log in `about:vapor`



\---



\## 9. THE REFLEX (AUTO-DECLINE CONSENT)



\### 9.1 The Problem



Hiding cookie banners (cosmetic filter) doesn't actually decline cookies. Issues:

\- Pre-consent cookies set before banner appears

\- Implicit consent from continued browsing

\- No rejection record in CMP logs



\### 9.2 Phase 1 — Pre-emptive Cookie Deletion



At `document\_start`, before page scripts run:

\- Scans existing cookies for known tracking patterns:

&#x20; - `\_ga`, `\_gid`, `\_gat`, `\_fbp`, `\_fbc`, `\_gcl`, `\_tt`, `\_uetsid`, `\_uetvid`, `fr`, `IDE`, `test\_cookie`, `NID`, `CONSENT`, `\_pk\_`, `\_\_hstc`, `\_\_hssc`, `\_\_hssrc`, `hubspotutk`, `intercom-id`, `ajs\_`, `amplitude\_`, `mp\_`, `\_mkto\_`, `pardot`, `drift\_`, `optimizely`

&#x20; - Cookies from domains in Shield's blocklist

\- Deletes matching cookies immediately

\- \*\*Whitelisted:\*\* `\_\_cf\_bm` (Cloudflare bot protection, deleting breaks site access)



\### 9.3 Phase 2 — Banner Detection \& Auto-Click



After `DOMContentLoaded` + 500ms:



\*\*Detection\*\* (element matches ≥2 criteria):

1\. \*\*CMP framework objects:\*\* `window.\_\_cmp`, `window.\_\_tcfapi`, `window.\_\_uspapi`, `window.OnetrustActiveGroups`, `window.Cookiebot`, `window.gdprframework`, `window.consentManager`

2\. \*\*DOM patterns:\*\* `#onetrust-banner-sdk`, `#CybotCookiebotDialog`, `#cookie-notice`, `#gdpr-cookie-notice`, `#sp-cc`, `#usercentrics-root`, `#truste-consent-track`, `.cc-window`, `#hs-eu-cookie-confirmation`, `#tarteaucitronRoot`, etc.

3\. \*\*Text content:\*\* "accept all", "reject all", "cookie preferences", "we use cookies", "consent", "datenschutz", etc. (multilingual)

4\. \*\*Position:\*\* fixed/sticky at viewport edge with high z-index



\*\*Auto-click sequence:\*\*

1\. Find "Reject" button (text: "reject all", "decline all", "essential only", etc.)

2\. If no reject button: click "Customize" → uncheck all except "Strictly Necessary" → save

3\. If CMP has API, use it directly (preferred):

&#x20;  - TCF v2: `window.\_\_tcfapi('rejectAll', 2, callback)`

&#x20;  - OneTrust: `window.OneTrust.RejectAll()`

&#x20;  - Cookiebot: `window.Cookiebot.decline()`

&#x20;  - CookieConsent.js: `window.CookieConsent.denyAll()`

4\. Post-rejection cleanup: wait 500ms, delete any tracking cookies set during consent flow, hide banner

5\. Fallback: hide banner + delete tracking cookies manually + log warning



\*\*Language support:\*\* English, German, French, Spanish, Italian, Dutch, Portuguese, Polish (stored in `%APPDATA%\\Vapor\\Profiles\\\[profile]\\vapor-blocklists\\consent-phrases.json`, user-editable)



\### 9.4 Timing



| Timing | Action |

|---|---|

| `document\_start` | Phase 1: delete pre-consent cookies |

| `DOMContentLoaded` + 500ms | Phase 2: detect banner, auto-reject |

| `window.load` + 1000ms | Phase 2 retry (async CMPs) |

| 5s after load | Final sweep: delete late-appearing tracking cookies |



\### 9.5 Settings



\- Global toggle

\- Mode:

&#x20; - 🟢 \*\*Aggressive\*\* (default): auto-reject all, delete pre-consent, hide banners

&#x20; - 🟡 \*\*Polite\*\*: auto-reject only if clear "Reject All" exists; otherwise just hide

&#x20; - 🔴 \*\*Manual\*\*: hide only; user triggers via URL bar broom icon

\- Pre-consent deletion toggle

\- Language list editor

\- CMP API usage toggle

\- Failure notification toggle

\- Consent log in `about:vapor` → "Consent Actions"



\### 9.6 Interaction with Broom



```

User visits example.com

&#x20; → Reflex: deletes pre-consent tracking cookies

&#x20; → Page loads, CMP banner appears

&#x20; → Reflex: auto-clicks "Reject All" via TCF API

&#x20; → Reflex: post-rejection cleanup

&#x20; → User browses (no tracking cookies active)

&#x20; → User navigates away

&#x20; → Broom: deletes all remaining cookies/storage

&#x20; → example.com completely forgotten

```



\### 9.7 Edge Cases



\- \*\*Paywalls:\*\* Reflex does not interact with paywalls (heuristics distinguish)

\- \*\*Page reload on rejection:\*\* detects `location.reload()` in click handler, uses API instead

\- \*\*Consent in URLs:\*\* preserves functional consent params (not stripped by URL Stripper)

\- \*\*`\_\_cf\_bm`:\*\* whitelisted by default

\- \*\*Multiple banners:\*\* handles GDPR + CCPA sequentially

\- \*\*Iframe banners:\*\* only interacts with top-level banner

\- \*\*Performance:\*\* adds \~10–30ms to page load



\---



\## 10. WORKSPACE TEMPLATES



\### 10.1 Template System



\- Templates are \*\*JSON configuration files\*\* — declarative, no code

\- Stored in `%APPDATA%\\Vapor\\Profiles\\\[profile]\\vapor-templates\\`

\- Browser ships with built-in templates (read-only)

\- Users can create, edit, import, export



\### 10.2 JSON Schema



```json

{

&#x20; "version": "1.0",

&#x20; "name": "Research",

&#x20; "description": "For academic research and deep dives",

&#x20; "icon": "🔬",

&#x20; "color": "#4A90D9",

&#x20; "pinned\_tabs": \[

&#x20;   "https://perplexity.ai",

&#x20;   "https://arxiv.org"

&#x20; ],

&#x20; "default\_new\_tab\_type": "regular",

&#x20; "default\_new\_tab\_url": "https://perplexity.ai",

&#x20; "default\_search\_engine": {

&#x20;   "name": "Perplexity",

&#x20;   "search\_url": "https://perplexity.ai/search?q={searchTerms}",

&#x20;   "suggest\_url": ""

&#x20; },

&#x20; "script\_blocking\_default": "first-party-only",

&#x20; "adblocker\_enabled": true,

&#x20; "url\_stripping\_enabled": true,

&#x20; "cname\_uncloaking\_enabled": true,

&#x20; "auto\_launch\_vpn": false,

&#x20; "tab\_hibernation\_timeout\_minutes": 15,

&#x20; "homepage": "https://perplexity.ai",

&#x20; "remembered\_sites": \["github.com", "gmail.com"],

&#x20; "remembered\_sites\_scope": "global"

}

```



\### 10.3 Built-in Templates



\*\*🔬 Research\*\*

\- Pinned: Perplexity, arXiv, Semantic Scholar, Wikipedia

\- New tab: Perplexity | Search: Perplexity

\- Script blocking: First-Party Only | Hibernation: 15 min



\*\*💻 Work\*\*

\- Pinned: vscode.dev, GitHub, project management placeholder

\- New tab: vscode.dev | Search: default

\- Script blocking: Allow All | Auto-launch VPN: true | Hibernation: 60 min



\*\*🕵️ Privacy\*\*

\- Pinned: DuckDuckGo, ProtonMail, Signal Web

\- New tab type: \*\*Tor\*\* | Search: DuckDuckGo

\- Script blocking: Block All | Kill switch: enabled | Hibernation: 5 min



\*\*🎮 Casual\*\*

\- Pinned: YouTube, Reddit, Twitter/X

\- New tab: regular blank | Search: Google (clean)

\- Script blocking: Allow All | Hibernation: 30 min



\*\*🛠️ Dev\*\*

\- Pinned: localhost:3000, MDN, Stack Overflow, vscode.dev

\- New tab: localhost:3000 | Search: MDN

\- Script blocking: Allow All | Adblocker: off for localhost | Hibernation: never



\### 10.4 Management UI



\- Settings → Workspaces → Templates

\- "Create from Current Workspace"

\- Import/Export `.json`

\- Apply to new or existing workspace

\- Form editor + "Edit as JSON" option



\---



\## 11. TAB MANAGEMENT



\### 11.1 Tab Hibernation



\- Unfocused tabs unloaded from memory after configurable timeout

\- Tab remains visible with title/favicon; subtle "zzz" indicator

\- Clicking reloads fresh content

\- Configurable per workspace (via template):

&#x20; - Timeout: 5 / 10 / 15 / 30 / 60 min, or "never"

&#x20; - Don't hibernate pinned tabs

&#x20; - Don't hibernate tabs playing audio

&#x20; - Don't hibernate tabs with unsaved form data

\- Manual: right-click → "Hibernate Tab" / "Hibernate Other Tabs"

\- Memory indicator in `about:vapor`



\### 11.2 Tab Grouping



\- Within workspaces, tabs can be grouped (color-coded, collapsible)

\- Groups separate from workspaces



\### 11.3 Tab Search



\- `Ctrl+Shift+A`: fuzzy search across all tabs in all workspaces

\- Shows title, URL, workspace, routing indicator

\- Clicking switches to tab (and workspace if needed)



\### 11.4 Tab Cleanup



\- "Close Duplicate Tabs"

\- "Close All Tabs in This Workspace" (with confirmation)

\- "Close All Non-Tor Tabs"



\### 11.5 Tab Crash Recovery



\- "This tab crashed" page with:

&#x20; - "Reload" button

&#x20; - "Reload Without Scripts" button (reloads with script blocker set to 🔴)

\- Crash logged in `about:vapor` → "Crashes" with URL, memory, suspected cause



\### 11.6 Global Pinned Tabs



\- Right-click pinned tab → "Pin Globally (All Workspaces)"

\- Tab appears in pinned section of every workspace

\- Closing in one workspace closes in all

\- Use cases: music player, chat app, monitoring dashboard



\### 11.7 Session Snapshots



\- Save current state of all workspaces, tabs, scroll positions to JSON file

\- Does NOT include cookies/storage (Broom's domain)

\- Restore reopens tabs; user re-logs in

\- Use cases: backup, sharing, switching computers



\---



\## 12. UI/UX \& CHROME



\### 12.1 Command Palette



\- `Ctrl+K`: floating fuzzy-search overlay

\- Searches: open tabs, workspaces, bookmarks, history, settings pages

\- Actions:

&#x20; - "New Tor Tab", "New Scramjet Tab"

&#x20; - "Toggle Laser", "Toggle Adblocker"

&#x20; - "Hibernate All Tabs"

&#x20; - "Clear Cookies for This Site"

&#x20; - "Block This Domain"

&#x20; - "Connect/Disconnect VPN"

&#x20; - "Remember/Forget Current Site"

&#x20; - "Open Settings", "Open about:vapor"

\- Ranked by recency and frequency

\- Keyboard-navigable (arrows + Enter)



\### 12.2 Status Bar



\- Thin bar at bottom (toggleable, hidden by default)

\- Shows: routing mode + exit IP, adblocker status + block count, VPN status, memory usage, download progress



\### 12.3 Context Menu Additions



\- Right-click page:

&#x20; - "Vaporize This Element"

&#x20; - "Block This Domain"

&#x20; - "Strip Tracking Parameters from This Link" (copies clean URL)

&#x20; - "Open in Tor Tab" / "Open in Scramjet Tab"

&#x20; - "Remember This Site's Cookies" / "Forget This Site's Cookies"

\- Right-click link:

&#x20; - "Open in New Tor Tab" / "Open in New Scramjet Tab"

&#x20; - "Copy Clean Link"



\### 12.4 New Tab Page



\- Clean, minimal

\- Search bar (workspace default engine)

\- Top sites (user-generated, max 8, no sponsored)

\- Quick links to workspace templates

\- Kill counter: "You've vaporized 1,247 ads this week"

\- No news, weather, or Pocket

\- Customizable background image/color



\### 12.5 Page Weight \& Request Counter



\- Indicator in URL bar or status bar:

&#x20; - Page weight (e.g., `"4.2 MB"`)

&#x20; - Request count (e.g., `"127 requests"`)

&#x20; - Blocked count (e.g., `"43 blocked"`)

&#x20; - JS execution time (e.g., `"1.2s JS"`)



\### 12.6 Redirect Chain Inspector



\- For links with 3+ redirects (configurable threshold):

&#x20; ```

&#x20; You clicked: bit.ly/3xYz123

&#x20;   → Redirect 1: bit.ly/3xYz123 (301)

&#x20;   → Redirect 2: tracking.example.com/click?id=12345 (302)

&#x20;   → Final: amazon.com/dp/B09V3KXJPB

&#x20; \[Follow to Final] \[Copy Final URL]

&#x20; ```

\- URL Stripper runs on final destination

\- Logged in `about:vapor` → "Redirects"



\### 12.7 Keyboard Shortcut Cheat Sheet



\- `?` or `Ctrl+/`: floating overlay of all shortcuts, grouped by category

\- Dismiss with `Escape`



\### 12.8 Local Reading List (Pocket Replacement)



\- Right-click → "Save to Reading List"

\- Saves local HTML snapshot (readable content, no ads/scripts)

\- Stored in `%APPDATA%\\Vapor\\Profiles\\\[profile]\\vapor-reading-list\\` as `.html` files

\- `about:reading`: all saved articles with thumbnails, titles, dates, full-text search

\- No cloud, no account

\- Optional auto-delete after 30 days



\---



\## 13. STATS \& DASHBOARDS



\### 13.1 about:vapor



\- \*\*Overview:\*\* total ads blocked (all time / session), bandwidth saved, time saved

\- \*\*Today's Activity:\*\* timeline graph of blocks over 24h

\- \*\*Top Blocked Domains:\*\* ranked list with counts

\- \*\*Laser History:\*\* log of all zaps with timestamps, sources, domains added

\- \*\*DOM Filters:\*\* elements neutralized by Filter

\- \*\*CNAME Uncloaking Log:\*\* revealed trackers

\- \*\*URL Stripping Log:\*\* params stripped, most common params

\- \*\*Consent Actions:\*\* Reflex auto-decline log (timestamp, domain, CMP, method, result)

\- \*\*Cookie Deletions:\*\* Broom action log

\- \*\*DNS:\*\* resolved domains, resolver used, CNAME events

\- \*\*Redirects:\*\* redirect chain log

\- \*\*Routing Stats:\*\* time per route type, data transferred

\- \*\*Memory:\*\* RAM usage, hibernated tabs, peak memory

\- \*\*Workspace Breakdown:\*\* blocks per workspace, tab counts

\- \*\*Crashes:\*\* tab crash log



\### 13.2 Per-Page Stats



\- Adblocker icon popup:

&#x20; - "Blocked 14 requests on this page"

&#x20; - "Stripped 3 tracking parameters"

&#x20; - "Uncloaked 1 CNAME tracker"

&#x20; - "Saved \~2.3 MB"

&#x20; - Breakdown by resource type



\---



\## 14. SETTINGS STRUCTURE



| Page | Contents |

|---|---|

| \*\*General\*\* | Homepage, default search, startup, language, downloads, translation |

| \*\*Privacy\*\* | URL stripping, CNAME uncloaking, fingerprinting (all toggles), referrer policy, DoH, HTTPS-only, clipboard, prefetch blocking, UA overrides, script blocking defaults |

| \*\*Adblocker\*\* | Enable/disable, view/edit blocklists, import/export, reset, consent popups, miners, element filters, overlay memory |

| \*\*Cookies\*\* | Broom toggle, default deletion mode, delay, remembered sites, granularity, Reflex mode, consent phrases, pre-consent deletion |

| \*\*Routing\*\* | Tor (daemon, auto-start, kill switch), Scramjet (proxy URL, kill switch), OpenVPN (binary path, profile name, auto-connect), default tab type |

| \*\*Workspaces\*\* | Template management, workspace overrides |

| \*\*Tabs\*\* | Hibernation timeout, exceptions, grouping, global pins |

| \*\*Appearance\*\* | Theme, accent color, toolbar layout, status bar, compact mode |

| \*\*Sound\*\* | Master volume, per-sound toggles |

| \*\*Advanced\*\* | `about:config`, user-agent global, hardware acceleration, experimental |



\---



\## 15. POLISH \& DELIGHT



\### 15.1 Sound Effects (all optional, all toggleable)



| Event | Sound | Duration |

|---|---|---|

| Laser zap | Crisp \*pew\* | \~100ms |

| Shield Breaker | \*Crack-shatter\* | \~400ms |

| Tab close | Soft \*whoosh\* | \~200ms |

| Workspace switch | Subtle \*click\* | \~50ms |

| Tor tab open | Low \*hum\* | \~500ms fade |

| Kill switch | Sharp \*alarm blip\* | \~300ms |

| Adblocker milestone (×100) | Tiny \*ding\* | \~150ms |



Master volume slider, default 30%.



\### 15.2 Visual Effects



\- Laser dissolve (Section 2.3)

\- Shield Breaker glass shatter (Section 4.5)

\- Workspace switch: horizontal slide (200ms ease-out)

\- Tab hibernation: favicon fades to grayscale, re-colorizes on wake

\- Kill switch: dark red overlay with cracked-glass texture



\### 15.3 Easter Eggs



\- `about:vapor`: page dissolves with laser effect, reassembles after 3s

\- 100 laser kills in session: confetti + toast `"Century Club! 🎉"`

\- Konami code (`↑↑↓↓←→←→BA`): CRT scanline filter for 30s

\- `about:laser`: mini game — shoot falling ad banners

\- 50+ tabs: toast `"That's a lot of tabs. Maybe hibernate some? 😅"`



\---



\## 16. FIRST-RUN EXPERIENCE



\### 16.1 Setup Wizard



1\. \*\*Welcome:\*\* "Vapor evaporates ads, trackers, and nonsense."

2\. \*\*Adblocker:\*\* "The Shield is on. It serves blank files instead of canceling requests. \[View Blocklist]"

3\. \*\*Privacy:\*\* "URL params stripped. CNAME uncloaked. Fingerprinting protected. Cookies auto-deleted on leave. Cookie consent auto-declined. \[Customize]"

4\. \*\*Routing:\*\* "Tor and Scramjet tabs available from new tab menu. Set up Tor now? \[Yes] \[Later]"

5\. \*\*OpenVPN:\*\* "Use OpenVPN? We'll scan for openvpn-gui.exe and add a launcher button. \[Detect] \[Skip]"

6\. \*\*Templates:\*\* "Pick starter templates. \[Research] \[Work] \[Privacy] \[Casual] \[Dev] \[None]"

7\. \*\*Done:\*\* "Try the laser: Ctrl+Shift+L. Happy browsing."



\### 16.2 Migration



\- Import bookmarks, history, passwords, extensions from Firefox/Chrome/Edge/Brave

\- Standard Firefox migration wizard, preserved from Zen



\---



\## 17. OUT OF SCOPE



These will NOT be built:



\- ❌ Browser-wide AI assistant / sidebar / page summarizer

\- ❌ Built-in password manager (use Bitwarden/1Password extension)

\- ❌ Built-in email client

\- ❌ Built-in torrent client

\- ❌ Crypto wallet integration

\- ❌ Social media integration

\- ❌ Reading mode (use Firefox's built-in)

\- ❌ Full NoScript replacement (3-state toggle is sufficient)

\- ❌ Full ABP filter syntax support (use uBlock Origin)

\- ❌ Cloud sync of any kind

\- ❌ Mobile version (desktop only)

\- ❌ Custom rendering engine (Gecko only)

\- ❌ Built-in VPN client (launcher only)

\- ❌ Multi-account containers UI (containers used internally, workspaces are the user-facing abstraction)

\- ❌ macOS support

\- ❌ Linux support

\- ❌ ARM64 support

\- ❌ 32-bit support



\---



\## 18. DEFENSE STACK SUMMARY



```

NETWORK LAYER

&#x20; ├── Shield — serves blank files for blocked requests

&#x20; ├── URL Stripper — removes tracking parameters

&#x20; ├── CNAME Uncloaker — reveals disguised trackers

&#x20; ├── DoH — encrypted DNS, no ISP leaks

&#x20; ├── HTTPS-Only — no plaintext connections

&#x20; ├── Referrer Hardening — no cross-origin URL leaks

&#x20; └── Prefetch Blocking — no speculative loading



DOM LAYER

&#x20; ├── Filter — neutralizes elements before activation

&#x20; └── Shield Breaker — destroys anti-adblock overlays



STORAGE LAYER

&#x20; ├── Broom — auto-deletes cookies/storage on site leave

&#x20; └── Reflex — auto-declines cookie consent on page load



FINGERPRINTING LAYER

&#x20; ├── Canvas, WebGL, AudioContext noise

&#x20; ├── Font, screen, timezone, language spoofing

&#x20; ├── Hardware, battery, gamepad, media device spoofing

&#x20; ├── Timing precision reduction

&#x20; └── Per-site UA overrides



CLIPBOARD LAYER

&#x20; ├── Read protection (permission prompt)

&#x20; └── Write sanitization (strip invisible tracking chars)



MANUAL LAYER

&#x20; └── Laser — user-targeted vaporization



ROUTING LAYER

&#x20; ├── Regular tabs (🟢) — system network / VPN

&#x20; ├── Tor tabs (🟣) — SOCKS5 via bundled daemon

&#x20; ├── Scramjet tabs (🔵) — web proxy

&#x20; ├── OpenVPN launcher — system GUI trigger

&#x20; └── Kill switch — freeze tabs on route failure

```



\---



\*This document is the single source of truth for Vapor Browser development. It is a reference specification only. All build work must be explicitly directed by the user in individual build rounds. Do not implement features from this document unless instructed to do so.\*

