# Raccoon 0.2 frontend foundation

This directory imports the ShardBrowser Launcher frontend at commit
`99e780e2e685e5b3b5357c5baee8796e10b3ce1e` from
`https://github.com/ProxyShard/ShardBrowser`. The upstream Launcher and
`ui-kit` source are MIT licensed; their license files remain in this directory
and `ui-kit/`. The Inter font retains its own notice in
`src/app/fonts/LICENSE-Inter.txt`. No ShardBrowser browser binaries, Rust
backend, team server, or launcher installer are imported.

The frontend source, UI kit, public assets, and Vite configuration remain
separate from the current Raccoon desktop frontend. Use the root pnpm lockfile:

```bash
rtk proxy pnpm install
rtk proxy pnpm --filter @raccoon/desktop-v2 build
```

The native entry uses the Raccoon Rust host at `apps/desktop/src-tauri` with
`tauri.v2.conf.json` and the application identifier `com.raccoon.desktop`,
separate from the default 0.1 desktop identifier. Its database lives in the
corresponding application data directory and uses the `v2/raccoon.sqlite`
workspace. This keeps normal v2 startup out of the 0.1 data directory without
migrating or deleting existing files. The Preview configuration has its own
application identifier. The v2 development server uses port `1422`, separate
from the original desktop server's port `1420`. The default desktop packaging
entry still uses `apps/desktop/src`. Start the v2 desktop development entry explicitly with
`rtk proxy pnpm --filter @raccoon/desktop-v2 run desktop:dev`. This starts
Tauri and requires Rust compilation, which remains assigned to CI under the
repository's local development restriction.

On 2026-11-18, `rtk proxy pnpm --filter @raccoon/desktop-v2 build` completed
and wrote `dist/index.html` and `ui-kit/dist/index.js`. This is a frontend
build result, not a runnable Raccoon desktop package or native integration
check. The Vite build reported only a chunk-size advisory.

## Native ShardBrowser integration

`index.html` loads `src/main.ts`. A real Tauri bridge selects `src/raccoon/main.tsx`.
The native entry loads configured connections and scopes Profile, Folder,
selection and view preferences by `connectionId`. Empty installations start
without sample Profiles. `src/raccoon/api.ts` validates public Raccoon DTOs.
`controller.ts` coordinates requests, durable create operation IDs and
reconciliation. `profile-adapter.ts` projects records into the imported
Profile table and binds native lifecycle actions.

The native ShardBrowser flow supports laboratory enable/save, kernel status,
download and deletion, Profile create/edit/details/start/stop/delete, Folder
create/rename/delete/move, and pending-operation reconciliation after restart.
Profile details show saved data and observed runtime state. Unknown and missing
observations keep business records and block unsafe lifecycle actions.
Creation fixes the installed kernel version and per-Profile seed. Native ShardBrowser
now reuses the upstream `ProfileFormDialog`, Basics, Proxy and full Fingerprint tabs,
including OS/template selection, hardware, screen/window, locale, noise, WebRTC,
geolocation and media-device controls. The complete structured payload is saved in
Rust-owned `settings.shardbrowser`. Launches apply the saved configuration over the
frozen identity with stable noise seeds. Existing v2 Profiles can load their frozen
configuration into the editor. Provider bindings and kernel versions stay fixed.
Proxy selection uses the shared global library, including pasted proxy import.
Cookie JSON import/export uses the official Chromium storage format through Rust.
Extension library and password protection remain unavailable in the native form.

The upstream Fingerprints page, filters, cards, Peek and JSON import controls are
mounted only for ShardBrowser Workspaces. Explicit `shardbrowser_fingerprint_*`
commands read installed official templates and persist custom templates in the v2
application directory. GPU compatibility uses the official WebGL/WebGPU probe and
comparison logic, with a pinned local engine, per-version cache and bounded cleanup.
No template-list request implicitly installs or downloads a kernel.

The imported table, toolbar, command menus and modal layout remain the UI basis.
Settings use the imported vertical tabs, setting rows and Save bar. Folders
have stable UUIDs in SQLite and use the connection-scoped `browser_folder_*`
commands. Schema 4 rejects earlier development database layouts and preserves
the files for explicit migration. Normal startup never reads 0.1 data.

## Native CloakBrowser integration

CloakBrowser is an explicitly enabled laboratory Provider with its own
`builtin-cloakbrowser` Workspace. `src/raccoon/CloakBrowserLab.tsx` reads and
saves the activation key as plaintext, shows the saved key again, checks and
downloads a latest or exact kernel, polls structured progress, retries the
failed target and deletes unbound local kernels after confirmation.
`src/raccoon/cloakbrowser-contract.ts` validates the CloakBrowser DTOs without
loading the Tauri entry.

