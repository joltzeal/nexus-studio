# 浏览器接入契约

## Raccoon 内部自动化源码接入（2026-11-18）

自动化复用固定上游 ShardBrowser `99e780e2` 的项目页面、步骤库、画布、
实时浏览器、模块管理和 Fleet。原生路径通过 `raccoon/automation` adapter
调用 `browser_automation_*`，所有请求显式携带 `connectionId`。Rust 的
`core/automation` 持有项目、运行快照、步骤意图、资源租约和恢复记录，执行器
采用上游 Rust runner、CDP、Wasmtime、HTTP 指纹客户端和数据库步骤实现。

Provider 通过 `automation_cdp` 提供经校验的运行实例。ShardBrowser 使用其
Motion、Traffic、Script 原生扩展，其他 Chromium 在协议能力核验后映射标准
Input、Runtime、Network/Fetch。标准输入的轨迹与节奏按其实际行为呈现。
Firefox 与占位 Camoufox 的真实执行仍待协议和 Provider 实现，缺少代理热切换
或商业代理服务的步骤返回明确错误。必需代理解析失败阻断操作。

自动化与现有生命周期服务共用 Profile 控制租约，后台运行按连接和运行 ID
隔离。结果未知时保留原步骤与操作身份，暂停核对，确认后再解释分支。工作台
切换清理预览控制与临时界面状态，后台运行继续由 Rust 持有。

本地 HTTP 服务使用 Axum 和 Bearer JWT，默认关闭，用户在 API 设置中显式
启用，仅绑定 `127.0.0.1`。MCP 导出包通过同一服务管理自动化项目和模块。
源码接入、受控前端检查与真实 Provider 验收分别记录，当前验证边界见
[质量记录](09-quality-and-testing.md)。完整设计见
[内部自动化方案](superpowers/specs/2026-11-18-raccoon-internal-automation-design.md)。

## desktop-v2 ShardBrowser 接入（2026-11-18）

v2 原生入口通过 Raccoon adapter 调用 `browser_connection_*`、
`browser_window_*`、`browser_folder_*` 和 `browser_operation_*`。
实验室的 ShardBrowser 启用开关采用草稿与保存栏，内核清单、下载及删除直接
调用 Rust 内核服务。Profile 的创建、编辑、详情、启停与删除复用原版表格和
UI Kit 弹窗框架；Workspace 由已配置连接读取，以 connectionId 隔离。
创建操作 ID 在一次提交期间固定，结果未知时核对持久操作，应用重启后仍可恢复。
`browser_operation_get` 可读回明确失败或已提交的单条操作。
Folder 使用 UUID 及连接范围，新数据库 schema 为 4。

原生开发和发行共用 `apps/desktop/src-tauri/tauri.conf.json`。
普通浏览器打开 Vite 地址时进入明确标注的样例预览。
受控 Raccoon IPC 的前端生命周期测试已执行；Rust 编译、真实内核、代理、
原生重启及 Windows 验收尚待完成。实际检查见质量记录。

## ShardBrowser 直接内核接入（0.2 开发中）

实验室中的 ShardBrowser 由 Raccoon 管理，不安装或调用 ShardBrowser Launcher。
Rust `ShardBrowserProvider` 通过本地适配的 MIT `shardx` SDK 创建持久身份、
启动 Chromium 并提供 loopback CDP；每个窗口的独立 profile 位于 Raccoon
受管目录，SDK 下载的版本位于独立内核目录。新建窗口从已安装版本选择，
绑定之后固定版本和 profile；普通启动不查询或安装新内核。
SDK 源码位于 `packages/shardx-sdk/`，保留上游 MIT 许可，添加了本机固定
内核入口和严格代理出口查询。下载二进制不包含在源码仓库中；用户已确认
取得内核集成许可，但发行时仍须独立留存许可范围及对应产物的授权证据。

创建、启停、删除和 Agent CDP 走统一 `BrowserProvider`。创建收据在窗口目录，
并绑定原始 profile 文件摘要；
运行收据保存 PID、可执行路径与 CDP 调试端点；跨应用启动后须核对进程
命令行及调试端点，无法确认时报告 `unknown` 并阻止重复启动。
代理出口查询失败时阻断启动，不允许通过直连查询填充身份数据。
不支持接管 Launcher 里已有的环境、加密导出和跨设备同步。
当前源码尚未运行 Rust 编译、安装、代理实测或 Windows/macOS 真机启动；
SDK 内核下载现读取 Raccoon 应用代理设置，手动/系统代理无法解析时不回退直连。
该下载链路仍须使用真实网络进行验证。

> 0.2 重写分支现状：新工作区会自动建立常开的 `builtin-bitbrowser` 接入；
> 比特浏览器是默认 Provider，实验室只管理其他实验接入。实验室中的
> CloakBrowser 开关通过原生命令持久化连接启用状态，激活码与内核维护移入实验室；
> 关闭前须确认该接入所有窗口均已停止；无法观察或仍在运行时拒绝关闭，
> 关闭不会删除已有窗口资料。普通连接表单和列表仅显示 AdsPower / 比特浏览器。
> 普通连接激活命令不能启用实验接入；实验接入由实验室专用命令控制。
> 设置页的实验室标签默认隐藏；在侧边栏连续点击版本号六次后解锁，解锁状态保存在本机 UI 偏好。
> 发行资源缺少浏览器 runner 不阻断外部接入及插件宿主启动，
> 激活码验证、内核维护、受管浏览器执行与外部 CDP 自动化在调用时各自报告该资源缺失。
> 旧 AliasMode 桌面 Local API 实现已移除；受管 AliasMode Chromium / Firefox 采用独立
> 内核目录与 Provider，从官方发行包检查、下载并校验 SHA256。下文“内置接入自动建立”“AliasMode
> Local API 可连接”等描述仅适用于 0.1 历史行为，不能作为 0.2 功能承诺。
>
> `apps/desktop-v2` 的实验室已经接入 CloakBrowser 的启用开关、明文激活码回显与校验、
> 内核检查/下载/指定版本/删除、Profile 创建/编辑/启停/删除、Folder、标签、备注和代理。
> CloakBrowser Workspace 复用 ShardBrowser 的大型 Profile 表单、标签栏、属性行和保存栏，
> Basics 保留名称、Folder、标签、颜色和备注，再接固定内核与起始地址；
> Fingerprint 沿用 ShardBrowser 指纹标签的分组标题、字段网格和帮助文案，
> 容纳指纹种子、尺寸、时区、语言和代理出口匹配（含 WebRTC IP）；
> CloakBrowser 新建和编辑独立准备表单，不调用 ShardBrowser 配置或指纹库，
> 新建弹窗不显示指纹库空状态；编辑直接读取该 Profile 的固定内核版本；
> 侧边栏隐藏仅属于 ShardBrowser 的指纹、书签和扩展入口，Profile Peek 也不显示指纹区。
> Profile 绑定内核与种子后不变，
> 克隆会生成新的 Raccoon UUID 和种子。CloakBrowser 启动前写入本地会话收据，
> 重启后可核对浏览器与运行组件的归属，并从 Profile 行结束残留会话。双平台实机验收仍待执行。

