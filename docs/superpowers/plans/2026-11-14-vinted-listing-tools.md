# Vinted Listing Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship browserless content preparation, deterministic Vinted publishing, and identity-checked account observations in Raccoon and its plugins.

**Architecture:** Rust owns durable execution scopes, admission, approvals and submission recovery. The Ecom Agent plugin owns Vinted adapters and content decisions; the account plugin owns its observations and financial records. Browser execution stays in the user's bound environment.

**Tech Stack:** Rust, SQLite, TypeScript, Zod, LangGraph, Playwright, React and shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-14-vinted-listing-tools-design.md`.

## Global Constraints

- All shell commands start with `rtk`; use the repository's fixed Node and pnpm.
- Do not run local builds, package generation, Rust compilation, Rust tests or Clippy. Run direct Vitest, lint, no-emit type checks and rustfmt; native compilation and distribution run in CI.
- Preserve user-owned `catalogs.json` and `output/`, existing immutable browser bindings, required proxies, durable actions and publication outbox.
- Post Listing browser execution makes zero model calls. Message retains its independent planner.
- Page category takes precedence; local taxonomy is an optional fallback. No fallback is not a queue-admission failure.
- Only exact current-response evidence proves logged out or blocked; never infer a sold item from its condition.
- Use normal browser CORS and credentials for the two exact financial GET endpoints; no credential extraction or direct-network fallback.
- Store plaintext in existing data owners. Exclude financial PII and credentials from general Agent snapshots, checkpoints and model input.
- Upgrade stored data once; do not add legacy runtime aliases.
- The user has approved implementation, commit, push, application release and affected plugin publication.

## Review Focus

- A stale observation after account rebinding cannot update the new account; test scope and per-domain ordering.
- An interrupted upload or submission cannot duplicate images or listings; test readback and unknown-result recovery.
- Preparation must progress with zero browser capacity and must never acquire a browser reservation; test separate admission and gateway denial.
- A page-selected category absent from the bundled taxonomy remains valid; test page precedence and category re-rendering.
- New machines receive the bundled catalog and updated plugins; verify the final package in CI and record actual publication results.

## File Responsibilities

- `plugins/vinted-accounts/src/agent-contracts.ts`, observations, store and account UI: account evidence, homepage, window login, independent Money and bank projection.
- `packages/browser-runtime/src/automation.ts` and tests: bounded host-authorized reads and observable form primitives.
- `packages/plugin-sdk/src/agent.ts`: explicit execution mode, approved content and step/result contracts.
- `apps/desktop/src-tauri/src/core/agent/`: preparation admission, scoped model/artifact access, approval storage, migration, state/recovery and browser policy.
- `plugins/sales-agent/src/content/`, `catalog/`, `platform/`, `workflow/`: preparation, local taxonomy, deterministic tools, current/wardrobe/financial reads and publication orchestration.
- `plugins/products/src/` and desktop product/Agent features: market-scoped platform facts, editable preparations and current execution status.
- Plugin packaging, release workflows and module documents: complete offline distribution and factual validation records.

### Task 1: Account Evidence and UI

**Scope:** Account plugin contracts, domain, store, capabilities, tests and desktop account presentation. Do not modify the shared Agent SDK or Rust coordinator.

- [ ] Add failing tests for exact official blocked evidence, window-specific login observations, homepage ownership, stale per-domain results and mutation durability.
- [ ] Replace the single-currency balance with independent Money observations; migrate existing records once. Add validated bank records, successful-empty semantics and PII-safe Agent projection.
- [ ] Preserve order-watch pause/Bark/dedup when a validated current homepage is applied.
- [ ] Show login observations, independent balances and masked bank summaries/details; provide an explicit account inspection entry using the existing Agent job boundary.
- [ ] Run the direct account and UI test suites, lint and no-emit checks; review scope and privacy.

### Task 2: Runtime Read and Form Boundaries

**Scope:** Browser runtime automation and controlled fixtures. Shared SDK and Rust policy integration belong to Task 3.

- [ ] Add failing tests for same-origin reads, exact financial paths, forbidden arbitrary origins/paths/headers, normal CORS, response byte budgets and redirect rejection.
- [ ] Add `readPolicy: "vinted_account_financials"` to host-authorized request input. Allow only HTTPS `api.www.vinted.<same-market>` and the two exact paths; use `credentials: "include"`, normal CORS, redirect error.
- [ ] Add bounded observable primitives needed by deterministic tools, including stable category values, upload evidence and observed custom-option selection. Unknown forms fail explicitly.
- [ ] Verify with controlled browser fixtures; no real account writes.

### Task 3: Durable Browserless Preparation

**Scope:** Agent SDK, Rust coordinator/gateway/store, native tests and matching frontend state contracts.

**Interfaces:**

- `AgentScope.mode` is required: `"content_preparation" | "browser"`. Window/account IDs remain real assigned bindings in both modes.
- `AgentStepResult.state` adds `"prepared"` and `"login_required"`. `"prepared"` transitions a Post Listing job to browser admission after durable preparation.
- Host methods `agent.content.get` and `agent.content.put` read/write scoped approved packages by `productId` and `contentKey`. Only preparation can write. Approved package includes the source digest, frozen product revision/images, final copy, model/rule versions and optional local fallback.
- Browser/model/action/plugin gateways explicitly deny methods outside the current execution mode. Browser Post Listing denies all model permits.

- [ ] Add Rust tests for preparation without browser/account/provider capacity, stale scopes, browser denial, bounded model permits, cache invalidation and restart recovery. Native execution is CI-only.
- [ ] Persist preparation execution separately from browser ownership; do not acquire window/account resources or provider capacity during preparation.
- [ ] Persist approvals and reuse only for identical frozen content and review context. A preparation storage failure never admits browser execution.
- [ ] Add `login_required` throughout query, controls, notification, recovery and UI states; preserve unknown submissions and confirmed outbox during migration.
- [ ] Apply the runtime policy at SDK, host gateway and native browser validation boundaries.
- [ ] Use rustfmt and source/no-emit checks locally; record that native tests await CI.

### Task 4: Content, Taxonomy and Deterministic Publishing

**Scope:** Ecom Agent content/catalog/platform/workflow modules and tests; products' market facts.

- [ ] Write failing tests for browserless real-image review, bounded copy rewriting, content-key invalidation, mixed preparation results and zero browser-phase model calls.
- [ ] Load and validate the bundled schema-1 taxonomy, revision, IDs and paths. Provide bounded search and optional typed hierarchical fallback; do not require fallback to publish.
- [ ] Prepare immutable approved content before browser admission. Review actual image bytes and English copy, preserve source product text, and reuse matching approvals.
- [ ] Implement exact current classification, bounded wardrobe scanning and identity-bracketed financial reads; project only bounded public account facts to model input.
- [ ] Replace Post Listing planning with checkpointed open/upload/wait/category/attributes/copy/price/readback steps. Prefer the stable page category, including IDs not in the local catalog.
- [ ] Preserve existing stable actions, pre-submit identity checks, reconciliation, manual control and publication outbox. Missing facts or changed forms pause without guessing.
- [ ] Run controlled fixture and workflow tests, including upload interruption, category changes, exact 106, unknown result and failed observation persistence.

### Task 5: Integration, Packaging and Documentation

- [ ] Connect explicit account inspection and preparation status to compact existing UI; preserve account/window bindings and product publication history.
- [ ] Package taxonomy resources in the final encrypted plugin. Add final-package offline taxonomy verification to CI.
- [ ] Update business/module documents from proposed to actual behavior; distinguish tested fixtures from unverified live Vinted/CORS behavior.
- [ ] Run direct full Vitest, ESLint, Prettier, all no-emit TypeScript targets and rustfmt. Record concrete failures and fix them.
- [ ] Perform independent task and whole-change review, resolve findings, then update the quality record.

### Task 6: Application and Plugin Release

- [ ] Confirm latest remote releases; select unused application and affected plugin versions.
- [ ] Update application/package/manifests/minimum-version metadata consistently; preserve the root lockfile.
- [ ] Commit the reviewed implementation excluding user raw data, push the branch and immutable release tag, and trigger application plus plugin workflows.
- [ ] Inspect CI and fix build failures using source edits and allowed checks. Never run local builds.
- [ ] Confirm public release assets, update metadata and R2 plugin catalog publication, then report actual versions and any remaining live-integration limitations.
