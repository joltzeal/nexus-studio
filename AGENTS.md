# Raccoon 工程约定

修改前先读 `docs/README.md`、`docs/03-development-standards.md` 和对应模块文档。
当前处于 0.2 重写阶段。`apps/desktop-v2` 是基于 ShardBrowser Launcher 前端源码的独立 UI 基础；`apps/desktop/src-tauri` 是现有 Raccoon Rust 后端。两者**尚未接通**，现有桌面包仍使用 `apps/desktop/src`。不得把网页预览、开发期 mock 或旧后端已存在的接口称为 0.2 已可用的真实集成。
0.2 不在正常运行路径兼容 0.1 的旧 schema、旧 IPC 或旧数据；未来单独设计显式运行的 0.1→0.2 迁移脚本。不得为了迁移阻塞 0.2 的新契约，也不得删除旧用户数据。

## 0.2 产品模型（目标契约）

- 产品是 Raccoon 工作台，不是 ShardBrowser Launcher 换名；借用后者的 UI 与可复用组件，不继承其数据所有权、厂商 API 或后端协议。macOS / Windows 均是目标平台。
- 用户界面统一称 **Profile**，不再称“窗口”；每个 Profile 是一个持久化的浏览器环境。用户可创建、查看、编辑、启动、停止、删除；运行状态与保存状态分别显示。
- Sidebar 保持 ShardBrowser 原版结构、密度、组件及交互：全部配置、搜索、文件夹、视图等；底部切换 Workspace。原版全部配置表格、工具栏、弹窗和设置页作为 UI 基础，不重新手写近似版或叠加 0.1 布局。Raccoon 特有功能使用同一 UI Kit 的模式扩展。
- 一个 Workspace 对应一个**已配置的接入实例**（`connectionId`），不是手动命名的独立工作区。同一厂商若未来允许多个接入实例，也不能仅凭 `providerId` 混合数据。Workspace 中的 Profile、Folder、视图、筛选和勾选按连接隔离；切换时清空临时选择与弹窗，保留适合保留的各自视图偏好。
- Folder 是 Workspace 内的组织单位；不使用 0.1 的跨连接全局“分组”。一个 Folder 不能混合不同连接的 Profile。插件与 Agent 关联始终使用 Raccoon Profile UUID，不使用厂商环境 ID。
- 空白安装不预置样例 Profile。网页预览可有明确的样例，但绝不呈现为 SQLite、厂商或真实执行结果。

## 浏览器接入与创建闭环（目标契约）

- Rust 是浏览器连接、Profile、Folder、SQLite、调度、操作意图和状态恢复的唯一所有者。前端只调用 Raccoon 边界契约，不直接请求各厂商 API，也不直接读写 SQLite。Provider 在 Rust 的 `ProviderRegistry` / `BrowserProvider` 下分派；新增厂商应增加适配器和能力声明，不在通用页面或 Agent 中堆砌厂商分支。
- 默认优先接 AdsPower、比特浏览器：依赖各自本机管理 API，并先探测连接、校验作用域。CloakBrowser、AliasMode 和 ShardBrowser 属于实验室显式启用的受管内核接入，版本、下载和必要授权在实验室维护。Camoufox 暂为占位，未实现前不能开启真实创建。具体引擎能力（例如 Firefox 无 CDP）以实际 Provider 声明为准。
- Workspace 从 `browser_connection_list` 等真实命令读取已启用连接；不能从前端写死厂商列表来假装接入可用。`enabled`、探测可达、内核已安装、授权有效、浏览器进程运行分别是不同状态。创建按钮按连接探测与 `capabilities.create` 决定是否可用；不可用时给明确原因。
- 保留原版“新建 Profile”的视觉与交互框架，但字段依据该 Provider 的能力展示与校验；转换为 Raccoon `CreateWindowInput`，由 `browser_window_create` 统一执行。不同厂商的代理、指纹、内核、版本和其他字段只传给确实支持的能力；不得把 ShardBrowser 的完整配置直接序列化给所有 Provider。
- Raccoon UUID 为 Profile 主键；绑定 `providerId + connectionId + providerProfileId` 创建后不可变，厂商 ID 仅在其连接范围内解释。创建先持久化操作 ID 和意图，再调用 Provider；超时/未知先核对远端结果，不盲目重试并造成重复环境。写入失败不能显示“已保存”。
- 完整接入包含列表、详情、创建、编辑、启动、停止、删除、Folder 和运行状态，以及失败后的核对与重启持久化；禁止只把 `profile_save` 换成 `browser_window_create`，却让其余 ShardBrowser `profile_*` / `process_*` 调用继续指向 mock。
- 第一条真实验收链：AdsPower 与比特各创建一个 Profile，跨应用重启仍能列出，能启动、停止和删除，Folder 不串 Workspace；之后分别验收实验室 Provider。没有用户提供的受控厂商环境时只能使用 mock，不修改真实厂商 Profile，也不声称真实联调已通过。
- 本机厂商管理 API 仅允许经验证的 loopback 地址并独立直连；浏览器必需代理失败时阻断启动，不能自动回退直连。断线、未知、环境暂不可见均不等于已停止或可删除业务关系。

## 前端适配边界