## 比特浏览器默认接入（0.2 开发中）

比特浏览器是 0.2 的默认 Provider。空白数据库在 `ConnectionStore` 初始化时
写入固定的 `builtin-bitbrowser` 连接，指向 `http://127.0.0.1:54345`，
保持启用和已确认；重新打开应用会恢复其启用状态，但保留用户改过的本机地址、
名称和默认分组。它不出现在实验室的启停开关里，实验室仍只显式启用
CloakBrowser、AliasMode、ShardBrowser 等实验接入。

本机 API 不可达时，探测返回 `connected: false` 的普通状态，而不是把已保存的
Workspace 当成损坏。所有配置页显示启动引导，创建按钮保持阻断；`browser_bitbrowser_launch`
尝试打开已安装的官方应用并轮询 `/health`，超时后提示完成登录并开启本地接口。
用户也可手动启动后点击重新检测。

创建使用文档中的 `/browser/add`。连接的默认分组优先，其次已有 `Raccoon`
分组、第一个可见分组，最后才新建 `Raccoon` 分组；不把 Raccoon Folder 冒充
厂商分组。指纹表单按 `/browser/add` 的 `browserFingerPrint` 文档覆盖平台身份、
内核类型/版本、UA、系统、显示语言、WebRTC、地理位置、HTTPS 错误、GPU、CPU、
内存、分辨率与窗口尺寸限制、缩放、各类噪声、端口保护、设备信息、TLS 特性、
插件指纹、启动参数和每次启动随机指纹；空值或“默认”不发送。
分辨率必须成对填写，选择自定义分辨率时必须给出宽高；
GPU 厂商/渲染器有值时才附带 `webGLMeta` 自定义标记。
经纬度必须成对填写并做范围校验，端口白名单、Host IP 和长度在表单与 Rust
边界分别校验。新建与编辑共用同一份指纹字段；编辑经 `/browser/update/partial`
只提交变化的指纹键，未知远端字段仍保留。
自定义时区由表单计算当前 UTC 偏差写入 `timeZoneOffset`（小时），与
`isIpCreateTimeZone = false` 一起提交。内核版本转发为 `coreVersion`，
创建后仍可随指纹更新。BitBrowser 仍没有 Raccoon 指纹库、
指纹种子、置顶、Cookie 导入/导出和调试地址复制；侧边栏不显示 ShardBrowser
专属的指纹、书签和扩展入口。

## AliasMode Chromium / Firefox（0.2 开发中）

实验室使用 CloakBrowser、AliasMode、ShardBrowser、Camoufox 标签页；AliasMode 内再按 Chromium / Firefox 管理；
两个已接入提供方的本机已安装版本均可从对应标签页删除，存在窗口绑定或待确认操作时
由后端阻止删除。页面不显示本机缓存目录。AliasMode Chromium 官方仓库明确说明
发行版基于 Apostate，并应用自己的 Chromium 补丁，不是原版 Chromium。

实验室开关写入 SQLite 中的 `builtin-aliasmode-chromium` 接入；内核下载由
`aliasmode_kernels.rs` 查询官方 GitHub Releases，并按 `SHA256SUMS.txt`
核验发行包，保留不同完整发行版本和对应的可执行文件摘要。当前支持
macOS arm64 和 Windows x64。窗口由独立的 `AliasModeProvider` 创建，
绑定本机已安装的固定版本、随机指纹种子和专属 `profiles/aliasmode/<uuid>`，
启动时核对可执行文件摘要；代理缺失或在线出口查询失败时阻断启动。
正常运行期间可经 loopback CDP 执行受控自动化。

受管进程启动时写入 PID、profile 和调试端口收据。应用重启后核对命令行
的用户目录、端口与 Chromium 调试端点 ID 再标记为运行；已核对的进程可从窗口页停止。
无法确认身份时标记 `unknown` 并阻止重复启动，进程退出后才核查
Chromium 锁文件。所有 SOCKS5 代理及 HTTP 认证代理通过仅监听 loopback 的 HTTP
中继转发，不将凭据传给 Chromium 启动参数；浏览器始终向中继发送 HTTP
代理请求，由中继建立上游 SOCKS5 隧道或注入 HTTP 代理认证；HTTPS 认证代理在启动前
明确阻断。应用退出时中继会停止，仍存活的浏览器虽然可以在重新打开
Raccoon 后停止，但代理不会自动重新接管；应停止并重新打开该窗口以恢复联网。
首装下载、macOS 包内符号链接、
Windows 下载与代理、真实登录态及多窗口并发尚未实际验证；
源码接入不等于发行版已通过双平台验收。

