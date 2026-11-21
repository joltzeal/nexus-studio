# Raccoon Plugin Pages on desktop-v2

Date: 2026-11-19

## Intent

Move the nine remaining first-party plugin business pages from the 0.1 desktop
frontend to `apps/desktop-v2`. The pages use the imported ShardX UI Kit and call
the installed Node plugin through the existing Raccoon Rust plugin host. The
work completes the second-level plugin navigation already present in v2 without
creating a second plugin runtime or changing plugin data ownership.

The pages in scope are:

| Plugin                     | Capability              | Page                                                                                   |
| -------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `studio.address-generator` | `address.generator`     | Address generation, map pick, saved addresses and Maps configuration                   |
| `studio.shared-supply`     | `supply.catalog`        | Category/store/product browsing, search, favorites and image search                    |
| `studio.ai-image`          | `image.provider`        | Providers, model configuration, image generation, plans and history                    |
| `studio.vinted-accounts`   | `account.pool`          | Account inventory, import/export, Profile binding, OTP and order-watch views           |
| `studio.sim8`              | `verification.provider` | SIM8 configuration, purchase, local records, orders, SMS and expiry reminders          |
| `studio.vinted-monitor`    | `monitor.collector`     | Monitor management, runs, item archive, review and image handoff                       |
| `studio.email`             | `email.provider`        | Mailbox inventory/import, device authorization, refresh/receive, messages and settings |
| `studio.products`          | `product.catalog`       | Product inventory, import, edit, image upload/read and publication history             |
| `studio.sales-agent`       | `sales.agent`           | Agent configuration and model checks, preflight, batches, review and recovery          |

The proxy-pool page is the v2 reference implementation and is not part of the
remaining-page count.

## Goals

- Give each installed first-party plugin a purpose-built v2 page instead of the
  generic “business page not connected” view.
- Preserve the meaningful workflows and safety checks of the current plugin
  pages while replacing their 0.1 page shell, component library and IPC adapter.
- Use the current plugin method contracts, strict boundary parsing and explicit
  per-page method compatibility gates.
- Use ShardX UI Kit components, semantic tokens and the imported page shell;
  do not add raw color values or a parallel global theme.
- Keep browser preview clearly separate from native execution and plugin-owned
  persistence.

## Non-goals

- No changes to plugin Node services, private schemas, manifests, package
  versions, or plugin RPC protocol unless a public contract defect blocks a
  page. Such a defect requires a separate, explicitly scoped contract change.
- No loading React code from a plugin package. The v2 business pages remain
  bundled with the application.
- No replacement or shortcut for the Rust plugin host, browser services,
  SQLite, Profile lifecycle, or Agent job coordinator.
- No fake browser execution, provider result, credential persistence, or
  successful operation in ordinary web preview.
- No 0.1 UI, `native-plugins` adapter, or old IPC compatibility in v2 pages.

## Approaches

1. **Complete page migration (selected).** Implement the nine pages in v2 with
   page-local adapters and shared plugin call/validation primitives. This
   matches the user's request and leaves every first-party plugin with a
   purpose-built destination. It is the largest option and requires carefully
   preserving complex file transfer and workflow contracts.
2. **Phased migration.** Ship simpler data pages first and later migrate image,
   monitor, product and Agent workflows. This lowers per-change risk, but leaves
   some installed plugins without a usable business page after the task.
3. **Generic plugin details only.** Keep the current overview for all plugins.
   This is smallest but does not meet the requested migration and is rejected.

## Architecture

### Shared host adapter and page gate

Keep `raccoon/plugins/call.ts` as the only general WebView entry to
`plugin_call`. Add a typed/validated adapter per capability under
`src/raccoon/plugins/<plugin>/`; UI components do not invoke Tauri commands or
fetch plugin upstream services directly. Each adapter parses external responses
before they enter React state and maps known failures to actionable messages.

Define a page contract per plugin ID containing its capability and the complete
set of methods required by the page's base view. The page mounts only when the
host catalog reports the expected ID, enabled/running state, granted capability
and all base methods. Each optional workflow (for example account/mailbox
association, order watch, image plans, or image transfer) has its own exact
method gate and unavailable/update state; it does not disable unrelated base
workflows. A method gate must include every method the enabled UI path can call
and must not require methods used only by hidden or optional workflows. Missing
base methods produce an update message, not a partial page that fails after the
user starts an operation. Add each plugin to `PluginPage.tsx` through a lazy
page import, keeping initial application chunks small.

The shared plugin center owns installation, update, license, uninstall and
process state. Business pages only own domain operations. The Rust host remains
the authority for plugin permissions and license checks.

### Per-page behavior

#### Filter hierarchy (2026-11-19 user refinement)

