# Raccoon 内部自动化实施计划

> 执行方式为当前会话持续实施，独立模块按明确写入范围并行分工，最后统一审查。

目标为接通上游自动化原生页面、Rust 执行器、SQLite 和多 Provider 会话，保留 ShardBrowser 的组件与执行语义。

架构沿用已确认设计。上游纯执行模块通过 Rust 宿主接口访问 Raccoon 生命周期与存储，前端通过专用 adapter 调用结构化命令。

技术栈为 React、TypeScript、Zustand、Tauri、Rust、CDP、Wasmtime 和 SQLite。

设计依据为 `docs/superpowers/specs/2026-11-18-raccoon-internal-automation-design.md`。

## 全局约束

- 所有 shell 命令以 `rtk` 开头，工作区脚本用 `rtk proxy`。
- 本地不执行应用构建、打包、Rust 编译、测试与 Clippy。
- 不提交、不发布、不操作真实厂商环境。
- 保留当前工作区及并行修改，在现有 `codex/raccoon-0.2-rewrite` 分支增量实施。
- 使用固定上游 `99e780e2e685e5b3b5357c5baee8796e10b3ce1e`，保留来源与 MIT 通知。
- 所有业务资源按 `connectionId` 校验，Profile 使用 Raccoon UUID。
- 结果未知先核对，同一 Profile 独占，必需代理失败阻断。
- 支持程度与当前可验证事实分别记录。

## 审查重点

- Workspace 切换后的异步响应、运行与实时会话作用域。
- 重复运行请求、创建超时、步骤重试及重启恢复。
- Provider 专有协议与标准 CDP 的能力差异。
- 实时编辑器与运行的 Profile 控制冲突。
- 导入项目、模块、子流程引用与秘密参数处理。

## 任务 1 固定接口与上游执行模块

文件范围为 `apps/desktop/src-tauri/src/core/automation/engine/`。

产出上游项目模型、runner、CDP、WASM、请求与数据库模块，并通过 `EngineHost` 接口调用宿主。`runner::start` 接收固定的宿主上下文、项目与子流程快照。宿主上下文显式携带连接和运行身份。

- [x] 引入并保留来源与许可证，通过 EngineHost 接入 Raccoon 所有权。
- [x] 引入全部 68 个步骤分派、分支、变量、子流程及模块，记录能力差异。
- [x] 结果未知保持操作身份，暂停并核对后续处理。
- [x] 叫停前完成 rustfmt 解析，Rust 编译与测试未执行，最后修改未重查。

## 任务 2 接通持久化、宿主和 Tauri 命令

文件范围为 `core/automation/{mod,store,host,commands}.rs`、现有服务的必要扩展、Cargo 清单与原生命令注册。

前端命令统一采用 `browser_automation_` 前缀，原有参数外显式携带 `connectionId`。项目有效负载保持上游结构。运行请求携带稳定的 `operationId`。状态和事件保持上游渲染字段，增加连接与运行身份用于过滤。

- [x] SQLite 保存项目、运行快照与中断记录，保存错误完整返回。
- [x] 实现项目 CRUD、复制、导入导出、模块管理与运行命令。
- [x] 实现 `EngineHost`，Profile 操作走 Raccoon 服务。
- [x] 保留持久化、隔离、幂等和恢复测试源码，Rust 测试未运行。

## 任务 3 Provider 会话与动作能力

文件范围为自动化会话宿主、Provider 的必要会话扩展与引擎 CDP 适配。

- [x] 接入 Provider 会话及运行实例身份校验源码。
- [x] ShardBrowser 使用原生扩展协议，其他 Chromium 按能力映射标准 CDP。
- [x] Firefox 和占位 Provider 返回具体不支持原因，真实执行仍有缺口。
- [x] 实现输入、实时画面、目标选择、脚本与流量适配。
- [x] 共享 Profile 独占与运行租约，未知状态保留待核对记录。

## 任务 4 原生前端与交互闭环

文件范围为 `apps/desktop-v2/src/raccoon/automation/`、自动化实体 API、原生入口及相关副作用。