Firefox 使用 `aliasmode/aliasmode-firefox` 官方发行的单独包和 `SHA256SUMS`，
按固定引擎与完整版本创建独立目录。启动按官方 `CAMOU_CONFIG_n` /
`CAMOU_PREFS_n` 传入配置，窗口可选屏幕尺寸、操作系统、CPU 数量与固定种子。
Firefox 不启用 CDP，也不向 Agent 提供浏览器自动化；仅支持人工窗口启停。
Chromium 按官方启动方式设置 `GOOGLE_API_KEY`、`GOOGLE_DEFAULT_CLIENT_ID`、
`GOOGLE_DEFAULT_CLIENT_SECRET` 为 `no`，抑制缺少 Google API Key 横幅。
Firefox 的原生启动、跨平台偏好、代理隔离和关闭后的状态恢复仍需实机核对，
不能因内核已安装或进程启动就承诺网页指纹和流量均符合官方 Manager。

## 0.1 历史实现（以下至“外部连接与能力”均非 0.2 承诺）

桌面窗口统一通过 `WindowService` 管理，按
`BrowserBinding { provider_id, connection_id, profile_id }` 分派到内置 CloakBrowser、
AdsPower、比特浏览器或实验性 AliasMode。Raccoon UUID 是业务窗口和插件关联的 `windowId`，
厂商环境 ID 仅保存在绑定中。`origin: created | attached` 区分创建与接管，
接管不会复制厂商目录，也不会自动启动环境。

内置 Provider 通过受管 Node.js 适配器调用官方 JS 包装层；
外部 Provider 只调用厂商桌面应用的 Local API，不经过内置 SDK、激活码或内核缓存。
`browser_window_create`、`browser_window_update`、`browser_window_start` 等命令
共用统一 DTO，不保留旧 `profile_*` 命令别名。

## 外部连接与能力

0.2 普通浏览器接入仅提供 AdsPower 和比特浏览器，其中比特浏览器是常开默认接入，
空白安装也会建立固定连接；CloakBrowser 只在实验室
显式启用，启停不删除已保存的窗口。AliasMode Chromium 在实验室启用、
下载内核后可创建独立窗口；旧 AliasMode Local API 不再使用。外部接入一次「连接并启用」完成
保存、实时探测、范围确认和启用。
AdsPower 默认地址为 `http://127.0.0.1:50325`，比特浏览器为 `http://127.0.0.1:54345`；
地址、连接名称和默认厂商分组折叠在「更多设置」，只有 AdsPower 展示可选 API Key。
外部浏览器仍需在官方应用中登录并开启本机 API；比特浏览器未运行时由工作台引导启动，
不会静默直连或伪造空环境列表。
当前 AdsPower 和比特浏览器探测都返回空 `scopeId`；
连通成功和用户填写的说明都不能证明稳定的厂商账户身份。
保存连接、应用重启或外部观察失败后需要重新确认，确认前阻断写操作。
切换账户或工作区应新建连接，历史窗口不改绑；同一 Provider 同时只启用一个连接。
原「账户 / 工作区名称」是本机手工标记，并非厂商登录信息，界面不再要求填写。
新连接内部以连接名称建立标记；既有标记与已绑定窗口保持不变。
检测失败保留已保存的连接 ID 供重试；配置未改变时只做重新确认，
已启用连接不重复激活，避免待处理操作阻止账户确认与操作恢复。

API endpoint 只接受 loopback HTTP(S) 根地址，不接受凭据、查询或 fragment。
请求固定到校验后的 loopback 地址，拒绝重定向、绕过应用/系统代理，并禁用自动重放。
AdsPower 支持可选 Bearer API Key；当前比特浏览器适配器不接受 API Key 配置。
发现环境和厂商分组使用 `browser_profile_discover`、`browser_group_list`，
接管使用 `browser_window_attach`；Raccoon 分组关系与厂商默认分组不是同一概念。

| 能力                       | 内置 CloakBrowser            | AdsPower                        | 比特浏览器                           |
| -------------------------- | ---------------------------- | ------------------------------- | ------------------------------------ |
| 创建、启动、停止、删除环境 | 受管实现                     | 已有 Local API 适配，待真实验收 | 已有 Local API 适配，待真实验收      |
| 接管已有环境               | 不提供外部接管               | 按连接发现并登记                | 按连接发现并登记                     |
| 编辑厂商配置               | 支持受限配置，身份字段不可变 | 未验证，不可用；在厂商应用编辑  | 支持表单映射的指纹字段，未知字段保留 |
| 插件代理                   | 原生解析并在失败时阻断       | 未验证，不可用                  | 已有映射路径，待真实验收             |
| 指纹种子                   | Raccoon 数字种子，创建后固定 | 厂商管理，不接受 Raccoon 种子   | 厂商管理，不接受 Raccoon 种子        |
| 内核选择                   | 完整包版本，创建后固定       | 厂商管理                        | `coreVersion`，创建后固定            |
| 加密导出与同步             | manifest3 内置快照           | 不支持                          | 不支持                               |

