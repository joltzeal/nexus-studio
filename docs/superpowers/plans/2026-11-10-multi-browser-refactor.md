# Multi-browser Refactor Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent work; integrate all tasks in the current workspace. No commits or releases are authorized.

**Goal:** 使用统一接口管理内置浏览器、AdsPower 和比特浏览器，删除被替代的旧接口和兼容读取路径。

**Architecture:** Rust 持有 SQLite、调度、操作恢复和提供方注册。三个提供方实现 `BrowserProvider`，外部浏览器直接调用本机 API；内置浏览器复用升级后的 Node 运行时。

**Tech Stack:** Tauri 2、Rust 1.93、React、shadcn、SQLite、Node 24.18.0、pnpm 11.17.0。

**Spec:** `docs/superpowers/specs/2026-11-10-multi-browser-provider-design.md`

## Global Constraints

- 用户已确认继续执行，无需再次确认方案或执行方式。
- 2026-11-10 补充要求优先：旧命令、旧 schema 读取、旧快照导入和过渡别名全部移除。
- 已有 SQLite 仅通过启动时的一次性 SQL 升级保留数据；升级后只支持新格式。
- 所有 shell 命令使用 `rtk`；不执行本地构建、打包、Rust 编译、Rust 测试或 Clippy。
- 本地允许直接执行 Vitest、ESLint、Prettier 和 `tsc --noEmit`；Rust 语法格式检查不编译。
- 保留已有 SIM8 改动，不创建提交、标签或发布。
- 真实厂商 API 操作仅在用户明确提供测试环境后执行；当前验证使用本机 mock HTTP 和单元测试。
- 更新后的 API 不保留 `profile_*` 命令，也不保留 `NativeProfile` 等过渡别名。

## Review Focus

- 启动/创建超时可能已产生远端副作用：保存操作意图并核对，不能直接重试。
- API 断线不能视为窗口停止，已关联的账号/手机号关系不能按空列表删除。
- 应用代理不得代理本机管理 API；必需窗口代理失败不得直连。
- 新旧 Tab 请求竞态和插件全局关联不可只依赖当前列表。
- 更新、退出及解绑不得误停第三方窗口或删除官方环境。

## Shared Interfaces

公共 Rust 类型位于 `core/browser/provider.rs`，公共 TS DTO 位于
`packages/contracts/src/browser.ts`。持久化窗口格式使用版本 2，快照 manifest 使用版本 3，
不接受旧格式。字段由相应任务的测试固定，不增设兼容分支。

`BrowserProviderId`：`cloakbrowser | adspower | bitbrowser`。
`WindowState`：`stopped | starting | running | stopping | unknown | missing`。
`ProxyMode`：`direct | manual | plugin | provider`。

对外窗口 DTO：`id`、`name`、`providerId`、`connectionId`、`providerProfileId`、
`origin`（`created | attached`）、`state`、`version`（字符串，可为空表示未知）、
`kernelVersion`、`proxy`、`proxyPlugin`、`proxyEndpoint`、`proxyMode`、`settings`、
`groupId`、`createdAt`、`lastOpenedAt`、`sortOrder`。
不包含 `running`；调用方根据明确状态派生展示。

命令全部使用新名称：

- `browser_window_list({ connectionId? })`
- `browser_window_create({ input })`
- `browser_window_update({ input })`
- `browser_window_update_note({ id, note })`
- `browser_window_delete({ id, deleteEnvironment })`
- `browser_window_start({ id })` / `browser_window_stop({ id })`
- `browser_connection_list()` / `browser_connection_save({ input })`
- `browser_connection_probe({ id })` / `browser_connection_confirm({ id, scopeLabel })`
- `browser_connection_activate({ id })`
- `browser_profile_discover({ connectionId })` / `browser_group_list({ connectionId })`
- `browser_window_attach({ connectionId, profileIds })`
- `browser_operation_list({ connectionId? })` / `browser_operation_reconcile({ operationId })`
- `browser_operation_resolve({ input })`：明确确认后的官方环境关联或操作结束。
- 所有迁移和同步命令使用 `window_transfer_*` / `window_sync_*` 前缀。

创建 input：`operationId`、`connectionId`、`name`、`proxyMode`、`proxy`、
`proxyPlugin`、`proxyEndpoint`、`settings`、`groupId`、`kernelVersion`。
编辑 input 用 `id` 代替前两项，不允许修改既有绑定。
连接 input：`id?`、`providerId`、`name`、`endpoint`、`apiKey`、
`defaultGroupId`、`scopeLabel`。

## Task 1: 公共类型、数据库和调度

**Files:** `core/browser/provider.rs`、`core/browser/connection_store.rs`、
`core/browser/operation_store.rs`、`core/browser/session_store.rs`、
`core/database.rs`、`core/window_store.rs`、`core/scheduler.rs`。

**Interfaces:** 产生严格的 `WindowRecord`、`BrowserConnection`、`BrowserProvider`、
`BrowserError`、`LaunchSnapshot` 和三个 Store，供全部后续任务使用。

- [x] 写 SQLite 升级、稳定排序、绑定不可变和调度迟到回调的 Rust 测试，交 CI 执行。
- [x] 一次性 SQL 升级保留旧 UUID/分组/内核/种子/目录；运行时只读新格式。
- [x] 删除旧 `profile_store`、channel 容量和未使用的 Core 演示抽象。
- [x] 持久化操作阶段和会话观察；使用系统文件锁限制同数据目录管理实例。
- [x] 运行 `rustfmt --check`，只检查解析与格式；不宣称 Rust 编译通过。

