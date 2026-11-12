# Email Plugin Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox syntax for tracking. No commits or releases are authorized by this task.

**Goal:** Add a usable Microsoft mailbox plugin with batch import, mail reading and durable background token refresh.

**Architecture:** Register provider factories which produce a token refresher and a mailbox client. A provider-independent service owns validated private storage, refresh scheduling and RPC; a bundled compact React adapter calls that service.

**Tech Stack:** Strict TypeScript, Zod, Node fetch, ImapFlow, MailParser, existing plugin SDK, React and shadcn.

**Spec:** `docs/41-email-plugin.md`

## Global Constraints

- All shell commands start with `rtk`.
- No local builds, packaging or Rust compilation/test/Clippy.
- Credentials remain plaintext in the plugin's private store; no Keychain, SQLite from Node, logging or localStorage.
- Preserve existing changes; no legacy readers or fake providers.
- HTTP and IMAP inherit application proxy settings and fail closed.

## Review Focus

- Reimporting a mailbox must not overwrite a token rotated since the original import.
- A refresh response arriving after credentials changed must not overwrite the edited account.
- A disk failure after remote rotation must not trigger another rotation using stale credentials.
- IMAP IDs must include UIDVALIDITY; a stale ID cannot retrieve another message.
- Closing/reopening a reader or changing pages must not display a late response from another mailbox.

### Task 1: Provider contracts and Microsoft implementation

**Files:** `plugins/email/src/domain/types.ts`, `providers/*`, provider tests.

**Interfaces:** `EmailProviderFactory.create(transport)` returns `{ tokens: TokenRefresher, mailbox: MailboxClient }`. Both use bounded DTOs and cancellation signals; no persistence in providers.

- [x] Write and run failing tests for token rotation/no rotation, OAuth failures, bounded Graph messages, validated pagination and UIDVALIDITY.
- [x] Implement factory registration and Microsoft Graph/OAuth IMAP with inherited proxy.
- [x] Run provider tests and no-emit type checking.

### Task 2: Durable service, scheduler and plugin process

**Files:** `plugins/email/{package.json,nexus.plugin.ts,tsconfig.json,scripts/*}`, `src/{store,services,rpc,capabilities}/*`, `src/index.ts`.

**Interfaces:** Service exposes `email.accounts.list/save/import/remove`, `email.refresh.queue`, `email.messages.list/get`, `email.settings.get/save` and configuration transfer. List DTOs never contain credentials.

- [x] Write and run failing tests for atomic writes, parsing, duplicate imports, scheduling/restarts, single flight, queued writes, retry and stale-result guards.
- [x] Implement serialized storage and refresh coordination, including retrying pending persistence before another network refresh.
- [x] Add RPC handshake/cancellation/shutdown tests and wire the manifest/process.
- [x] Run plugin tests directly through Vitest.

### Task 3: Host capability and desktop page

**Files:** SDK exports, Rust manifest enum, desktop `features/email/*`, plugin registry, desktop/workspace dependency declarations.

**Interfaces:** `email.provider` capability; page consumes validated mailbox summaries, batch reports and bounded message pages.

- [x] Add capability parsing/manifest tests, frontend DTO and stale-response tests; observe failures.
- [x] Register capability and bundled page; implement compact import, CRUD, filter/pagination, refresh settings and mail reader.
- [x] Update lockfile with pinned dependencies using CLI without builds.
- [x] Run frontend tests, lint and no-emit TypeScript checks.

### Task 4: Verification and documentation

**Files:** `docs/{README,06-plugin-system,09-quality-and-testing,14-plugin-integration-guide,17-plugin-host,37-configuration-transfer,41-email-plugin}.md`.

- [x] Run the direct Vitest suite and changed-file formatting/lint/no-emit checks; rustfmt only, no Rust compilation/tests.
- [x] Inspect the actual rendered page with controlled plugin responses, including narrow width and failure handling.
- [x] Review storage/network/token concurrency, document outcomes and remaining real-account/platform gaps.
- [x] Report code and usage; leave changes uncommitted and unpublished.

## Recorded validation

- Direct full Vitest: 223 passed files, 2 skipped; 3419 passed tests, 9 skipped.
- Plugin, desktop and test TypeScript checks used no-emit temporary source aliases; no local build.
- Full ESLint, changed-file Prettier and Rust formatting checks passed.
- Controlled Playwright: 12 interaction groups at 1440×900 and 390×844, no app console errors/warnings or page overflow.
- Independent review findings were fixed with regressions: terminal OAuth permission handling, ImapFlow server response fields and safe structured errors through the Tauri/UI bridge. Bounded re-review found no remaining blocker.
- Real Microsoft accounts/proxies, Rust execution, native WebView, Windows and packaged distribution were not tested. Evidence and scope are recorded in `docs/09-quality-and-testing.md`.
