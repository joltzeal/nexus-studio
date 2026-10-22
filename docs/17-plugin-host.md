# 插件宿主

本文说明桌面应用里已实现的插件宿主：发现、安装、进程托管、权限检查点与窗口启动阻断。
插件开发者要遵守的契约见[插件对接开发规范](14-plugin-integration-guide.md)，
产品边界见[插件系统](06-plugin-system.md)，代理插件本身见[代理池插件](15-proxy-plugin.md)。

## 1. 代码位置与组成

| 文件                              | 职责                                            |
| --------------------------------- | ----------------------------------------------- |
| `core/plugin_host/manifest.rs`    | 严格解析并校验 manifest，拒绝未知字段与不兼容项 |
| `core/plugin_host/discovery.rs`   | 扫描插件包，读取入口与 digest，汇总扫描问题     |
| `core/plugin_host/install.rs`     | 复制安装、校验复制结果、卸载与目录清理          |
| `core/plugin_host/registry.rs`    | `registry.json` 读写、上限读取与原子写入        |
| `core/plugin_host/process.rs`     | 受管 Node.js 子进程、握手、调用、取消、脱敏     |
| `core/plugin_host/permissions.rs` | 能力与域名的检查点                              |
| `core/plugin_host/mod.rs`         | 宿主状态机、安装/启用/停用/调用、窗口启动阻断   |
| `core/plugin_service.rs`          | 桌面命令与初始化，与窗口服务共享同一个宿主实例  |

数据根目录为 `app_data_dir/plugins`：

```text
plugins/
├── registry.json              # 已安装登记表，写入后权限 0600
├── installed/<id>/<version>/  # 安装副本
├── storage/<id>/              # 声明 storage: private 时的私有目录，权限 0700
└── .staging/<uuid>/           # 安装中间目录，成功后 rename 到 installed
```

## 2. 状态

页面只展示四种状态，全部来自实际检查，不预先置为成功：

| 状态        | 含义                                                     |
| ----------- | -------------------------------------------------------- |
| `available` | 发现到插件包但未安装；`enabled` 为假，无方法与状态       |
| `stopped`   | 已安装未启用，或进程已按请求停止                         |
| `running`   | 已启用且子进程存活、握手完成                             |
| `failed`    | 已启用但进程未启动、已退出或握手失败；`lastError` 为原因 |

启用只是授权动作：`enable()` 先把请求能力收窄为声明能力并写盘，再尝试启动进程。
启动失败时保留授权记录，但状态返回 `failed` 与真实错误，不显示为运行中。
调用前会重新确认进程存活，崩溃后的调用不会复用旧状态。

## 3. 发现

扫描 `installed/` 与开发根目录，每个候选目录读取：

- manifest：包根目录的 `nexus.plugin.json`，或 `dist/nexus.plugin.json`。
- 入口：`package.json` 的 `main`（必须是 `.js`，不允许 `..`），缺省为 `dist/src/index.js`。

开发根目录来自环境变量 `NEXUS_PLUGIN_DEV_ROOTS`（冒号分隔），
默认追加仓库内 `plugins/`，因此 `plugins/proxy-pool` 构建后可直接出现在插件中心。
同一 ID 出现多次时只保留第一个并记录 `DuplicateId`；
缺 manifest、manifest 非法、缺入口都以 `DiscoveryProblem` 上报，不静默跳过整批扫描。
扫描结果不写入登记表，只有安装才会持久化。

## 4. 安装与卸载

安装以本地目录为来源，没有网络下载入口：

1. 重新读取候选包的 manifest 并校验，不接受界面传入的字段。
2. 复制到 `.staging/<uuid>`，最多 20000 个条目、深度 24，跳过 `.git` 与 `.DS_Store`。
3. 重新读取复制后的 manifest，digest 与来源不一致则拒绝安装。
4. `rename` 到 `installed/<id>/<version>`，再写入登记表。

同一 ID 已安装时返回 `INVALID_REQUEST` 与中文原因，不做覆盖式升级。
卸载会先停止进程、删除该版本目录并清理空的父目录。

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
插件自身的密码不会出现在宿主日志里，因为宿主从不接收它们。

## 7. 密码归属

宿主不接触密码：没有系统钥匙串，也没有宿主侧凭据库。
代理密码与 proxycheck 密钥由插件自己明文写入私有目录的 `secrets.json`（权限 0600），
与 `proxy-pool.json` 同目录、同样的保护级别。宿主既不读取，也不代为保管。

- manifest 的 `permissions.secrets` 仍声明槽位名，用于说明插件需要哪些密钥，
  但值不在宿主手里，页面只能展示槽位名，无法报告“已保存”。
