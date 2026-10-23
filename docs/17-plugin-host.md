# 插件宿主

本文说明桌面应用里已实现的插件宿主：发现、安装、进程托管、权限检查点与窗口启动阻断。
插件开发者要遵守的契约见[插件对接开发规范](14-plugin-integration-guide.md)，
产品边界见[插件系统](06-plugin-system.md)。仓库内三个插件的实际范围分别见
[代理池插件](15-proxy-plugin.md)、[地址生成器插件](19-address-generator-plugin.md)与
[共享货源插件](21-shared-supply-plugin.md)。

## 1. 代码位置与组成

| 文件                              | 职责                                            |
| --------------------------------- | ----------------------------------------------- |
| `core/plugin_host/manifest.rs`    | 严格解析并校验 manifest，拒绝未知字段与不兼容项 |
| `core/plugin_host/discovery.rs`   | 扫描插件包，读取入口与 digest，汇总扫描问题     |
| `core/plugin_host/install.rs`     | 复制安装、校验复制结果、卸载与目录清理          |
| `core/plugin_host/package.rs`     | `.nexuspkg` 切片与逐文件校验、密钥推导          |
| `core/plugin_host/market.rs`      | 商店地址、catalog 解析、HTTP/文件拉取、版本比较 |
| `core/plugin_host/registry.rs`    | `registry.json` 读写、上限读取与原子写入        |
| `core/plugin_host/process.rs`     | 受管 Node.js 子进程、握手、调用、取消、脱敏     |
| `core/plugin_host/permissions.rs` | 能力与域名的检查点                              |
| `core/plugin_host/mod.rs`         | 宿主状态机、安装/监督重启/调用、窗口启动阻断    |
| `core/plugin_service.rs`          | 桌面命令与初始化，与窗口服务共享同一个宿主实例  |

数据根目录为 `app_data_dir/plugins`：

```text
plugins/
├── registry.json              # 已安装登记表，写入后权限 0600
├── store.json                 # 插件商店地址与上次检查结果，权限 0600
├── installed/<id>/<version>/  # 安装副本
├── storage/<id>/              # 声明 storage: private 时的私有目录，权限 0700
└── .staging/<uuid>/           # 安装中间目录，成功后 rename 到 installed
```

## 2. 状态

安装是唯一的决策点：装上即启用，并一次性获得 manifest 声明的全部能力与域名。
没有停用、重启或逐项授权的入口，进程生命周期由宿主自己负责。页面只展示三种状态：

| 状态        | 含义                                                         |
| ----------- | ------------------------------------------------------------ |
| `available` | 发现到插件包但未安装；`enabled` 为假，无方法与状态           |
| `running`   | 子进程存活且握手完成                                         |
| `starting`  | 已安装但进程尚未拉起（刚启动应用、刚安装或刚卸载后重来）     |
| `retrying`  | 进程已退出或启动失败，监督线程按退避重试；`lastError` 为原因 |

宿主在应用启动时调用 `supervise()`：先等 600 ms 让窗口先绘制，然后每 3 秒扫一遍
已安装插件，进程缺失、已退出或握手失败就重新拉起。失败按 500 ms 起、逐次翻倍、
上限 30 秒退避；进程连续存活超过 30 秒后失败计数归零，一次偶发崩溃不会让延迟一直升级。
调用前会重新确认进程存活，崩溃后的调用不会复用旧状态。
`shutdown()` 会先停掉监督线程再逐个停止子进程。

## 3. 发现

扫描 `installed/` 与开发根目录，每个候选目录读取：

- manifest：包根目录的 `nexus.plugin.json`，或 `dist/nexus.plugin.json`。
- 入口：`package.json` 的 `main`（必须是 `.js` / `.cjs` / `.mjs`，不允许 `..`），缺省为 `dist/src/index.js`。

开发根目录来自环境变量 `NEXUS_PLUGIN_DEV_ROOTS`（冒号分隔），
默认追加仓库内 `plugins/`，因此 `plugins/proxy-pool` 构建后可直接出现在插件中心。
同一 ID 出现多次时只保留第一个并记录 `DuplicateId`；
缺 manifest、manifest 非法、缺入口都以 `DiscoveryProblem` 上报，不静默跳过整批扫描。
扫描结果不写入登记表，只有安装才会持久化。

