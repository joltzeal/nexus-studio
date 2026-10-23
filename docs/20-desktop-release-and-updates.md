# 桌面发行与应用内更新

## 发行组成

`rtk proxy pnpm run desktop:package` 先构建工作区包，再运行
`scripts/stage-desktop-runtime.mjs`，最后使用 Tauri 发行配置构建。
脚本从 Node.js 官方发行地址获取固定版本 `24.18.0`，用同一官方来源的
`SHASUMS256.txt` 校验后，按当前 Rust target 放入 `src-tauri/binaries`。
浏览器适配器通过 pnpm deploy 复制到 `src-tauri/runtime`。发行分阶段使用 hoisted 布局，
使 Node 依赖以实际目录进入 Tauri 资源包；默认 pnpm 软链接不会被当前 Tauri 打包流程保留。
以上两个目录是忽略的生成物，不提交到 Git。
发行资源还包括 `network-preload.js` 与其 HTTP/SOCKS5 传输依赖；
分阶段检查须同时加载浏览器适配器与代理预加载模块。

插件不再随安装包分发：发布构建的插件列表只有「已安装」与「商店清单」两个来源，
安装包内只带 Node 与浏览器适配器，插件以加密的 `.nexuspkg` 从商店按需安装。
因此 `RuntimePaths` 也不再要求 `runtime/plugins` 存在。见[插件商店与在线更新](25-plugin-market.md)。
发行版从自身资源目录运行适配器，并从自身可执行目录运行 Node sidecar。
macOS 是例外：Node 作为单独签名的 `Contents/Helpers/node` 运行，避免把
Node 专用的 JIT entitlement 授予 Rust 主程序。

浏览器内核不随 Nexus 安装包分发。用户不需要配置 Node、Rust、Python、
环境变量或 CLI 登录；首次创建窗口由官方 SDK 获取对应内核，需要网络。
最新内核仍受用户自己填入的激活码约束。下载失败不会静默换用系统浏览器。
浏览器二进制的再分发权需要独立确认，本流程不打包它。
用户也可先在「应用设置 → 浏览器内核」下载，查看实际进度和本地版本，再创建窗口；
两条入口复用同一缓存，见[浏览器内核](27-browser-kernels.md)。

## CI 与自动发布

`.github/workflows/ci.yml` 在 macOS/Windows 和 Linux 上运行源码检查。
`.github/workflows/release.yml` 仅在 `v*` 标签触发，构建 macOS arm64、
macOS x64 与 Windows x64，使用 GitHub Actions 的
`TAURI_SIGNING_PRIVATE_KEY` 签名更新包。构建阶段先创建草稿 Release，
三个平台上传构件、更新签名与 `latest.json`，macOS 继续执行最终包内运行时检查。
`publish` 作业依赖整个 `package` 矩阵；只有全部成功后，才自动取消草稿并设为最新版本。
任一平台失败时保留草稿，不发布不完整版本。无需用户手动将草稿转为正式发布。
签名密钥不进入源码。本地备份位于开发机的
`~/Library/Application Support/Nexus Studio Release/updater.key`；丢失密钥后，
现有安装无法无缝接受新签名。发版前同步根 `package.json`、
`apps/desktop/package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`
和 `src-tauri/tauri.conf.json` 中的应用版本。侧栏与关于页共用桌面包版本，
插件保留各自独立的版本号。
未提供 `APPLE_SIGNING_IDENTITY` 时，macOS 工作流使用临时 ad-hoc 签名使
应用包及随附 Node 可执行文件具备有效的本地签名；它不提供开发者身份和公证。
随附 Node 在 Hardened Runtime 下必须携带
`com.apple.security.cs.allow-jit` 与
`com.apple.security.cs.allow-unsigned-executable-memory`，否则 Node 虽能输出版本，
但初始化 V8 时会因无法保留 CodeRange 而退出，进而同时阻断内核准备和插件进程。
macOS 专用发行配置在 bundle 前复制 Node，并使用 `NodeEntitlements.plist`
和同一发行身份只签名 Helper；Rust 主程序与外层应用不携带这两个权限。
正式发行需要在 macOS runner 导入开发者证书并配置公证凭据。

当前没有 Apple Developer ID 或 Windows 签名证书；草稿构件尚不能
称为无提示安装包。macOS 公证、Windows 代码签名与新机器安装验证
必须分别完成。CI 编译不替代真实平台安装和首次内核下载测试。
macOS 发行构建完成后必须运行 `pnpm runtime:verify-packaged`，使用最终签名后的
`Contents/Helpers/node` 实际执行 JavaScript，并导入代理预加载模块与浏览器适配器。
该检查还验证整包签名、Node 的两个 JIT entitlement，以及 Rust 主程序未获得这些权限；
只检查文件存在或只运行签名前的 staged Node 不足以证明运行时可用。

## 更新通道