- `apps/desktop-v2/src/pages/profiles` 与 `src/pages/settings` 当前直接复用上游页面和组件；`src/raccoon-preview`、`src/dev/mock` 仅服务网页预览。开发真实接入时在明确的 Raccoon adapter / domain store 上转换数据，逐条替换上游 IPC，不让 mock 与真实后端混用。
- 原版 `profile_save`、`profile_list`、`profile_get`、`process_list`、Folder 与 Settings 协议均不自动等价于 Raccoon 命令；尤其不能通过一个通用 `invoke` 别名把两个数据模型硬接起来。审计并迁移所有读写、轮询和副作用后才切换 Tauri 前端入口。
- 设置页面沿用 ShardBrowser 纵向标签及保存栏；只开放 Raccoon 后端确实支持的设置。上游 API、Storage、Sync、Update 等功能不得使用 mock 返回值冒充 Raccoon 原生能力。实验室使用同一 UI Kit；内核下载、激活码及接入开关在真实命令接好前保持明确禁用。
- ShardBrowser 组件、样式和图标的来源及许可证见 `apps/desktop-v2/README.md`；保持上游的结构与视觉节奏，不把 0.1 的 shadcn 壳层、主题 token 或 `legacy-pages.css` 迁进 v2。不得把借用前端源码解释为已经接入 ShardBrowser 浏览器内核。

## 命令与工作区

- 所有 shell 命令必须以 `rtk` 开头；命令链中每段都加前缀。
- 工作区脚本使用 `rtk proxy pnpm run <script>`，避免 RTK 替换同名命令。
- 需要未过滤输出时使用 `rtk proxy <command>`，仍保留 RTK 前缀。
- 使用 pnpm 和根锁文件；Tauri 优先使用官方 CLI，0.1 的 shadcn 约定不约束 0.2 的 ShardX UI Kit。
- 遵循仓库固定工具链，不为无关任务升级依赖或引入其他 JS 锁文件。
- 本地不执行构建、打包或 Rust 编译/测试/Clippy；可直接运行 Vitest、lint、无产物 TS 检查和 rustfmt。
- 插件按用户 2026-11-14 新要求仅在本地开发、编译和打包并直接发布对象存储；此例外不包括应用或 Rust 构建。`plugins/` 与 `market/` 不提交 Git，公开数据契约放在 `packages/plugin-contracts/`，主应用 CI 不依赖插件源码。
- 根 test/typecheck/check 会触发构建，本地不要调用；直接运行对应工具并如实记录结果。
- 未经要求不创建提交或发布，不将开发构件描述为正式发行证据。

## 数据与运行边界

- 0.1 的窗口、分组、接入、激活码和应用代理目前由 Rust 明文存入 SQLite；0.2 的新数据目录、schema 与 Profile/Folder 契约仍须落地，不能把 0.1 存储称为已完成的 0.2 存储。UI 偏好可用 localStorage，但不能将 Profile 和连接数据仅保存在前端。
- 浏览器预览与 Tauri WebView 按来源隔离，不承诺共享或同步。
- Profile 详情只展示资料；创建、启动、停止和删除分别触发明确的原生操作。
- 插件由独立 Node 进程执行，按能力声明与授权检查调用，不将其称为安全沙箱。
- 外部厂商测试使用受控 mock；没有用户提供的测试环境，不修改真实厂商窗口。
- contracts、plugin-sdk 与 browser-runtime 保留；健康协议未接入页面。
- 区分进程健康、浏览器可用与插件执行，不能使用含混 ready 状态。
- 写入失败不反馈已保存；不要用模拟响应掩盖真实存储错误。
- 示例、源码、日志与 localStorage 不放真实凭据或账号令牌。

## 编码与长期边界

- 使用 strict TypeScript 与边界数据校验，跨包通过公开导出访问。
- `apps/desktop` 的旧主题规则只适用于旧前端；v2 遵循导入的 ShardX UI Kit、Tailwind 与原版页面组件，不在业务 JSX 中写原始色值或新建第二套全局视觉体系。
- 测试有意义的持久化、状态转换、关系一致性、协议失败与恢复行为。
- Rust 是 SQLite 唯一所有者，命令使用结构化错误；明文存储不能描述成加密或系统凭据保管。
- 现有 SQLite 的窗口 schema 2 和迁移 manifest 3 属于旧应用当前事实；0.2 建立独立目录和新 schema，正常启动不读取 0.1 数据。迁移后续由单独显式脚本负责备份、冲突报告和核对，不在新应用内增加运行时兼容读取。
- 真实浏览器要求不可变启动快照、profile 独占锁与必需代理失败阻断，禁止自动直连。
- Profile 的 Provider 绑定创建后不可变。厂商环境 ID 只在 connectionId 下解释，插件关系继续使用 Raccoon UUID。
- 本机厂商管理 API 必须独立直连并验证 loopback；必需窗口代理失败时不能回退直连。
- 写操作先持久化意图，超时核对结果后恢复，禁止盲目重试创建、启动或删除。
- 断线、未知与环境不可见均不代表已停止，不得清空业务关联。
- Manager 只作参考，不成为运行时或数据库依赖；不引入 Python、FastAPI、Docker。
- 未来生成跨语言绑定时固定来源与校验流程，不把手写契约称为已生成绑定。
- 不为未实现功能预建完整环境 schema，不要求用户配置 `.env` 才能使用产品。

## 协作与证据

保留用户修改，尊重并行分工；不覆盖他人负责的文件。
修改当前范围、能力或契约时同步相应模块文档，长期规划与当前事实明确分开。
`docs/09-quality-and-testing.md` 的实际检查结果由主线填入，不虚构通过记录。
未执行 Windows、签名或真实代理集成时明确说明；macOS 壳检查不能替代这些证据。
旧页面行为参考 `docs/11-demo-pages.md`；0.2 前端现状参考 `apps/desktop-v2/README.md`，架构方向参考 `docs/superpowers/specs/2026-11-17-raccoon-02-provider-architecture-design.md`；冲突时按本文 0.2 边界处理并同步更新模块文档。发布约束见 `docs/08-distribution.md`。
