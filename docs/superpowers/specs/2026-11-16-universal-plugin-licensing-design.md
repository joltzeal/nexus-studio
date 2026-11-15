# Universal Plugin Licensing and Plugin Center

## Intent

Require a plugin-specific activation for every first-party market plugin, while making activation discoverable and manageable from a clearer plugin center. Provide an operator-only activation-code guide outside the Git worktree.

## Goals

- Apply host-side licensing checks to all 11 first-party plugin IDs in the market catalog: install, package install, start, restart, RPC calls, Agent gateway calls, and supervision.
- Store a separate device key and signed lease for each plugin; activation status and expiry are queried per plugin.
- Bind each one-time card to a plugin and month, quarter, or year SKU. Preserve existing SIM8 and Sales Agent SKU names.
- Let users activate from the corresponding installed or store plugin row; do not present a single SIM8-only entitlement control.
- Replace stacked installed/store tables with a compact tabbed plugin center, summary counts, clear per-plugin state and action hierarchy.
- Write the operator card-generation guide under `~/.config/raccoon/license-worker/`, outside Git, with restrictive file permissions.

## Non-goals and limits

- No payment callback, renewal stacking, device replacement, card-shop integration, or runtime package decryption-key protection.
- This is entitlement enforcement in the trusted desktop host, not tamper-proof DRM; locally stored device keys and authorized plugin code remain extractable by the local user.
- Do not alter third-party extension plugin behavior; scope the first pass to the 11 current first-party market IDs.

## Approaches

1. **Hard-code a single SIM8 lease and duplicate it for each plugin.** Rejected because leases can be accidentally shared and the UI/status model remains single-plugin.
2. **Generic per-plugin entitlement store and one host gate, with Worker SKU mapping.** Selected: minimal evolution of the current signed lease protocol, independent keys/leases per plugin, all entry points call one gate, and UI requests a status map.
3. **Delegate entitlement decisions to each plugin process.** Rejected because plugins can self-report success and be reached through alternate host paths.

## Design

The host maintains one `plugin_entitlements` row per plugin ID, each with an independent Ed25519 device key and signed lease. Generic APIs accept an explicit plugin ID: `status(plugin_id)`, `status_all(plugin_ids)`, `activate(plugin_id, card)`, and `require(plugin_id)`. Lease verification checks that the signed `pluginId` matches the requested plugin. Every first-party catalog item is gated by the same host method before installation, startup, restart, generic RPC, Agent gateway use, and scheduled supervision. Unlicensed installed plugins remain visible for activation/uninstall but their process is stopped and plugin page is not mounted as runnable.

Worker D1 adds month/quarter/year products for the remaining nine market plugin IDs. Existing `sim8-*` and `sales-agent-*` SKUs remain valid. The admin card issuer validates SKU syntax and lets Worker D1 remain the source of truth for whether a SKU exists and is enabled. D1 stores only card HMACs. No secret key or admin token enters UI, SQLite entitlement payload, docs in Git, or console output.

The plugin center uses two top-level tabs, `已安装` and `插件商店`, rather than stacked tables. A compact overview shows installed/running, needing activation, and updates counts. Each plugin row/card displays name, ID, version, capability summary, running/activation state, and only relevant actions. Activating a plugin opens one shared dialog whose selected plugin ID is explicit; the dialog shows that plugin's name, device code, expiry/state and accepts its card. Store install/update is disabled until that plugin's entitlement is active. Existing update-all remains but skips unlicensed plugins and explains the count.

The operator guide is written to `~/.config/raccoon/license-worker/ISSUE-CARDS.md` with mode `0600`; it documents supported plugin IDs/SKUs, exact command examples, proxy use, output-file permissions, one-time card handling, and safe error recovery. It is intentionally outside the repository and untracked.

## Verification

- Unit tests prove known first-party plugin IDs are individually required and unrelated fixture IDs are not accidentally included.
- Rust tests prove a card lease for one plugin cannot authorize another, and all host operation paths reject an unlicensed known plugin.
- Worker tests prove each newly seeded SKU creates a card that redeems only for its bound plugin; prior SIM8/Sales Agent cards still redeem.
- UI tests prove per-plugin status lookup, activation target selection, activation-required install disabled state, and tab navigation.
- Run targeted Vitest, desktop typecheck/lint/format, Worker tests/typecheck, Rust focused tests/Clippy as allowed; run the local desktop development app for interaction QA. Do not create a DMG or publish unless separately requested.