`catalog()` 只在开发构建（`cfg!(debug_assertions)`）里把扫描到的候选列成 `available`。
发布构建的插件列表只有两种来源：已安装的插件与商店清单，因此全新安装的应用默认没有任何插件。
发布构建也不再向安装包内放置插件目录，插件统一从商店安装，见[插件商店与在线更新](25-plugin-market.md)。

## 4. 安装与卸载

安装有两条来源，写入磁盘的方式相同：先写 `.staging/<uuid>`，再整体 `rename` 到
`installed/<id>/<version>`，失败不会留下半个版本。

**本地目录**（开发用）：

1. 重新读取候选包的 manifest 并校验，不接受界面传入的字段。
2. 复制到 `.staging/<uuid>`，最多 20000 个条目、深度 24，跳过 `.git` 与 `.DS_Store`。
3. 重新读取复制后的 manifest，digest 与来源不一致则拒绝安装。
4. `rename` 到 `installed/<id>/<version>`，再写入登记表。

**商店包**（`.nexuspkg`）：

1. catalog 里的 SHA-256 与下载字节比对，不符直接拒绝。
2. 解析容器，逐个文件比对 header 里的 `sha256` 与路径合法性。
3. 写入版本目录并登记，随后启动进程。

同一 ID 已安装时：版本更高则替换记录、停旧进程、装新版本、删旧版本目录、启动新进程；
版本相同则原地重装；版本更低直接返回 `INVALID_REQUEST`。
插件私有目录 `storage/<id>` 与版本无关，升级不丢数据。
卸载会先停止进程、删除该版本目录并清理空的父目录。

## 4.1 商店

`store.json` 保存商店地址、上次检查时间与最后一次错误。地址支持 `https` / `http` / `file`，
保存后立即检查一次；启动约 40 秒后首次扫描，之后每 30 分钟一次，失败只记录不弹窗。
拉取在 Rust 侧完成，商店不需要配置 CORS。完整协议与发布流程见
[插件商店与在线更新](25-plugin-market.md)。

## 5. 登记表

`registry.json` 只保存已安装记录：ID、版本、manifest 副本、目录、入口、manifest digest、
启用标记、已授权能力与域名、安装时间。加载时逐条重新校验 manifest：

- 读取上限 256 KiB，超出即视为损坏。
- 任一条目 manifest 非法时整体报 `UNAVAILABLE`，不跳过、不修补、不重置为空表。
- 写入使用临时文件加 `rename`，文件权限 `0600`，避免半写状态。

digest 只在安装时比对，启动时不会重新校验磁盘上的入口文件。
篡改安装目录内的代码不会被宿主发现，这是当前的真实缺口。

## 6. 进程托管与协议

每个已启用插件对应一个 `node <entry>` 子进程，环境变量为：

- `NEXUS_PLUGIN_ID`：插件标识。
- `NEXUS_PLUGIN_STORAGE_DIR`：仅当 `storage: private` 时注入。
- `NEXUS_PLUGIN_KEY`：由 id 与版本推导的解密密钥，只有商店包的 `bootstrap.cjs` 会读它；
  本地目录安装的插件忽略这个变量。

握手顺序为插件发 `hello`、宿主回 `handshake`、插件发 `ready`：

- `hello` 的 `pluginId`、`version`、`apiVersion` 必须与安装记录一致，否则按 `ManifestMismatch` 失败。
- `ready` 携带方法列表与状态，宿主把它作为可调用依据；未握手完成前调用返回 `NOT_READY`。
- 握手超时 15 秒。

调用约束：

- 请求 `deadlineMs` 上限 120000，缺省 30000，桌面命令把输入夹在 1 秒到 120 秒之间。
- 超过截止时间 750 毫秒仍未响应时发 `cancel` 并返回 `TIMEOUT`，迟到结果被丢弃。
- 单行上限 1 MiB，超限的行会被读完再丢弃，并计为一次协议错误。
- 连续 3 次协议错误标记进程失败；失败后进程被回收，状态变为 `failed`。
- 停止先关闭标准输入等 2 秒，再结束进程并等待回收，读线程一并 join。

