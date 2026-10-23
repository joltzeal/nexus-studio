# macOS Bundled Node Runtime Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the signed macOS application can execute its bundled Node runtime so browser preparation and installed plugins work on a clean machine.

**Architecture:** Package macOS Node as a separately signed Helper with the JIT entitlements required under Hardened Runtime, without granting those permissions to the Rust application process. Verify the final signed application instead of only checking the unsigned staging directory. Keep the runtime import check cross-platform so Windows packaging continues to validate the same files.

**Tech Stack:** Tauri 2, macOS code signing, Node.js 24, pnpm, Vitest

**Spec:** `docs/20-desktop-release-and-updates.md`

## Global Constraints

- Preserve the fixed Node.js 24.18.0 runtime and the Windows sidecar layout.
- Do not change browser, plugin, profile, proxy, or authorization behavior.
- All shell commands use the repository-required `rtk` prefix.
- Do not commit or publish without an explicit user request.

## Review Focus

- A signed macOS Node without JIT entitlements must fail the packaged-runtime verification.
- Both arm64 and x64 macOS Node Helpers must receive the same entitlements.
- The macOS Rust application executable must not receive Node JIT entitlements.
- Windows verification must resolve `node.exe` and resource paths without macOS assumptions.
- The verification must exercise JavaScript execution and imports, not only `--version`.
- Release CI must run the verification after Tauri has signed and assembled the final bundle.

---

### Task 1: Final packaged-runtime verifier

**Files:**

- Create: `scripts/lib/packaged-runtime.mjs`
- Create: `scripts/lib/packaged-runtime.test.mjs`
- Create: `scripts/verify-packaged-runtime.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces: `resolvePackagedRuntime(options)` for deterministic platform path resolution.
- Produces: `pnpm runtime:verify-packaged [bundle path]`, which executes the bundled Node with the packaged proxy preload and browser adapter.

- [x] Write path-resolution tests for macOS and Windows fixtures.
- [x] Run the focused tests and confirm they fail against the old macOS path.
- [x] Implement the resolver and verification command.
- [x] Run the focused tests and confirm they pass.
- [x] Run the command against the broken macOS bundle and confirm it fails at Node/V8 startup.

### Task 2: macOS entitlement and release integration

**Files:**

- Create: `apps/desktop/src-tauri/NodeEntitlements.plist`
- Create: `apps/desktop/src-tauri/tauri.release.macos.conf.json`
- Create: `scripts/prepare-macos-node.mjs`
- Modify: `apps/desktop/src-tauri/tauri.release.conf.json`
- Modify: `apps/desktop/src-tauri/src/core/runtime_paths.rs`
- Modify: `scripts/package-desktop.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/20-desktop-release-and-updates.md`

**Interfaces:**

- Consumes: `pnpm runtime:verify-packaged [bundle path]` from Task 1.
- Produces: final macOS bundles whose nested Node executable can initialize V8 and import the packaged runtime.

- [x] Add a macOS-only Helper preparation step that signs Node with JIT entitlements.
- [x] Keep the Rust application executable free of Node JIT entitlements.
- [x] Run a release app build and inspect both final executable signatures.
- [x] Run the packaged-runtime verifier against the final bundle and confirm it passes.
- [x] Add the verifier after local packaging and after `tauri-action` in release CI.
- [x] Update the release documentation with the signed-runtime requirement and verification evidence.
- [x] Run focused tests, formatting, type checks, Rust checks, and final packaged-runtime verification.