## Task 2: 外部浏览器适配器

**Files:** `core/browser/local_api.rs`、`core/browser/providers/adspower.rs`、
`core/browser/providers/bitbrowser.rs`、对应 Rust 单元测试。

**Interfaces:** 实现 Task 1 的 `BrowserProvider`；不写 Nexus 窗口业务表。

- [x] 用 mock 夹具固定分页、业务失败、loopback 校验、鉴权和代理字段映射。
- [x] 实现官方创建、查询、局部更新、删除、启停、状态、目标分组与创建标记核对。
- [x] 复用 blocking reqwest，独立直连、节流、有限超时，写入不盲目重试。
- [x] 未验证的配置能力明确拒绝；不重随机已有指纹。
- [x] Rust 测试留给 CI，本地仅格式检查。

## Task 3: 内置适配器与 Node 运行时

**Files:** `core/browser/providers/cloakbrowser.rs`、`packages/browser-runtime/src/profile-runtime.ts`、
`profile-runner.ts` 及相应测试。

**Interfaces:** 内置适配器实现同一 trait；Node 只接受新窗口记录和完整内核绑定。

- [x] 新 runtime schema 测试拒绝版本 1、旧 channel 绑定和缺失内置字段。
- [x] 提取受控子进程生命周期、内核和激活码，移出通用服务。
- [x] 删除旧 binary/version 推断和历史兼容载荷。
- [x] 直接运行相关 Vitest 测试，核对代理阻断、持久指纹及快照。

## Task 4: 通用窗口服务与恢复

**Files:** `core/window_service.rs`、`core/browser/registry.rs`、`core/plugin_service.rs`、
`core/updater_service.rs`、`src/lib.rs`。

**Interfaces:** 实现 Shared Interfaces 中的新命令；插件继续使用 Nexus UUID。

- [x] 用契约测试固定创建超时、断线、外部窗口已启动、重启恢复和删除两种语义。
- [x] 持久化操作意图，确认远端结果后提交；疑似成功保留可恢复状态。
- [x] 管理接入作用域、启动快照、代理解析、状态观察和插件上下文。
- [x] 更新互锁只阻止受控进程、迁移和未完成操作，不阻止稳定的外部会话。
- [x] 完全移除旧 `profile_service` 与旧命令注册。

## Task 5: 前端接入与现有页面联动

**Files:** `packages/contracts/src/browser.ts`、`lib/platform/windows.ts`、
`lib/platform/browser-connections.ts`、`features/spaces/*`、
`features/settings/browser-connections-page.tsx`、账号池批量入口及测试。

**Interfaces:** 消费 Shared Interfaces 的新 DTO 和命令，不使用兼容别名。

- [x] 新契约与 API 测试先固定新字段、命令、错误边界和稳定排序。
- [x] 添加提供方 Tabs、连接设置和已有环境选择；表格布局保持紧凑。
- [x] 按能力处理激活码、内核、随机种子、代理来源与编辑字段。
- [x] 旧 Tab 响应不覆盖新 Tab；全局 SIM8、短信和代理关联使用全部窗口。
- [x] 账号池批量创建选择接入；使用 operationId 恢复结果，删除名称/种子猜测逻辑。
- [x] 删除 `native-profiles.ts`，更新全部调用和测试夹具。
- [x] 直接运行 Vitest、ESLint、Prettier 和无产物类型检查。

## Task 6: 迁移、同步与兼容清理

**Files:** `core/transfer_service.rs`、`core/transfer_archive.rs`、
前端迁移 API、`plugin-sdk` 必要上下文、相关测试和模块文档。

**Interfaces:** 仅支持 manifest 3；外部提供方返回明确“不支持完整迁移”。

- [x] 更新内置导出和导入格式以及日志恢复，不保留 manifest 2 导入分支。
- [x] 删除历史目录扫描、JSON 文件导入、旧授权/SDK 兼容和旧命令别名。
- [x] 全仓扫描遗留标识，保留确有当前用途的业务能力，不能将“兼容”清理误做功能删除。
- [x] 更新架构、存储、浏览器、插件、批量、迁移与测试文档。

## Task 7: 集成验证与独立审查

**Interfaces:** 全部任务最终产物。

- [x] 运行直接 Vitest、ESLint、无产物 TypeScript 检查、Prettier 和差异检查。
- [x] 用 Rust 格式工具检查语法；CI 负责 Rust 编译/测试，当前不得标记通过。
- [x] 新上下文审查绑定、超时恢复、代理、数据升级和前端跨 Tab 竞态。
- [x] 修复重要问题，更新真实证据；不构建、不提交、不发布。

## Progress

- 方案已由用户批准，补充要求为删除全部旧兼容路径。
- 源码实施、兼容路径清理和允许的本地检查已完成；未执行本地构建或发布。
- 新一轮直接 Vitest：184 文件通过、2 文件跳过；2628 项通过、9 项跳过。
- 六个 TypeScript 无产物检查与约定范围 ESLint 退出 0；26 个 Rust 文件通过 rustfmt。
- 三组独立审查的重要发现已修正；核心 R1–R4 最后定点静态复核无未关闭的重要发现。
- Rust 编译、Rust 回归、真实厂商 API、Windows 安装与发行验收仍须在 CI 或受控环境执行，
  不以格式、前端测试或源码审查替代。详细记录见 `docs/09-quality-and-testing.md`。
