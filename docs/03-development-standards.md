# 开发规范

> 0.2 重写进行中。Workspace 对应已配置的 connectionId，Profile 和 Folder 按连接隔离。
> desktop-v2 的 ShardBrowser 原生命令接入已落地源码，并完成受控 IPC 前端验证。
> Rust 编译、真实内核、代理、重启和双平台验收仍待完成。
> 下文涉及 0.1 页面和旧契约的说明作为历史记录，最新边界以 AGENTS.md 和模块文档为准。

## 当前工作范围

Rust 统一窗口服务管理内置浏览器、AdsPower 和比特浏览器。
SQLite 持久化窗口、分组、接入、操作意图、状态观察、激活码和应用代理；插件经受信任 Node 进程执行。
窗口页保持紧凑表格，只增加提供方 Tabs 及必要的能力与恢复入口。
空白安装不预置样例窗口，真实运行状态来自提供方观察，浏览器预览不模拟原生命令成功。

此次重构删除旧窗口命令、DTO 别名、旧运行时和快照导入兼容路径。
已有 SQLite 只执行一次启动升级；正常读取仅接受窗口 schema 2 和迁移 manifest 3。
旧演示窗口、分组及插件开关的 localStorage 仓库与旧记录适配已删除；
当前表单校验直接位于窗口模块，不依赖演示模型。
最新用户任务已替代最初的“仅演示页面”限制，不能再用旧范围拒绝后端实现。

## CLI 与工具链

优先使用官方 CLI 初始化 Tauri、shadcn 和工程配置，再作必要调整。
基线为 Node.js 24.18.0、pnpm 11.17.0、Rust 1.93.0、Tailwind 4。
版本来自仓库约定，不是“最新版本”声明；具体依赖以清单和锁文件为准。
使用 pnpm 工作区和唯一根 `pnpm-lock.yaml`，不混入其他 JS 锁文件。
依赖变更同步锁文件，不为无关修复顺带升级工具链。
所有 shell 命令必须加 `rtk` 前缀；工作区脚本使用 `rtk proxy pnpm run`。
使用 proxy 保留脚本语义，避免 RTK 替换同名 lint、typecheck 或测试命令。

## 根命令入口

| 命令                                       | 用途与边界                       |
| ------------------------------------------ | -------------------------------- |
| `rtk proxy pnpm install --frozen-lockfile` | 按锁文件安装开发依赖             |
| `rtk proxy pnpm run dev`                   | Vite 前端预览                    |
| `rtk proxy pnpm run desktop:dev`           | Tauri 桌面开发入口               |
| `rtk proxy pnpm run build`                 | 共享包与前端构建                 |
| `rtk proxy pnpm run desktop:build`         | 当前平台桌面开发构件             |
| `rtk proxy pnpm run typecheck`             | TypeScript 类型检查              |
| `rtk proxy pnpm run lint`                  | ESLint 检查                      |
| `rtk proxy pnpm run format:check`          | Prettier 格式检查                |
| `rtk proxy pnpm run test`                  | Vitest 行为测试                  |
| `rtk proxy pnpm run runtime:check`         | 独立运行时协议检查，非 UI 接入   |
| `rtk proxy pnpm run rust:check`            | Tauri Rust 核心编译检查          |
| `rtk proxy pnpm run rust:test`             | 调度器与插件边界测试             |
| `rtk proxy pnpm run rust:lint`             | Rust 格式与 Clippy 检查          |
| `rtk proxy pnpm run check`                 | 根脚本定义的 JS 与 Rust 聚合检查 |

入口存在不代表执行通过，实际结果由主线填入[验证记录](09-quality-and-testing.md)。
不能忽略失败退出码，也不能将纯调度器测试通过描述为真实浏览器验证通过。

按当前协作约定，本地不再执行构建或打包，Rust 编译、测试与 Clippy 也交由 CI。
本地可执行格式、lint、无产物的类型检查和直接调用 Vitest 的测试。
根 `typecheck`、`test`、`check` 脚本会先构建共享包，不作为本地检查入口；
应直接调用对应工具，并在验证记录中注明未执行的编译和安装检查。

2026-11-14 用户要求插件仅在本地开发并直接发布对象存储，因此插件单独编译、
调试和打包作为明确例外；不包含应用构建或 Rust 检查。
2026-11-19 用户进一步要求后续不再执行插件 build 或图像验证；当前协作按此最新约束执行，
不沿用前述例外自动构建插件。直接源码测试、lint、格式与无产物类型检查仍可执行。
`plugins/` 与 `market/` 不提交 Git。公开契约位于 `packages/plugin-contracts/`，
主应用构建不依赖私有插件目录，具体入口见[插件本地开发](50-local-plugin-development.md)。

