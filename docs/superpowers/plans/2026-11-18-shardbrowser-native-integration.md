# ShardBrowser native integration implementation plan

The existing Provider architecture and the requested ShardBrowser lifecycle define this implementation. React keeps the imported ShardX table, toolbar, sidebar and dialog frames. A Raccoon domain adapter owns frontend request coordination and calls the registered Rust commands. Rust owns browser records, folders, operations and runtime execution.

## Implementation

- [x] Add validated Raccoon IPC and a connection-scoped domain controller. Test delayed reads across switches, unknown observations, failed writes and stable create operation IDs.
- [x] Project native records into the existing Profile table through an explicit UI adapter. Replace native actions and capability-gate upstream commands, forms and side effects.
- [x] Connect the laboratory and kernel controls. Provide supported Profile fields, read-only details, persisted folders and operation reconciliation.
- [x] Enforce connection-scoped Folder membership in Rust and complete supported ShardBrowser runtime settings.
- [x] Add a native entry using the existing Rust host with a separate development configuration. Keep browser preview explicitly selectable.
- [x] Run direct frontend tests, no-output TypeScript checks, lint and rustfmt. Record pending CI, native engine, proxy and Windows verification in module documentation.

## Constraints

Use the root pnpm lockfile and existing public contracts. Keep current user edits. Local application builds and Rust compilation, tests and Clippy remain assigned to CI. Real provider writes require a user-controlled test environment. Scope the native frontend to ShardBrowser for this delivery and make other connections explicitly unavailable until their adapters are connected.
