# ecom agent implementation

Approved basis: `docs/44-sales-agent-architecture.md`; Playwright was confirmed by
the user on 2026-11-13. This work implements the real plugin and host integration.

## Constraints

- Preserve existing product-plugin and demo work.
- Rust exclusively owns SQLite, task coordination, leases, checkpoints and action receipts.
- BrowserProvider owns browser lifecycle and immutable environment bindings.
- No local builds, packaging, Rust compilation, Rust tests or Clippy.
- No real marketplace writes, commits or releases without a separate request.
- Confirmed blocked accounts stop; unknown submission outcomes require reconciliation.
- A product is assigned to exactly one window in a batch; published products are rejected.

## Work

1. Define validated public contracts and wire protocol for the sales Agent.
2. Add narrow account observations and identity snapshots to the account plugin.
3. Add controlled Playwright actors and provider-specific automation access.
4. Add durable Rust batches, exclusive resources, action journal, checkpoints,
   reverse host routing, artifact snapshots and background dispatch.
5. Implement the Node sales Agent plugin, LangGraph workflow, model adapters,
   Vinted tools, confirmed publication sync and configuration transfer.
6. Replace demo-only access with an installed-plugin task page using real products
   and windows, assignment, bulk edit, progress, pause, cancel and recovery.
7. Run scoped behavioral tests, no-output TypeScript checks, lint and format.
   Review failure/restart behavior; update module docs with actual evidence.

## Progress

The 2026-11-13 completion audit does **not** mark the whole approved architecture
delivered. See `docs/45-sales-agent-implementation-audit.md` for the evidence and
remaining requirements.

| Step                        | Source status                                                                            | Verification                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1. Public contracts         | Implemented                                                                              | SDK/protocol regression and no-output type checks passed                                                |
| 2. Account observations     | Implemented                                                                              | Temporary-storage, identity, idempotency and strong-status cases passed; live account checks unexecuted |
| 3. Browser actors           | Implemented integration                                                                  | Eight intercepted Chromium scenarios passed; three real providers unexecuted                            |
| 4. Durable coordinator      | Main path implemented; capacity coordination incomplete                                  | Rust test source and production-SQL fixtures added; compilation and native tests unexecuted             |
| 5. Sales workflow           | Main path implemented; bounded pre-submit retries and lost-result-page discovery missing | Workflow, model and platform fixtures passed; no real listing, message or model acceptance              |
| 6. Task UI                  | Main list implemented; explicit manual takeover missing                                  | 19 rendered scenarios passed; follow-up control regression passed                                       |
| 7. Development verification | Allowed local checks and audit recorded; full acceptance incomplete                      | Final direct Vitest, noEmit, ESLint and rustfmt passed; no local build or release                       |

- Final whole direct Vitest run: 270 files passed, 2 skipped; 4,514 tests passed,
  9 skipped. Chromium was explicitly enabled; its eight cases are included.
- Source-alias no-output checks passed for desktop production options, Agent/SDK,
  and package/plugin tests. Desktop retains the real ES2020 + DOM options.
- Whole repository ESLint passed with zero warnings; all 23 changed/new Rust
  files passed rustfmt. Native test source is not a Rust test execution result.
- Independent review found two P1 and four P2 execution defects; main found one
  additional mixed-batch Pause defect. All seven have source fixes and scoped
  regressions: durable-submit click guards, original product facts, checkpoint
  compaction, sequential account evidence, hidden uploader, mixed Resume and Pause.
- Workflow regression now covers 18 cases, including two products with distinct
  receipts after outbox recovery and unknown-message reconciliation after process
  reconstruction without duplicate send.
- The remaining approved capability gaps are bounded pre-submit retry/cooldown,
  provider capacity and independent model pooling, explicit manual takeover,
  and bounded read-only discovery of a listing after the result page is lost.
- Release wiring includes sales Agent dependency, tests, packaging and startup
  verification. The 200 controlled release-workflow tests use command substitutes;
  they do not build, install or publish packages.
- Decision: continue in the existing shared feature branch and preserve prior product/demo/workflow edits; no commits or release are authorized.
- Decision: keep model credentials in plaintext plugin storage and frozen native task data, as required; exclude them from task views and events.

## Verification boundary

Controlled browser fixtures and mocked platform responses are development evidence.
Real provider, marketplace, model, Windows and Rust compilation checks must be
reported separately. Do not describe mock execution as a real successful listing.