- [x] 叫停前完成受控 IPC 的连接范围、响应校验和过期响应检查。
- [x] 显式适配自动化命令，挂载原版页面。
- [x] 接通辅助窗口、Fleet、录制、流量和模块入口。
- [x] 保留组件结构与样式，使用上游已有反馈模式呈现能力差异。
- [x] 叫停前完成直接 Node、无产物 TypeScript 和定向 lint，后续停止执行。

## 任务 5 服务入口和集成审查

- [x] 上游 HTTP / MCP 自动化入口接入内部服务，明确认证与连接范围。
- [x] 完成 42 个命令注册及 68 个步骤分派的源码核对。
- [x] 完成独立源码审查，修复已报告的操作核对、DOM、数据库和资源释放问题。
- [x] 按实际证据更新文档与质量记录，记录用户停止测试指令。
- [ ] Rust 编译、真实 Provider、重启恢复和 macOS/Windows 原生验收。
- [ ] 全界面、更多尺寸和原生渲染的像素验收。

## 进度与实施裁定

- 2026-11-18 已获用户确认开始实施。
- 当前工作区含大量 v2 未提交内容。选择原分支增量实施，避免隔离工作区漏掉现有未提交基础。
- 仓库限制优先于通用技能中的构建、提交与全套测试步骤。

### 2026-11-18 集成进度

- 原生自动化客户端和全部上游自动化命令的显式映射已接入。
- 页面挂载、Workspace 异步隔离、辅助窗口、预览清理和原生事件过滤已接入，前端正在做受控渲染验证。
- Rust 引擎、SQLite、宿主、Helper 与 HTTP/MCP 模块正在集成和独立静态审查。
- 客户端和作用域 14 项 Node 测试通过，MCP 6 项 Node 测试通过。
- CloakBrowser CDP 启动参数 7 项 Vitest 测试通过，browser-runtime 无产物类型检查通过。
- 上游 Wasmtime 48 / wreq 0.16 的 MSRV 高于 Rust 1.93，选用 Wasmtime 41.0.4、wreq 0.15.3、wreq-util 0.1.0，并按实际 API 适配。
- Rust 依赖已解析和下载，未编译、测试、Clippy 或打包。

### 用户停止测试指令

用户在本轮实施中明确要求停止运行测试。收到指令后停止测试与浏览器验证，后续仅继续必要的生产代码整合、已知问题修复与文档记录。此前已执行的结果单独保留，指令后修改的验证状态如实标明。

### 生产代码整合

- 已引入上游 runner、CDP、WASM、HTTP、数据库与完整步骤清单，保留 MIT 来源。
- 已接通 SQLite 项目、修订、运行快照、步骤意图、取消、资源归属、模块授权和有界运行产物保留。
- 已接通 Provider 会话、实际协议探测、共享生命周期租约、ShardBrowser Helper 与原生页面、Fleet、API 设置及 MCP 导出。
- 已加入运行结果核对及用户明确确认后的结束与释放，超时编辑/删除通过 owner-aware WindowService 核对路径处理。
- 最后代码修改未再执行测试。Rust 编译、真实 Provider、双平台和像素验收仍有待提供实际证据。

### 本轮交付状态

上述完成项表示源码接入或对应已记录的受控检查已完成。真实执行的剩余验收项
保留在任务 5。收到停止测试指令后，未继续测试或浏览器验证。

- 操作核对统一覆盖 update/delete/start/stop，并校验 connection、Profile 和 owner。
- 运行持久化串行捕获与写入快照，确认终态后释放内存注册表引用。
- 恢复完成后读回 SQLite 权威终态，再退休对应内存运行，持久化失败保留未决状态。
- 叫停前列表与编辑器主内容区在 1280×800、DPR 1、相同数据下各为 0 差异像素。
  比较范围不含侧栏，更多尺寸与原生界面的像素验收待完成。
- 普通预览仍有 `workbench_settings_get` mock handler 缺失警告，原生受控入口无该警告。
