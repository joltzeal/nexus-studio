# Universal Plugin Licensing Implementation Plan

> **For agentic workers:** Execute inline, task-by-task, using TDD and the linked design.

**Goal:** Require an independent activation for every first-party market plugin and make activation understandable in a modern tabbed plugin center.

**Architecture:** Keep enforcement in the Rust host and use per-plugin Ed25519 keys and leases in SQLite. Worker SKU rows map one-time cards to plugin IDs and durations; the React center obtains a status map and activates the explicitly selected plugin.

**Tech Stack:** Rust/Tauri, SQLite, Cloudflare Workers/D1, React, shadcn Tabs, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-universal-plugin-licensing-design.md`

## Global Constraints

- Scope licensing to the 11 first-party IDs in the market catalog; third-party plugins remain unaffected.
- Preserve `sim8-*` and `sales-agent-*` SKUs; seed month/quarter/year plans for the other nine plugins.
- Never put admin or signing secrets into Git or the desktop client.
- Put the operator guide at `~/.config/raccoon/license-worker/ISSUE-CARDS.md`, outside Git.
- Do not build a DMG, publish a desktop release, or upload plugin packages.

## Review Focus

- A lease for one plugin must not authorize a different plugin; test altered and cross-plugin leases.
- A market-listed plugin must fail closed at every host operation if unlicensed; test install, start, RPC, Agent caller/generation, and supervision.
- Third-party plugin IDs must not be accidentally placed behind the first-party paywall; test an unlisted fixture plugin.
- Old SIM8 and Sales Agent cards must remain redeemable after migration; test existing SKUs alongside new SKUs.
- Proxy failures must preserve actionable activation errors without leaking card or proxy secrets; test DNS-through-SOCKS path and generic denied response.

## Files and Interfaces

- `apps/license-worker/migrations/0001_init.sql`: append product SKU seeds for nine plugin IDs.
- `apps/license-worker/scripts/issue-cards.mjs`: accept `<plugin-key>-(month|quarter|year)` for all 11 keys.
- `apps/license-worker/test/worker.test.ts`: add per-plugin card binding and legacy SKU coverage.
- `apps/desktop/src-tauri/src/core/plugin_host/license.rs`: `status(plugin_id)`, `status_all(plugin_ids)`, `activate(plugin_id, card)`, `require(plugin_id)` with one SQLite row per plugin.
- `apps/desktop/src-tauri/src/core/plugin_host/mod.rs`: known-ID constant; `PluginHost::license_statuses()` and `activate_license(plugin_id, card)`; one `require_license(id)` gate used by all operations and display states.
- `apps/desktop/src-tauri/src/core/plugin_service.rs`, `src/lib.rs`, `native-plugins.ts`: Tauri commands and typed map API.
- `plugins-page.tsx` and `App.css`: tabbed installed/store views, overview counts, per-plugin status/action and shared targeted activation dialog.
- `docs/06-plugin-system.md`, `docs/17-plugin-host.md`, `docs/53-plugin-card-licensing.md`, `docs/09-quality-and-testing.md`: current behavior and real verification.
- `~/.config/raccoon/license-worker/ISSUE-CARDS.md`: private mode-0600 operator guide, excluded from Git by location.

## Tasks

### Task 1: Worker SKUs and issuer

- [x] Add tests proving each of the 11 plugin-key SKUs issues cards redeemable only by that plugin, including prior `sim8-*` and `sales-agent-*` SKUs.
- [x] Run focused Worker tests; 12 tests and TypeScript noEmit pass.
- [x] Seed 27 missing product rows; generalize the issuer to validate plugin SKU slugs and update usage text without storing secrets.
- [x] Apply migration remotely, deploy Worker, and verify health plus all 33 enabled SKUs. No card was issued.

### Task 2: Generic host entitlement

- [x] Add plugin-scoped lease verification and a regression test that rejects altered/cross-plugin leases; preserve unlisted plugin behavior by only gating fixed first-party IDs.
- [x] Generalize `PluginLicenseStore` methods to take plugin ID and keep unique keys/leases per ID; bind signature checks to the requested ID.
- [x] Replace SIM8-only gates with `FIRST_PARTY_PLUGIN_IDS`; expose per-plugin status map and targeted activation command.
- [x] Review Agent gateway, supervisor, source/package/market installation paths. Rust tests/Clippy were not run under repository constraints; `cargo fmt --check` passes.

### Task 3: Plugin center UX

- [x] Add tests for first-party ID detection, third-party exclusion, and usable entitlement state.
- [x] Use `Record<string, PluginLicenseStatus>` and scope activation calls to the selected `pluginId`.
- [x] Restructure installed/store content under `Tabs`; add compact summary counts and a shared dialog scoped to the chosen plugin.
- [x] Disable install/update/reinstall for unlicensed first-party entries; keep uninstall and activation available; update-all skips and reports unlicensed entries.
- [x] Run focused Vitest, desktop noEmit, ESLint and Prettier. Rendered UI QA was not run; only Vite on port 1420 was found active.

### Task 4: Documentation and local verification

- [x] Update public architecture, host, licensing and quality docs to distinguish deployed state, local tests and remaining payment/device-replacement limits.
- [x] Write `ISSUE-CARDS.md` outside the repo with mode `0600`; verify its path is outside the Git worktree.
- [x] Run Worker tests/typecheck, targeted desktop tests/typecheck/lint/format, Rust formatting and `git diff --check`. Rust compilation/tests/Clippy were not run.
- [x] Keep existing local Vite server on port 1420; no Tauri app port was found. No DMG created.