安装包的 updater 公钥固定在 `tauri.release.conf.json`；关于页只在发行版
提供“检查更新”。检查清单用于发现新版本，更新包在下载和安装时由 Tauri 按固定公钥
验证签名；检查成功不等于已完成包验签。更新可下载、安装并重启，运行中窗口必须先停止。
更新不会删除本机 SQLite、插件私有数据或浏览器 user-data。

`joltzeal/nexus-studio` 已于 2026-10-23 改为公开仓库，
`v0.1.2` 已正式发布，Release 中包含安装文件、更新包、签名与 `latest.json`。
源码中的发行配置使用
`https://github.com/joltzeal/nexus-studio/releases/latest/download/latest.json`。
2026-10-23 实际匿名请求确认主仓库最新正式版本为 `v0.1.2`，
该清单返回 HTTP 200；旧 `joltzeal/nexus-studio-updates` 仓库及其清单均返回 HTTP 404。
打开或关闭代理不能修复不存在的更新源。

检查更新通过 Rust `core/updater_service.rs` 的 `app_update_check` 入口，
每次读取本机应用代理设置，再为 Tauri updater 的检查与下载客户端配置同一路由。
直连显式清除继承代理，系统代理和手动代理复用应用现有解析规则；
配置读取失败、PAC 不受支持或代理不可达时失败，不自动切为直连。
检查超时为 30 秒，更新包下载超时为 15 分钟；修改应用代理后重新检查更新，
已发现更新的下载继续使用该次检查解析的代理。代理边界见[应用代理](26-application-network-proxy.md)。

原生集成必须在 `core/mod.rs` 导出 `updater_service`，并在 `lib.rs` 的
`tauri::generate_handler!` 中注册 `core::updater_service::app_update_check`。
该入口返回 Tauri 管理的原生更新资源；前端用官方 `Update` 对象继续下载、验签和安装，
不自行信任前端传回的清单或跳过签名检查。关于页区分更新源、清单、平台、
代理设置、网络与超时错误，并在重新检查或退出页面时释放旧更新资源。
检查失败不会显示“当前已是最新版本”；安装失败不会触发重启。

更改源码和发布主仓库 Release 都不会修改已安装应用中的旧端点。
已经安装、仍指向 `nexus-studio-updates` 的版本需要手动安装包含修复的构建，
或另行提供旧地址的兼容更新源。本次未创建兼容仓库、修改公开 Release、
上传清单或重新签名发布包；现有 `v0.1.2` 资产不会因源码修复而变化。
尚未执行新安装包的真实覆盖安装与重启，不将端点及单元测试结果视为该发行验证。

## 本机验证记录（2026-10-22）

在 macOS arm64 上，Node 24.18.0 官方校验下载与 hoisted 资源分阶段完成；
受管 Node 在打包后的 `.app` 中成功导入浏览器适配器。Tauri 生成
`Nexus.app`、更新用 `.app.tar.gz` 和 `.sig`；ad-hoc 签名后的应用通过
`codesign --verify --deep`。Rust `cargo check --locked` 与库测试通过
（58 通过、1 个真实浏览器冒烟用例忽略）；前端测试 323 个通过。
此记录不涵盖 Windows 安装、干净机器首次内核下载或公开更新服务。

## 0.1.0 本机检查（2026-10-23）

macOS arm64 分阶段运行时检查通过，含 `network-preload.js` 和 SOCKS5 依赖；
本机 Tauri 发行构建生成 `.app`、`.dmg`、更新压缩包和 `.sig`，
`codesign --verify --deep --strict` 通过。此构件采用 ad-hoc 签名，
未进行 Apple 公证；Windows 打包、跨机器安装与公开更新服务仍需分别检查。
代理请求的测试覆盖 Node `fetch` 经 SOCKS5 转发与代理不可达时报错，
不证明任意插件原始网络连接都经过应用代理。

## 0.1.1 macOS sidecar 修复验证（2026-10-23）

0.1.0 的 macOS sidecar 曾在 Hardened Runtime 签名后缺少 JIT entitlement：
`node --version` 可执行，但实际运行 JavaScript 会以
`Failed to reserve virtual memory for CodeRange` 退出。补充
0.1.1 将 Node 改为独立签名的 Helper，最终 `.app` 内的 Node entitlement 检查包含
`allow-jit` 与 `allow-unsigned-executable-memory`，Rust 主程序不包含二者，并通过
`runtime:verify-packaged` 对代理预加载模块和浏览器适配器的真实导入检查。
该验证覆盖当前 macOS arm64 本机构件；macOS x64 由同一发行配置生成，
仍需在对应机器或 CI runner 上执行同一签名后检查。

## 0.1.2 发行范围（2026-10-23）

本次包含浏览器内核本地清单与提前下载入口、真实下载进度和失败分类，
并补齐窗口指定代理的解析与浏览器启动参数传递。窗口选择具体代理时不依赖默认项，
必需代理无法解析时继续阻断启动。现有窗口的内核绑定不因下载而改变。

