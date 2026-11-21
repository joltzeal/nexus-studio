# Rust automation engine port

Source is ProxyShard/ShardBrowser at commit `99e780e2e685e5b3b5357c5baee8796e10b3ce1e`. The upstream MIT license is reproduced verbatim in `LICENSE.upstream`. Source files carry provenance headers.

## Files and upstream origins

| Local file | Upstream source or responsibility |
| --- | --- |
| `runner.rs` | `src-tauri/src/runner.rs`, including step dispatch, branches, retry, canvas order, loops, deadlines, subflows, v1 and v2 module dispatch |
| `cdp.rs` | `src-tauri/src/cdp.rs`, including WebSocket command/reply transport, DOM/shadow lookup, picking, navigation and screencast events |
| `wasm.rs` | `src-tauri/src/wasm.rs`, including Wasmtime ABI, variable filtering, grants, manifests, resource limits, module installation and state |
| `modguard.rs` | `src-tauri/src/modguard.rs`, preserving dynamic-action restrictions |
| `requests.rs` | `src-tauri/src/requests.rs`, preserving Rust HTTP fingerprinting and cookie sessions |
| `db.rs` | `src-tauri/src/db.rs`, preserving SQLite, PostgreSQL, MySQL/MariaDB and MongoDB drivers |
| `model.rs` | Project, Block, Branch and RunSettings from `src-tauri/src/space/local/automation.rs` |
| `host.rs` | Explicit Raccoon service boundary, immutable scope, capability and durable-intent types |
| `chromium.rs` | Standard Chromium Input, Runtime/isolated world and Network/Fetch adaptation |
| `mod.rs` | Public module registration and exports |
| `test_host.rs` | Controlled test host used by runner tests |

## Service contract

Initialize `wasm::initialize(v2_data_root)` once at service startup. Implement `EngineHost` and register this module from the service. The host owns all Profile data, connection ownership, required proxy checks, immutable launch receipts, resource leases, durable operation intents and run storage.

Call `runner::start(Arc<dyn EngineHost>, Project, Vec<Project>)`. The project list must contain the exact selected project and must already be validated for the same connection. Admission persists the snapshot through `begin_run` before dispatch. `status(connection_id, run_id)`, `all(connection_id)` and `stop(connection_id, run_id)` use explicit scope. A global Fleet may aggregate these service results while retaining each scope.

The in-memory registry retires a completed run immediately after its final snapshot is durably acknowledged, when every worker is `done`, `stopped` or `failed` and has no pending intent. Completed history is read from the durable store. Active, interrupted, reconciling and persistence-failed runs retain ownership. After explicitly confirming all host jobs, control leases and lifecycle intents, the service can call `runner::retire_recovered(terminal_state).await`. This validates terminal worker state, serializes and persists the recovered snapshot, then removes the matching run generation. Persistence failure preserves the unresolved registry entry. Registry retirement releases the retained host and frozen-module references. The service owns bounded persisted history and snapshot-file retention.

Each primitive, module-returned action and subflow step allocates a durable `StepIntent` before dispatch. `StepKey` includes worker, pass, monotonic sequence, block, kind and call stack. Lifecycle suboperations must derive distinct stable operation keys from the step intent, method and Profile. Host errors with uncertain effects must retain `OutcomeUnknown` through anyhow contexts. Confirmed validation and rejection errors stay ordinary errors.

The worker pauses an unknown step, persists its intent and polls `reconcile` without evaluating either branch. A committed result restores variables, binding and temporary Profile ownership. Confirmed retryable failure may take the configured upstream failure branch, and the next actual attempt gets a new related step sequence. Stop retains unresolved intent ownership. Cancelling an action with no dispatched side effect records `cancelled` and permits cleanup. Parent subflow/module cancellation delegates to the active child intent.

State writes are awaited before another step. A per-run async persistence gate is acquired before snapshot capture and held through the host write, ordering concurrent worker snapshots and terminal state writes. Failed persistence suspends dispatch and retries the same write. The concrete host must expose final persistence failures and serialize any additional writers outside this engine. The engine serializes step intent information and worker variables for inspection and recovery. Restart reconstruction of an executing WASM stack remains a service recovery concern and must never blindly replay a module or interrupted page action.

CDP sessions require `cdp::with_scope(scope, worker, future)`. A verified `CdpEndpoint` carries a process/launch identity and capabilities. Literal loopback WebSocket endpoints are checked again by the transport. Old socket readers cannot remove a newer session. `release_preview` stops screencast, releases paused interception, disables observation and detaches only the preview scope, retaining uncertain teardown for reconciliation.

After confirmed run recovery, call `cdp::release_recovered(profile_id)` in the original run and worker scope. This accepts run-owned sessions, blocks new commands and drains current commands and interception before protocol cleanup. Sent command IDs survive dropped waiting futures and timeouts until their protocol replies arrive. A five-second drain deadline or lost transport returns `OutcomeUnknown` and retains the session, pending command identities and control ownership. Disconnected run sessions remain registered for this purpose. The host retains its lease on release failure. An externally confirmed stopped browser can be detached separately using that lifecycle evidence. Controlled tests cover acknowledged cleanup before detach and disconnected-session retention.

