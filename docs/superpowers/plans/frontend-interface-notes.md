# Task 5 frontend integration notes

The frontend now consumes the Shared Interfaces from the November 10 plan.
There are no `NativeProfile` aliases or `profile_*` command fallbacks.
Rust and browser-runtime files are outside this task's ownership.

## Command return values consumed by the frontend

- `browser_window_list({ connectionId? })`: strict `BrowserWindow[]`. Omitting
  `connectionId` must return all connections, including disabled historical
  connections, for global SIM8, phone, account, group and proxy associations.
- `browser_window_create({ input })`: strict `BrowserWindow`.
- `browser_window_update`, `browser_window_delete`, `browser_window_start` and
  `browser_window_stop`: completion acknowledgement; UI refreshes actual state.
- Update input intentionally excludes `kernelVersion`: an existing kernel and
  provider binding are immutable. Only create input includes `kernelVersion`.
  The strict update schema rejects it rather than passing compatibility fields
  to Rust. This follows the parent integration clarification.
- `browser_window_update_note({ id, note })`: the exact persisted note string.
- `browser_connection_list`: strict `BrowserConnection[]`, including historical
  connections.
- `browser_connection_save`, `browser_connection_confirm` and
  `browser_connection_activate`: the complete saved `BrowserConnection`.
- `browser_connection_probe`: `{ connected, message, scopeId, capabilities }`.
- `browser_profile_discover`: `RemoteProfile[]`; the backend completes pagination.
- `browser_group_list`: `ProviderGroup[]`; only official groups populate the
  connection's default-group selector.
- `browser_window_attach`: `BrowserWindow[]`, including existing associations.
- `browser_operation_list`: operations with `id`, `windowId`, `connectionId`,
  `kind`, `phase`, nullable `message`, `createdAt` and `updatedAt`.
- `browser_operation_reconcile`: `BrowserWindow | null`. Null is a successfully
  completed delete/unlink; recovery refreshes the global window and operation
  lists without a false uncertainty error. Pending results throw the structured
  `operation_uncertain` error. Creation retry still checks its persisted
  operation before resubmitting; null alone cannot confirm creation.

All browser command failures are consumed as `{ code, message, retryable }`.
No frontend account/phone unbind command is added to deletion; backend lifecycle
cleanup owns those associations.

## Capability and recovery behavior

AdsPower's `update=false` makes provider-owned configuration read-only while
Nexus metadata (platform, note, Nexus group) remains editable. The update command
must accept unchanged remote fields for such a metadata edit without invoking
an unsafe remote update. Metadata editing also remains available while running
or offline; remote controls are read-only unless the state is confirmed stopped.
`proxyPlugin=false` hides that creation choice; stored values remain visible and
unchanged during read-only metadata editing.

Batch rows retain an operation UUID and the exact first submitted payload.
After a lost response, the UI asks to reconcile that UUID once. A manual retry
sends the identical UUID and frozen payload to the idempotent create command;
the backend alone decides whether it can submit or must reconcile. The UI does
not infer safety from absence in the pending-operation list (which intentionally
excludes failed and committed operations). Account binding failures retry only binding.

The API list is always global. The table derives its display from the active
connection; monotonic request/revision guards prevent stale reads overwriting
local notes or newer snapshots. Provider and connection changes clear selection
and scoped dialogs. Superseded status reads follow the latest accepted read so
they cannot falsely confirm startup; connection revision changes invalidate
pending proxy checks. Sorting uses `createdAt DESC, sortOrder DESC, id DESC`,
matching the SQL total order. External full snapshot export/import/sync is
rejected before any transfer command, with affected selected window names and
an explanation even before selecting windows.

## Source resolution without builds

The contracts package exports `@nexus/contracts/browser` from `src/browser.ts`
and also re-exports the DTOs from its root source index. Frontend tools use the
public browser subpath, so new DTO checks do not depend on regenerating `dist`.
No builds or generated-dist edits are required for this task.

Verification evidence is reported in the task's final response; the shared
quality matrix remains owned by the main integration task.

## Files changed by Task 5

The SIM8 expiry, phone, account editing and SMS behavior already present in
`spaces-page.tsx` is retained. SIM8 edits listed here migrate its shared window
type and complete test fixtures.

