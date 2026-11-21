# Profile Proxy Picker Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkboxes for tracking.

**Goal:** Add the approved Proxy Pool submenu to desktop-v2 Profile proxy pickers.

**Architecture:** Keep the Rust binding fields and the existing plugin inventory RPC. Convert source-aware picker values at the desktop-v2 adapter boundary and reuse ShardX controls across selectors.

**Tech Stack:** React, TypeScript, ShardX UI Kit, existing Tauri/plugin contracts.

## Global Constraints

Keep native proxy entries at the top level. Pin Proxy Pool above them and omit a Direct menu option. Keep endpoint credentials inside the existing native resolution path.

## Review Focus

Cover stable endpoint references on reopen, unsupported providers, paginated inventory, and missing or unavailable plugin data.

- [x] Test the Profile proxy contract and batch mapping.
- [x] Wire native create, edit, quick binding, and batch adapters.
- [x] Reuse the two-level chooser in all Profile proxy pickers.
- [x] Verify interaction and adapter regressions, then update module docs.