标准输出只承载协议消息。标准错误进入 4 KiB 环形缓冲作为诊断，
写入前把 `scheme://user:pass@host` 改写为 `scheme://***@host`。
启动解析的 `connectionUrl` 可能包含认证信息，只用于进程间启动传递，不写入日志；
`ResolvedBrowserProxy` 的 `Debug` 实现隐藏完整连接地址。

## 7. 密码归属

宿主没有系统钥匙串，也没有宿主侧凭据库。
代理密码与 proxycheck 密钥由插件自己明文写入私有目录的 `secrets.json`（权限 0600），
与 `proxy-pool.json` 同目录、同样的保护级别。宿主不读取插件存储的业务结构，也不代为保管。
启动所需的代理密码会由插件解析并放入 `connectionUrl`，临时经过插件 IPC、宿主内存与
浏览器适配器的标准输入；不能再把这一边界描述为“宿主从不接收密码”。

- manifest 的 `permissions.secrets` 仍声明槽位名，用于说明插件需要哪些密钥，
  宿主不提供密钥库状态，页面只能展示槽位名，无法据此报告“已保存”。
- `proxy.resolve` 的 `configHandle` 与 `secretRef` 仍是不透明引用，由插件自己解析；
  调度快照与 `ProxyReference` 只保存句柄和引用，不保存连接地址或密码。
- `connectionUrl` 只用于本次启动，不写回窗口记录、不进入 UI，也不进入日志或错误消息。
  插件无法解析必需密码时必须失败，不得生成省略认证的地址。
- WebView 的通用 `plugin_call` 不允许调用原生启动专用的 `proxy.resolve`，
  避免将完整连接信息返回页面；普通列表、检测和配置方法继续通过既有插件接口使用。
- 卸载插件时删除整个安装目录，私有目录由用户或后续清理入口处理。
- 这是本地明文文件，能读取该用户文件的程序都能读到密码，产品不宣称加密或隔离。

## 8. 权限检查点

`call()` 在把请求交给进程前依次检查：

1. 能力是否在 manifest 中声明。
2. 能力是否在安装时被授予（`granted_capabilities`）。
3. 插件是否仍处于启用状态。
4. 方法是否在 `ready` 上报的方法列表中。

任一失败都返回 `PERMISSION_DENIED`，不进入进程。
安装时授予的是 manifest 声明的全部能力，插件拿不到自己没声明的能力；
登记表里残留的未启用或部分授权的旧记录会在 `open()` 时被补齐为“已启用 + 全量声明能力”，
所以不存在需要用户手动恢复的中间态。

网络域名只在 manifest 与授权记录中保留，当前不拦截插件进程的出站连接，
也没有按调用校验域名；manifest 不是沙箱，这一条仍由第 10 节的限制覆盖。

## 9. 窗口启动阻断

窗口记录新增 `proxy_plugin` 字段，与手动 `proxy` 互斥，由
`profile_store` 在写入时校验（同时给出两者或 ID 非法都会被拒绝）。

启动顺序为：解析代理 → 预留调度槽位 → 启动浏览器。解析失败时槽位不会被占用：

1. 记录里有 `proxy_plugin` 时，调用 `resolve_browser_proxy(plugin_id, window_id, endpoint_id)`，
   内部只发一次 `proxy.resolve`，截止时间 20 秒。RPC payload 只有 `{ endpointId }`，
   不发送严格 schema 不接受的 `windowId`；公开方法保留未使用的 `_window_id` 参数。
2. `endpoint_id` 指定一行时不要求默认项；未指定时才使用插件默认项。
   `configured` 为假或 `configHandle` 为空时返回 `NOT_CONFIGURED`，消息区分
   “窗口指定的代理不存在或不可用”与“未选择默认代理”，不重复添加“代理插件”前缀。
   指定项已删除、停用或密码引用不可用时透传失败，不改用默认项。
