# Raccoon 直管 AliasMode Chromium 内核：设计草案

状态：仅作内核技术参考，产品定位和数据切换以
[Raccoon 0.2 浏览器接入重构方案](2026-11-17-raccoon-02-provider-architecture-design.md)为准。
本文保留 AliasMode Chromium 内核下载、启动和版本绑定的细节作为技术参考；
「内置浏览器」的产品定位和页面结构不再作为实施目标。

## 目标和边界

用户在 Raccoon 的「实验室」启用 AliasMode Chromium、下载内核，然后像使用内置浏览器一样创建和打开窗口。Raccoon 自己保存窗口资料、独立浏览器目录、指纹种子和内核绑定；不安装、不启动 AliasMode 桌面应用，也不依赖其 `127.0.0.1:50400` Local API。

保持现有窗口管理和插件所使用的 Raccoon UUID。内核文件属于 Raccoon 受管缓存，浏览器进程属于 Raccoon 的窗口调度器。内核下载和升级只安装新版本，不迁移、覆盖或重绑已创建窗口。

首期仅支持官方已发布的 **AliasMode Chromium**：Windows x64 和 macOS arm64。macOS x64 没有该内核的官方发行包；页面明确显示不支持，不能改用 CloakBrowser、AliasMode 桌面程序或其他架构的二进制冒充 AliasMode Chromium。AliasMode Firefox 有不同的自动化协议和 profile 格式，不在本方案内。

## 考虑过的接入方式

| 方式 | 结果 |
| --- | --- |
| 复用现有 AliasMode Local API Provider | 仍要求安装并启动 AliasMode 桌面应用，不符合目标。 |
| 把 AliasMode Chromium 路径塞进 CloakBrowser SDK | 该路径强制检查 CloakBrowser 激活码、SDK 缓存和版本；不能保证代理、指纹、数据导出和生命周期行为正确。 |
| **独立受管内核 Provider，共用窗口编排和生命周期约束** | 符合目标；需要实现独立下载器、启动器、代理鉴权和观察恢复。 |

选用第三种。沿用 `BrowserProvider`、`WindowService`、操作意图、插件关系及调度边界；不把两个浏览器的下载、许可证或启动实现合成一个类。

## 现有代码的具体影响

当前 `CloakBrowserProvider` 使用 `KernelService` 调用 Node 适配器的 SDK `ensureBinary`，`profile-runtime.ts` 启动前要求激活码、CloakBrowser 包清单，并用 SDK `launchPersistentContext` 打开浏览器。其 `create_profile` 的 staging marker、启动锁、进程观察、失败回收和 Ecom Agent 自动化入口可以作为行为参考，但 SDK 启动分支不能原样复用。

现有 `AliasModeProvider` 调用 Local API，配置不含本地 `binary_path`，并关闭了内核选择、指纹种子和手动代理能力。这些能力不能通过仅修改 `capabilities` 为 true 获得。`WindowStore` 和 `WindowService` 的部分校验只把 CloakBrowser 视作受管内核，其分支需改为按明确的「受管本地内核」能力判断，不能把新的内核误走外部 API 范围确认或启动流程。

建议新 Provider ID 为 `aliasmodeChromium`（最终 JSON 命名以 contracts 统一确定），连接 ID 固定为 `builtin-aliasmode-chromium`。旧 `aliasmode` ID 表示桌面应用 Local API，**不能直接重解释为新内核**：已有窗口没有本地内核、profile 目录和种子，改名会造成假持久化和会话丢失。过渡期间旧记录与新记录分开；新建入口只展示直管内核。移除旧 Local API 需要另行确认既有窗口的处置，不自动删除记录、业务关联或厂商目录。不新增旧格式的运行时兼容读取。

## 内核发行、安装和升级