CloakBrowser reuses the ShardBrowser `ProfileFormDialog` shell: the same large
dialog, sticky tabs, property rows, footer and Save rules. Basics carries the
shared name, Folder, tags, colour and notes, then the fixed kernel
and start URL. Its Fingerprint tab uses ShardBrowser's own group headings, field
grid and help rhythm for fingerprint seed, viewport, timezone,
language and proxy-exit matching (including WebRTC IP). Proxy is the common proxy
picker; ShardBrowser's fingerprint library and extension tab stay out of this form.
Creation with the latest kernel may download it through Rust; an exact installed
version can be pinned instead. The Provider binding, kernel and seed stay fixed
after creation, while the other fields remain editable. Clones get a new UUID
and seed and keep the source kernel. Start, stop, delete, Folder and tag actions
reuse the common Raccoon commands. Pin, CDP address, show window, Cookie JSON
and configuration JSON import/export remain unavailable for CloakBrowser.

Fingerprints belong to ShardBrowser only. For CloakBrowser Workspaces the
sidebar hides Fingerprints, Bookmarks and Extensions and only the Provider form
is mounted in the shared dialog; Profile Peek also omits its Fingerprint section and skips the
ShardBrowser fingerprint-config read. The underlying DRM assets and other
Provider adapters are untouched.

The CloakBrowser Provider saves a per-Profile launch receipt and checks for
the matching processes after an app restart. A row with an unresolved local
session exposes a cleanup action that verifies ownership before stopping it.
The license panel and session-limit error also offer a live seat lookup. Real
kernel, license recovery and macOS/Windows window-close behavior still need
native validation.

## Internal automation

The native Automation section now mounts the imported upstream project list,
editor, block canvas, live browser, traffic panel, modules and Fleet components.
`src/raccoon/automation` validates native responses and sends explicitly scoped
`browser_automation_*` commands. Workspace changes invalidate asynchronous UI
work and release captured preview sessions. Rust retains background run ownership.

The Rust module at `apps/desktop/src-tauri/src/core/automation` ports the pinned
upstream runner, CDP, Wasmtime, HTTP and database step implementations through a
Raccoon host boundary. Provider sessions use actual protocol capability discovery.
ShardBrowser keeps its native domains. Other Chromium providers use standard CDP
adapters with explicit capability differences. Firefox and Camoufox execution
remain capability gaps. The optional loopback HTTP server and exported stdio MCP
package route to the same internal service.

These are source integration facts. Rust compilation, actual Provider execution,
macOS/Windows native behavior and restart recovery require separate verification.
Before the user stopped further testing, controlled IPC interactions covered the
automation editor, Workspace isolation, Helper, recovery and API settings. At
1280×800 and DPR 1, the list and editor main content regions each matched the
imported upstream preview with zero differing pixels. The comparison excluded
the sidebar and covered only that viewport and fixture data. Final recovery
integration changes were not rechecked after the stop instruction.
See `docs/09-quality-and-testing.md` for the checks actually performed.

## Global proxy library

The original Proxies page now calls the Rust-owned global SQLite library.
Saved proxies are available across connection Workspaces and support bulk
import, edit, delete, HTTPS reachability/exit checks and stored history.
ShardBrowser Profile forms and inline/bulk assignment use a nullable proxyId.
The Rust service resolves it into each operation's launch snapshot. Referenced
proxies cannot be deleted. Other Provider adapters may consume the same library
when their manual-proxy capability and frontend adapter are connected.

## Browser preview

An ordinary browser opens the original sample preview at the existing root URL.
It uses `src/raccoon-preview` and `src/dev/mock`, with browser-local data.
Native Tauri always selects the real entry.
The browser preview is independently scoped from native storage.

## Verification boundary

The native frontend lifecycle has been exercised using controlled Raccoon IPC
responses in Playwright. This checks frontend dispatch and rendering. Rust
compilation/tests, real ShardBrowser download/launch/proxy/restart behavior,
Windows and packaged installation remain pending. Detailed actual checks are
recorded in `docs/09-quality-and-testing.md`.

## Native workbench interactions

