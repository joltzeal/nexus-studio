# ecom agent completion

Spec: `docs/superpowers/specs/2026-11-13-sales-agent-completion-design.md`.
User approved all missing capabilities, improvements and enhancements on 2026-11-13.
Preserve the shared branch. No commits, releases, builds or Rust compilation/tests.

## Work and ownership

1. Main: extend public SDK contracts and settings, define exact native/host payloads.
   Prove bounds, relation validation, draft limits and control restrictions with direct Vitest.
2. Platform worker: sales-plugin platform discovery, durable safe retry, controls consumption,
   item progress, model permits/usage and real capability tests. Own plugin source except settings
   storage and notification sender assigned to main; communicate any interface changes.
3. Native worker: `core/agent/**`, necessary WindowService/provider integrations and command
   registration. Add durable scheduling/cooldowns/model slots, controls, preflight, item projections,
   workspace storage, usage, notifications outbox and protected retention. Write Rust regression
   source and execute production-SQL fixtures; never compile or claim Rust tests passed.
4. UI worker: sales-agent feature and required semantic CSS. Integrate all actual commands,
   compact progress/error actions, preflight, drafts/templates, review workbench, per-job/item
   controls, usage/notification settings and deep-link navigation. Test stale/lost replies.
5. Main: plugin settings persistence, Bark sender, shared navigation and cross-plugin links,
   configuration transfer, docs and integration. Never send real notifications during tests.
6. Independent review: requirements coverage and failure/restart/write-boundary audit.
   Implement material findings and verify with regression tests.
7. Main: full direct Vitest, source-alias noEmit preserving production options, ESLint,
   Prettier, rustfmt, controlled rendered QA. Update docs44/45/quality record with facts.

## Integration interfaces

SDK details are pinned before workers implement; native and plugin consume the same names.
No worker edits another owner's files. Expected worker changes are not external interference.
New commands use flat Tauri arguments, except preflight/save use structured `input`.
Model and control gateways remain coordinator-scoped; ordinary WebView plugin calls cannot forge them.
Product source snapshots, account identity and browser bindings remain immutable.
Only explicit unsubmitted item amendments are layered over snapshots with a recorded revision.
Budget accounting is native-owned and independent of graph checkpoints.
Drafts never contain image bytes, CDP addresses or model credentials.

## Progress

- Public contracts, model policies, notification payloads, controls and workspace bounds are
  implemented. Direct SDK regressions observed failing boundaries before their fixes.
- Main-owned settings persistence, bounded Bark sender, deep-link registration, business
  navigation and source-history links are implemented. The integration subset passed
  130 tests; rendered navigation passed seven controlled scenarios.
- The full release-workflow direct suite passed 201 tests. This is workflow regression
  evidence, not a release or native compilation result.
- Native, workflow and UI implementation is handed back. Every task records
  RED/GREEN evidence or the explicit unexecuted Rust boundary.
- First whole-repository direct regression passed 283 files / 4,624 tests, with two files
  and nine tests skipped; all 11 controlled Chromium cases ran. Whole ESLint and format
  checks passed. Production-source noEmit checks passed for all changed JS/TS packages.
- Independent integration review found retention replay, blank-origin initialization,
  item continuation, queue fairness and accumulated-control bounds to fix, plus missing
  paginated request summaries. Main added summary SDK contracts and owns only the new
  native `model_history.rs` / `model_history_tests.rs`; native worker registers those.
  UI worker owns request-summary presentation. Workflow worker also fixes approval of
  empty or already-applied retained amendments.
- Final whole-repository direct regression: 283 files / 4,648 tests passed, two files /
  nine tests skipped. All 12 controlled Chromium cases ran. Whole ESLint, seven
  production-options/source-test noEmit configurations and full Rust format checks passed.
- Controlled rendered QA passed 19 Agent scenarios, seven cross-page navigation
  scenarios and seven incomplete-draft follow-ups. No real marketplace writes,
  model calls, Bark sends or vendor-profile changes were performed.
- Native SQL fixtures: 17 scenarios passed using 59 production statements; SQLite
  prepared 199 static statements. Main's four request-history SQL checks also passed.
  The 31 completion regression functions remain unexecuted Rust source.
- Focused independent review closed all seven integration findings, including the
  final running-control race, without new P1/P2 in that scope. That final change
  touched only three Rust files; JS/TS source hashes stayed unchanged after the
  full regression. Main independently reran native SQL and Rust formatting.
- All 14 items now map to code, test evidence and acceptance limits in docs45.
  docs09 records actual checks; docs46 covers operation and recovery. Native
  compilation/execution, real providers/platforms/models/Bark, Windows and installed
  deep links remain unverified. No local build, packaging, commit or release occurred.
