# desktop-v2 插件配置导入导出实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在插件中心右上角提供「插件配置」，通过原生 JSON 文件对话框选择性导入导出插件设置。

**Architecture:** 复用当前公共 `raccoon-configuration` schemaVersion 2 和插件的 `configuration.export/validate/import`，不引用 v1 React 页面或偏好存储。新增 v2 适配器与 ShardX Modal；原生文件服务对齐当前契约，正常路径不接受旧归档。

**Tech Stack:** React、ShardX UI Kit、TypeScript、Zod 公共契约、Tauri 文件服务、Vitest。

**Spec:** 用户本轮明确要求；配置方法边界参考 `docs/37-configuration-transfer.md`，页面规范参考 `docs/superpowers/specs/2026-11-18-raccoon-plugin-center-design.md`。

## Global Constraints

- 保留现有工作区修改，不创建分支、提交或发布。
- 仅插件配置；导出 preferences/networkProxy 为 null，导入不写应用设置或业务库存。
- 全部选中项先校验，之后逐项写入，真实确认成功才移出待重试选择。
- 未安装、未授权、未运行、未声明接口的插件显示具体原因；不自动安装。
- 不执行应用/插件 build、打包、Rust 编译/测试/Clippy 或图像验证。

## Review Focus

- 原生保存/打开对话框取消，不显示成功，不清空当前预览。
- 某插件校验失败，之前校验通过的插件也不能提前写入。
- 部分写入失败，保留失败选择；已成功项不能在同一预览内意外重复导入。
- 插件在预检后被卸载、升级或重启，不能向已变化的实例写入。
- 弹窗关闭或页面卸载，迟到结果不能污染新弹窗或继续发起写操作。

## Task 1: 配置边界与流程

**Files:** 新增 `apps/desktop-v2/src/raccoon/plugins/configuration.ts` 及行为测试。

- [x] 测试版本/大小/重复项校验、能力与可用性、导出所选、全量预检、逐项结果、实例变化。
- [x] 运行定向 Vitest，确认新功能缺失导致失败。
- [x] 实现 `pluginConfigurationTargets`、文件边界及插件导入导出流程，使用现有公开契约。
- [x] 运行测试并确认通过。

## Task 2: 原生主题弹窗与页面入口

**Files:** 新增 `apps/desktop-v2/src/pages/plugins/PluginConfigurationDialog.tsx` 及交互测试；修改同目录 `index.tsx`。

- [x] 测试打开文件仅预览、取消不报成功、成功项移出选择、缺失插件禁选、处理中阻止重复操作及卸载隔离。
- [x] 先验证失败，再实现 Modal、导入/导出切换、选择列表、敏感配置说明和右上角按钮。
- [x] 运行使用实际 UI Kit 的 DOM 交互测试，不执行截图。

## Task 3: 原生文件格式与记录

**Files:** 修改 `apps/desktop/src-tauri/src/core/configuration_service.rs`、`plugin_service.rs`、v2 `raccoon/plugins/call.ts`、`docs/37-configuration-transfer.md`。

原生配置调用复用已有 `call_generation`，增加可选 `expectedIdentity` 以防列表预检与实际 RPC 之间的插件替换竞态；新配置界面要求可确认的安装/进程代次。现有其他调用不改变行为。

- [x] 原生校验对齐 `raccoon-configuration` / schemaVersion 2，补充旧格式拒绝的 Rust 测试源码；不在本地运行 Rust 测试。
- [x] 定向 Vitest、ESLint、无产物 TypeScript、Prettier、rustfmt 检查。
- [x] 更新模块文档与本计划的实际执行结果，明确未验证原生对话框及双平台行为。

## 实际结果

- 新增配置适配器及真实 UI Kit DOM 测试：2 个文件、24 项通过。
- 现有配置平台、v1 页面及 SDK 配置契约回归：3 个文件、12 项通过。
- desktop-v2 `tsc --noEmit` 与本次源码范围 ESLint 通过；新增源码与计划 Prettier、两个改动 Rust 文件的 rustfmt 检查通过。
- 独立只读审查发现紧凑归档被漂亮打印放大后误判超限的问题；新增 64 节紧凑归档用例确认失败，再修正导入预算并通过全部 24 项测试。其余审查范围无阻断项。
- 未运行应用/插件 build、打包、发布、图像验证、Rust 编译/测试/Clippy 或真实原生文件对话框、Windows/macOS 发行包验收。没有创建分支或提交。
