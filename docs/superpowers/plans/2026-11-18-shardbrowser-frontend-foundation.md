# ShardBrowser Frontend Foundation Implementation Plan

> **For agentic workers:** Use the current session to implement the isolated foundation. Do not replace Raccoon's Rust runtime or the existing desktop frontend in this phase.

**Goal:** Establish a separately buildable Raccoon 0.2 frontend from the ShardBrowser Launcher source.

**Architecture:** Import the upstream React source, UI kit, assets, and frontend build configuration into `apps/desktop-v2`. Keep its visual and component structure intact for the first build. The existing Raccoon Rust backend remains the eventual native command owner; a separate adaptation phase will replace upstream IPC and data stores before switching Tauri's frontend entry.

**Tech Stack:** React 19, Vite, Tailwind 4, pnpm 11, upstream ShardX UI Kit.

**Spec:** `docs/superpowers/specs/2026-11-17-raccoon-02-provider-architecture-design.md` and the user's instruction to adopt ShardBrowser as a new frontend base.

## Global Constraints

- Preserve the dirty `codex/raccoon-0.2-rewrite` worktree and all existing app files.
- Use only the root pnpm lockfile; do not add an npm lockfile or a nested Git repository.
- Preserve the upstream MIT notice, record the exact upstream source revision, and distinguish Launcher source from browser binaries.
- Do not execute tests. A local frontend build is explicitly requested for this phase.
- Do not route upstream `profile_*` commands to Raccoon's Rust backend until the domain mapping is implemented.

## Review Focus

- The UI kit CSS and icons must resolve from the new workspace without a second package manager.
- Vite must not require the upstream Rust crate to produce frontend assets.
- The existing desktop app must retain its current frontend entry after the new build.
- The imported frontend must not silently imply that its upstream browser commands work in Raccoon.

---

### Task 1: Import the upstream frontend

**Files:** `apps/desktop-v2/src`, `apps/desktop-v2/ui-kit`, `apps/desktop-v2/public`, frontend configuration and license files.

- [x] Import upstream frontend source at a fixed commit, excluding its independent Rust backend, team server, package lock, and Git metadata.
- [x] Record provenance and scope in `apps/desktop-v2/README.md`.
- [x] Keep the existing `apps/desktop` code and build entry unchanged.

### Task 2: Make it a pnpm workspace

**Files:** `pnpm-workspace.yaml`, `apps/desktop-v2/package.json`, `apps/desktop-v2/ui-kit/package.json`, root `pnpm-lock.yaml`.

- [x] Include the nested UI kit in the workspace and use a workspace dependency.
- [x] Replace upstream npm prebuild with pnpm UI kit build, without adding another lockfile.
- [x] Install with the repository's pinned Node/pnpm toolchain.

### Task 3: Prove the frontend build

**Files:** Only build configuration files if the build exposes a concrete issue.

- [x] Run the new frontend's production Vite/TypeScript build; fix integration errors.
- [x] Confirm the output exists and the existing Tauri frontend path was not changed.
- [x] Document the build result and remaining native IPC integration work.