The v2 window follows the upstream native chrome: macOS uses an overlay title
bar, hidden title text, real traffic lights and the original 38 px top inset.
Windows/Linux remove the v2 main window's system caption and use the imported
window controls. The native root synchronizes selected/system appearance and
lets CSS own `color-scheme` after startup. Window movement, caption controls and
theme calls have explicit Tauri permissions. These settings are shared by v2
dev and builds that include `tauri.v2.conf.json`; the root's default desktop
packaging entry still targets the legacy frontend. Before creating windows,
Rust applies the embedded v2 main-window chrome to the generated Tauri context.
This also covers a long-running dev CLI whose cached `TAURI_CONFIG` predates
the overlay settings. Window size, visibility, other windows and non-v2 entries
are preserved. Native startup changes require a new binary; restart the entire
`tauri dev` CLI when changing configuration, since restarting its Rust child
alone can retain cached extra configuration. Controlled browser checks do not
verify AppKit/WebView2 or packaged window appearance.

The v2 main window's Close button hides the window and keeps the app running.
On macOS, the app icon remains in the Dock. Click it or the Raccoon menu bar
icon to reopen the window. On Windows, reopen the window from the notification
area icon. Settings → General provides a quit action that checks for unsaved
changes.

The upstream command palette is mounted in both the browser preview and the
native shell. The sidebar Search row is the upstream opener and `Mod+K` opens
the same dialog. Native results omit What's new, the tour, the website, team and
ProxyShard rows; Fingerprints, Bookmarks and Extensions appear only in a
ShardBrowser Workspace. Settings lists General, Appearance and Other, and each
opens its tab. Profile import is hidden when the Workspace cannot create
Profiles. Navigation, theme, Stop all and Toggle sidebar run through the native
shell.

Folder creation/editing uses the upstream name, color and icon dialog with one
persisted Rust write. Tags have a separate connection-scoped SQLite registry and
transactional Profile references. The original Profile Peek now displays Profile,
Fingerprint and Activity sections. All Profiles mounts the original Continue and
Problems to fix foldouts with native Profile/proxy data.

Native menus support clone, pin/unpin, Cookie import/export, copy CDP, show browser,
configuration import/export, fingerprint regeneration, proxy/folder/tag assignment,
and move to Trash. Clones have a new UUID, independent hardware/noise picks and an
empty browsing session. Trash supports restore and explicit permanent deletion.
Native retention is manual. Traffic measurements remain unavailable. Activity
counts start when this implementation first observes a running Profile.
For CloakBrowser, pin, Cookie/configuration transfer, CDP, show browser and
fingerprint regeneration are disabled by command policy; clone stays enabled
with a new UUID and seed.

Settings support persisted language/window preferences, theme/scale/motion,
Profile defaults, tags, views, application network proxy, storage information and
laboratory kernel management. API server, helper, cloud sync, extension library and
password protection require further native integration.

## Plugin center

Enabled plugins list under a collapsible Plugins group in the sidebar, using
the Folder and View group pattern. `registerPluginSidebarBadge(pluginId,
Component)` reserves a plugin's row badge; the Vinted account pool's badge is a
placeholder that reads `sidebarBadge` or `accountCount` from its status until
the plugin supplies a real component.

### Plugin-declared Profile panels

The shared Profile table now reads optional `ui.profileTable` entries from the
native plugin catalog. Installed plugins supply the title, monochrome SVG paths,
capability and view ID. The Plugins column and its display-menu entry appear
when a plugin declares an entry. The column keeps the existing connection-scoped
visibility, order and width preferences.

`widgets/PluginPanel` renders the versioned `@nexus/plugin-sdk/ui` component
schema inside the same 420px / 360px Peek frame as Profile details. The plugin
supplies business fields, labels, actions and confirmation content. The native
`plugin_ui_command` gateway validates the Profile connection, webview owner,
installation and process generation for each view session. Workspace changes,
closed panels and plugin replacement invalidate old responses. Forms join the
existing unsaved-change guard, including intermediate plugin confirmations.
Profile Peek also exposes the same declared plugin icons in its header. Plugin
Peek includes a return-to-Profile action with the shared unsaved-change guard.
Section actions can declare header placement, and view actions occupy a fixed
footer while the section content scrolls independently.
The view protocol distinguishes a successful transition from a saved mutation.

The local Vinted account-pool development source declares the supplied icon and
implements account association, atomic creation/association, editing, confirmed
contact replacement and unbinding, SMS reads, and saved wardrobe pagination.
Its business implementation stays in the local plugin. The Peek now includes
inline saved wardrobe pagination, SIM8 phone assignment, mailbox association,
SMS/Email waiting, persistent copyable notices and digit audio. Generic declared
service mediation, background task scheduling and batched semantic icon status
live in the host. Full plugin pages remain separate. The UI protocol and gateway require the updated
application host. Installed hosts and published plugin packages require their
own release and installation steps.

