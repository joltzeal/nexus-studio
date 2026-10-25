# 浏览器接入契约

## 当前实现

桌面窗口页的“创建窗口”直接创建真实 CloakBrowser Profile；“打开”才启动持久上下文。
Rust 保存绑定和调度，Node.js 适配器
调用官方 JS 包装层。新建只请求最新稳定内核，下载、启动和浏览器快照均需激活码，
受管缓存路径和原版本绑定在启动前校验；内核策略见[浏览器内核](27-browser-kernels.md)。
窗口的代理来源可以是手动地址或代理插件；
代理插件由插件宿主解析，失败时阻断启动，见[插件宿主](17-plugin-host.md)。
原有 localStorage 演示窗口不会自动迁移或出现在原生列表。
`packages/browser-runtime` 包含独立健康协议与真实 Profile 适配器；
`profile-runner` 处理内核准备、清单、授权校验、启动、便携状态校验与导出。
`profile-runner version <binaryPath>` 离线执行指定内核的 `--version`，
以 `{ "version": "...", "binary_path": "..." }` 返回实际显示版本和输入路径。
二进制探测有 10 秒截止，原生调用另设 20 秒上限，不启动 Profile 或访问激活服务。
迁移用它核对本机缓存内核与窗口绑定，完整内核包修订号另由清单核对。
Manager 只作产品与隔离行为参考，不作为本应用的运行依赖。

## 窗口加密转移的便携状态契约

`profile-runner snapshot <userDataDir>` 从 stdin 首行读取与 `launch` 相同的
NativeProfile JSON，核对绑定内核后用该内核启动 headless 持久上下文，
调用 `context.storageState({ indexedDB: true, opfs: true })`，
关闭浏览器后仅向 stdout 输出一行：

```json
{ "schemaVersion": 1, "storageState": { "cookies": [], "origins": [] } }
```

主程序负责原始 `user-data` 目录复制与加密归档。导入主程序将上面的完整对象写入
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

历史临时 Profile 的 Cookie、localStorage、IndexedDB 和 OPFS 实测保留在
[质量与验证](09-quality-and-testing.md)。这些旧内核结果不作为当前最新内核的验收证据；
本次重构未执行真实内核、跨机器或跨 macOS/Windows 的登录恢复验证。

## 配置来源与映射

配置选项参考 CloakBrowser 官方
[JS README 的 Launch、Persistent Context、Fingerprint Management 部分](https://github.com/CloakHQ/CloakBrowser/blob/main/js/README.md)。
实际接入时必须按选用的 SDK 与二进制版本复核选项。

| 窗口字段           | 官方能力                                                    | 当前处理                               |
| ------------------ | ----------------------------------------------------------- | -------------------------------------- |
| 独立窗口           | `launchPersistentContext({ userDataDir, headless: false })` | 原生 Profile 独立目录，显式打开后启动  |
| HTTP / SOCKS5 代理 | `proxy`                                                     | 手动无凭据地址；插件代理解析失败则阻断 |
| 出口自动匹配       | `timezone`、`locale`、`--fingerprint-webrtc-ip`             | 在线查询；有代理且未显式关闭时启用     |
| 时区、语言         | `timezone`、`locale`                                        | 手工覆盖；空值使用在线结果或包装层默认 |
| 尺寸               | `viewport`                                                  | 默认或两个常用尺寸                     |
| 指纹种子           | `--fingerprint=<seed>`；持久化 profile 会保留种子           | 可在创建时填写，之后不可修改           |
| 起始地址           | Playwright 页面导航                                         | 仅允许不含凭据的 HTTP(S) 地址          |

底层还支持 GPU、硬件、屏幕、品牌、存储配额、WebRTC 等单项指纹标志。
官方建议保留种子产生的一致参数组合；因此本页不开放任意参数注入。
自定义参数进入插件能力与版本兼容性评估后再设计，避免混合不一致指纹。

## 代理启动与就绪时序

适配器核对 `--version` 后同时传递绑定路径与 `browserVersion`，
避免 SDK 在只有本地路径时将代理鉴权功能按未知版本处理。
正常代理启动保留完整连接 URL、认证信息与出口自动匹配，不在失败时回退直连。
窗口持久字段仍叫 `geoip`，缺少 settings 时默认开启；直连不进行在线匹配。
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

原来的 SDK 路径会在新机器上下载约 70 MB 数据库；旧测试预填了开发机数据库，
掩盖了空缓存下因下载不可用导致的启动失败。该依赖已从启动路径移除，
`mmdb-lib` 和 `socks-proxy-agent` 不再是应用显式生产依赖，
并通过工作区 `ignoredOptionalDependencies` 排除 SDK 的这两个可选依赖。
SQLite/迁移契约中的 `geoip` 字段仅保留为兼容旧数据的自动匹配开关名称，
不再表示启用 SDK 数据库功能；页面统一称“出口 IP 自动匹配”。
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
原生侧在启动超时或就绪前 stdout 提前 EOF 时先终止仍存活的 runner 再等待退出；
SOCKS5 地址校验接受普通 `socks5://host:port` 的空 path（含 IPv4/IPv6），
仍拒绝真实 URL 路径，避免合法代理在原生校验处被误拒绝。

## 后续生命周期与安全边界

Rust 核心负责 profile 路径、独占锁、进程生命周期、错误与重试；Node.js 适配器封装官方 SDK。
不同 Profile 的启动和停止可并行；Nexus 不自行猜测或固定 CloakBrowser 并发席位。
官方包装层未公开可信席位数时，超额由 CloakBrowser 启动错误裁决并反馈给用户。
UI 只接受稳定 DTO，不持有进程句柄或调试端口。启动前生成不可变、经过验证的快照；
修改窗口配置不静默改变已运行会话，重启后才应用。
代理必需时，配置无效、不可用或鉴权失败必须阻断启动和敏感流量，
禁止自动回退直连。官网指出部分 Playwright request API 不走浏览器 SOCKS5/认证 HTTP 代理，
适配器必须单独约束这类请求，不能凭页面代理配置声称全部流量已受保护。
日志仅存脱敏摘要，代理密码和许可证不进入 localStorage。

## 版本与分发

CloakBrowser 二进制版本、并发配额及再分发许可由所选版本和授权决定，不能从 profile 数量推断。
在正式打包前核对官方 [binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md)；
macOS、Windows 分别进行启动、隔离、持久化、代理阻断及崩溃恢复验证。
本地表单、协议健康检查、前端构建均不能代替这些运行验证。

## 浏览器沙箱

本次移除的是旧内核接入和兼容代码，未调整 SDK 与 Playwright 的沙箱参数。
若修改默认启动参数，需在受支持内核的 macOS 和 Windows 临时 Profile 上单独验证。
