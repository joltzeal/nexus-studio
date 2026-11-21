# Raccoon Provider 工作台重构：设计草案

状态：历史草案，已被 [Raccoon 0.2 浏览器接入重构方案](2026-11-17-raccoon-02-provider-architecture-design.md)
取代。本文关于保留 0.1 schema、旧 AliasMode Local API 和迁移旧配置的建议
不再作为实施依据；尚未修改应用行为或发布。

## 定位

Raccoon 是多个指纹浏览器的窗口、分组、插件与任务的管理调度层。主入口优先展示
AdsPower 和比特浏览器；CloakBrowser 与 AliasMode Chromium 是「实验室」里由
Raccoon 手动启用、下载和维护内核的实验性接入。不再向用户呈现「内置浏览器」
这一类型。启用实验内核后，它们仍在窗口管理里作为独立 Provider 使用，窗口页
保持一套表格、一套业务 ID 和一套插件调用方式。

「默认接入点」表示 UI 中优先发现和引导连接，不代表 AdsPower 或比特浏览器已经
安装、启动或完成授权。外部厂商 API 不可达时应显示未连接和明确操作指引，
不得伪装成可用环境。启用实验室开关也不能自动下载数百兆内核。

## 从现有代码得到的约束

当前已有 `BrowserProvider` trait 与 `ProviderRegistry::get(providerId)` 分派，
所以**不需要从头发明全局工厂**。但下列代码把 CloakBrowser 视作默认的内置特例：

| 层 | 具体位置 | 当前耦合 |
| --- | --- | --- |
| 接入初始化 | `browser/connection_store.rs` | 每次初始化自动建 `builtin-cloakbrowser`；外部接入需人工确认。 |
| 调度与依赖注入 | `window_service.rs` | 持有独立 `builtin: Arc<CloakBrowserProvider>`，并在多个创建、恢复、启动和安装路径对其分支。 |
| 记录与启动 | `window_store.rs`、`window_service.rs` | 只有 CloakBrowser 可存内核路径、版本及种子；其他 Provider 被判作厂商外部环境。 |
| 受管运行时 | `browser/providers/cloakbrowser.rs`、`kernel_service.rs`、`packages/browser-runtime` | SDK 授权、内核安装、启动、代理、进程锁和数据快照专属。 |
| 数据升级及迁移 | `database.rs`、`transfer_service.rs` | 既有数据库一次性升级写入 CloakBrowser 绑定；加密快照限定该 Provider。 |
| 页面 | `spaces-page.tsx`、`window-editor.tsx`、`browser-connections-page.tsx` | 默认 Tab 为 CloakBrowser，列表显示「内置浏览器」，表单按 provider ID 特判。 |
| Agent 与插件契约 | `packages/plugin-sdk/src/agent.ts`、`core/agent/settings.rs` | 并发字段及可用 Provider 枚举写死为 CloakBrowser、AdsPower、比特浏览器；AliasMode 尚不在 Agent 允许列表。 |
| 发行 | `plugin_service.rs`、`runtime_paths.rs`、`scripts/stage-desktop-runtime.mjs` | 启动和打包要求 Node/浏览器适配器文件，Node 同时被插件宿主使用，不能因为下调 CloakBrowser 优先级就把 Node 删掉。 |

因此，这是**跨页面、调度、存储契约、Agent 和发行的重构**；单独增加一个
`createProvider()` 工厂函数不能移除上述硬编码。保留一个 Provider 注册入口和
一个按 ID 分派的调用入口，具体下载、代理和进程实现仍由各 Provider 各自负责。

## 方案比较

| 方式 | 结果 |
| --- | --- |
| 只改默认 Tab、设置文案，保留内置特判 | 成本低，但新内核仍被当成外部接入或依赖 CloakBrowser SDK，长期持续分叉。 |
| **调整接入模型，区分受管内核和本机厂商 API；统一编排，只在 Provider 内实现差异** | 改动跨多层，但与 Raccoon 的中间层定位一致，可逐步上线。 |
| 把全部厂商逻辑合入单一超级工厂 | 失去清晰的错误、代理和恢复边界；难以保持不同内核的版本与数据隔离。 |

选第二种。工厂/Registry 负责发现、创建和分派 Provider，不负责自行实现所有
浏览器逻辑。

## Provider 与接入状态

统一使用 `BrowserProvider` 接口调用
`create / update / start / stop / observe / automation / delete`；Provider 描述中明确
接入模式 `localApi` 或 `managedRuntime`，并由各自报告 capabilities 与 availability。
`WindowService` 根据模式调用通用的意图持久化、独占锁和操作恢复；平台特定校验仍
留在 Provider 内，不以用户可见名称推测能力。

- `AdsPower`、`BitBrowser`：本机 API；设置「浏览器接入」页优先展示，实时探测
  loopback、存储连接、范围确认后才能执行写操作。窗口版本和厂商数据仍归官方应用。
- `CloakBrowser`：受管内核；只在实验室允许下载、检查版本及配置激活码，独立
  `CloakBrowserProvider` 与现有 SDK。不能把它的激活码检查强加到其他 Provider。