1. Rust 的 `AliasModeKernelService` 查询官方 GitHub Releases 的非 draft 发布记录；不能用 GitHub `/releases/latest` 代替，因为官方当前发布的是 prerelease。按版本、平台、架构、发行资产名白名单解析可用包和 `SHA256SUMS.txt`。把版本与校验结果、查询时间分别展示，不把查询失败显示成「已经是最新」。
2. 「下载」流式写入受管临时目录，限制大小和超时，支持应用代理；代理不可用时报错，不回退直连。核对发布清单中的压缩包 SHA-256，安全解压并校验所需可执行文件，记录该文件的 SHA-256、包版本、平台及架构。拒绝路径穿越、链接逃逸、缺失二进制、异常解压体积和损坏资产；仅在全部验证后原子落入 `app_data/aliasmode-kernels/<完整发行版>/`。
3. 安装清单只扫描已提交的受管版本；启动时重新校验绑定路径、目录、架构、清单和文件摘要。下载中断只留下可清理的 staging，不进入已安装清单。并发下载共享同一个受管准备锁。
4. 实验室页展示「检查更新 / 下载 / 已安装版本 / 正在使用的窗口数量 / 下载状态」；版本以发行版标识（例如 `155.0.8059.85-aliasmode.5`）保存，Chromium 的 `--version` 显示值单独保存，不能凭显示值猜包修订号。
5. 新建窗口可选「最新已安装」或指定本机已安装版本；若自动准备最新版，创建前先明确版本并写入不可变绑定。升级只为**以后创建的窗口**提供新版本；已有窗口继续从原内核启动。旧内核只在零窗口引用、零运行进程且用户明确清理时才能删除。不能因发布新包而替换运行中的二进制或迁移 profile。

官方当前提供 `aliasmode-chromium-...-windows-x64.zip` 和 `aliasmode-chromium-...-macos-arm64.zip`，没有 macOS x64 包。版本发现和下载要将「上游 GitHub 不可达 / 当前平台无包 / 校验失败 / 下载中断 / 启动失败」区分反馈。GitHub 同源 SHA-256 能发现下载损坏，但不能代替独立的发行签名；需要明确来源信任边界。内核代码采用 GPL-3.0，实际分发前核对许可证、声明、源码提供义务和产物归属。

## 窗口与进程

- 创建：通过现有 `operationId` 和持久化意图创建专属 staging 目录；保存 Raccoon UUID、受管 binary path、完整版本、不可变种子及配置快照。成功核对 marker 和目录后提交窗口记录；超时先查结果，不盲目二次创建。
- 启动：校验窗口绑定、所选内核、独占锁和代理解析。由受管进程启动对应 Chromium，传独立 `--user-data-dir`、固定 `--fingerprint`、persona、locale/timezone、WebRTC 和 loopback 调试端口；只在实际就绪并确认属于本次进程后标记为 Running。固定窗口启动参数，不用启动时的最新默认值覆盖已保存配置。
- 代理：沿用窗口的手动或代理池解析；带认证代理必须通过受管 loopback 中继等明确可验的连接方式，不能把 `user:pass@host` 直接传给 `--proxy-server` 后假定 Chromium 能认证。出口 IP 自动匹配、时区、语言和 WebRTC 按此内核的官方参数单独映射；必需代理失败阻断，禁止直连回退。
- 停止：按当前子进程身份发送正常退出并等待；超时后依照现有受管进程策略处理。启动失败要确认进程和中继均已退出，否则状态为 Unknown 且继续占用目录。应用重启后不能因为内存中的 `Child` 不在了就声称浏览器已停止；须核对目录锁、进程身份和调试会话，再决定能否重新启动。
- 自动化：Ecom Agent 继续使用现有 Playwright/CDP 工具契约；CDP 端点仅 loopback、绑定已确认会话，只在运行期间提供给受信任的原生自动化入口，不向 WebView 或一般插件开放。若选择直接启动内核，不能让 Playwright 再创建另一个浏览器进程或覆盖其 fingerprint 参数。
- 数据：每个提供方使用不同的 profile 根目录。不能将现有 CloakBrowser 或旧 AliasMode 桌面应用的原始用户目录直接挂到新内核；跨内核 Cookie、密钥和指纹保持需要单独设计、验证和用户发起的迁移，不能在首期声称支持。

