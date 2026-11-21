# Raccoon 0.2：工作台重写与浏览器接入方案

状态：0.2 重写中。数据目录、提供方分组、偏好隔离及实验室 CloakBrowser
显式启用入口已开始实施；AliasMode 受管内核、统一分派与桌面布局尚未完成。
工作分支 `codex/raccoon-0.2-rewrite` 从 `v0.1.43` / `e779c83` 创建。
0.2 运行时只支持新契约；0.1 数据以后通过独立脚本一次性迁移。

## 定位与取舍

Raccoon 管理窗口、分组、插件和任务，浏览器由独立的 Provider 执行。每种
浏览器提供方就是一个 space（例如 AdsPower 一个、比特浏览器一个），以
`providerId` 标识；不再让用户填写独立工作区名称。同一 space 内的窗口仍以
`connectionId` 绑定实际接入，不将两种标识混为一谈。AdsPower
与比特浏览器作为默认推荐接入，依赖各自本机管理 API。CloakBrowser 和
AliasMode Chromium 仅在实验室手动启用、下载和维护；Raccoon 直接调度其内核，
不要求安装 AliasMode 桌面应用。用户不再看到“内置浏览器”类别。

考虑过原地逐文件替换旧分支；这会让旧 schema、旧别名和 CloakBrowser 特例
持续约束新设计。也考虑过从零建立新仓库；这会失去已经验证的发行配置、
UI 组件及公开插件契约。选择在新分支**重写应用的领域核心与工作台页面**，
沿用 Tauri + Rust + React + shadcn + SQLite 的工具链，并审计后复用字体、
图标、组件及构建基础设施；不将 0.1 的状态模型和 UI 控制流原样搬入。
Provider 使用统一注册和分派，厂商执行逻辑仍由各适配器维护。

目标：创建、打开、观察、停止和删除通过同一编排入口；新 Provider 主要增加
实现、能力声明和注册；插件继续引用 Raccoon 窗口 UUID；失败或未知状态可核对。
本方案不承诺外部厂商 API 一定提供完整指纹配置、环境迁移或 CDP 能力。

## 现状证据

- `core/browser/provider.rs` 已有 `BrowserProvider`、能力与绑定定义，Registry
  已在 `window_service.rs` 中注册各实现。
- `connection_store.rs` 启动时自动写 `builtin-cloakbrowser`；
  `window_service.rs` 仍持有 `builtin: Arc<CloakBrowserProvider>` 并对创建、
  启停和恢复做大量 `CloakBrowser` 分支。
- `window_store.rs` 对内核路径、版本与种子的校验仅识别 CloakBrowser；
  `transfer_service.rs` 直接通过 `self.windows.builtin` 执行迁移。
- 当前 `AliasModeProvider` 是桌面应用 Local API 适配器，不能直接替换为
  Raccoon 管理的 AliasMode Chromium。
- Agent 设置与 SDK 的允许列表、窗口页面的提供方默认值及设置的“激活码 /
  浏览器内核”顶层入口都需要调整。Node 同时承载插件进程，不能整体移除。

## 统一调用入口

```text
窗口页 / 插件 / Ecom Agent
  -> WindowService（意图持久化、锁、状态与恢复）
  -> ProviderRegistry.resolve(connection.providerId)
  -> BrowserProvider（能力、接入、环境、观察、自动化）
     ├─ AdsPower / 比特：本机 API
     └─ CloakBrowser / AliasMode Chromium：受管内核
```

Registry 是唯一的提供方分派点，不能在页面、Agent 或通用存储层按提供方名称
分叉执行业务。能力元数据表达 `connectionKind`、`create`、`attach`、
`update`、`proxyModes`、`kernelSelection`、`automation`、`transfer` 等真实
可用能力。可用性单独报告“未配置 / 不可达 / 缺少内核 / 授权失败 / 可用”；
不能从 `providerId` 或 `enabled` 猜测运行就绪。

Rust 负责连接、窗口记录、调度、意图和锁；各 Provider 负责厂商字段映射、
本机 API 或内核二进制的准备及进程观察。允许参考现有实现并复用经过验证
的独立模块，不为了“重写”复制旧业务分支。受管内核的通用独占与启动快照可
抽出共用服务，但 SDK 调用、激活码和下载协议留在各自适配器。窗口绑定
`providerId + connectionId + profileId` 创建后不可变；远端 ID 只在连接
作用域内解释。超时先观察并核对结果，再决定恢复，不盲目重试写操作。
未知、断线和环境不可见都不能被解释为已停止。

窗口列表和分组以 providerId 划分 space；切换 space 要清空临时勾选与弹窗，
保留各自的筛选位置。每个 space 有独立的分组，一组不能同时包含 AdsPower
和比特浏览器的窗口。具体环境及厂商范围仍由不可变的 connectionId 确定，
Agent 和插件选中窗口后校验实际连接。插件安装与授权属于整个 Raccoon 应用，
业务关联仍用 Raccoon UUID。接入断线不删除 space、分组或窗口。

管理 API 仅接受经验证的本机 loopback 地址，独立于窗口代理直连；
受管内核的 CDP 只绑定 loopback 并限制为运行中的受信任自动化入口，
不把端点作为通用 WebView/插件配置项。所需窗口代理失败时阻断启动。

## 四种接入的产品行为