主应用版本为 `0.1.2`；代理池插件独立升为 `1.0.1`，需要配套更新。
插件不随桌面安装包分发，推送应用标签不会自动上传插件商店。
`v0.1.2` 最初由标签工作流生成草稿，三个平台的发布构建均成功，
2026-10-23 已通过 GitHub CLI 转为正式发布并设为最新版本。
后续标签由新增的 `publish` 作业在整个构建矩阵成功后自动发布；
推送标签后无需等待 CI，但在构建完成前不会出现正式 Release。
本机发布前检查见[质量记录](09-quality-and-testing.md)。

## 更新源与签名检查（2026-10-23）

匿名直连访问旧更新源得到 HTTP 404，主仓库的 `latest.json` 得到 HTTP 200，
版本与公开最新 Release 的 `v0.1.2` 一致。清单包含 7 个平台条目，对应
macOS arm64、macOS x64、Windows MSI 与 NSIS 共 4 个独立更新包。
完整包通过本机现有静态系统代理下载，未修改代理设置；
4 个包均与 GitHub Release 的 SHA-256 摘要一致，清单中的签名与公开 `.sig`
文件一致，按发行配置固定公钥验证的 Ed25519 包签名和可信注释签名全部通过，
可信注释中的版本均为 `0.1.2`。未读取或使用私钥。

在临时副本中补齐原生注册后，实际 Tauri updater 通过本地 HTTP 代理完成
清单检查、54,757,967 字节 macOS arm64 包下载、包签名与受签名保护版本校验；
改变包中一个字节后验证失败。该验证没有安装或重启应用，也没有修改公开发布源。
原生服务包含显式直连、HTTP/SOCKS5、代理失败阻断、损坏设置、清单错误及
资源元数据的回归测试；前端另有检查入口、边界数据、进度与安装失败测试。
主线接入模块和命令注册后，共享工作树中以 `--locked` 执行的 9 项原生更新器
定向测试全部通过；更新器与发行配置的 25 项 Vitest 测试通过。
源码修复、临时集成验证与已发布安装包保持区分，真实覆盖更新和 Windows 安装仍待验证。

## 0.1.3 发行范围（2026-10-23）

主程序版本统一为 `0.1.3`，包含代理启动等待与认证 SOCKS5 修复、
新窗口默认按出口 IP 匹配时区/语言/WebRTC、窗口加密迁移、
设备同步宿主接口及更新源/应用代理修复。
迁移保持完整内核包版本、类型、实际显示版本与窗口指纹绑定，
导入失败支持插件收据补偿和重启恢复。模块边界见
[窗口加密迁移](28-window-transfer.md)及[窗口同步插件](29-window-sync-plugin.md)。

窗口同步插件最低主程序版本为 `0.1.3`，避免旧版宿主接受尚不支持的能力。
插件仍独立分发；桌面 Release 不会自动上传代理池、账号池或同步插件到商店，
迁移关联资料需安装支持迁移协议的对应插件。
`v0.1.3` 标签触发既有三平台发行流程，全部打包与包内运行时检查成功后自动发布。
本机先前生成的 `Nexus_0.1.2_aarch64.dmg` 沿用原文件及版本，
不能改名作为远程 `0.1.3` 构建；当前验证结果见[质量记录](09-quality-and-testing.md)。

## 空缓存代理启动修复（2026-10-23）

`v0.1.3` 推送后的修复将出口匹配改为在线 API，移除首次启动对 GeoLite2
数据库的依赖。新机器无需提前准备数据库；查询使用窗口代理，主服务不可用时
尝试备用服务，失败明确反馈且不回退直连。
生产依赖检查改为实际使用的 Playwright、Undici 与 SOCKS；
运行时测试禁止数据库下载并使用空缓存，不再复制开发机已有数据库。
已推送的标签与已有安装包不因源码修改而改变，新的打包验证记录见
[质量记录](09-quality-and-testing.md)。

## 0.1.4 发行范围与新版本提醒（2026-10-23）

本次版本为 `0.1.4`，所有窗口启动和离线快照入口都禁用 SDK 数据库查询，
自动匹配统一使用在线 IP 服务。打包时排除 GeoIP 相关可选依赖，
已有窗口配置与指纹、内核绑定保持兼容。

发行版桌面应用启动 10 秒后自动检查更新，之后每 6 小时检查一次。
发现新版本后显示 12 秒 toast，提示前往“应用设置 → 关于 Nexus”更新；
同一次应用运行期间，同一个版本只自动提醒一次。
没有新版本或后台请求失败时保持安静，下个周期重试；手动检查仍展示具体错误。
检查复用原生更新入口和应用代理，不自动下载、安装或重启。
退出或卸载组件会取消定时任务，检查返回的更新资源在读取版本后释放；
迟到的检查结果不会再弹提醒。网页预览和开发构建不启动后台检查。

旧版仅提供“关于”页的手动检查，不会因为远程发布而自动获得新的 toast 功能；
安装 `0.1.4` 后才具备上述自动提醒。推送标签后由既有 GitHub Actions 构建，
发布状态以远端工作流结果为准，本地检查不等于远端构建完成。