- `apps/desktop/src/App.css`
- `apps/desktop/src/features/accounts/accounts-page.test.ts`
- `apps/desktop/src/features/accounts/accounts-page.tsx`
- `apps/desktop/src/features/groups/groups-page.tsx`
- `apps/desktop/src/features/proxy/proxy-picker.tsx`
- `apps/desktop/src/features/proxy/proxy-usage.test.ts`
- `apps/desktop/src/features/proxy/proxy-usage.ts`
- `apps/desktop/src/features/settings/browser-connections-page.test.ts`
- `apps/desktop/src/features/settings/browser-connections-page.tsx`
- `apps/desktop/src/features/settings/settings-page.tsx`
- `apps/desktop/src/features/sim8/expiry-associations.ts`
- `apps/desktop/src/features/sim8/expiry-notice.test.ts`
- `apps/desktop/src/features/spaces/attach-window-dialog.test.ts`
- `apps/desktop/src/features/spaces/attach-window-dialog.tsx`
- `apps/desktop/src/features/spaces/batch-window-dialog.test.ts`
- `apps/desktop/src/features/spaces/batch-window-dialog.tsx`
- `apps/desktop/src/features/spaces/browser-operation-recovery.test.ts`
- `apps/desktop/src/features/spaces/browser-operation-recovery.tsx`
- `apps/desktop/src/features/spaces/file-transfer-dialog.tsx`
- `apps/desktop/src/features/spaces/spaces-page.test.ts`
- `apps/desktop/src/features/spaces/spaces-page.tsx`
- `apps/desktop/src/features/spaces/transfer-state.test.ts`
- `apps/desktop/src/features/spaces/transfer-state.ts`
- `apps/desktop/src/features/spaces/transfer-toolbar.test.ts`
- `apps/desktop/src/features/spaces/transfer-toolbar.tsx`
- `apps/desktop/src/features/spaces/use-window-launch.ts`
- `apps/desktop/src/features/spaces/window-batch.test.ts`
- `apps/desktop/src/features/spaces/window-batch.ts`
- `apps/desktop/src/features/spaces/window-config.test.ts`
- `apps/desktop/src/features/spaces/window-config.ts`
- `apps/desktop/src/features/spaces/window-editor.test.ts`
- `apps/desktop/src/features/spaces/window-editor.tsx`
- `apps/desktop/src/features/spaces/window-launch.test.ts`
- `apps/desktop/src/features/spaces/window-launch.ts`
- `apps/desktop/src/features/spaces/window-note.test.ts`
- `apps/desktop/src/features/spaces/window-note.tsx`
- `apps/desktop/src/features/spaces/window-sync-dialog.tsx`
- `apps/desktop/src/lib/platform/app-updates.test.ts`
- `apps/desktop/src/lib/platform/browser-api.ts`
- `apps/desktop/src/lib/platform/browser-connections.test.ts`
- `apps/desktop/src/lib/platform/browser-connections.ts`
- `apps/desktop/src/lib/platform/browser-test-support.ts`
- `apps/desktop/src/lib/platform/native-profiles.test.ts` (deleted)
- `apps/desktop/src/lib/platform/native-profiles.ts` (deleted)
- `apps/desktop/src/lib/platform/native-transfer.test.ts`
- `apps/desktop/src/lib/platform/native-transfer.ts`
- `apps/desktop/src/lib/platform/windows.test.ts`
- `apps/desktop/src/lib/platform/windows.ts`
- `docs/superpowers/plans/frontend-interface-notes.md`
- `packages/contracts/package.json`
- `packages/contracts/src/browser.test.ts`
- `packages/contracts/src/browser.ts`
- `packages/contracts/src/index.ts`

## Direct verification

All checks use Node 24.18.0 from
`/Users/ameno/.nvm/versions/node/v24.18.0/bin`, pinned pnpm 11 and
`pnpm_config_verify_deps_before_run=false`. Every shell command starts with
`rtk`. No build, package, Rust or browser-runtime edit is part of Task 5.

- Focused Vitest: 21 files, 173 tests passed, including contracts, browser APIs,
  spaces, browser connection settings, proxy usage and SIM8 associations.
- Repository-wide `pnpm exec vitest run --maxWorkers 4`: 186 files passed,
  2 files skipped; 2,572 tests passed, 9 tests skipped.
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`: exit 0.
- `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json`: exit 0.
- `pnpm exec tsc --noEmit -p tsconfig.tests.json`: exit 0.
- `pnpm exec eslint apps/desktop/src packages/contracts/src --max-warnings 0`:
  exit 0.
- Direct Prettier `--check` across all 51 retained task files: exit 0.
- `git diff --check` for the frontend/contracts scope: exit 0.
- Frontend/contracts legacy scan: no `NativeProfile`, `native-profiles` or
  quoted `profile_*` command names.

No source-versus-dist blocker occurred: the public browser source subpath is
used without generating dist. Real AdsPower/BitBrowser API calls, a running
Tauri integration and Windows behavior were not exercised. Final review was
performed in this task without subagents, as requested.
