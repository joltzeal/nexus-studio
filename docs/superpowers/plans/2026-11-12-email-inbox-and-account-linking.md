# Email Inbox and Account Linking Implementation Plan

> **For agentic workers:** Use subagent-driven development with disjoint write scopes. Do not commit or publish; the current request authorizes implementation and verification.

**Goal:** Improve mail reading and lists, synchronize read state with the mailbox, add scheduled reception, and link mailboxes to Vinted accounts.

**Architecture:** Keep Microsoft traffic and durable state in the email plugin, Vinted account relationships in the accounts plugin, and cross-plugin composition in the desktop app. Token refresh and mail reception have independent schedules. A successful read-state write reflects a provider result rather than an optimistic local-only flag.

**Tech Stack:** Existing strict TypeScript, Node plugin processes, React, compact shadcn components, Graph, OAuth IMAP and private JSON stores.

**Spec:** `docs/41-email-plugin.md` plus the current user's inbox, read-state, scheduled reception and account-pool integration request. This plan records the additive contracts.

## Constraints and Decisions

- All shell commands start with `rtk`; use fixed Node 24.18.0 and pnpm 11.17.0.
- No local build, packaging, Rust compilation/test/Clippy, real Microsoft requests or credentials.
- Keep existing user edits. No SQLite or Keychain access from plugins.
- No commit, push, tag or R2 change in this task.
- Keep raw provider errors and credentials out of DTOs, notifications and logs.
- Existing email folders remain `inbox` and `junkemail`; do not add sending or remote deletion.
- Preserve all existing account data, contact links, window bindings, addresses and order settings.
- Ruling: proceed with the authorized changes using the existing architecture and documented defaults; no additional design approval is needed.
- Ruling: automatic reception defaults to every minute, configurable from 1 to 60 minutes, while the existing token refresh interval remains 5 to 1440 minutes.
- Ruling: relationships require an explicit choice. Matching email addresses can be suggested, but must not silently replace an account's login address or binding.
- Ruling: rich HTML mail is sanitized, bounded, and rendered in an iframe without scripts, remote resources, forms or navigation. Plain text remains available.

## Shared Contracts

### Email plugin and desktop

- `EmailSettings` adds required `autoReceive: boolean` and `receiveIntervalMinutes: number` (1–60). Normalize missing newly added persisted fields once at the store boundary.
- `MailboxView` adds `receiving: boolean` and `reception: MailReceptionState`.
- `MailReceptionState` contains `lastCheckedAt`, `nextCheckAt`, `latestReceivedAt`, `lastError`, `lastErrorCode`, and nullable `inbox` / `junkemail` counts. Each count is `{ total: number, unread: number }`; timestamps are ISO strings or null.
- `MessageQuery` / provider list input adds `readState?: 'all' | 'unread' | 'read'`. Default is `all`; cursors are bound to the filter as well as mailbox and folder.
- `MailMessagePage` is `{ items, nextCursor, total, unread }`. Counts describe the folder; items respect the requested filter.
- `MailMessageDetail` adds `html: string | null`, capped at 128 KiB. Existing plain text stays capped at 64 KiB. `truncated` reports either content truncation.
- `email.accounts.get { id }` returns a single credential-free `MailboxView`.
- `email.accounts.targets { query?, page?, pageSize? }` returns `{ items: { id, email, enabled, status }[], total, page, pageSize, storageDurable }`, maximum page size 50.
- `email.receive.queue { ids }` accepts 1–100 distinct mailbox UUIDs and returns `{ queued, skipped }`; manual reception works with automatic reception disabled.
- `email.messages.read { accountId, folder, messageIds, isRead }` accepts 1–20 distinct IDs and returns `{ updatedIds, failures: { messageId, code }[], isRead }`. Updated and failed IDs partition the input. Failure codes use existing plugin codes; no raw messages.
- Message list/get/read inputs accept optional `expectedEmail`. Readers supply the mailbox email snapshot; the service checks its normalized address before and after network operations, so a mailbox renamed under the same UUID cannot silently redirect an account relationship.
- `MailboxClient.setRead(session, { folder, messageId, isRead }, signal): Promise<void>` performs one provider write. Graph uses Mail.ReadWrite; write permission failure must not disable read-only reception.
- Provider `list` returns accurate folder counts. Background reception lists the first page of both folders without marking messages read, then atomically persists counts and timing.
- Reception is bounded to two simultaneous accounts, single-flight per account, cancellable at shutdown and guarded by credential revision. Persist manual intent, failure backoff and next check. Permanent authorization failures stop repeated receiving until credentials change; transient failures preserve last successful counts.
- Mailbox removal, pause, transport/credential changes and plugin shutdown invalidate stale reception jobs.

### Account relationship

