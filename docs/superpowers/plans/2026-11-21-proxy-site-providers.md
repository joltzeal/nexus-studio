# Proxy Site Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除旧 Decodo 端口生成器，支持网站 Provider 抽象、Decodo API 与 TXT 手动订阅，以及主程序多级代理选择。

**Architecture:** 代理池内使用 `ProxySiteProvider` 和注册表隔离网站 API，服务层维护接入/订阅/来源及稳定的本地 endpointId。主程序只消费公开的分层列表和原有代理引用；到期、撤回和接入禁用由插件解析层执行阻断。

**Tech Stack:** TypeScript、Zod 公共契约、现有插件私有 JSON/凭据端口、React、ShardX UI Kit、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-21-proxy-site-providers-design.md`，含用户确认的 Decodo TXT 与到期日期补充。

## Global Constraints

- 全部 shell 命令使用 rtk；不创建分支、提交或发布，保留现有用户修改。
- 不执行插件/应用 build、打包、Rust 编译/测试/Clippy 或图像验证。
- 不请求真实代理账户，不购买、更改子用户或变更厂商配置；HTTP 测试仅注入合成响应。
- API 与手动订阅分别标记，缺失数据不伪造；主程序代理仍在顶级且不新增直连。
- Provider 刷新、订阅续期不更换已绑定端点 ID；到期或缺失依赖必须阻断启动。

## Review Focus

- TXT 含无效行、超额或敏感密码时整批不写，错误不回显凭据。
- 到期、禁用、撤回的端点即使已有 Profile 绑定也必须阻断解析。
- 同地址的手动代理与不同网站账号不能被普通库存去重逻辑合并所有权。
- 刷新中改凭据、后续页失败、取消或迟到响应不得覆盖新数据或清空旧库存。
- 多级单选/多选、返回、搜索、分页和失败重试不能混入其他层级或暴露密码。

## Task 1: 公共契约与 Provider 抽象

**Files:** `packages/plugin-contracts/src/proxy-pool.ts`、公开 exports；`plugins/proxy-pool/src/providers/{base,decodo,manual}.ts`。

- [ ] 先写 TXT 与 Decodo 请求/错误/取消行为测试并确认失败。
- [ ] 定义接入、订阅、源引用、分层节点及 RPC 的公开 schema。
- [ ] 实现基类、注册表、Decodo 适配器与只解析实际 TXT 行的导入器；不拼接端口。
- [ ] 直接运行测试并通过；依赖使用现有固定版本与根锁文件。

## Task 2: 持久化、RPC 与解析约束

**Files:** `providers/service.ts`、`providers/state.ts`、私有 store、库存服务、能力分派、入口与 manifest。

- [ ] 先写真实能力调用测试：手动订阅、续期 ID 稳定、来源隔离、到期阻断、API 失败保留库存。
- [ ] 实现接入配置、API 同步、手动订阅更新/替换、分层读取，使用 staged secrets。
- [ ] 扩展配置迁移保存 Provider 设置；普通原生代理绑定字段不变。
- [ ] 删除旧 Decodo schema、函数、RPC、测试与 mock；既有普通代理记录保留。
- [ ] 运行源码用例、无产物类型检查和 lint。

## Task 3: 服务商管理与 TXT 交互

**Files:** v2 `raccoon/plugins/proxy-pool/providers.ts`、`pages/plugins/proxy-pool/ProvidersDialog.tsx`，现有页面入口和 BatchDialog。

- [ ] 写接入/订阅选择、TXT 选择及过期日期交互测试。
- [ ] 实现服务商入口、API 配置、订阅列表、手动上传/续期/删除；沿用现有主题 Modal 与图标按钮。
- [ ] 批量添加仅保留通用 URL 导入，删除旧 Decodo 模式。
- [ ] 验证处理期间防重复、关闭/卸载隔离、无密钥显示和真实保存确认。

## Task 4: 主程序分层选择器

**Files:** v2 `ProxyChoiceList.tsx` 与对应测试、proxy-pool API/model/parse。

- [ ] 新增根手动代理、Provider、订阅、端点选择及返回/搜索/分页测试，先确认失败。
- [ ] 通过统一分层接口实现导航，保留所有 Profile 单选/多选入口与风险等标签。
- [ ] 同一服务组件覆盖新建、编辑、快捷换绑、批量分配及批量创建；不可用端点允许解除已勾选项但不新增绑定。
- [ ] 运行现有选择器及代理引用回归。

## Task 5: 检查、审查与文档

- [ ] 定向源码 Vitest、相关回归、无产物 TS、ESLint、Prettier；不运行依赖 dist 的进程测试。
- [ ] 独立只读审查，重要问题先写复现测试再修复。
- [ ] 更新代理插件、配置迁移与质量记录，明确无真实 API、代理启动及 Windows 验收。

## 执行记录

采用当前工作区内直接实施；用户已连续授权此改造并补齐手动订阅范围，不再追加通用确认。