| 提供方 | 默认入口 | 准备方式 | 版本与凭据归属 |
| --- | --- | --- | --- |
| AdsPower | 浏览器接入 | 连接并探测其本机 API | 厂商应用管理 |
| 比特浏览器 | 浏览器接入 | 连接并探测其本机 API | 厂商应用管理 |
| CloakBrowser | 实验室手动启用 | 激活码、查询和下载内核 | Raccoon 管理独立安装清单 |
| AliasMode Chromium | 实验室手动启用 | 查询并下载发行包 | Raccoon 管理独立安装清单 |

“默认入口”只表示展示顺序；未安装或未连接的厂商应用要明确告知具体准备步骤。
启用实验室开关不触发网络下载；新建受管窗口只能选择**已安装**版本，保存
精确版本、二进制身份和独立 profile 路径。升级新增版本，不能覆盖现有绑定。
下载仅从经确认的官方发行源读取并核对资产完整性；同源 SHA-256 校验只能
证明传输文件与同源清单一致，不能称作独立签名验证。上游发行资产及许可证
须经发行审查，真实系统验证前不标为可用。

现有 AliasMode Local API 实现从 0.2 移除，0.2 的 AliasMode ID 只指受管
Chromium。旧绑定不重解释、不在运行时兼容读取。Camoufox 继续只是实验室
占位，不注册空实现。

## 0.2 数据切换与后续独立迁移

0.2 使用新的应用数据子目录和新 SQLite schema。0.2 正常启动不打开 0.1
数据库、不读旧 localStorage 或快照 manifest，也不执行启动时迁移。
旧磁盘资料不删除；迁移前旧窗口、分组、接入、插件关系与激活码不会自动
出现在 0.2。新工作区首次打开要告知旧数据仍在原位置。

后续提供**独立、用户显式运行、可重复验证的一次性迁移脚本**，不是让
0.2 主程序依赖旧 schema。脚本在两版应用和相关浏览器窗口均停止时运行：

1. 检测来源版本和目标 schema，先备份来源数据库、受管 profile、插件私有
   数据及目标已有状态；目标已有数据时先预览冲突，不做静默覆盖。
2. 读取 0.1 静态资料并建立旧 ID 到新 Raccoon UUID 的映射；按依赖顺序转换
   接入、按提供方分组、窗口，再转换可读取的插件关系和配置。0.1 全局分组如
   同时包含不同提供方窗口，按提供方拆为多个新分组并为每个引用建立映射；
   空分组归属无法推断时进入待人工处理报告。localStorage 中的偏好
   不在 SQLite 内，离线脚本无法直接保证获取；缺失时使用 0.2 默认偏好并在
   报告中说明。厂商环境 ID 必须保留所属 connection 作用域；不会把旧
   AliasMode Local API 环境当成受管内核。
3. CloakBrowser 的 profile、内核绑定及插件文件只在来源完整、目标内核
   已验证且可核对时迁移；跨平台加密 Cookie、不能迁移的链接/特殊文件、
   授权状态、凭据及厂商管理的 profile 不保证自动可用。不可安全转换的
   记录写入报告并留在旧目录，不制造“迁移成功”的假窗口。
4. 在独立 staging 目标上核对引用完整性、数量、目标 schema 和启动前
   校验，通过后原子提交；失败丢弃 staging，来源与现有目标原封不动。
   产出导入、跳过、冲突和待人工处理的逐项报告；重复执行以导入标识
   幂等，不能重复创建厂商环境或覆盖新工作区的数据。

迁移脚本在 0.2 核心契约稳定后开发并单独验收；此阶段只保留旧数据，不交付
可用迁移能力。0.2 若先发布，必须明确标注 0.1 数据不会自动出现，并在发布
计划中决定是随 0.2 一同提供迁移脚本，还是先向全新工作区用户开放。
即使以后迁移脚本完成，正常运行路径仍然只读 0.2 数据。

重写后不保留：默认 `builtin-cloakbrowser` 注入、`builtin` 独立服务字段、
Legacy AliasMode API、受管内核等于 CloakBrowser 的判定、0.1 数据升级、
旧快照兼容读、旧前端提供方枚举和旧 Agent allowlist。重做 0.2 的迁移
manifest，按能力对每种 Provider 独立验证；无迁移能力时明确拒绝，不能
导出不完整的浏览器状态。插件协议升级并校验版本，不用别名兼容旧方法。

## 实施顺序与验收

1. 固定 0.2 领域、Provider 与公开插件契约及新数据根目录；重写服务接口、
   窗口持久化、意图与状态机，补齐绑定、代理、恢复和能力映射测试。
2. 用统一 Registry 重写浏览器执行入口，独立实现 AdsPower/比特的连接发现、
   作用域校验与环境操作；检查现有插件的调用方式并升级公开契约。
3. 各自实现 CloakBrowser 和 AliasMode Chromium 的内核维护、授权或发行
   校验、创建启停、版本独占与跨应用重启恢复。
4. 按[界面方案](2026-11-17-raccoon-02-native-interface-design.md)重写应用壳、
   窗口页、实验室、设置和插件宿主页面；真实设备完成双系统交互验收。
5. 新架构稳定后另行设计和实施 0.1→0.2 离线迁移脚本，在来源备份、
   staging 和真实浏览器数据样本上独立验收；脚本不回写 0.1。

按照仓库约定，本地阶段不执行应用构建、Rust 编译与打包；CI 及目标系统上的
安装和真实厂商联调属于实施后的发布门槛。
