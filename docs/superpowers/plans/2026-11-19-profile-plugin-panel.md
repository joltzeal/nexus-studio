# Profile Plugin Panel Implementation Plan

> Agent execution follows the writing-plans and test-driven-development skills in the current session.

**Goal** Implement a plugin-declared Profile table icon opening plugin-owned content in the shared Peek panel.

**Architecture** Optional manifest UI declarations flow through the Rust catalog. A scoped native gateway dispatches generic view messages to the owning plugin. A generic ShardX renderer displays plugin-defined content and actions.

**Tech Stack** Strict TypeScript, Zod, React, Zustand, ShardX UI Kit, Rust and existing plugin JSON RPC.

**Spec** `docs/superpowers/specs/2026-11-19-profile-plugin-panel-design.md`.

## Global constraints

- Preserve the existing working tree and v1 data.
- Keep Vinted fields, labels, actions and rules in the plugin directory.
- Use Raccoon Profile UUID and connectionId for scope.
- Use existing 420px / 360px Peek geometry and one panel slot.
- Execute direct tests and noEmit checks locally. Rust compilation and application builds remain for CI.
- Keep plugin sources local and make no commits or publications.

## Review focus

- A→B→A Workspace switches and late plugin responses.
- Missing declarations, plugin restart/update/removal and unsupported UI versions.
- Concurrent account modification or relation replacement during confirmation.
- Creation persistence failure and duplicated submissions.
- Plugin UI data, external URLs and credentials crossing the generic boundary.

## Task 1 — Public UI and manifest contracts

- [x] Verify SDK manifest rejection before implementation and validate the UI boundary.
- [x] Implement generic schema, public exports and Rust declaration validation.
- [x] Add optional catalog UI metadata and manifest installation identity.
- [x] Verify SDK tests and noEmit types.

## Task 2 — Vinted plugin views

- [x] Write and run failing AccountPool dispatch tests, and verify the existing storage suite.
- [x] Implement view open/dispatch/close, account forms, confirmation and wardrobe views in the plugin.
- [x] Implement transaction-scoped revision checks and atomic creation/binding.
- [x] Declare the supplied Vinted icon in the plugin manifest.
- [x] Verify plugin behavior tests and noEmit types.

## Task 3 — Native sessions and generic frontend

- [x] Implement bounded native sessions with validated Profile connection and plugin installation identity.
- [x] Add generic frontend request/session tests for stale responses and invalid payloads.
- [x] Implement plugin column, generic renderer and shared panel selection.
- [x] Verify focused node tests, lint and noEmit types.

## Task 4 — Integration verification and documentation

- [x] Exercise controlled IPC with the real plugin and frontend where supported.
- [x] Run rustfmt without Rust compilation, targeted suites and independent source review.
- [x] Update module docs and record exact verification boundaries.

## Progress

Plan created before production edits. User authorized the first implementation in this conversation.

Implemented inline in the existing feature branch to preserve the current uncommitted source foundation.
The independent review findings were fixed and regression-tested. The newest user clarification removes
the no-plugin explanatory hint and hides the column/menu option until an installed plugin declares it.
Exact verification results and native build boundaries are recorded in `docs/09-quality-and-testing.md`.

## Follow-up — Profile Peek entry and Vinted layout

- [x] Reuse the declared plugin icon buttons in the Profile Peek header.
- [x] Add a guarded return from the plugin Peek to Profile details.
- [x] Support generic section header actions and a fixed view-action footer.
- [x] Group the plugin-owned account form and place detail actions by section.
- [x] Verify both entry points, unsaved changes, responsive layout and module checks.