- Persist `mailbox?: AssignedAccountMailbox | null` on account records.
- `AssignedAccountMailbox` is `{ pluginId: 'studio.email', mailboxId: string, email: string, linkedAt: string }`.
- `vinted.accounts.mailbox.targets { query?, page?, pageSize? }` returns credential-free `{ id, account, status, mailbox }` targets with pagination and `storageDurable`.
- `vinted.accounts.mailbox.set { accountId, mailbox: { pluginId, mailboxId, email } | null, expectedMailboxId: string | null }` compares and updates only this relation and `updatedAt` in one durable mutation, returning `{ mailbox, updatedAt, storageDurable }`.
- Deletion or changed mailbox address is shown as unavailable and requires relinking; never fall back to another mailbox with a similar address.
- Relationships remain in the accounts plugin; no plugin opens another plugin's private files. Transfer/import clears device-local mailbox IDs rather than importing a link to an unrelated mailbox on the destination.

## Review Focus

- Graph read-only tokens must still read mail after a read-state write fails with permission denied.
- Scheduled jobs or old UI requests cannot reapply results after credentials, account, folder, filter or plugin process changes.
- Read-state partial failures update only confirmed successes and preserve the remaining selection.
- Mailbox and account mutations preserve unrelated credentials and business relationships, including concurrent contact edits.
- HTML emails cannot run scripts, load remote trackers or escape their reading frame.

## Tasks

### Task 1: Email provider, reception and persistence

**Write scope:** `plugins/email/**` except package dependency declarations owned by the coordinator.

**Interfaces:** Implement the shared email contracts. Preserve public factory extension boundaries and strict RPC validation.

- [x] Add failing provider tests for Graph and IMAP read-state filters, stable filtered cursors, accurate counts and confirmed read/unread writes.
- [x] Add failing service tests for automatic/manual reception, restart, shutdown, single-flight, two-account concurrency, backoff, disk failures and stale revision rejection.
- [x] Add failing tests for HTML sanitization, response size, target projection and read-state partial failures.
- [x] Implement provider changes, bounded HTML presentation and the independent reception coordinator.
- [x] Verify all email plugin tests directly and report exact commands and results.

### Task 2: Durable account-mailbox relationship

**Write scope:** `plugins/vinted-accounts/src/**`, `apps/desktop/src/features/accounts/types.ts`, and dedicated new `account-mailbox-api.ts` / test files. Do not edit accounts-page or the general accounts API.

**Interfaces:** Implement account relationship contracts. Export frontend `listAccountMailboxTargets` and `assignAccountMailbox`, with strict response validation.

- [x] Add failing tests for assign/replace/unlink, stale expected ID, missing/deleted accounts, disk failure and no credentials in target results.
- [x] Test ordinary account saves, imports, contacts, pagination, transfer and order updates preserve or deliberately clear the relation as specified.
- [x] Implement the stored relation and dedicated RPCs without broad record replacement.
- [x] Verify accounts plugin tests and dedicated frontend adapter tests directly.

### Task 3: Mail list and reader

**Write scope:** existing files under `apps/desktop/src/features/email/**`; exclude coordinator-owned new `accounts-bridge*`, `link-account-dialog*`, and `account-mailbox-popover*` files.

**Interfaces:** Consume shared email DTOs; export `MailReader` with existing `account/onClose` props and optional `onChanged?: () => void`. Coordinator supplies `EmailAccountLink` row component in `accounts-bridge.tsx` with `{ mailbox: MailboxView, disabled?: boolean }`.

- [x] Add failing tests for status filtering, explicit unread indicators, single/current-page selection, confirmed read/unread operations and partial failures.
- [x] Improve responsive master/detail layout, readable sender/recipient/date headers, formatted HTML/plain text tabs, copy actions and empty/error/loading states.
- [x] Mark an unread message read only after successful detail load; show permission failure without hiding the readable message or pretending it was marked read.
- [x] Add background list refresh without losing selection or detail; isolate requests by account/folder/filter/page/process.
- [x] Add reception settings and row counts/timing, with separate token and reception labels and manual actions.
- [x] Integrate the coordinator's account-link row component and verify direct frontend tests.

### Task 4: Account pool integration, documentation and verification

**Write scope:** coordinator-owned new email bridge/dialog files, accounts-page and general account API validation, workflow assertions, module documentation and quality record.

- [x] Add failing tests for credential-free pickers, optimistic relation checks, matching suggestions, process invalidation, missing plugins and unavailable/deleted mailboxes.
- [x] Add link/unlink and reader entry points to both email and account-pool pages. Validate a bound mailbox by ID and expected email before opening.
- [x] Update account record validation and release handshake expectations for new methods.
- [x] Run direct full Vitest, three source-aliased no-emit TS checks, ESLint, changed-file Prettier and diff checks.
- [x] Perform isolated desktop/narrow-screen browser QA with mock mailbox responses, including HTML network isolation and read-state failure recovery.
- [x] Record actual results and limitations in `docs/09-quality-and-testing.md`; update email, account and configuration documents.
- [x] Obtain an independent review and fix verified findings before reporting completion.