## 页面和结构

实验室开关控制新建入口；已存在的窗口即使关闭开关仍可查看和管理，避免失联。实验室中提供内核下载、状态和更新入口；窗口管理新增「AliasMode Chromium」Tab，沿用现有表格、分组、搜索、批量创建和插件 UUID 关联。新建表单根据该 Provider 的实际能力展示种子、内核、代理和基本指纹选项。浏览器接入设置不要求填写 `50400` 地址或安装第二个桌面应用。

分层保持如下：

```text
窗口管理 / 实验室
    -> WindowService + BrowserProvider 契约
       -> CloakBrowserProvider -> 现有 SDK + 授权 + 内核缓存
       -> AliasModeChromiumProvider -> AliasModeKernelService + 本机进程 + CDP
       -> 外部桌面应用 Providers -> 各厂商本机 API
```

`WindowRecord` 保持 schema 2 的显式绑定与不可变身份；调整校验以支持第二个受管内核。SDK 专属字段仍限定 CloakBrowser，AliasMode 专属参数仅在其 Provider 校验并生成，避免把通用窗口层变成厂商参数仓库。

## 实施顺序与验收

1. 先做平台和版本清单、校验下载、离线库存、应用代理、取消/失败恢复及实验室页面；用受控发行元数据与本地测试压缩包测路径穿越、摘要不符、同版本重复下载和任务中断。
2. 实现新 Provider 和 schema 2 受管绑定校验，创建、启动、停止、状态观察、不可变版本/种子和独占锁；用可控假进程验证重复启动、Unknown、端口错配、代理解析失败及跨应用重启。
3. 接通真实 Chromium 的窗口 UI、代理鉴权/出口匹配和 CDP 自动化，确认多窗口并发、停止/重启后 profile、Cookie 持久、Vinted 登录页面及 Ecom Agent 操作；不能仅凭 mock 宣称真实站点兼容。
4. 明确导入导出与迁移：首期不把 CloakBrowser 的快照流程默认为 AliasMode 可用；测试通过后再按完整内核包、存储状态和跨机器恢复证据单独开放 `transfer` 能力。
5. macOS arm64 与 Windows x64 分别验证首次下载、系统代理、代理池、认证代理、升级保留旧窗口、签名/杀软拦截和重新安装 Raccoon 后的恢复。macOS x64 验证清晰的不支持提示。遵守仓库约定，本地不执行应用/Rust 构建；CI 和目标系统负责发行验收。

## 依据

- 当前工程：`apps/desktop/src-tauri/src/core/browser/providers/cloakbrowser.rs`、
  `apps/desktop/src-tauri/src/core/browser/providers/aliasmode.rs`、
  `apps/desktop/src-tauri/src/core/window_service.rs`、
  `apps/desktop/src-tauri/src/core/window_store.rs`、
  `packages/browser-runtime/src/profile-runtime.ts`、
  `docs/05-browser-integration.md`、`docs/27-browser-kernels.md`。
- AliasMode Chromium 官方 README、启动参数和发行文件：
  `https://github.com/aliasmode/aliasmode-chromium`、
  `https://github.com/aliasmode/aliasmode-chromium/blob/main/docs/reference/switches.mdx`、
  `https://github.com/aliasmode/aliasmode-chromium/releases`。
- AliasMode 桌面运行时代码的发行包校验、命令行和代理实现仅作行为参考，
  不成为 Raccoon 运行时依赖：
  `https://github.com/aliasmode/aliasmode/blob/main/aliasmode-chromium.ts`、
  `https://github.com/aliasmode/aliasmode/blob/main/launcher.ts`。