Text search uses an Input; enumerated status, method, category and relationship
choices use labeled Select controls. Keep search, filter conditions and actions
in distinguishable groups. Bound their widths and use responsive grid columns,
including an appropriately wider column for longer relationship choices. Do not
place a series of full-width Kit fields directly in a wrapping flex row, which
causes each to occupy a complete line. Desktop filters should form compact
columns, while narrow windows may stack them in reading order. A business-page
tab switch remains Tabs/SegmentControl and is not treated as a filter. Apply
these rules to every remaining plugin page as it is migrated.

- **Address generator (updated by the user's 2026-11-19 request):** preserve city catalog selection,
  map selection, generated identity, saved address list and
  clipboard/CSV export. Per the user's follow-up, firstname, lastname, username
  and every address field have independent copy controls. The main frontend reads
  `VITE_GOOGLE_MAPS_API_KEY` at build time and passes it directly to the Maps SDK;
  no end-user Key input or plugin-key fallback is used. The Node plugin does not
  need or receive this value through RPC. Map script and tile connectivity must follow the current
  desktop CSP; no page-side address API fetch is introduced. Remove OpenStreetMap/Overpass
  lookup and `address.generate` from the plugin; preserve previously saved records.
  The base gate includes `address.catalog`,
  `address.profile`; CSV copy additionally requires `address.csv`; saved-address
  controls require `address.saved.list/save/remove`; private-file export is
  separately gated on `address.export`.
- **Shared supply:** preserve category, merchant, product and text/image search,
  favorites, product copy and controlled image display. Images use the plugin's
  open/read/close chunk protocol; the page never fetches remote product image
  URLs directly. The base catalog/search gate covers `supply.catalog`,
  `supply.stores`, `supply.products`, `supply.search`, and `supply.imageSearch`;
  image display additionally requires `supply.image.open/read/close`, while
  favorites/CSV controls require all four `supply.favorites.*` methods.
- **AI image:** preserve provider CRUD and checks, generation, explicit model
  selection, plans, records, reference uploads, output reads, retry and
  recognition. Image bytes use bounded upload/read chunks. Generation remains
  an asynchronous plugin-owned record, with visible queued/running/failed
  states. Product handoff uses public source identity only. Base generation
  requires provider list/save/remove/test, presets, upload begin/chunk/finish/
  abort, file chunk, record list/get/remove/retry/recognize and `image.generate`.
  Provider image test, remote upload, record export and scene planning each
  require their corresponding methods before exposing those controls.
- **Vinted accounts:** preserve paginated revision-consistent list reads,
  account CRUD, import/template export, OTP reads, account-to-Raccoon-Profile
  binding and order watch. Binding always uses the Raccoon Profile UUID and the
  current v2 Workspace; switching Workspace invalidates stale dialogs and
  responses. Credential values never enter logs or unrelated page state. Base
  account CRUD gates list/save/remove/import/template/OTP/bind/unbind/bindings.
  Mailbox import/linking, address targets/assignment and order-watch settings,
  items, Bark tests and scheduling are optional workflows, each gated by its
  full method set from the installed manifest.
- **SIM8:** preserve token configuration, provider account, project/category
  choice, immediate and deferred purchase, local number pool, order detail,
  SMS read, renewals, filter checks and expiry reminders. Token fields remain secret inputs;
  purchase and renewal results must be confirmed from returned plugin records.
  Base and tab contracts cover every called configuration, profile, category,
  app, prefix, buy, record and SMS method. Orders, renewals, filtering and expiry
  each require their own complete method group before their controls appear.
- **Vinted monitor:** preserve monitor and proxy CRUD, URL inspection, scheduled
  and manual runs, run history, paginated archive, item detail, star/review/delete
  and seller monitoring. Images use the plugin's proxy-scoped chunk protocol.
  Existing AI handoff remains explicit and carries only public source metadata
  and transferred image bytes. The base monitor/archive gate includes monitors
  list/save/remove/run, runs list/get, item list/get/star/availability/remove/
  monitorSeller, proxies list/save/remove/default, and URL inspect. Image detail
  and transfer controls separately require `vinted.image.open/read/close`.
- **Email:** preserve mailbox list/edit/import, Graph/IMAP choice, device-code
  authorization start/poll/cancel, settings, manual refresh/receive queues,
  paginated messages, safe message detail and read state. Authorization and
  mailbox credentials stay transient or in plugin-owned storage; errors are
  categorized without exposing provider tokens or raw credential-bearing data.
  The page gate includes account list/get/save/import/remove, refresh/receive
  queues, settings get/save, message list/get/read and authorization
  start/poll/cancel.
- **Products:** preserve paginated search/filter, product CRUD, CSV/JSON import,
  bounded image upload/read, deletion confirmation and read-only publication
  history. Writes carry the public contracts' create key/revision fields.
  Publication records are never created by a preparation state or simulated
  page action. AI-image import remains available through the existing public
  `products.sources.find/importAi` and `image.records.get/image.file.chunk`
  handoff, with upload/discard methods and process-identity checks. The general
  product page's base methods include list/get/save/remove/import, publication
  history list, image upload begin/chunk/finish/abort, image read and discard;
  AI import is separately gated on its cross-plugin method set. The host-reserved
  `products.publications.record` method is never exposed as a normal page action.
- **Sales Agent:** use Rust `sales_agent_*` commands for all durable batches,
  preflight, assignments, controls, event/history reads, model request details,
  usage, artifact preview, related history and retention. Current native command
  set is `sales_agent_batch_create/list/get/control`, `sales_agent_events`,
  `sales_agent_preflight`, `sales_agent_job_control`, `sales_agent_items`,
  `sales_agent_item_control`, `sales_agent_artifact_preview`,
  `sales_agent_workspace_list/get/save/delete`, `sales_agent_usage`,
  `sales_agent_model_requests`, `sales_agent_retention_preview/clean`,
  `sales_agent_attention`, and `sales_agent_related`. Through WebView plugin RPC,
  the host currently allows only `salesAgent.settings.get/save`,
  `salesAgent.models.test`, and configuration export/validate/import. Other
  `sales.agent` calls, including `salesAgent.catalog.search`, are host-blocked.
  Do not route durable jobs through direct plugin RPC, bypass Rust lease/scope
  checks, or expose arbitrary CDP/script execution.

### Preview and unavailable states

Native Tauri uses the real v2 adapters. An ordinary browser does not have a
plugin host: each page must show a consistent “desktop application required” or
explicit preview-only state. If a page includes sample data, it must be labeled
as sample data and all side effects that would imply real plugin persistence,
provider calls, Profile mutations or purchases remain unavailable. Do not
return successful mock RPC results to page code.

## UI and interaction

- Follow the proxy-pool page's `PageHeader` / `PageBody`, semantic UI Kit tokens,
  compact controls and table/dialog patterns where appropriate.
- Use page-specific navigation only inside the business content; do not duplicate
  plugin center, installation or license controls inside a business page.
- Keep destructive operations behind confirmation. Preserve explicit loading,
  empty, error, retry, authorization, unavailable and partial-result states.
- Keep operation feedback adjacent to the affected section; use shared toasts
  for concise completion summaries.
- Keep large tables paginated and use the plugin's established page limits.
- Preserve keyboard access, labels, focus behavior, narrow window layouts and
  bounded long text.
- `NativeApplication` keeps plugin pages mounted while the Browser Workspace
  changes. Any page that reads or mutates Workspace/Profile relationships must
  key its workspace-scoped component by `connectionId`, invalidate pending
  requests and clear selections/dialogs on a connection change. Global plugin
  inventory pages may remain application-scoped.

## Error and persistence rules

- Validate every plugin response at its adapter boundary. Unknown fields may be
  tolerated only where the current public contract already allows them.
- A failed write must not update the page's saved snapshot as if it succeeded.
- After successful writes, re-read the authoritative plugin state; after a
  refresh failure, say the operation completed but the view could not refresh.
- Poll only plugin-owned asynchronous operations that require it, stop polling
  when the page unmounts, and avoid overlapping requests.
- No business data is stored in localStorage. UI-only preferences may use the
  existing v2 preference patterns.

## Testing and acceptance

- Add unit tests for each page gate and response parser, especially missing
  methods, wrong capability, malformed pages and failed writes.
- Add tests for high-impact page operations: generated address save/remove,
  image chunk integrity, revision-checked account/product writes, purchase
  record confirmation, monitor/image cancellation and Agent command routing.
- Validate every page's real UI adapter is called through `plugin_call`, except
  documented native Agent operations and native Workspace/Profile data.
- Exercise component/page smoke flows with controlled IPC; controlled data is
  not evidence of real external service, browser or purchase success.
- Run direct desktop-v2 TypeScript, affected ESLint, focused Node tests,
  formatting, `check:i18n`, `check:errors`, and `git diff --check` where
  applicable. Follow repository restrictions: do not run app/Rust builds,
  Rust tests or Clippy locally.
- Do not update quality records until commands actually run. Report untested
  real providers, purchases, browser networking, Windows, restart and packaging
  separately.

## Implementation calls for the builder

- Preserve domain-specific business workflows, not the old component tree or
  CSS. Reuse pure validation, formatters and SDK/public contracts only when
  they can be imported without pulling the 0.1 desktop shell or IPC.
- Build in dependency order: shared page contract/adapter pattern; address and
  shared supply; accounts and email; SIM8 and monitor; products; AI image; Agent;
  then plugin center registry, docs and cross-page verification.
- Avoid source imports from `apps/desktop/src` into `apps/desktop-v2`. If an
  existing pure helper is needed, port a small focused implementation with
  contract-based tests or move it to an already-public shared package as a
  separately justified change.
