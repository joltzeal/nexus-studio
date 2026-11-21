# Raccoon 0.2 Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 0.1 browser-centric runtime and webpage-like shell with a Provider-based desktop workbench, with 0.1 data migration handled later by a separate offline tool.

**Architecture:** The 0.2 runtime owns a new data directory and database format. Rust coordinates windows and delegates execution to registered providers; browser-specific runtime and license code lives inside providers. React presents a shared workbench shell and capability-driven windows, with experimental browser maintenance isolated in the lab.

**Tech Stack:** Tauri 2, Rust, SQLite, React, TypeScript, shadcn, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-17-raccoon-02-provider-architecture-design.md`, `docs/superpowers/specs/2026-11-17-raccoon-02-native-interface-design.md`.

## Global Constraints

- 0.2 does not read 0.1 data at runtime; preserve old files untouched for a future explicit offline migration.
- AdsPower and BitBrowser lead the UI; CloakBrowser and managed AliasMode Chromium are enabled and maintained only in the lab.
- Every provider is a space (AdsPower and BitBrowser each have one); groups are separate per providerId. Actual window bindings remain scoped by connectionId. No standalone workspace name field.
- Browser bindings cannot change after creation; failed required proxies never fall back to direct.
- Keep plugins private and the Node plugin host independent from any browser SDK.
- Do not run application builds, Rust compile/test/Clippy locally. Use rustfmt, direct Vitest, lint and artifact-free TypeScript checks when applicable.
- Do not commit or publish without a separate user request.

## Review Focus

- Existing 0.1 data beside a fresh 0.2 install must remain untouched and unseen by the running 0.2 app.
- Missing or broken experimental runtime must not prevent external provider connections or the plugin host from starting.
- A provider timeout must preserve intent and existing account bindings until observation reconciles it.
- No proxy fallback or stale browser version can be introduced by the rewrite.
- 100+ windows, long names and many enabled plugins must remain usable at the minimum window size.

---

### Task 1: Workspace boundary and fresh database

**Files:** `apps/desktop/src-tauri/src/core/plugin_service.rs`, `database.rs`, `transfer_service.rs`, `runtime_paths.rs` and focused Rust tests.

**Interfaces:** 0.2 data root and database path from one source of truth, no schema upgrade on normal open.

- [ ] Define the versioned workspace root for the native initialization path.
- [ ] Create schema in one transaction for a new database; reject unknown versions instead of upgrading.
- [ ] Update transfer recovery and ancillary service paths to the same root and filename.
- [ ] Add regression checks for 0.1 data left alone and new database initialization; rustfmt touched files.

### Task 2: Provider contract and dispatcher

**Files:** `core/browser/provider.rs`, `registry.rs`, `connection_store.rs`, `window_service.rs`, `window_store.rs`, `group_store.rs`, `packages/contracts/src/browser.ts`.

**Interfaces:** `ProviderRegistry.get(providerId)` for all calls; provider-declared capabilities and connection kind.

- [ ] Remove default CloakBrowser connection and old AliasMode Local API registration.
- [ ] Scope group records and assignments by providerId; reject cross-space membership and preserve bindings on disconnect.
- [ ] Replace name-based managed/runtime checks with provider capabilities and a managed connection kind.
- [ ] Keep durable intent, immutable bindings, scoped IDs, explicit unknown observations and proxy failure rules.
- [ ] Cover capability and reconciliation behavior with focused tests; rustfmt and direct contract tests.

### Task 3: Experimental runtimes

**Files:** `core/browser/providers/`, `core/kernel_service.rs`, `core/license_service.rs`, `packages/browser-runtime/`.

**Interfaces:** per-provider install inventory, explicit download and launch, version-pinned profile.

- [ ] Keep CloakBrowser SDK and license under its provider, remove dependency from generic boot paths.
- [ ] Add independent AliasMode Chromium downloader, verified installation, launch and observation.
- [ ] Test corrupt archives, unavailable versions, startup failures, profile locks and proxy failures.
- [ ] Do not claim cross-device profile transfers for an unverified provider.

### Task 4: Native workbench shell

**Files:** `apps/desktop/src/components/app-shell.tsx`, `apps/desktop/src/App.css` (split into focused styles), `features/settings/`, `features/spaces/`.

**Interfaces:** shared layout and scroll ownership; available provider choices and explicit lab configuration.

- [ ] Rebuild sidebar, title area and scroll containers around the screenshot's list-panel hierarchy.
- [ ] Switch space by providerId in the sidebar, remove manual workspace naming and duplicate provider tabs.
- [ ] Rebuild windows list toolbar, filtered rows, overflow and bottom pager without losing existing actions.
- [ ] Rebuild settings into category navigation; put experimental kernel/download/license settings in lab.
- [ ] Keep enabled-plugin navigation dynamic and retained navigation state.
- [ ] Verify keyboard, empty, error, busy and long-list states with direct frontend tests.

### Task 5: Cutover and release validation

**Files:** `core/agent/`, `packages/plugin-sdk/`, `packages/contracts/`, docs and CI configuration as required.

**Interfaces:** 0.2-only public contract; agent provider support is capability-driven.

- [ ] Remove old runtime DTO aliases, upgrades, legacy browser ID and legacy agent allowlists.
- [ ] Upgrade plugin contracts explicitly and reject unsupported versions; maintain stable Raccoon UUID relationships.
- [ ] Check resulting source for leftover compatibility branches and update actual-state docs.
- [ ] Use CI and real macOS/Windows installation for release gates; no local build.

### Task 6: Separate offline migration (after 0.2 contract stabilizes)

**Files:** new standalone migration script/package and its tests.

**Interfaces:** explicit source/target paths, preview and report, staged atomic commit, source read-only.

- [ ] Inventory 0.1 SQLite, profile directories, plugin data, settings and unportable records.
- [ ] Backup and preview ID remapping, conflicts, skipped files and references before write.
- [ ] Stage a 0.2 workspace, validate, then commit atomically; repeated runs do not duplicate remote environments.
- [ ] Test interruption, rollback, connection scope and unsupported AliasMode Local API records.