以下为 0.1 AliasMode Local API 历史设计，0.2 已删除此适配器，不能作为当前
接入或自动化能力使用。旧 Provider 使用其 [Local API OpenAPI](https://github.com/aliasmode/aliasmode/blob/main/docs/public/local-api.openapi.json)，
默认地址为 `http://127.0.0.1:50400`。本机需先运行官方应用及 API；不接受 API Key。
支持默认指纹的 Chromium 直连环境创建、启动、停止、删除，以及运行中 CDP 的 Ecom Agent
自动化。创建通过持久操作标记和 `user_id` 回读确认，缺少稳定 `created_time` 时保留不确定
操作，避免将未知环境绑定为已确认。删除前后核对身份、停止状态、`deleted/locked`
回执及环境列表；失败或超时保留恢复入口，不盲目重试。
不支持接管已有环境、厂商配置修改、手动或插件代理、自定义时区/语言/尺寸/起始地址、
指纹种子、内核版本选择和加密转移。官方列表 API 不提供代理详情，因此无法验证用户
在 AliasMode 应用内事后修改的代理；本接入不能承诺实际流量始终直连，也不能用它
执行要求必需代理的窗口。此路径仅有受控 mock API 测试，未在真实 AliasMode、代理或
Windows 上完成验收，不把实验性接入描述为已完成真实环境验证。

AdsPower 的 `update` 和 `proxyPlugin` 能力均已在适配器关闭，
不能因通用接口存在这些字段就将其显示或承诺为可用。
编辑与插件代理须在真实验证完成后才能开放，不能通过覆盖完整指纹来实现未经验证的更新。
通用能力字段仅描述适配范围，不能替代真实厂商、版本和平台验收。

外部窗口的运行状态来自 Local API 观察。`unknown` 不等于 `stopped`，
`missing` 不触发插件关联删除；断开时保留历史身份，不按名称寻找替代环境。
解除 Raccoon 关联和删除厂商环境分别由 `deleteEnvironment` 表达。
退出或更新 Raccoon 不自动停止厂商环境。创建响应不明时通过持久操作 ID 协调，
不能盲目重试，细节见[核心后端](12-core-backend.md)。

## 内置运行时输入

以下快照、出口匹配、代理桥接和就绪协议仅适用于内置 CloakBrowser。
新建默认请求最新稳定内核，也可选择已安装的完整包版本；
下载、启动和浏览器快照需要内置激活码，内核策略见[浏览器内核](27-browser-kernels.md)。
`CloakBrowserProvider` 持有授权、内核、网络和运行时资源；
`packages/browser-runtime` 包含独立健康协议与真实持久上下文适配器。
`profile-runner` 处理内核准备、清单、授权校验、启动、便携状态校验与导出。
该名称是内部 CLI，不是旧 Tauri 命令兼容入口。

`launch` 和 `snapshot` 的 stdin 直接接收 `WindowRecord` v2：
必须有 `schema_version: 2` 和内置 Provider/连接绑定，`proxy_endpoint` 为整数或 `null`，
`settings` 按当前 schema 校验。`kernel_version` 保存完整包版本，
可选 `provider_config.displayVersion` 单独保存 Chrome 显示版本。
旧记录、缺失字段的默认补写和外部绑定都不能作为运行时兼容输入。
只有既有 SQLite 数据在应用启动初始化时执行一次 SQL 升级，见[本地数据](07-data-storage.md)。

`profile-runner version <binaryPath>` 离线执行指定内核的 `--version`，
以 `{ "version": "...", "binary_path": "..." }` 返回实际显示版本和输入路径。
二进制探测有 10 秒截止，原生调用另设 20 秒上限，不启动 Profile 或访问激活服务。
迁移用它核对本机缓存内核与窗口显示版本，完整内核包修订号另与记录及清单核对。
Manager 只作产品与隔离行为参考，不作为本应用的运行依赖。

## 窗口加密转移的便携状态契约

`profile-runner snapshot <userDataDir>` 从 stdin 首行读取与 `launch` 相同的
`WindowRecord` v2 JSON，核对内置绑定和精确内核后用该内核启动 headless 持久上下文，
调用 `context.storageState({ indexedDB: true, opfs: true })`，
关闭浏览器后仅向 stdout 输出一行：

```json
{ "schemaVersion": 1, "storageState": { "cookies": [], "origins": [] } }
```

主程序在导出或同步的任何运行时、插件和目录操作前检查整批 Provider；
混入任一外部窗口即拒绝整批，不读取厂商目录。
快照 manifest 只接受版本 3，携带 v2 记录和能力快照，旧 manifest 没有导入适配器。
这里的便携站点状态仍为 `schemaVersion: 1`，与 manifest 和记录版本无关。

主程序负责内置原始 `user-data` 目录复制与加密归档。导入主程序将上面的完整对象写入
`<userDataDir>/../portable-state.json`；Node 适配器在下一次正常 `launch` 时读取并恢复，
成功后删除便携状态文件，失败则保留文件并阻断启动。该文件是含会话数据的明文，
仅用于受管 Profile 的导入，不应进入日志、源码或非加密导出文件。
Cookie 由浏览器上下文 API 解密导出并在目标机器重新写入；
不能仅凭复制原始 Cookie 数据库和 `Local State` 承诺跨机器会话可用。
刚导入、尚未正常打开的窗口若再次导出，snapshot 会先离线恢复待导入状态再采集，
并保留该便携文件，直到正常启动成功恢复后再消费，避免将空目录重新导出为空会话。

导入在内核准备、插件检查与文件/SQLite 修改之前，先调用
`profile-runner validate-state <absolute-path> [absolute-path...]`。
命令接受 1–100 个绝对路径，按顺序读取并用恢复路径相同的完整 parser 校验，
每个文件最多 128 MiB；读取期间增长的文件也受相同上限约束。
所有文件有效后仅输出 `{"valid":true}` 一行并以 0 退出。
失败时 stdout 为空、退出码非 0，stderr 仅含
`PORTABLE_STATE_INVALID_ARGUMENTS`、`PORTABLE_STATE_READ_FAILED`、
`PORTABLE_STATE_TOO_LARGE` 或 `PORTABLE_STATE_INVALID`。
该操作不读取 stdin、不加载浏览器 SDK、不启动浏览器或访问授权/网络；
主程序另给校验子进程设置 30 秒上限，避免无效状态在下次启动时才被发现。

Snapshot 从创建上下文时即离线，跳过代理插件解析、GeoIP 与起始地址，
并阻断页面外部请求。Playwright 新建持久上下文不会自动追踪磁盘中已有的 origin；
适配器通过 Chromium 本地 `chrome://settings/content/all` 的站点数据列表发现
已有存储，再以拦截生成的空白文档登记 origin。该 Chromium 内部接口不兼容、
发现不支持的分区存储或 origin 时直接导出失败，不返回缺失存储的成功结果。

恢复使用所固定 Playwright `1.64.0` 的公开
[`context.setStorageState` API](https://playwright.dev/docs/api/class-browsercontext#browser-context-set-storage-state)。
其内部以拦截的空白页面初始化 origin，且绕过 Service Worker，
不向原站点发送初始化请求。保留 IndexedDB 的结构化编码、索引、版本与 OPFS 文件；
未知格式、浏览器拒绝或超时会阻断启动并保留文件，成功完成后才删除。
公开 API 会替换 Cookie 与所涉及 origin 的存储，所以导出同时包含 OPFS。
便携状态不覆盖 sessionStorage、系统密码库、硬件通行密钥或浏览器扩展的私有状态，
也不承诺完整保留 Service Worker 与缓存状态；
不能将原始目录复制描述为这些数据已完成跨机器解密。适配器不新增应用凭据的
Keychain/系统凭据库接入，Chromium 本身的存储行为仍由内核负责。

固定 Playwright 构建的 IndexedDB collector 会遗漏 falsy 值，
且直接 JSON 化非有限数字会改变数据。适配器仍调用公开 `storageState`，
同时通过离线 origin 的 IndexedDB API 读取记录，以 Playwright 支持的
encoded-value 格式补全索引、键和值。覆盖 `0`、`false`、`null`、空键、
非有限数字、Date、BigInt、ArrayBuffer/TypedArray、Map、Set 与循环引用；
Blob、CryptoKey、DataView 等不受该格式支持的类型明确导出失败，不退化成空对象。

历史执行结果统一见[质量与验证](09-quality-and-testing.md)，不作为当前重构的通过记录。
本次文档更新未执行 Rust、真实内核、厂商 API、跨机器或 Windows 登录恢复验证。

## 内置配置来源与映射

配置选项参考 CloakBrowser 官方
[JS README 的 Launch、Persistent Context、Fingerprint Management 部分](https://github.com/CloakHQ/CloakBrowser/blob/main/js/README.md)。
实际接入时必须按选用的 SDK 与二进制版本复核选项。

| 窗口字段           | 官方能力                                                    | 当前处理                                           |
| ------------------ | ----------------------------------------------------------- | -------------------------------------------------- |
| 独立窗口           | `launchPersistentContext({ userDataDir, headless: false })` | 原生 Profile 独立目录，显式打开后启动              |
| HTTP / SOCKS5 代理 | `proxy`                                                     | 手动地址或插件解析；代理失败则阻断                 |
| 出口自动匹配       | `timezone`、`locale`、`--fingerprint-webrtc-ip`             | 在线查询；有代理且未显式关闭时启用                 |
| 时区、语言         | `timezone`、`locale`                                        | 手工覆盖；空值使用在线结果或包装层默认             |
| 尺寸               | `viewport`                                                  | 默认或两个常用尺寸                                 |
| 指纹种子           | `--fingerprint=<seed>`；持久化 profile 会保留种子           | 创建时手填或随机生成于 `10000–99999`，之后不可修改 |
| 起始地址           | Playwright 页面导航                                         | 仅允许不含凭据的 HTTP(S) 地址                      |

`settings.cloakbrowser` 保存 README 列出的单项指纹覆写：平台身份、GPU 厂商、
硬件线程、设备内存、屏幕宽高、平台版本、存储配额、任务栏高度、WebRTC IP、
噪声、第三方 Cookie、SAPI 语音、触摸点数、默认搜索引擎、透明代理及其 DNS、
可移植 Cookie，以及关闭伪装的 `--fingerprint=off`。
单项为空时不生成对应参数，由种子继续提供一致值；只有明确填写的项目才覆写。
官方仍建议把种子作为身份主体，因为任意组合单项可能破坏一致性。

CloakBrowser 的颜色和标签关系复用可选 `settings.shardbrowser._meta`；
该字段对 CloakBrowser 只保存 `navigator.platform` 与 `_meta`，不参与 SDK 启动。
后端草稿校验允许 ShardBrowser 与 CloakBrowser 携带此字段，其他 Provider 仍拒绝。

## 内置代理启动与就绪时序

适配器核对 `--version` 后同时传递绑定路径与 `browserVersion`，
避免 SDK 在只有本地路径时将代理鉴权功能按未知版本处理。
正常代理启动保留完整连接 URL、认证信息与出口自动匹配，不在失败时回退直连。
当前持久字段为 `settings.geoip`，新建默认开启；v2 读取不接受缺失 settings，
直连不进行在线匹配。
适配器通过窗口代理依次请求 `https://ipwho.is/?fields=ip,success,country_code,timezone.id`
与备用 `https://api.ip.sb/geoip`，取得出口 IP、IANA 时区和国家代码；
语言由国家代码经 Node Intl Locale 推断，手工时区和语言优先。
接口不要求用户填写第三方密钥，不使用风险评分阻断窗口。
每个请求最多 5 秒，主接口超时、限流或返回无效数据时尝试备用接口。
两者都不可用时报 `PROFILE_GEO_ONLINE_UNAVAILABLE`；
两次均为代理连接/认证失败时报 `PROFILE_GEO_PROXY_CONNECT_FAILED`。
错误不包含代理凭据，也不会自动切换直连。

请求使用显式 Undici dispatcher，HTTP(S) 和 SOCKS5 均携带窗口代理认证，
不沿用应用代理或开发机的全局 fetch。SOCKS5 将目标域名交由代理解析。
返回 IP 必须有效且非 loopback/未指定地址，自动时区必须可被 Intl 识别。
手工填完时区和语言仍要求在线取得出口 IP，以匹配 WebRTC；
停止或启动超时会取消请求并回收连接。
所有启动入口均显式传 `geoip:false`，包括直连、关闭自动匹配和离线快照；
在线解析完成后将时区、语言和 WebRTC IP 交给最终持久上下文，
不调用 SDK 的 GeoIP 解析、不读取或下载 GeoLite2 数据库。
指纹种子参数保留，现有窗口内核绑定不变。

SDK GeoIP 数据库依赖已从本应用启动路径移除，
`mmdb-lib` 和 `socks-proxy-agent` 不再是应用显式生产依赖，
并通过工作区 `ignoredOptionalDependencies` 排除 SDK 的这两个可选依赖。
SQLite 和迁移契约中的 `geoip` 是当前自动匹配开关，
不表示启用 SDK 数据库功能；页面统一称“出口 IP 自动匹配”。
staging 与安装包 smoke 检查 SDK 的 `playwright-core`，
以及运行时的 `undici`、`socks`，缺失时报 `BROWSER_RUNTIME_DEPENDENCY_MISSING`。
SDK 启动阶段保留 60 秒上限及网络取消信号，迟到的上下文也会关闭。
适配器在 SDK 启动失败时也会关闭 stdin 读取器，防止已报错的子进程继续等待输入，
使原生窗口持续显示启动中直至外层 120 秒超时。

时区与语言经 SDK 的 `--fingerprint-timezone`、`--lang`、
`--fingerprint-locale` 传递，出口 IP 由适配器追加
`--fingerprint-webrtc-ip=<exitIp>`。
不再为旧 macOS 内核追加语言兼容参数。

认证 SOCKS5 现使用仅监听 `127.0.0.1` 临时端口的 SOCKS5 relay，
每条上游连接由既有 `socks@2.8.7` 携带原始完整账号密码，
浏览器与在线查询均走该路径，不自动直连。查询通过 SOCKS5 relay，
让服务域名也由上游解析；出口 IP 来自远端 HTTPS API，不将本地 relay 地址
当作匹配值。relay 的客户端/上游握手有 15 秒上限，
启动失败、启动超时与浏览器关闭均回收监听端口和连接；
启动 relay 失败报 `PROFILE_PROXY_BRIDGE_FAILED`。

代理集成测试使用临时本地 SOCKS5 与 HTTPS 服务，测试证书仅在子进程中信任。
显式运行需要 `NEXUS_TEST_BROWSER_BINARY`、`NEXUS_TEST_BROWSER_CACHE` 和
`NEXUS_TEST_LICENSE_KEY`：二进制必须属于测试缓存内的受支持安装目录，
缓存应是预先下载最新内核的独立测试目录，不使用用户 Profile。
没有这三个参数时跳过真实浏览器测试。历史执行结果见[质量记录](09-quality-and-testing.md)，
不能作为当前授权内核或 Windows 的验证结论。

`NEXUS_READY` 表示真实持久浏览器上下文已创建，且待导入便携状态已成功恢复。
正常启动也从创建上下文时设置 `offline:true`，恢复成功后才 `setOffline(false)`，
再发就绪信号和导航，避免复制的旧 Profile 在便携 Cookie 替换前发送站点请求；
失败时保持离线并关闭上下文。该浏览器离线设置不阻断 Node 层的代理/GeoIP 解析。
远程 `startUrl` 导航独立执行，使用 `domcontentloaded` 与显式 30 秒截止时间，
不会阻塞就绪通知或停止命令。导航失败只产生不含 URL/凭据的
`PROFILE_START_URL_FAILED` 诊断，保留可用浏览器供用户操作。
浏览器自行关闭时适配器退出命令等待，stdin 读取器也会关闭。
原生侧在启动超时或就绪前 stdout 提前 EOF 时先请求关闭，再核对并回收该 Profile 的本机进程；
SOCKS5 地址校验接受普通 `socks5://host:port` 的空 path（含 IPv4/IPv6），
仍拒绝真实 URL 路径，避免合法代理在原生校验处被误拒绝。

## 生命周期与安全边界

内置 Provider 负责受管目录和进程，`WindowService` 负责业务锁、状态与操作协调；
Node.js 适配器封装内置官方 SDK。外部环境由厂商应用持有，通过 Local API 控制和观察。
不同 Profile 的启动和停止可并行；Raccoon 不自行猜测或固定 CloakBrowser 并发席位。
超额由 CloakBrowser 启动错误裁决。「检查授权席位」按需读取官方实时席位计数和本机会话。
UI 只接受稳定 DTO，不持有进程句柄或调试端口。启动前生成不可变、经过验证的快照；
修改窗口配置不静默改变已运行会话，重启后才应用。
代理必需时，配置无效、不可用或鉴权失败必须阻断启动和敏感流量，
禁止自动回退直连。官网指出部分 Playwright request API 不走浏览器 SOCKS5/认证 HTTP 代理，
适配器必须单独约束这类请求，不能凭页面代理配置声称全部流量已受保护。
日志仅存脱敏摘要，代理密码和许可证不进入 localStorage。

## Ecom Agent 自动化端口

当前浏览器工具层采用现有 `playwright-core` 与受管 Node 运行时，供 Rust 宿主网关调用。
它不包含销售流程、插件权限检查或持久任务协调；这些由
[Ecom Agent 架构](44-sales-agent-architecture.md) 所述宿主负责。
`WindowService` 提供以下 Rust 接口，均返回 `BrowserResult`，不是直接开放给页面的 IPC：

```rust
pub fn agent_window_snapshot(&self, id: &str) -> BrowserResult<Value>;
pub fn acquire_agent_window(&self, id: &str, owner: &str) -> BrowserResult<()>;
pub fn start_agent_window(&self, id: &str, owner: &str) -> BrowserResult<()>;
pub fn agent_browser_execute(&self, id: &str, request: Value) -> BrowserResult<Value>;
pub fn release_agent_window(&self, id: &str, owner: &str) -> BrowserResult<()>;
```

窗口快照仅含 `id/name/providerId/connectionId/profileId/state`，不包含代理、密码、
API Key 或许可证。宿主先取得持久账号/窗口/profile 锁与租约令牌，再用稳定 `owner`
取得本机窗口租约。该租约阻止手动启动、停止、修改、删除、转移、连接切换和安装更新。
Agent 使用独立 `start_agent_window`，要求匹配 owner，仍执行原有代理解析、启动意图、
状态核对与失败阻断；不能绕过普通 busy 检查调用手动入口。
宿主每次执行前验证持久令牌和账号/profile 关系；本机租约不代替持久锁或授权。

工具请求格式固定为 `{ operation, origin, input, timeoutMs? }`：

| operation         | input                    | 结果                                                       |
| ----------------- | ------------------------ | ---------------------------------------------------------- |
| `navigate`        | `{url}`                  | `{url}`                                                    |
| `snapshot`        | `{maxChars?}`            | `{url,title,text,controls:[{index,role,name,type,value}]}` |
| `click`           | `{target}`               | `{completed:true}`                                         |
| `submit`          | `{target,operationId}`   | `{completed:true,operationId}`                             |
| `fill` / `select` | `{target,value}`         | `{completed:true}`                                         |
| `upload`          | `{target,files}`         | `{completed:true}`                                         |
| `readFields`      | `{fields:{name:target}}` | 字段值对象                                                 |
| `request`         | `{path,method:"GET"}`    | `{url,status,text}`                                        |

`target` 只接受 `css/role/name/label/placeholder/testId/index`；选择方式最多一种，
`name` 仅用于 role，`index` 可选择快照可见控件或缩小指定选择器。
CSS 不接受 Playwright 的 `>>` 选择器链；表单变更与提交还核对目标文档来源，
拒绝将 iframe/object/embed 作为动作目标，不能通过选择器跨入其他来源的表单。
快照最多 100 个控件和 100,000 字符，默认 20,000 字符；字段最多 32 个，
`readFields` 单字段最多 16,384 字符，与 `fill` 一致，高于商品描述的 6,000 字符上限；
截断后的超长内容仍会超过商品校验上限，不能冒充完整合法描述。
请求和单行回执仍最多 256 KiB，截止时间默认 30 秒、最多 120 秒。
`navigate` 可在同一来源内访问 `/items/new` 和 `/inbox/<id>` 等平台路径，
复用原 profile 与页面，不重建环境。普通 `click` 读取实际 DOM，拒绝 submit/image
类型及发布、发送、删除、确认、支付等最终动作标签；button/link 角色及其子节点
同样受限，不能用 `type=button` 绕过。运行时覆盖适配器支持的完整发布/发送词表，
包括 Upload、List item、Hochladen、Mettre en ligne 及其他支持语言，
按 NFKC、空白、末尾必填星号和大小写归一后逐个名称来源精确匹配；
保留危险动作的通用识别。最终动作必须使用 `submit`。
`submit.input.operationId` 为宿主预先准备并验证的稳定 UUID。运行时在点击前记住该 ID，
重复 ID（包括上次调用失败或超时）拒绝重发，每个租约最多 256 次最终动作。
运行时不能自行证明 action 已持久化；Rust 协调器负责验证 prepared action、
账号/窗口/profile 与租约令牌。`completed` 仅表示点击调用结束，不代表平台发布已确认。
密码表单值与敏感 JSON 键脱敏；错误不回显 Playwright 调用日志、输入值或凭据。
`select.value` 同时与当前可选且未隐藏 option 的实际 value 和可见 label 精确匹配，
仅有一个匹配时选择该 DOM option；缺失、重复 label/value 或 value/label 冲突均拒绝，
不猜测平台分类或成色 ID。
上传最多 20 个绝对路径，必须由 Rust 工件网关解析授权引用后提供，
插件/模型不能自行选择本机文件。路径格式校验不代表工件授权。
`upload` 仍接受 `{target,files}` 并返回 `{completed:true}`；宿主外侧的
`{target,artifactIds}` 契约不变。target 为 file input 时直接设置受控文件；
为观察到的 Add photos 等可点击入口时，先拦截该页 filechooser，再点击入口。
实际 file input 必须属于绑定页面的主 frame 和固定来源，不向子 frame 或其他页面
提供文件；入口也执行最终动作保护，不能用 upload 绕过 prepared submit。
等待 chooser 与点击均收敛后才结束操作，期间持续拦截文件对话框；
超时不反馈完成，移除本次监听器，不保留可能消费后续上传的等待者。

`origin` 必须是工具层明确列出的 Vinted HTTPS 根域或 www 域来源，不接受其他子域、
凭据、非标准端口或通配后缀。actor 首次调用固定 exact origin，导航和后续操作均核对；
禁止原始 JavaScript、任意 Cookie、HTTP 请求头及远端 API 地址。
同源 GET 使用固定 `page.evaluate` 脚本中的浏览器 `fetch`，禁止跳转，
响应体最多 64 KiB，复用当前登录态、profile 与窗口网络路径；不调用 Node fetch
或 Playwright APIRequestContext。网站本身加载的资源不等于工具获准访问任意 API。
页面与 locator 的固定脚本均作为独立函数传给 Playwright，由其序列化并调用，
不传未调用的箭头函数字符串；工具输入仅作为数据参数。

每个窗口只有一个 actor；窗口之间可并行。已有目标来源页面多于一个时拒绝猜测；
已绑定页面关闭后拒绝自动换页。actor 不关闭用户已有页面或浏览器。
释放会撤销页面导航保护并清空 actor 的来源绑定。
每个租约最多记住 256 个最终动作 ID；仅在无未收敛操作且释放成功后清空本机重放集合，
同一受管 runner 可继续后续租约，跨租约防重仍由宿主持久 action journal 与 fence 负责。
超时只结束调用等待，仍保留底层操作与租约。收到最终收敛回执前，
后续执行和释放返回 `operation_pending`；未收到回执的断线不会释放占用或自动重连。
持久外部写入结果仍须由宿主核对，底层操作收敛不等于平台写入成功。

内置模式复用 `launchPersistentContext()` 的同一个上下文和已有 runner，
不会第二次启动浏览器。stdin 在首行 v2 配置后接受带 `requestId` 的工具 JSON，
stdout 保留 `NEXUS_READY`，增加
`NEXUS_AUTOMATION {"requestId":"...","ok":true,"result":...}` 或
`{"requestId":"...","ok":false,"error":{"code":"...","message":"..."}}`。
超时先回 `AUTOMATION_TIMEOUT`，操作实际结束后再以同一 ID 回
`AUTOMATION_SETTLED`；Rust 有界 stdout pump 按 ID 关联，忽略无关 ID。
内部释放命令为 `{requestId,control:"release"}`，不是公开 Agent 工具。
原来的 `stop`、浏览器关闭退出和离线恢复行为保留。

外部模式经 `BrowserProvider.automation_session` 独立只读扩展取得端点：
AdsPower 使用 V2 `GET /api/v2/browser-profile/active` 的 `ws.puppeteer`，
比特浏览器使用 `POST /browser/ports` 的 profile 到端口映射，再直连该端口
`/json/version` 取得浏览器 WebSocket。两者先验证不可变绑定和厂商身份；
只允许回环 IP 的 `/devtools/browser/<id>`，localhost 固定为 127.0.0.1，
拒绝凭据、查询、跳转及远端主机。发现会话不调用 start/open 或修改代理。
受管 `profile-runner automation-cdp` 从 stdin 接收经审核的端点，
通过 `connectOverCDP` 附着唯一已有上下文；不要求安装新的组件或配置环境变量。
释放/退出只终止 Node actor、断开 CDP，不发送 `Browser.close` 或停止厂商环境。

上述厂商接口已按官方资料核对：
[AdsPower V2 状态](https://localapi-doc-en.adspower.com/docs/Check-Browser-Status-V2)、
[比特浏览器窗口接口](https://doc2.bitbrowser.cn/jiekou/liu-lan-qi-jie-kou.html)、
[Playwright CDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)。
本轮验证限于受控运行时测试、TypeScript/lint 与 rustfmt；
不宣称已完成 Rust 编译、真实厂商账号、真实代理、Windows 或发行验证。
运行时另保留使用本机已安装 Playwright Chromium 的受控表单回归，
所有页面/API 请求由 fixture 拦截；没有该测试浏览器时跳过，不自动下载。
可用 `NEXUS_TEST_AUTOMATION_BROWSER_BINARY` 指定独立测试 Chromium 路径。
该回归覆盖实际脚本序列化、完整 6,000 字符描述的表单读写、
普通按钮/链接最终动作保护、观察到的上传入口与隐藏/零尺寸 file input、
子 frame 上传拒绝、chooser 超时恢复、提交边界、同源 GET 脱敏和释放保留页面，
不替代授权内核或真实账号集成验收。

## 版本与分发

CloakBrowser 二进制版本、并发配额及再分发许可由所选版本和授权决定，不能从 profile 数量推断。
在正式打包前核对官方 [binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md)；
macOS、Windows 分别进行启动、隔离、持久化、代理阻断及崩溃恢复验证。
本地表单、协议健康检查、前端构建均不能代替这些运行验证。

## 内置浏览器沙箱

统一窗口重构不代表 SDK 与 Playwright 的沙箱参数已完成新的安全验证。
若修改默认启动参数，需在受支持内核的 macOS 和 Windows 临时 Profile 上单独验证。

## 2026-11-18 ShardBrowser 官方表单与指纹库

0.2 原生入口恢复使用已导入的官方 ProfileFormDialog 与 FingerprintTab，
包含操作系统、模板、User-Agent、CPU、内存、刷新率、屏幕、窗口、语言、
噪声、WebRTC、端口、地理位置及媒体设备配置。代理页签使用全局代理库。
完整 JSON 由 Raccoon 边界传入 Rust，作为 settings.shardbrowser 持久化。
创建时冻结身份，后续编辑形成启动快照，并保留固定内核、种子及 Provider 绑定。

指纹库页面仅在 ShardBrowser Workspace 开放，沿用官方卡片、筛选、详情、
从模板创建及 JSON 导入交互。模板来自已安装内核和独立的自定义指纹目录。
GPU 兼容性采用官方引擎探测及 WebGL/WebGPU 对比逻辑，具有版本缓存和超时回收。
原生扩展库和密码保护仍显示未接入状态。

此次未执行真实浏览器启动或打包。用户自行构建 Preview 后进行运行核对。

## 2026-11-18 Profile 工作台交互补齐

Folder 创建和编辑使用官方对话框的名称、颜色及十二种图标选择，
一次保存到 Rust 管理的 connectionId 范围内记录。Sidebar、表格和表单读取同一外观。
Profile 移动 Folder 由 WindowStore 在一个 SQLite 事务内校验 Profile、Folder、
providerId 和 connectionId，并对数据库繁忙、目标缺失和 Workspace 范围错误返回独立信息。
Profile 标签具有独立的 Workspace 注册表与引用关系，支持批量分配、
改名、改色、删除和重启持久化。保存表单时标签引用与 Profile 在同一事务写入。

原生 Profile 表格复用官方 ProfilePeek 的配置、指纹和活动区，以及
Overview 的继续与待解决问题折叠区。问题来自已有代理检查、配置差异及
当前启动失败，未请求 ProxyShard 商业服务。活动展示实际观察的启动次数与运行时长，
流量统计尚未接入。应用首次记录前的历史运行时长未回填。

右键菜单已适配克隆、置顶/取消置顶、Cookie JSON 导入导出、调试地址复制、
显示浏览器、配置 JSON 导入导出、重新生成指纹、标签、Folder 和代理操作。
克隆沿用官方行为生成独立硬件选择与噪声种子，不复制浏览器站点数据。
Cookie 读写采用官方 Chromium 数据库格式与对应平台 OSCrypt 模式。
当前源码尚未通过本轮 Rust 编译及真实内核 Cookie 互通验收。

新建 Profile 默认名称由固定英文词表随机组合，例如 `Amber Fox`。
每次打开创建弹窗生成一次，弹窗会话内保持稳定，并避开当前列表已有名称。
ShardBrowser 启动错误按代理配置、代理出口检查、Profile 占用、CDP 建立和内核执行分类。
底层错误文字经过安全映射后写入操作记录，代理凭据保持在瞬时启动边界内。
创建、更新和启动的操作意图只持久化代理模式、代理库 ID、插件 ID 与端点 ID 等来源引用；
解析后的代理连接 URL 不写入 operation payload。创建重试会从原始引用重新解析本次凭据，
更新恢复只使用提交前生成的字段摘要核对远端结果，启动恢复只观察 Provider 状态。
旧调用方提交的 inline 手动代理会先规范化到 Rust 代理库的稳定引用，再准备 Profile 操作意图。
已有数据库中的历史 operation 记录不会在正常启动时自动改写，后续清理采用显式维护流程。

移入回收站保留 Profile 及浏览器数据，支持恢复与显式永久删除。
原生回收站采用手动清理策略，保留期限与未统计的磁盘大小以无数据状态展示。

配置 JSON 导入创建新 UUID，并清空导入文件中的原 Workspace 标签 ID，
避免把其他接入的业务引用写入本机。代理 ID 由本机代理库校验，缺失时显示错误。