## TypeScript 与页面

启用 strict TypeScript，外部输入与持久化读取先校验再缩窄类型。
组件聚焦呈现和交互，原生调用与 DTO 校验集中在 `lib/platform`；localStorage 仅用于明确的界面偏好。
使用工作区公开导出，不跨包导入内部源文件，不用 `any` 绕开契约。
固定主页面为窗口管理、分组管理、插件中心和应用设置。
插件二级导航使用宿主目录中已安装、已启用的记录，不在侧栏维护固定插件名单；
专用页面适配器与目录发现分开管理，接入规则见[插件对接规范](14-plugin-integration-guide.md)。
使用 shadcn 基础组件、项目正式变体和[主题规范](04-theme.md)中的语义 token。
JSX 不写原始颜色，保留纸白与钴蓝，遵循现代、克制的后台方向。
左侧为 Raccoon 标识、工作区和紧凑导航，顶栏为面包屑与主题切换。
窗口页使用 shadcn Table 与搜索；创建、编辑、详情用 Dialog，删除用 AlertDialog。
分组保持简洁卡片，插件能力卡不加彩色装饰，设置只保留普通控件。
不展示 ThemePreview、大标题、插画或营销式主视觉，避免厚重古典后台样式。
处理空状态、键盘焦点、长文本、保存错误与窗口缩放。

## 全局 compact 基准

全局采用紧凑尺度，以 shadcn 官方默认组件形态为基础，提高同屏有效信息量。
以下为项目统一尺度约定，不将这些数值描述为所有 shadcn 组件的官方默认值。

| 对象                            | 基准                                 |
| ------------------------------- | ------------------------------------ |
| 常规按钮、输入框、Select 等控件 | 高度 32px                            |
| 主导航项                        | 高度 36px                            |
| 卡片                            | 内边距与内容间距均为 16px            |
| 页面内容区                      | 内边距 16–20px                       |
| 表格单元格                      | 上下 8px，左右 12px                  |
| Dialog 内容区                   | `p-4`、`gap-4`，即内边距与间距 16px  |
| 设置项                          | 标准紧凑控件，不使用大尺寸 tile 选项 |

该基准适用于全部页面；密度选项不能让默认界面退回宽松的大块排版。
通过对齐、分隔和清楚标签保持可读性，保留可见焦点、完整错误反馈与可操作范围。
后续页面与组件复用本节尺度，具体主题 token 与状态遵循[主题规范](04-theme.md)。

## 页面与持久化

0.2 页面壳层、窗口管理和设置导航以 Tailwind 类维护，颜色与尺度由
`apps/desktop/src/theme.css` 定义。其余插件业务页现仍有
`apps/desktop/src/legacy-pages.css` 待逐页迁移；不得继续在其中新增全局壳层覆盖。
AliasMode Chromium 实验室提供官方发行版查询、校验下载与受管窗口接入；
Firefox 使用单独发行包和窗口生命周期，不接入 CDP 或 Agent 自动化。
真实 macOS / Windows 安装和代理验收仍须单独完成。

窗口、分组、浏览器接入和运行状态通过 Rust 命令获取；外观与工作区偏好使用 localStorage。
浏览器与桌面 WebView 的偏好按来源隔离，不承诺共享或同步。
窗口详情只展示资料，打开与停止是独立动作；插件安装与调用反馈来自宿主结果。
持久化失败保留输入并显示错误，不以空列表或模拟成功掩盖错误。
数据不存在、提供方断线与环境不可见分开表达，禁止按空列表清除账号或号码关系。
业务凭据按用户要求明文存储，不进入普通日志、源码、测试夹具或错误通知。

## 原生与适配器规范

Rust 业务以 `Result` 处理可恢复错误，避免在外部输入路径使用 panic。
SQLite 由 Rust 唯一持有；接入 API Key、激活码与手动代理等字段明文保存，不写 Keychain。
插件私有存储同样不能宣称加密。导出文件仍使用显式密码加密，与本地明文存储是两件事。
Rust、Node.js、UI 采用明确适配器与版本化协议，保留生成绑定的后续计划。
浏览器提供方通过 `BrowserProvider` 注册，不在通用服务中堆叠厂商条件分支。
窗口绑定创建后不可变，插件只接收 Raccoon UUID。接入更换账户时新建记录，不改绑旧窗口。
本机管理 API 验证 loopback 并独立直连，不经过应用或环境代理；窗口代理解析失败则阻断启动。
写操作先保存意图，确认远端结果再提交；超时使用操作标记与读回恢复，不盲目重发。
移出 Raccoon 与删除官方环境严格区分，清理插件关系失败时保留删除记录供重试。
manifest 与权限声明不得称为沙箱。
未完成的代理流量集成与发行行为不能用局部测试冒充通过。