- `AliasModeChromium`：新的受管内核 Provider，实验室手动下载官方包、验证并
  安装；独立内核服务，不运行 AliasMode 桌面端。版本固定、进程和 profile 行为
  见[AliasMode 直管内核技术细节](2026-11-17-aliasmode-managed-chromium-design.md)。
- 旧 `AliasMode` Local API：已有 `aliasmode` 绑定不能重解释成新内核绑定。
  旧记录与新 Provider 分开；旧连接若存在，保留查看和恢复入口，不在新安装
  主入口宣传桌面应用。是否最终移除旧 Provider，应以既有窗口的显式处置为前提，
  不能在升级时丢失它们或清空插件关系。

对于受管内核，连接由 Raccoon 创建并拥有本机身份；对于厂商 API，连接必须有
明确的厂商 endpoint、访问范围和在线探测。实验室开关持久化为 Rust/SQLite 状态，
后端在创建新实验窗口时检查状态；不能仅用 `localStorage` 隐藏按钮实现控制。
关闭开关不删除已有窗口、浏览器目录、连接或历史任务；已有环境仍可查看并按
一致的恢复规则操作。

## 页面组织

1. 窗口管理默认选择最近一次使用且仍可展示的 Provider；全新安装优先 AdsPower，
   其次比特浏览器；选择无连接的 Provider 时显示发现/连接引导，不切换成实验内核。
   当实验室启用某内核或该内核已有窗口时，该 Provider 才显示为窗口 Tab。
2. 浏览器接入页优先列 AdsPower、比特浏览器及它们的连接状态；不再写「内置浏览器
   可直接使用」。实验内核的日常下载、版本和激活码移至实验室，不要求连接
   `127.0.0.1:50400` 的 AliasMode 桌面应用。
3. 实验室包含两个独立控制块：CloakBrowser 的激活码/已安装内核/下载更新，
   AliasMode Chromium 的官方发行版查询/安装/升级/安装清单。手动开启只开放
   新建能力，下载是另一次明确操作；不在后台自动换内核版本。
4. 新建窗口表单依 capabilities 显示种子、内核、代理、账号连接和分组；对已有
   窗口只显示创建时固定的版本和身份。批量创建遵循相同能力，并在同批次固定
   具体内核版本。

## 数据、Agent 与发行

保留现有 `WindowRecord` schema 2、Raccoon UUID、`BrowserBinding` 和一次性数据库
升级规则。针对受管内核定义明确的绑定校验，而不是在存储层直接写死
`provider == CloakBrowser`。已存在的 CloakBrowser 窗口继续原样可访问；
不会因为默认入口改成 AdsPower 就自动迁移、删除或改变激活要求。
新的 AliasMode 内核需使用独立 profile 根目录、内核清单和不可变版本。

加密导入导出、跨设备同步和 Ecom Agent 不能直接随 Provider 新增而宣称兼容。
现有迁移仅经过 CloakBrowser 快照验证；AliasMode 内核迁移要另行验证 Cookie、
IndexedDB、跨机器密钥和相同内核版本，AdsPower/比特浏览器的厂商目录由其
应用管理。Agent 的 Provider 并发设置和调用前校验改成依受支持 Provider
定义的 map，保留对已有设置的显式一次性迁移，不扩大到尚无 CDP 的接入。
在数据/契约设计阶段就明确可用性状态、版本和代理失败语义。

Node 仍用于插件宿主、既有内核适配器和 Agent；发布包无需捆绑两个实验内核，
在实验室下载至应用数据目录即可。将应用启动时对实验内核 SDK 的不必要检查
移到对应 Provider 的启用/操作阶段，不能影响仅使用 AdsPower/比特浏览器的用户。
内核升级只新增受管安装版本；老窗口固定老版本，已在使用的二进制不得被覆盖。

## 分阶段实施和检查点

1. 枚举并替换「CloakBrowser 是默认/唯一受管 Provider」的校验与初始化分支，
   明确 `Registry` 为统一调用点，保留现有窗口读写与恢复，优先保证旧数据不变。
2. 实现默认提供方与实验室设置迁移、页面入口和按能力驱动的表单；全新工作区
   不自动创建 CloakBrowser 连接，已有工作区保留原有连接与窗口。
3. 实现 AliasMode Chromium 内核查询、下载、校验、独立 Provider/进程和 CDP；
   对 macOS Intel 给出不支持提示。上游官方当前发布 Windows x64、macOS arm64
   资产，Linux 不属于 Raccoon 发布范围。
4. 联通代理池与认证代理、Agent 公开契约，验证 CloakBrowser 在关闭实验入口
   后已有窗口可用，验证 AdsPower/比特浏览器在无实验组件时仍可完成连接和创建。
5. 完成 macOS arm64、Windows x64 的真实安装、首次下载、离线启动、代理失败、
   多窗口并发、内核升级不改旧 profile、更新安装互斥与 Agent CDP 验收。

首版验收必须区分「默认展示」与「已安装并可用」；默认接入若未检测到厂商
桌面应用，应提供下载/启动指引，但不能声称只安装 Raccoon 就能启动其窗口。
依据仓库约定，此草案阶段不执行本地构建、Rust 编译或正式发布。