3. 返回 `ResolvedBrowserProxy { reference: ProxyReference, connection_url: String }`。
   宿主从同一次响应解析引用与 `connectionUrl`，不读取插件库存或密钥文件。
   仅支持 `http`、`https`、`socks5`、`socks5h`，必须有主机和有效的显式端口，
   不允许路径（含末尾 `/`）、查询、片段、空白或反斜线；保留原百分号编码与显式默认端口。
   已安装插件缺少有效字符串 `connectionUrl` 时明确提示更新或重新安装并阻断启动，
   无效地址返回不含输入内容的协议错误。
4. `reference` 用于调度器的必需代理绑定；`connection_url` 只填入本次启动的临时配置，
   经标准输入传给浏览器适配器，不保存到窗口记录、调度快照或 UI。调用方直接使用该结果，
   不再调用 `resolve_proxy` 重新解析，避免两次解析选择不同配置。
5. `resolve_proxy(plugin_id, window_id, endpoint_id) -> Result<ProxyReference, HostError>`
   保留只返回不透明引用的原有接口，复用相同调用和解析 helper，
   不要求旧插件返回 `connectionUrl`。公开 SDK 的 `ProxyProvider.resolve()` 也保持只返回引用。
6. 记录里没有插件也没有手动代理时才使用直连；插件失败不会退化为直连。
   浏览器适配器收到 `proxy_plugin` 却没有运行时 `proxy` 时也必须拒绝启动。

宿主未初始化时启动直接失败，提示“代理插件宿主未初始化，窗口启动被阻断”。

## 10. 桌面命令与页面

| 命令                     | 作用                                 |
| ------------------------ | ------------------------------------ |
| `plugin_catalog`         | 已安装与可安装插件列表，含状态与错误 |
| `plugin_proxy_providers` | 具备 `proxy.provider` 能力的插件     |
| `plugin_install`         | 从本地目录安装并立即启动             |
| `plugin_uninstall`       | 停止进程并删除安装目录               |
| `plugin_call`            | 按能力与方法调用，带截止时间         |

页面侧：插件中心是一张紧凑表格，列出插件、能力、版本、状态与操作；
操作只有“安装”、清单详情（`i` 图标）与卸载，没有启用、停用或重启。
侧栏与插件页面共用 `AppShell` 读取的宿主目录，只为已启用且非 `available` 的记录生成入口。
前端原生适配层在安装、商店安装/更新与卸载成功后发布目录变更通知，失败不发布成功通知；
目录监听器串行读取，忽略变更前仍在途的旧响应，并每 5 秒补查后台状态。
重读失败保留菜单并允许重试，当前插件被移除时回到插件中心；卸载再安装不会自动抢回页面。
专用 React 页面按插件 ID 登记，没有适配器的插件显示通用详情，规则见
[插件对接规范](14-plugin-integration-guide.md)第 10.1 节。
代理池页面通过同一宿主调用 `proxy.*` 方法，默认代理与密钥都在插件侧配置。
密码在插件侧填写与保存，页面不回显，也没有宿主侧的密钥输入框。
地址生成器页面同样只经 `plugin_call` 调用 `address.*` 方法，地图 Key 存在插件私有目录，
页面只写入与清除，不回显明文；共享货源页面也只调用 `supply.*` 方法，
收藏存在插件自己的 JSON 文档里，宿主不保存商品数据。
三个页面都不新增宿主侧的业务命令。

## 11. 已执行的证据

本次以 Node.js 24.18.0 构建 `studio.proxy-pool` 1.0.1 后执行
`rtk proxy cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --locked core::plugin_host`，
宿主模块 44 个用例全部通过。完整工程检查由主线汇总到[质量与验证](09-quality-and-testing.md)，
此处只记录宿主模块的实际范围：

- manifest 未知字段、通配符/端口/localhost/IP 域名、不兼容核心与 API、重复能力；
- 仓库内 `plugins/proxy-pool` 的 manifest 通过校验，且能完成真实握手与 `proxy.list`、`proxy.get` 调用；
- 实际构建的代理插件在临时目录安装运行，无默认项时指定端点仍能返回精确连接地址与引用，
  带认证的端点验证百分号编码，密码引用缺失时报错，
  删除或停用指定项后即使另有可用默认项也失败；