## 测试与维护

优先测试持久化、数据校验、状态转换、超时恢复、作用域、代理阻断和跨 Tab 竞态。
不为低风险样式改动编写镜像实现测试，不以测试数量代替质量。
检查只报告实际结果，未执行的 Windows、签名和真实集成不得写为通过。
修改契约或当前范围时同步模块文档，保留用户修改与初始化来源。
不创建未经要求的提交或发布，不将未签名开发产物描述为可正式分发。

## 0.2 原生设置接入（2026-11-18）

`apps/desktop-v2/src/raccoon/Settings.tsx` 沿用上游纵向 Tabs、SettingRow、
SettingsGroup、SaveBar 和 UI Kit 控件。Raccoon 设置的 IPC 与响应校验位于
`settings-api.ts`，状态及默认值消费入口位于 `settings-store.ts`。

| 设置分类         | 当前实现                                                                            |
| ---------------- | ----------------------------------------------------------------------------------- |
| 常规             | 语言选择、单键快捷键、启动最小化、关闭行为说明与主动退出                            |
| 外观             | 浅色/深色/系统主题、自动或指定界面缩放、减少动态效果                                |
| Profile 默认设置 | 时区、浏览器语言、WebRTC、Do Not Track、启动最大化                                  |
| 标签             | 当前 connectionId 下的标签改名、改色、使用数量和确认删除，调用 `browser_tag_*`      |
| 视图             | 当前 connectionId 下的自定义视图改名、侧栏显示和确认删除                            |
| 存储             | Rust 返回 0.2 目录、SQLite 文件大小及 Profile/Folder/代理数量，可复制和打开数据目录 |
| 其他             | 应用网络直连、系统静态代理、手动 HTTP(S)/SOCKS5 代理，调用 `network_proxy_get/set`  |
| 实验室           | 已有 ShardBrowser 开关、内核清单、下载进度和删除                                    |
| 关于             | 实际原生包版本、系统与架构、开发运行标志和开源组件来源                              |

常规和 Profile 默认值由 Rust 的 `workbench_settings.rs` 存入
`v2/raccoon.sqlite` 的 `workbench_settings` 单条记录，读写均校验字段。
启动时按 `startMinimized` 设置最小化窗口。Windows 和 macOS 的 v2 主窗口拦截关闭请求，
隐藏窗口并保持应用运行。Windows 可从通知区域重新打开窗口。macOS 保留 Dock 中的应用图标，
点击 Dock 或菜单栏中的 Raccoon 图标可重新打开窗口。
在「设置 → 通用」可主动退出应用，有未保存的编辑时先提示处理。Linux 的 v2 主窗口使用保存的
`closeBehavior` 设置。Windows 和 macOS 的原生窗口交互待实机验收。

保存栏提交常规、默认值、应用代理和实验室开关。各项成功后更新已确认状态，
后续项失败保留未完成草稿与错误，可再次保存。外观和单键偏好立即写入当前
WebView 的本地存储。标签、视图采用逐项保存，页面明确显示各项操作入口。
视图继续使用上游连接隔离的本地偏好存储，设置页写入后核对实际存储值。

`settings-store.ts` 在原生设置模块加载时读取设置。
官方表单 `loadCreate` 的原生分支通过 `settings-api.ts` 的
`loadNativeProfileDefaults` 每次读取已持久化的默认值，再将默认时区、语言、WebRTC、
Do Not Track 和最大化合入初始表单，由原有 `show` 同时建立 `draft` 与 `saved`。
调用方显式传入的 `preset` 字段优先于默认值。等待读取期间关闭或重开表单时，
旧 session 的结果会被丢弃。用户随后在表单内的编辑按正常保存流程持久化。
默认值读取失败时当前表单展示错误，可关闭后重新打开；设置页也提供重新读取入口。

界面语言用于已接入的上游翻译组件，Raccoon 专用设置文案当前使用中文。
内部自动化已接入 HTTP API/MCP 设置及 ShardBrowser 原生助手入口，具体范围与
实际证据见[浏览器接入](05-browser-integration.md)和[质量记录](09-quality-and-testing.md)。
云同步和团队服务继续显示各自未接入说明。
开机自启动、扩展自动检查、Profile 密码、通用附加启动参数、数据目录迁移、
删除全部数据、遥测和正式更新安装仍缺少对应 0.2 完整闭环，当前设置页不开放写入控件。

此范围的轻量检查为定向 ESLint、无产物 TypeScript 和 Rustfmt。
未执行应用构建、打包、Rust 编译/测试、浏览器启停或真实下载，平台窗口行为、
SQLite 重启持久化与代理网络链路仍需原生验收。实际检查结果由主线记录到质量文档。
