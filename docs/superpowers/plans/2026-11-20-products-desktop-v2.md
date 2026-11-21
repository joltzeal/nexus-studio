# 商品管理 desktop-v2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `studio.products` 的商品库存、编辑、导入、图片管理、AI 生图导入和只读发布历史迁移到 desktop-v2。

**Architecture:** 页面只通过 `apps/desktop-v2/src/raccoon/plugins/products` 调用 native `plugin_call`，所有外部响应先经过 public Zod contract 和分页/修订/图片完整性校验。页面保持商品插件数据所有权，AI 生图导入仅使用公开记录和分块图片协议，不访问任一插件私有目录。

**Tech Stack:** React 19、TypeScript strict、ShardX UI Kit、Zod public contracts、Vitest/Node direct tests。

**Spec:** `docs/superpowers/specs/2026-11-19-raccoon-plugin-pages-desktop-v2-design.md`、`docs/43-products-plugin.md`、`docs/superpowers/plans/2026-11-19-raccoon-plugin-pages-desktop-v2.md`。

## Global Constraints

- 0.2 页面不复用旧 `apps/desktop` shadcn 页面或旧 IPC adapter。
- Rust/插件是数据所有者；前端不读写 SQLite 或插件私有目录。
- 普通页面不调用 `products.publications.record`；发布历史只读。
- 保存、删除、导入、AI 入库均在回执核对失败时保留草稿/错误，不反馈虚假成功。
- 图片最多 12 张、单张最多 8 MiB；分块必须校验偏移、总长、MIME、SHA-256，并在取消或失败后清理未提交图片。
- 用户最新约束：不执行插件 build、应用 build、浏览器/截图或图像验证；只执行直接测试、lint、格式和无产物 TypeScript。

## Review Focus

- 旧修订号写入覆盖新编辑：测试 expectedRevision 与回执 revision 一致性。
- 上传响应丢失或取消后留下孤立图片：测试 abort/discard 清理和已引用图片保护。
- 分页最后一页删除后仍停留在空页：测试 page clamp 与重复 ID/total 校验。
- AI 生图记录重启或重复导入：测试 source recordId 幂等及插件进程身份变化。
- 普通 UI 暴露发布写入：测试 page adapter 不导出或调用 publication record。

## Implementation Tasks

### Task 1: Product boundary adapter

**Files:**
- Create: `apps/desktop-v2/src/raccoon/plugins/products/model.ts`
- Create: `apps/desktop-v2/src/raccoon/plugins/products/parse.ts`
- Create: `apps/desktop-v2/src/raccoon/plugins/products/api.ts`
- Test: `apps/desktop-v2/src/raccoon/plugins/products/api.test.ts`

**Interfaces:**
- Consumes `@nexus/plugin-contracts/products` and v2 `callPlugin`.
- Produces `productApi.list/get/save/remove/import/listPublications`, image upload/read/discard helpers, and `PRODUCT_METHODS` page gates.

- [ ] Write failing tests for malformed pages, stale save replies, source/publication filters, image chunk corruption, upload cancellation cleanup, and publication-write absence.
- [ ] Run the focused test file and confirm failures are caused by missing adapter behavior.
- [ ] Implement strict parsers and typed methods; avoid exposing `products.publications.record` from the UI adapter.
- [ ] Run focused tests and the existing public contract tests.

### Task 2: Product domain forms and AI import adapter

**Files:**
- Create: `apps/desktop-v2/src/raccoon/plugins/products/form.ts`
- Create: `apps/desktop-v2/src/raccoon/plugins/products/ai-import.ts`
- Test: `apps/desktop-v2/src/raccoon/plugins/products/ai-import.test.ts`

**Interfaces:**
- Consumes Task 1 adapter and existing AI image `getRecord/readImageBytes`.
- Produces form defaults/serialization, product error mapping, `importGenerationProduct(recordId, options)` and process identity checks.

- [ ] Write failing tests for ready/draft validation, source idempotency, active generation rejection, plugin replacement, partial upload cleanup, and response mismatch.
- [ ] Run focused tests and confirm RED.
- [ ] Implement form conversion and bounded cross-plugin import; preserve source identity and never call publication write.
- [ ] Run focused tests with the existing AI image import tests.

### Task 3: v2 product pages

**Files:**
- Create: `apps/desktop-v2/src/pages/plugins/products/index.tsx`
- Create: `apps/desktop-v2/src/pages/plugins/products/ProductEditor.tsx`
- Create: `apps/desktop-v2/src/pages/plugins/products/ImportDialog.tsx`
- Create: `apps/desktop-v2/src/pages/plugins/products/PublicationHistory.tsx`
- Create: `apps/desktop-v2/src/pages/plugins/products/ProductImage.tsx`
- Modify: `apps/desktop-v2/src/pages/plugins/PluginPage.tsx`

**Interfaces:**
- Consumes product adapter, form helpers, and AI import orchestration.
- Produces lazy `ProductsPage` for `studio.products`, with base/optional method gates and bounded responsive filters.

- [ ] Write failing content/contract tests for search Input versus labeled Select filters, stale editor save, deletion confirmation, import feedback, cross-page selection, and publication history pagination.
- [ ] Run focused page tests and confirm RED.
- [ ] Implement compact list, editor, image reorder/upload/remove/cover controls, CSV/JSON import, AI batch import, delete confirmation, and read-only publication history with Kit components.
- [ ] Register lazy route and run page tests, lint, format, and no-output TypeScript.

### Task 4: Documentation and verification

**Files:**
- Modify: `docs/43-products-plugin.md`
- Modify: `docs/09-quality-and-testing.md`
- Modify: `apps/desktop-v2/README.md`

- [x] Record v2 page scope, method gates, AI import ownership, and unverified native/build boundaries.
- [x] Run focused product/plugin-contract tests and static checks; do not run build, browser, screenshots, or image verification.

## Implementation Record

- Task 1: 业务解析与回执校验留在 `api.ts`，图片协议集中在 `images.ts`，没有另建仅转发的 `parse.ts`。
- Task 2: 复用 `ai-image/product-import.ts` 及已有回归测试，将商品上传/清理适配收归商品模块；新增入库回执图片核对。
- Task 3: ShardX 商品页已注册。测试直接覆盖文本搜索与枚举筛选分组、写入/删除回执、发布历史分页和图像分块协议；未做原生交互验收。
- Task 4: 实际验证见 `docs/09-quality-and-testing.md`。图标契约仍属于独立方案，不随商品页改变。