- 宿主启动解析只发一次 RPC，旧插件缺少 `connectionUrl` 时提示更新，
  无效协议、端口、路径、查询、片段与空白被拒绝，错误与调试输出不回显连接凭据；
- 仓库内 `plugins/address-generator` 从 `dist` 安装即启动并调用
  `address.catalog`，同一次会话里用 `proxy.provider` 调用同一方法被 `PERMISSION_DENIED` 拒绝；
- 仓库内 `plugins/shared-supply` 从 `dist` 安装即启动，
  `supply.catalog` 返回 10 个分类、`supply.favorites.list` 总数为 0，
  再用 `address.generator` 调用同一插件被 `PERMISSION_DENIED` 拒绝；
- 发现阶段的缺入口跳过、安装成功、重复安装被拒、卸载清理；
- 能力未声明、方法未上报时的拒绝；
- 登记表往返与损坏时失败关闭；
- 诊断中的 URL 凭据被脱敏；
- 安装后直接调用（不再有单独的启用步骤）；
- 进程被 `test.crash` 打断后 `supervise_once()` 把它重新拉起，状态从 `retrying` 回到 `running`；
- 旧登记表里 `enabled: false` 的记录在 `open()` 时被补齐为已启用并写回；
- 未选择默认代理时窗口启动被阻断，选择后可解析；
- 卸载会停止进程并清理安装目录。

这些用例运行在 macOS 上，使用临时目录与真实 `node` 进程，不连接真实代理或浏览器。

## 12. 已知限制

- 密码是插件私有目录里的明文文件，没有加密、没有系统钥匙串托管；
  任何能读取该用户文件的程序都能读取它。
- 宿主不记录密码，但插件进程自身可以读到全部密码；manifest 不是隔离手段。
- 没有操作系统级隔离：插件进程拥有当前用户的文件与网络权限。
  manifest、权限检查点与独立进程只用于授权记录和故障管理，不构成安全沙箱。
- 出站网络不受宿主拦截，声明的域名无法在运行时强制。
- 安装时不校验签名，只比对 manifest digest；启动时不重新校验入口文件。
- 安装来源是本地目录，没有插件市场、下载与自动更新。
  目标形态（`.nexuspkg`、私有分发、L3 会话密钥、收费检查点）见
  [插件发布与 CI/CD](18-plugin-release-and-cicd.md)，均为方案，尚未实现。
- 只实现了 `proxy.provider`、`address.generator`、`supply.catalog`、`image.provider`、
  `monitor.collector`、`account.pool`、`verification.provider` 与 `window.sync` 的真实调用路径；
  `platform.adapter` 与 `environment.configurator` 只有声明与类型。
- 地址生成器的公开地址来自 Overpass 镜像，覆盖与时效取决于 OpenStreetMap；
  它不连接任何地址库服务，也不做真实收件验证。
- 共享货源插件连接第三方供应商接口，其可用性、限流与数据结构变化都不受宿主控制；
  宿主只透传 `UNAVAILABLE` / `RATE_LIMITED` / `TIMEOUT`，不做重试或缓存兜底。
- Vinted 监控插件的采集请求由本机直连目标站点，没有代理通道，也不受宿主限速；
  被站点拒绝时只能由插件在运行记录里说明原因。
- Vinted 账号池把账号密码明文写在插件私有目录（0600），宿主既不加密也不代管；
  窗口与账号的关联也由插件保存，卸载插件会一并删除。
- 未验证 Windows 下的进程回收、路径与凭据行为。

## 13. 窗口迁移边界

窗口迁移服务通过插件的 `transfer.export/import/rollback/commit` 交换不透明附件，
不读取账号池或代理池的私有业务文件。WebView 通用 `plugin_call` 拒绝 `transfer.*`
及 `window.sync` 能力；配对秘密、临时文件路径和导入收据由专用原生命令管理。
同步插件只接收已经加密的快照，不直接接触浏览器 Cookie。
完整格式与失败恢复见[窗口加密迁移](28-window-transfer.md)，
传输协议见[窗口同步插件](29-window-sync-plugin.md)。