## Behavior and deliberate adaptations

All 68 palette kinds retain dispatch arms. The aliases `setVar` and `ifExists` remain accepted. Unknown kinds return errors before lazy browser start. Project fields and upstream serde defaults remain intact, including ignored legacy `run.profiles` payload data.

Native ShardBrowser sessions retain Motion, Traffic and Script calls behind verified capabilities. Standard Chromium uses ordered Input operations, isolated-world Runtime evaluation and Fetch interception. Input does not reproduce native Motion trajectories, timing or fingerprint guarantees. Standard proxy hot swap is explicitly refused. Proprietary `proxy.generate` and `proxy.residential` return an explicit unavailable-service error in Raccoon.

Profile creation, selection, reading, retention, deletion, lazy start, stop, proxy resolution and autofill cross `EngineHost`. Cleanup deletes only temporary records still owned by this run. Kept Profiles are removed from the temporary cleanup list. Host cleanup must preserve browsers that were already running before acquisition according to the service's resource receipts.

HTTP clients and database handles are scoped by connection, run, worker and operator session name. An HTTP session rejects proxy/fingerprint changes and applies each request's timeout. Required proxy resolution failure never falls back to direct networking. Database blocking work and close/drop cleanup stay off the async executor. Each database handle has its own lock. SQLite partial batches, changed schema on failure and uncertain I/O, submitted PostgreSQL transport failure, MySQL connectivity/batch ambiguity and uncertain MongoDB errors preserve unknown outcomes.

DOM condition, text, URL, count, viewport and shadow traversal errors propagate. A disconnected browser cannot become an absent element, empty text or zero count. Expanded secret parameters are redacted from in-memory log messages. Durable variables and application-owned storage remain sensitive plaintext managed by the concrete host.

WASM binaries and digest-bound grants freeze into an application-root snapshot for each run. Installation and freezing share a mutation lock. Snapshot selection is scoped to synchronous module calls and restored even on unwind. Module state remains application-wide as upstream. Snapshot files are retained for reconciliation, and bounded artifact retention belongs to the service. A privileged external filesystem edit can still alter snapshot files and requires service-level content-integrity verification before recovery.

## Exact dependency versions

These versions match the main workspace lock at the final static review. Main owns Cargo declarations and lock updates.

| Crate | Exact resolved version | Required declaration/features |
| --- | --- | --- |
| `wasmtime` | `41.0.4` | `=41.0.4`, upstream default features |
| `wreq` | `0.15.3` | `=0.15.3`, defaults plus `cookies`, `gzip`, `brotli`, `deflate`, `zstd` |
| `wreq-util` | `0.1.0` | `=0.1.0`, defaults plus `emulation`, `emulation-serde` |
| `postgres` | `0.19.14` | `=0.19.14`, defaults, upstream `NoTls` behavior |
| `mysql` | `28.0.4` | `=28.0.4`, `default-features=false`, `minimal-rust`, `rustls` |
| `mongodb` | `3.10.1` | `=3.10.1`, defaults plus `sync` |
| `anyhow` | `1.0.104` | default features |
| `serde` | `1.0.229` | `derive` |
| `serde_json` | `1.0.154` | default features |
| `tokio` | `1.54.1` | `rt-multi-thread`, `macros`, `process`, `net`, `io-util`, `time`, `sync` |
| `tokio-tungstenite` | `0.24.0` | `default-features=false`, `connect` |
| `futures-util` | `0.3.34` | `sink`, defaults |
| `rusqlite` | `0.40.2` | `default-features=false`, `bundled` |
| `url` | `2.5.8` | defaults |
| `uuid` | `1.29.3` | `v4`, `serde` |
| `base64` | `0.22.1` | defaults |
| `sha2` | `0.10.9` | defaults |
| `regex` | `1.13.2` | defaults, standard traffic matching |

Upstream declared Wasmtime `48.0.1`, wreq `0.16.1` and wreq-util `0.2.0`. Their MSRV exceeds the fixed Rust 1.93 toolchain. The compatible pins above are deliberate dependency deviations. wreq-util uses `Emulation` in 0.1.0, and the inventory is copied from that pinned enum. Newer upstream fingerprint choices that are absent in 0.1.0 return an explicit unknown-fingerprint error. Wasmtime 41 memory, linker, fuel and Mach-port configuration APIs were checked against downloaded crate source.

## Verification and remaining integration

Rustfmt parses and formats the owned Rust module tree. Static comparison checks all 68 upstream palette kinds against the builtin dispatch inventory, verifies upstream arm coverage and verifies the reproduced license. Unit tests cover upstream subflow semantics, module restrictions, SQLite, scoped identity, unknown creation reconciliation, persistence failure, unknown kinds, HTTP route conflicts, partial SQL, grants and module freezing. Tests were authored and retained without execution under the task's Rust test restriction.

Rust compilation, Rust unit tests, Clippy, builds, real browser/provider traffic, macOS/Windows native execution, restart recovery and standard protocol equivalence remain unverified. Main owns Cargo/lib registration, persistent store, concrete host, commands, frontend and runtime capability probes. A formatted source port is available for their integration and CI verification.