- `proxy.resolve` 返回的 `secretRef` 仍是不透明引用，由插件自己解析；
  启动快照只保存句柄与引用，不保存密码。
- 卸载插件时删除整个安装目录，私有目录由用户或后续清理入口处理。
- 这是本地明文文件，能读取该用户文件的程序都能读到密码，产品不宣称加密或隔离。

## 8. 权限检查点

`call()` 在把请求交给进程前依次检查：

1. 能力是否在 manifest 中声明。
2. 能力是否在启用时被授予（`granted_capabilities`）。
3. 插件是否仍处于启用状态。
4. 方法是否在 `ready` 上报的方法列表中。

任一失败都返回 `PERMISSION_DENIED`，不进入进程。
授权时把请求能力与声明能力求交集，不能授予未声明的能力。

网络域名只在 manifest 与授权记录中保留，当前不拦截插件进程的出站连接，
也没有按调用校验域名；manifest 不是沙箱，这一条仍由第 10 节的限制覆盖。

## 9. 窗口启动阻断

窗口记录新增 `proxy_plugin` 字段，与手动 `proxy` 互斥，由
`profile_store` 在写入时校验（同时给出两者或 ID 非法都会被拒绝）。

启动顺序为：解析代理 → 预留调度槽位 → 启动浏览器。解析失败时槽位不会被占用：

1. 记录里有 `proxy_plugin` 时，调用该插件的 `proxy.resolve`，截止时间 20 秒。
2. 结果 `configured` 为假或 `configHandle` 为空时返回 `NOT_CONFIGURED`，
   消息为“代理插件未选择默认代理，窗口启动被阻断”。
3. 成功时启动快照只保存不透明句柄与可选密钥引用，不保存代理地址或密码。
4. 记录里没有插件也没有手动代理时才使用直连；插件失败不会退化为直连。

宿主未初始化时启动直接失败，提示“代理插件宿主未初始化，窗口启动被阻断”。

## 10. 桌面命令与页面

| 命令                     | 作用                                 |
| ------------------------ | ------------------------------------ |
| `plugin_catalog`         | 已安装与可安装插件列表，含状态与错误 |
| `plugin_proxy_providers` | 具备 `proxy.provider` 能力的插件     |
| `plugin_install`         | 从本地目录安装                       |
| `plugin_uninstall`       | 停止进程并删除安装目录               |
| `plugin_enable`          | 收窄授权、写盘、启动进程             |
| `plugin_disable`         | 取消启用并停止进程                   |
| `plugin_restart`         | 重启进程并返回最新状态               |
| `plugin_call`            | 按能力与方法调用，带截止时间         |

页面侧：插件中心按状态给出安装、启用、停用、重启、卸载与清单查看；
代理池页面通过同一宿主调用 `proxy.*` 方法，默认代理与密钥都在插件侧配置。
密码在插件侧填写与保存，页面不回显，也没有宿主侧的密钥输入框。
地址生成器页面同样只经 `plugin_call` 调用 `address.*` 方法，地图 Key 存在插件私有目录，
页面只写入与清除，不回显明文；两个页面都不新增宿主侧的业务命令。

## 11. 已执行的证据

`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --locked`
当前为 59 个用例中 58 个通过、1 个忽略（真实浏览器启动冒烟）。插件宿主相关用例覆盖：

- manifest 未知字段、通配符/端口/localhost/IP 域名、不兼容核心与 API、重复能力；
- 仓库内 `plugins/proxy-pool` 的 manifest 通过校验，且能完成真实握手与 `proxy.list`、`proxy.get` 调用；
- 仓库内 `plugins/address-generator` 从 `dist` 安装、以 `address.generator` 启用并调用
  `address.catalog`，同一次会话里用 `proxy.provider` 调用同一方法被 `PERMISSION_DENIED` 拒绝；
- 发现阶段的缺入口跳过、安装成功、重复安装被拒、卸载清理；
- 能力未声明、未授权、未启用、方法未上报时的拒绝；
- 登记表往返与损坏时失败关闭；
- 诊断中的 URL 凭据被脱敏；
- 安装→启用→调用；
- 未选择默认代理时窗口启动被阻断，选择后可解析；
- 卸载与停用都会停止进程。

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
- 只实现了 `proxy.provider` 与 `address.generator` 的真实调用路径；
  `platform.adapter`、`verification.provider`、`image.provider` 与
  `environment.configurator` 只有声明与类型。
- 地址生成器的公开地址来自 Overpass 镜像，覆盖与时效取决于 OpenStreetMap；
  它不连接任何地址库服务，也不做真实收件验证。
- 未验证 Windows 下的进程回收、路径与凭据行为。
