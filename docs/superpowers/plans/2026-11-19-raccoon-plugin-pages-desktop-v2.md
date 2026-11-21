# Raccoon Plugin Pages desktop-v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the nine remaining first-party plugin business pages to `apps/desktop-v2` with ShardX UI Kit, validated Raccoon host adapters, and no 0.1 UI or IPC compatibility.

**Architecture:** Keep `raccoon/plugins/call.ts` as the sole general WebView plugin RPC bridge. Add page-local capability adapters, response validation and exact base/optional method gates; lazy-register each page in the v2 plugin router. Ecom Agent durable workflows continue through Rust `sales_agent_*` commands, while plugin RPC is restricted to methods currently allowed by `plugin_service.rs`.

**Tech Stack:** React 19, strict TypeScript, ShardX UI Kit, Tailwind 4 semantic tokens, Tauri 2 plugin host, Node built-in test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-raccoon-plugin-pages-desktop-v2-design.md`

## Global Constraints

- Do not import `apps/desktop/src` page components, legacy IPC adapters or CSS into desktop-v2.
- Do not modify plugin Node services, manifests, private schemas, package versions or RPC protocol in this scope.
- Do not load React code from plugin packages; all page bundles ship with desktop-v2.
- Use `plugin_call` only through `src/raccoon/plugins/call.ts`; never fetch plugin upstream APIs from page components.
- Validate plugin responses before they enter React state; never present failed writes as saved.
- Gate optional features on every method that their visible UI can call; do not disable unrelated base functionality.
- Keep browser preview distinct from native execution; do not simulate successful plugin writes, purchases, provider results or Profile mutations.
- Ecom Agent durable batches, jobs, controls, events, artifacts, workspace, usage and retention use Rust `sales_agent_*` commands.
- `plugin_service.rs` currently permits Agent WebView RPC only for settings get/save, model test and configuration transfer; `salesAgent.catalog.search` is blocked.
- Profile/account associations use Raccoon UUIDs and clear workspace-scoped selections, dialogs and pending responses when `connectionId` changes.
- Use ShardX UI Kit and semantic tokens; no raw color values or second global theme.
- Do not run application/Rust builds, Rust tests or Clippy locally; no dependency changes or commits.

## Review Focus

- Plugin response shape drift — adapter rejects malformed rows without corrupting page state; cover in each capability adapter test.
- Optional RPC method absent — only the dependent feature is unavailable; cover each page-contract optional group.
- Workspace changes during account/Profile assignment — stale selection and late responses are discarded; cover in account Workspace-scope tests.
- Chunk interruption or cancellation — close/abort sessions and do not report completed image transfer; cover supply, AI image, monitor and product transfer tests.
- Restricted Agent and publication RPC — durable Agent work uses native commands and ordinary page code cannot call reserved publication writes; cover command-routing tests and static host-boundary assertions.

---

## File Map

- `apps/desktop-v2/src/raccoon/plugins/page-contract.ts` — plugin IDs, capabilities, required base methods and optional method groups.
- `apps/desktop-v2/src/raccoon/plugins/<plugin>/` — one typed adapter/model/parser/test set per capability.
- `apps/desktop-v2/src/pages/plugins/<plugin>/` — ShardX UI Kit page and focused dialogs/panels.
- `apps/desktop-v2/src/pages/plugins/PluginPage.tsx` — lazy registry, unavailable states and handoff props.
- `apps/desktop-v2/src/raccoon/Application.tsx` — route-level props for native Workspace context and cross-plugin handoffs.
- `apps/desktop-v2/e2e/` — controlled native-boundary page flows, if the existing E2E harness can host the native route without enabling successful preview mocks.
- `docs/09-quality-and-testing.md`, `docs/06-plugin-system.md`, `docs/19-address-generator-plugin.md`, `docs/21-shared-supply-plugin.md`, `docs/22-ai-image-plugin.md`, `docs/23-vinted-monitor-plugin.md`, `docs/24-vinted-accounts-plugin.md`, `docs/30-sim8-plugin.md`, `docs/41-email-plugin.md`, `docs/43-products-plugin.md`, `docs/44-sales-agent-architecture.md` — record current page integration and actual validation boundaries.

## Task 1: Shared Plugin Page Contracts

**Files:**

- Create: `apps/desktop-v2/src/raccoon/plugins/page-contract.ts`
- Create: `apps/desktop-v2/src/raccoon/plugins/page-contract.test.ts`
- Modify: `apps/desktop-v2/src/raccoon/plugins/call.ts` only if an adapter-boundary helper is required; keep the existing invoke/error behavior.
- Test: `apps/desktop-v2/src/raccoon/plugins/page-contract.test.ts`

**Interfaces:**

- Produces: `PLUGIN_PAGE_CONTRACTS`, `pageContractProblem(plugin, contract)`, and optional-workflow support checks used by all plugin pages.
- Produces: exact base and optional method groups for the nine plugin IDs listed in the design spec.
- Produces: Agent native command set matching `apps/desktop/src-tauri/src/core/agent/commands.rs`; the contract does not list blocked Agent RPC as page-callable.

- [ ] **Step 1: Write failing contract tests**
  - Assert all nine plugin IDs and capability names match the design table.
  - Assert every base/optional method list is nonempty and has no duplicates.
  - Assert unknown IDs, missing/available plugin, disabled/unlicensed/starting/retrying states, wrong capability/grant and missing base methods produce distinct non-success states.
  - Assert a missing optional method does not fail the base contract but disables only its named optional group.
- [ ] **Step 2: Run tests and confirm expected failure**
  - Run: `rtk proxy node --test apps/desktop-v2/src/raccoon/plugins/page-contract.test.ts`
  - Expected: fail because the contract module/API is not implemented.
- [ ] **Step 3: Implement shared contracts and pure gates**
  - Define plugin contract IDs as a string-literal union and keep method arrays as readonly literals.
  - Represent base methods separately from named optional groups; do not infer capability from `studio.` IDs.
  - Add exact Agent native command list, including artifact preview, model request history, retention and related-history commands.
- [ ] **Step 4: Run contract tests and formatting**
  - Run: `rtk proxy node --test apps/desktop-v2/src/raccoon/plugins/page-contract.test.ts`
  - Run: `rtk proxy node_modules/.bin/prettier --check apps/desktop-v2/src/raccoon/plugins/page-contract.ts apps/desktop-v2/src/raccoon/plugins/page-contract.test.ts`
  - Expected: all contract cases pass and files are formatted.

## Task 2: Address Generator and Shared Supply

**Files:**

- Create: `apps/desktop-v2/src/raccoon/plugins/address-generator/{model.ts,parse.ts,api.ts,parse.test.ts}`
- Create: `apps/desktop-v2/src/raccoon/plugins/shared-supply/{model.ts,parse.ts,api.ts,parse.test.ts,image-transfer.ts,image-transfer.test.ts}`
- Create: `apps/desktop-v2/src/pages/plugins/address-generator/{index.tsx,SavedAddresses.tsx,MapsSettings.tsx}`
- Create: `apps/desktop-v2/src/pages/plugins/shared-supply/{index.tsx,ProductGrid.tsx,ProductDetail.tsx}`
- Modify: `apps/desktop-v2/src/raccoon/plugins/page-contract.ts`, `apps/desktop-v2/src/pages/plugins/PluginPage.tsx`
- Test: each adapter/parser test and route registration tests.

**Interfaces:**

- Consumes: Task 1 `pageContractProblem` and optional-feature gate.
- Produces: typed address and supply methods using `callPlugin` with `address.generator` / `supply.catalog`.
- Produces: bounded shared-supply image loader using only `supply.image.open/read/close`; returns a Blob after integrity and size checks.

- [ ] **Step 1: Write parser and capability-gate tests**
  - Address: reject malformed catalog/profile/saved-address pages and invalid persistence flags.
  - Supply: reject malformed category/product/favorite pages and invalid image metadata/chunks.
  - Assert saved-address file export and supply image/favorite sections stay individually gated.
- [ ] **Step 2: Run focused tests and confirm expected failure**
  - Run: `rtk proxy node --test apps/desktop-v2/src/raccoon/plugins/address-generator/parse.test.ts apps/desktop-v2/src/raccoon/plugins/shared-supply/parse.test.ts apps/desktop-v2/src/raccoon/plugins/shared-supply/image-transfer.test.ts`
- [ ] **Step 3: Implement adapters before UI**
  - Parse all external RPC results; keep Maps API key response limited to the existing Maps SDK requirement.
  - Implement supply chunk transfer with cancellation, exact offsets, base64 validation, MIME/size bounds and best-effort close.
- [ ] **Step 4: Implement both v2 pages with Kit patterns**
  - Address: city selector, public generation, map picking, generated profiles, save/remove, copy/CSV, optional saved-address list and Maps settings.
  - Supply: category/store/product browsing, text/image search, favorite add/remove/export, controlled image load and product copy.
  - Use the v2 dialog, tabs, fields, grid/list and semantic statuses; preview shows desktop-required or sample-only state with writes disabled.
- [ ] **Step 5: Register lazy pages and test adapter behavior**
  - Update `PluginPage.tsx` and test each registered page can be imported independently.
  - Run focused Node tests, ESLint and Prettier for the changed paths.

## Task 3: Vinted Accounts and Email

**Files:**

- Create: `apps/desktop-v2/src/raccoon/plugins/vinted-accounts/{model.ts,parse.ts,api.ts,api.test.ts,workspace-scope.ts,workspace-scope.test.ts}`
- Create: `apps/desktop-v2/src/raccoon/plugins/email/{model.ts,parse.ts,api.ts,api.test.ts}`
- Create: `apps/desktop-v2/src/pages/plugins/vinted-accounts/{index.tsx,AccountForm.tsx,ImportDialog.tsx,OrderWatch.tsx}`
- Create: `apps/desktop-v2/src/pages/plugins/email/{index.tsx,MailboxForm.tsx,AuthorizationDialog.tsx,MailReader.tsx,EmailSettings.tsx}`
- Modify: `apps/desktop-v2/src/raccoon/plugins/page-contract.ts`, `apps/desktop-v2/src/pages/plugins/PluginPage.tsx`, `apps/desktop-v2/src/raccoon/Application.tsx`
- Test: account revision/page aggregation, Workspace invalidation, mailbox shape/auth state and message-page parsers.

**Interfaces:**

- Consumes: Task 1 page/optional-method contracts and Task 2 address `Profile` DTO if reused; otherwise define the minimal public account-address DTO locally.
- Produces: all account calls via `account.pool`, all email calls via `email.provider`.
- Produces: account workspace-scope key based on `connectionId`, with stale operation token invalidation on change.

- [ ] **Step 1: Write failing parser and Workspace-race tests**
  - Verify revision-consistent account pages reject duplicate IDs, changed revisions, duplicate window bindings and mismatched totals.
  - Verify Workspace change clears account selection/dialog state and ignores prior Workspace responses.
  - Verify mailbox/message shapes reject malformed statuses, timestamps, cursors and secret-bearing fields outside public DTOs.
- [ ] **Step 2: Run focused tests and confirm expected failure**
  - Run: `rtk proxy node --test apps/desktop-v2/src/raccoon/plugins/vinted-accounts/api.test.ts apps/desktop-v2/src/raccoon/plugins/vinted-accounts/workspace-scope.test.ts apps/desktop-v2/src/raccoon/plugins/email/api.test.ts`
- [ ] **Step 3: Implement validated adapters**
  - Aggregate `vinted.accounts.list` pages with a shared revision and reject partial results.
  - Gate address/mailbox association, mailbox import and order watch independently using their full manifest method groups.
  - Keep email refresh/receive queues, auth polling and message paging bounded; sanitize errors to the documented category/message contract.
- [ ] **Step 4: Implement account and email pages**
  - Account page: inventory CRUD, CSV/XLSX template/import, OTP reads, bindings, address/mailbox relationships and order-watch controls/history.
  - Email page: mailbox CRUD/import, authorization lifecycle, settings, refresh/receive queues, folders, message list/detail/read state.
  - In `Application.tsx`, key account workspace scope by `connectionId`; close pending dialogs and discard late responses when Workspace changes.
- [ ] **Step 5: Register routes and verify focused behavior**
  - Add lazy routes and test wrong-capability/missing-method/optional-feature states.
  - Run focused Node tests, ESLint and Prettier.

## Task 4: SIM8 and Vinted Monitor

**Files:**

- Create: `apps/desktop-v2/src/raccoon/plugins/sim8/{model.ts,parse.ts,api.ts,api.test.ts}`
- Create: `apps/desktop-v2/src/raccoon/plugins/vinted-monitor/{model.ts,parse.ts,api.ts,api.test.ts,image-transfer.ts,image-transfer.test.ts}`
- Create: `apps/desktop-v2/src/pages/plugins/sim8/{index.tsx,PurchasePanel.tsx,RecordsTable.tsx,OrdersPanel.tsx,ExpiryPanel.tsx}`
- Create: `apps/desktop-v2/src/pages/plugins/vinted-monitor/{index.tsx,MonitorForm.tsx,ItemsTable.tsx,ItemDetail.tsx,RunHistory.tsx}`
- Modify: `apps/desktop-v2/src/raccoon/plugins/page-contract.ts`, `apps/desktop-v2/src/pages/plugins/PluginPage.tsx`, `apps/desktop-v2/src/raccoon/Application.tsx`
- Test: SIM8 purchase/record confirmation, optional method groups, monitor URL/item validation, image transfer cancellation and AI handoff identity.

**Interfaces:**

- Consumes: Task 1 contract/gate API and Task 3 account adapter for optional SIM8 number-to-account linking.
- Produces: typed `verification.provider` and `monitor.collector` adapters with action-specific deadlines.
- Produces: monitor image transfer scoped to `vinted.image.open/read/close`; page receives only a validated Blob.

- [ ] **Step 1: Write failing response and transfer tests**
  - SIM8: reject invalid order/record/config/filter responses; purchase is accepted only after a valid order number and returned record set.
  - Monitor: reject malformed list pagination, invalid URL inspection and item identities; cancellation always attempts transfer close.
  - Assert missing orders/renew/filter/expiry methods disable those panels without disabling the number pool; gate monitor image methods separately.
- [ ] **Step 2: Run focused tests and confirm expected failure**
  - Run: `rtk proxy node --test apps/desktop-v2/src/raccoon/plugins/sim8/api.test.ts apps/desktop-v2/src/raccoon/plugins/vinted-monitor/api.test.ts apps/desktop-v2/src/raccoon/plugins/vinted-monitor/image-transfer.test.ts`
- [ ] **Step 3: Implement adapters and bounded image transport**
  - Keep token values only in password input state and the single save request.
  - Verify purchase/renewal/read results by response DTO, not by optimistic local insertion.
  - Monitor images use bounded chunks, abort signaling and unconditional best-effort close.
- [ ] **Step 4: Implement Kit pages and independent optional panels**
  - SIM8: settings, buy/deferred buy, local number pool, orders, SMS, renewals, filter checks and expiry status/actions.
  - Monitor: monitor/proxy CRUD, run controls/history, archive filters, item details/review/star/remove, seller-monitor action and image handoff.
  - Preserve account linking only when the account plugin's complete relation contract is available.
- [ ] **Step 5: Register and verify focused tests/lint/format**

## Task 5: Products and AI Image Handoff

**Files:**

- Create: `apps/desktop-v2/src/raccoon/plugins/products/{model.ts,parse.ts,api.ts,api.test.ts,ai-import.ts,ai-import.test.ts}`
- Create: `apps/desktop-v2/src/pages/plugins/products/{index.tsx,ProductEditor.tsx,ImportDialog.tsx,PublicationHistory.tsx}`
- Modify: `apps/desktop-v2/src/raccoon/plugins/page-contract.ts`, `apps/desktop-v2/src/pages/plugins/PluginPage.tsx`, `apps/desktop-v2/src/raccoon/Application.tsx`
- Test: revision/create-key writes, upload chunk abort/finish, source-idempotent AI import, plugin process replacement and reserved-publication refusal.

**Interfaces:**

- Consumes: Task 1 gate API; `@nexus/plugin-contracts/products`; the v2 AI-image page handoff event contract.
- Produces: product adapter for `product.catalog` RPC with validated page, detail, save, import, image, source-import and publication-read responses.
- Produces: `importGenerationProduct(recordId, { signal, onProgress })`-equivalent orchestration with explicit source identity and process identity check.

- [ ] **Step 1: Write failing contract and cross-plugin import tests**
  - Assert malformed product pages, duplicate IDs, stale revisions and mismatched save responses are rejected.
  - Assert AI import refuses active/incomplete generation, validates bounded chunks, deduplicates by source record, and cleans uploaded but uncommitted images after failure/cancel.
  - Assert UI adapter has no path to `products.publications.record`.
- [ ] **Step 2: Run focused tests and confirm expected failure**
  - Run: `rtk proxy node --test apps/desktop-v2/src/raccoon/plugins/products/api.test.ts apps/desktop-v2/src/raccoon/plugins/products/ai-import.test.ts`
- [ ] **Step 3: Implement product RPC and image adapter**
  - Use public Zod schemas from `@nexus/plugin-contracts/products`; preserve `createKey`, expected revisions and upload IDs.
  - Implement image reads/uploads with exact offsets, maximum byte/chunk sizes and abort/discard recovery.
- [ ] **Step 4: Implement Products page and AI handoff**
  - Add paginated inventory filters, editor, CSV/JSON import, confirmation delete and read-only publication history.
  - Wire AI image handoff; import only completed record snapshots and keep source record ID for plugin-side idempotency.
- [ ] **Step 5: Register and verify tests/lint/format**

## Task 6: AI Image Page

**Files:**

- Create: `apps/desktop-v2/src/raccoon/plugins/ai-image/{model.ts,parse.ts,api.ts,api.test.ts,file-transfer.ts,file-transfer.test.ts}`
- Create: `apps/desktop-v2/src/pages/plugins/ai-image/{index.tsx,ProviderSettings.tsx,GenerateDialog.tsx,ScenePlanDialog.tsx,RecordDetail.tsx,RecordHistory.tsx}`
- Modify: `apps/desktop-v2/src/raccoon/plugins/page-contract.ts`, `apps/desktop-v2/src/pages/plugins/PluginPage.tsx`, `apps/desktop-v2/src/raccoon/Application.tsx`
- Test: provider/model contracts, explicit image/vision models, plan method optional gate, upload/read chunk validation, record polling/unmount cancellation and product handoff.

**Interfaces:**

- Consumes: Task 1 page/optional gates and Task 5 AI-to-products handoff receiver.
- Produces: `image.provider` adapter for supported provider, preset, generation, scene-plan, record and file operations.
- Produces: a source-handoff payload containing only allowed public source metadata and copied bounded image bytes.

- [ ] **Step 1: Write failing adapter and chunk tests**
  - Reject model selection/config version mismatch, malformed providers/plans/records, invalid offsets, oversized chunks and MIME mismatches.
  - Assert missing `image.plans.*`, `image.providers.testImage`, `image.upload.remote`, or `image.records.export` disables only that feature.
  - Assert no generated history indicates success from a request acknowledgement alone; poll authoritative plugin records.
- [ ] **Step 2: Run focused tests and confirm expected failure**
  - Run: `rtk proxy node --test apps/desktop-v2/src/raccoon/plugins/ai-image/api.test.ts apps/desktop-v2/src/raccoon/plugins/ai-image/file-transfer.test.ts`
- [ ] **Step 3: Implement validated adapter and chunk transport**
  - Keep image and vision provider/model choices explicit; never silently substitute a missing model.
  - Use per-chunk bounds below the 1 MiB plugin RPC line limit; close/abort transfer sessions on completion, cancellation and unmount.
- [ ] **Step 4: Implement Kit workflows and cross-page handoff**
  - Add provider CRUD/test, generation/scene plan, record history/detail/retry/recognition and image previews.
  - Keep background plugin generation owned by plugin records; cancel page polling without claiming server-side generation cancellation.
- [ ] **Step 5: Register and verify tests/lint/format**

## Task 7: Sales Agent Page

**Files:**

- Create: `apps/desktop-v2/src/raccoon/plugins/sales-agent/{model.ts,parse.ts,api.ts,api.test.ts,native.ts,native.test.ts}`
- Create: `apps/desktop-v2/src/pages/plugins/sales-agent/{index.tsx,Preflight.tsx,BatchComposer.tsx,BatchRuns.tsx,ReviewWorkbench.tsx,AgentSettings.tsx,RetentionDialog.tsx}`
- Modify: `apps/desktop-v2/src/raccoon/plugins/page-contract.ts`, `apps/desktop-v2/src/pages/plugins/PluginPage.tsx`, `apps/desktop-v2/src/raccoon/Application.tsx`
- Test: exact allowed plugin RPC, complete Rust command routing, request/response Zod contracts, batch mutation confirmation and workspace/account/product source boundaries.

**Interfaces:**

- Consumes: `@nexus/plugin-sdk/agent` schemas and Tasks 3/5 account, product and Workspace public adapters.
- Produces: only the host-allowed `salesAgent.settings.get/save`, `salesAgent.models.test` and configuration RPC adapter.
- Produces: native command adapter for every `sales_agent_*` handler listed in the design spec; it must validate results against the same DTO schemas and include artifact preview/model requests/retention/related history.

- [ ] **Step 1: Write failing routing/contract tests**
  - Assert settings/model checks invoke only allowed `plugin_call` methods.
  - Assert batch, preflight, controls, events, assignments, workspace, usage, model requests, retention, artifact preview, attention and related history call their exact native command, never plugin RPC.
  - Assert native batch create result is checked before reporting creation and reserved publication/notification/step methods are unavailable to direct page calls.
- [ ] **Step 2: Run focused tests and confirm expected failure**
  - Run: `rtk proxy node --test apps/desktop-v2/src/raccoon/plugins/sales-agent/api.test.ts apps/desktop-v2/src/raccoon/plugins/sales-agent/native.test.ts`
- [ ] **Step 3: Implement boundary adapters**
  - Parse every input and response with `@nexus/plugin-sdk/agent`; use existing `browser-api` `invokeBrowser` boundary for native commands.
  - Do not include `salesAgent.catalog.search` in WebView method contract because current host blocks it.
- [ ] **Step 4: Implement Agent page**
  - Port preflight, assignment editing, settings, batch list/detail, pause/resume/cancel/reconcile/takeover, item review, events, usage, artifact view, related history and retention confirmation.
  - Verify that the selected Workspace and Profile UUIDs still match before submission; discard late results after Workspace switches.
- [ ] **Step 5: Register and verify tests/lint/format**

## Task 8: Cross-Page Integration and Documentation

**Files:**

- Modify: `apps/desktop-v2/src/pages/plugins/PluginPage.tsx`
- Modify: `apps/desktop-v2/src/raccoon/Application.tsx`
- Modify: `apps/desktop-v2/src/dev/mock/handlers.ts` only to reject plugin calls explicitly; do not return successful fake business writes.
- Modify: module docs `docs/06-plugin-system.md`, `docs/19-address-generator-plugin.md`, `docs/21-shared-supply-plugin.md`, `docs/22-ai-image-plugin.md`, `docs/23-vinted-monitor-plugin.md`, `docs/24-vinted-accounts-plugin.md`, `docs/30-sim8-plugin.md`, `docs/41-email-plugin.md`, `docs/43-products-plugin.md`, `docs/44-sales-agent-architecture.md`.
- Modify: `docs/09-quality-and-testing.md` only with actual test results.
- Test: all page-contract tests, changed adapter tests, page router and controlled native-route smoke flows.

**Interfaces:**

- Consumes: all page exports from Tasks 2–7.
- Produces: `PluginPage` lazy route for each listed ID, optional `handoff` props to AI image and connection-scoped `connectionId` lifecycle for relationship pages.

- [ ] **Step 1: Write route and preview boundary tests**
  - Assert each first-party ID resolves to its intended lazy page and unknown IDs resolve to generic details.
  - Assert ordinary browser preview displays a desktop-required/preview-only state and no `plugin_call` mutation succeeds.
  - Assert installation/uninstall/navigation returns to the plugin center and plugin page state survives irrelevant Browser Workspace changes.
- [ ] **Step 2: Run focused tests and confirm expected failure**
  - Run the v2 Node tests for page contracts and each touched capability adapter.
- [ ] **Step 3: Wire page registry and cross-plugin handoffs**
  - Add one lazy page per plugin; do not eagerly import the nine page bundles from the application shell.
  - Thread connection ID into account/Agent pages and handoff selection/image data only between monitor/AI image/products as specified.
  - Ensure browser preview RPC calls reject with an explicit unavailable error rather than returning business success fixtures.
- [ ] **Step 4: Update module docs and actual quality record**
  - Document v2 page ownership, method gates and verification boundaries.
  - Add only commands actually run and outcomes actually observed.
- [ ] **Step 5: Run complete permitted local verification**
  - Run: `rtk proxy node_modules/.bin/tsc -p apps/desktop-v2/tsconfig.json --noEmit`
  - Run: `rtk proxy node_modules/.bin/eslint <changed v2 paths> --max-warnings 0`
  - Run: `rtk proxy node --test <all changed v2 *.test.ts files>`
  - Run: `rtk proxy node apps/desktop-v2/scripts/check-i18n.mjs`
  - Run: `rtk proxy node apps/desktop-v2/scripts/check-errors.mjs`
  - Run: `rtk proxy node_modules/.bin/prettier --check <changed paths>` and `rtk proxy git diff --check`
  - Run allowed Playwright page smoke tests only if they use a controlled native IPC fixture; do not treat a fixture as real plugin/provider evidence.

## Final Acceptance

- All nine pages are lazy-routed, purpose-built v2 pages; no 0.1 React page/IPC/CSS is imported.
- Every native plugin call goes through the shared host adapter and every page response is validated.
- Every base/optional method gate exactly matches the methods visible UI can call.
- Ecom Agent durable operations use Rust commands; host-blocked Agent RPC is not used.
- Address maps follow CSP; image transfers are bounded/cancellable; account/Profile links use Raccoon UUIDs and current Workspace.
- Browser preview does not claim real plugin data, persistence, provider calls, purchases or browser execution.
- Tests, lint, type check and visual smoke results are recorded with truthful boundaries; no app/Rust build or native integration is claimed without evidence.