Local no-output checks use `--customConditions development` to resolve the new
SDK UI source before package compilation. Release imports and type outputs
remain `dist/ui.js` and `dist/ui.d.ts`.

The native `plugins` section now mounts a ShardX UI Kit plugin center backed by
the existing Rust plugin host commands. It reads the application-level plugin
catalog, market status and first-party license status, then supports local
installation, market installation, sequential updates, license activation,
manifest details, store configuration and uninstall confirmation. Starting and
retrying plugins are polled while the page is open.

The page uses the imported `PageHeader`, `SegmentControl`, `DataList`, `Modal`,
`DialogModal` and `AlertModal` patterns. Plugin state remains owned by Rust and
stays stable across Browser Workspace selection. The current host automatically
starts installed plugins and owns process retries. User-visible lifecycle actions
are installation and uninstall.
The visual and migration rules for the existing desktop plugin page are recorded
in `docs/superpowers/specs/2026-11-18-raccoon-plugin-center-design.md`.

The frontend build, type check, plugin process exercise, market request and
license activation remain pending for this change.

## AI image and plugin filters

`src/pages/plugins/ai-image` now provides the bundled v2 business page for
`studio.ai-image`, through the native plugin host and `src/raccoon/plugins/ai-image`.
It preserves provider configuration/testing, explicit vision/image selections,
reference uploads, all presets and full prompts, plans, aging, EXIF, batch history,
recognition, retry, exports and product imports. The application-level import
worker keeps its v2 pending list across page closure and application restarts.
The four plugin prompt sources are unchanged; no real paid model is invoked by
the source checks. Image object URLs are released after their last visible owner
leaves, preserving sharing between a history row and its detail view.

The plugin center and all nine bundled business pages share `PluginWorkspace`:
the standard `PageHeader` and gutter around one ShardX `Card`, with filters,
results and pagination inside. Table tiles reuse the surrounding surface without
another shadow. Search inputs grow, fixed-choice selectors stay labeled, and
each filter row scrolls locally instead of wrapping when space runs out. Proxy
risk and monitor archive ranges live under More Filters with an active count.
AI history uses the same full-width filter row in the standalone and embedded
views. The plugin-center installed/store switch remains a tab control. Plugin-owned
navigation icons are a separate proposal in
`docs/superpowers/specs/2026-11-19-plugin-navigation-icons-design.md`; the new icon
contract has not been implemented.

Per the user's latest constraint, no further plugin build or image/visual
verification is performed. Unit/protocol/text-content tests, lint, formatting and
no-output TypeScript checks are the available local evidence; native WebView,
actual downloads, real providers and Windows remain separate acceptance work.

## Product management page

`src/pages/plugins/products` is the bundled v2 page for `studio.products`.
It uses ShardX UI Kit, keeps search and labeled filters on one row, and provides
paginated inventory with cross-page selection, revision-checked editing and deletion,
cover ordering, CSV/JSON import, and read-only publication history. The editor and AI
import share the bounded product image transport. AI import is gated separately and
copies files through public RPCs, never through another plugin's private directory.
The product RPC and storage formats are unchanged; this is a source migration, not a
new plugin package or native WebView acceptance result.

## Shared supply and Vinted monitor

The bundled `shared-supply` and `vinted-monitor` pages use the shared ShardX Card
and filter-row layout. Shared Supply provides catalog
browsing, text/image search, product details and favorites with CSV copy. Vinted
Monitor provides monitor and proxy configuration, run history, archive review,
seller monitoring and explicit per-item AI image handoff. Both use controlled
plugin image transfers without direct WebView CDN requests. This source migration
leaves plugin storage, backend protocols and network behavior unchanged.

## Address generator page

The address plugin has a dedicated lazy-loaded v2 page using the imported Kit.
It uses map picking only; OpenStreetMap/Overpass generation has been removed.
The plugin generates firstname, lastname and username from the selected address.
Every displayed profile field has its own copy control. Saved addresses support
search, pagination, CSV and confirmed Vinted account association.

Set `VITE_GOOGLE_MAPS_API_KEY` in the main application's build environment (or
the v2 Vite dev server environment). Vite embeds this browser key in the frontend;
the page passes it directly to the Maps SDK. No `.env` file or end-user Key input
is required. The independent Node plugin does not automatically receive a
compiled frontend variable, and this page does not send the key through RPC.
The plugin only generates synthetic identity fields and owns local address data.
This is a public browser key in the application assets, not a server secret.
Missing build configuration disables map picking with a clear message while
keeping saved-address workflows available. Changing it requires a frontend
rebuild, or a Vite restart during development. Actual Google service/native
window verification remains separate from controlled browser checks.
