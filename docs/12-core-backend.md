# 核心后端：统一窗口与 Provider 边界

## 范围与资源归属

`core::window_service::WindowService` 编排全部浏览器的窗口创建、编辑、接管、
启动、停止、删除、状态观察与操作恢复。`core::window_store::WindowStore`
把 `WindowRecord` v2 和分组关系写入 SQLite。
内置 CloakBrowser、AdsPower 与比特浏览器通过统一 `BrowserProvider` 接口接入，
不是三套彼此独立的业务窗口服务。

| 模块                                          | 职责                                                  |
| --------------------------------------------- | ----------------------------------------------------- |
| `window_service`                              | 业务窗口、连接范围校验、插件解析、操作和迁移/安装互斥 |
| `window_store`                                | v2 记录校验、读写、备注、分组关系与排序               |
| `browser::provider` / `registry`              | 统一绑定、能力、状态、错误与 Provider 分派            |
| `browser::connection_store`                   | 本机 API 连接、账户范围确认、启用连接切换             |
| `browser::operation_store` / `session_store`  | 写操作阶段和结果协调、会话观察证据                    |
| `browser::providers::cloakbrowser`            | 授权、内核、运行时、应用网络与受管浏览器会话          |
| `browser::providers::adspower` / `bitbrowser` | 厂商 Local API 参数映射与环境观察                     |
| `scheduler`                                   | 窗口独占、预留、不可变启动快照及代次回调              |
| `plugin_host`                                 | 插件安装、受管 Node 进程、能力检查与内部调用          |
| `database` / `transfer_service`               | 数据库初始化升级 / 内置窗口加密迁移与恢复             |

通用服务持有 `builtin: Arc<CloakBrowserProvider>`，不直接持有内核、授权或 Node
运行时字段。外部适配器不经过内置启动进程，也不读写厂商浏览器目录。
插件私有业务资料不进入主程序数据库，插件不能直接操作浏览器句柄或调试端口。

## 统一记录与连接

`BrowserBinding { provider_id, connection_id, profile_id }` 区分浏览器类型、
具体账户连接和厂商环境。Nexus UUID 是业务窗口和插件关联的 `windowId`，
内置环境标识与该 UUID 一致；外部环境另存自己的 ID。
`origin` 区分 `created` 与 `attached`。
普通更新不允许改变 Provider、连接、环境、内置内核或指纹身份。

内置连接 `builtin-cloakbrowser` 自动建立。外部连接只接受 loopback HTTP(S) 根地址；
请求层固定 loopback 解析结果、拒绝重定向，绕过应用/系统代理，
并禁用自动请求重放。连接节流、有界队列和单环境锁约束并发。
AdsPower 可配置 Bearer API Key；当前比特浏览器适配器拒绝不支持的 API Key 配置。

探测成功只表示 API 可达。当前两个外部 Provider 都不能返回稳定账户范围 ID，
用户必须人工确认账户或工作区。保存连接、启动应用或外部观察失败后重新确认；
确认前不执行外部写操作。不同账户使用不同连接，不按 endpoint 或环境名称重绑旧窗口。
每个 Provider 同时只启用一个连接，停用历史连接不删除其窗口记录。
停用接入仍可测试连接、读取目标分组并确认账户，随后再启用；
环境创建、修改和启停仍要求接入已启用且范围已确认。
确认过程在取得连接操作锁后读取配置，探测结果只能确认同一修订，不能确认后来更改的地址或密钥。

## 公开命令

当前入口在 `src-tauri/src/lib.rs` 注册，输入对象使用 camelCase：

| 命令                                                         | 主要输入与用途                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `browser_window_list`                                        | `{ connectionId? }`，统一窗口与当前观察状态                  |
| `browser_window_create`                                      | `{ input }`，含稳定 `operationId`、`connectionId` 和窗口配置 |
| `browser_window_update`                                      | `{ input }`，含 `id` 和可编辑配置，不接受新绑定或内核        |
| `browser_window_update_note`                                 | `{ id, note }`，保存本机窗口备注                             |
| `browser_window_start` / `browser_window_stop`               | `{ id }`                                                     |
| `browser_window_delete`                                      | `{ id, deleteEnvironment }`，区分解除关联与删除环境          |
| `browser_connection_list/save/probe/confirm/activate`        | 连接管理、连通探测与人工范围确认                             |
| `browser_profile_discover` / `browser_group_list`            | `{ connectionId }`，发现厂商环境和厂商分组                   |
| `browser_window_attach`                                      | `{ connectionId, profileIds }`，将外部环境登记为业务窗口     |
| `browser_operation_list` / `browser_operation_reconcile`     | 待处理操作查询与按操作 ID 协调                               |
| `browser_operation_resolve`                                  | `{ input }`，明确确认后关联创建结果或人工结束结果不明的操作  |
| `window_transfer_pick/recovery_status/export/inspect/import` | 本机加密快照和恢复状态                                       |
| `window_sync_offer/receive/status/cancel/import`             | 通过同步插件传输快照并显式导入                               |
| `kernel_status` / `kernel_check_latest` / `kernel_download`  | 仅内置浏览器的内核清单、查询和准备                           |

表中的斜线表示同前缀的多个独立命令。旧 `profile_*` 命令和别名已退出公开接口。
内部 `binding.profile_id`、SQL 表 `profile_records` 与 Node `profile-runner`
名称仍有实际用途，不代表旧命令兼容层。

## 写操作与结果不明

创建输入的 `operationId` 是稳定 UUID。后端先保存请求散列、连接、预留窗口 ID 与阶段，
再调用 Provider；同一 ID 使用不同内容会返回冲突。
提交后超时、断开或返回无法确认的结果时，保留 `operation_uncertain`，
不能因没有收到成功响应就再次创建。

`browser_operation_list` 提供未收敛操作，`browser_operation_reconcile`
结合本机记录和 Provider 证据核对结果。外部创建通过操作标记协调，
不能用名称或本机指纹种子推定同一环境。
连接切换及相关窗口操作受待处理操作和互斥状态约束。
批量创建复用此机制；账号绑定失败仅重试插件绑定，不重建窗口。

`browser_operation_resolve` 只处理 `submitted` / `uncertain` 阶段，并要求
`confirmed: true`。外部创建可通过 `action: "associate"` 与 `providerProfileId`
选择官方可见、身份可核对且未被占用的环境，继续使用原操作预留的 Nexus UUID。
该环境作为 `attached` 窗口沿用官方配置，不把原创建意图强加给所选环境。
创建、接入和恢复共用连接绑定锁；仍有待完成创建时，普通接入不会抢占其远端环境。

用户核对官方应用后可使用 `action: "abandon"` 明确结束外部结果不明的操作，
或内置浏览器的启停操作。结束记录以 `cancelled` 留在 SQLite，保留原请求和确认事实，
不会再次发送远端写请求，不会删除候选环境，也不能用相同操作 ID 重新创建。
尚未在本机保存窗口的外部创建可以离线结束，避免失效的地址或密钥与待处理操作互相阻塞。
现有窗口的启停结果必须重新观察；未知状态不能清除占用。
结束无法确认的外部配置修改时，窗口转为沿用官方配置，避免后续启动重写旧代理设置。
`confirmed` 阶段只需恢复本机提交，不提供跳过提交的人工结束入口。

修改操作在提交前保存实际发送字段的版本化 SHA-256 确认证据。
证据按适配器字段核对，包含已解析代理值的散列，不保存插件返回的可复用代理地址。
恢复使用原证据，只读官方配置，不重新解析插件默认代理，不重发修改。
分组在慢操作期间被删除时，提交和回滚均将窗口留为未分组，不恢复已删除的分组。

错误通过 `{ code, message, retryable }` 暴露。
不支持、范围未确认、配置错误、资源忙、API 不可达与结果不明应有不同反馈；
结果不明需要协调，不能当作普通可重试网络错误。
日志与 UI 不回显 API Key、代理密码或上游敏感报文。

## 生命周期与能力

状态包含 `stopped`、`starting`、`running`、`stopping`、`unknown`、`missing`。
外部窗口每次观察来自对应连接，API 失败不等于停止，旧观察不是当前停止证明。
外部环境消失不自动删除账号关联；不同连接下相同环境 ID 也不能互换。
批量观察同时带回已核对身份的官方名称和内核标识，在没有待处理修改时刷新本机缓存；
重复接入已有环境也会刷新这些信息，保留原 UUID、分组、备注、平台、代理来源及排序。
内置内核仍固定，外部内核的新报告只作为观察更新，不触发内核下载或改写厂商配置。
退出或更新 Nexus 不应停止厂商应用拥有的环境。解除本机关联与删除厂商环境
必须分别表达，删除环境需显式选择且满足 Provider 能力和状态约束。

页面和服务共同检查能力。AdsPower 编辑与插件代理在验证前不可用，
具体能力及限制见[浏览器接入](05-browser-integration.md)；
比特浏览器已有受限的部分更新适配路径，不代表完成真实厂商验收。
外部数字指纹种子、Nexus 内核选择和完整窗口转移均不支持。
代理必需时，解析或更新失败阻断启动，不自动改为直连。

内置启动在读取配置、解析代理和生成快照前持有窗口操作锁。
同一窗口在启动、运行、停止、迁移或恢复期间保持独占；
不同窗口不持有全局状态锁等待浏览器。
调度回调携带代次，迟到结果不能改变后续尝试；
状态查询在读取 Provider 前记录窗口和连接操作版本，仅在版本未变且没有操作锁时
提交观察结果；旧的停止查询不能释放后来启动的会话。
连接配置与观察票据在同一锁定区间读取，提交观察时再次核对修订与启用状态。
启动恢复确认运行时保留或重建运行预留；只有确认停止后才释放。
导出和导入先持有迁移锁，再读取新的停止事实；安装更新先取得安装互锁，
再核对受控运行预留和内置进程，不在网络调用期间持有全局状态锁。
CloakBrowser 的实际并发授权由官方服务和二进制裁决，Nexus 不从窗口数量猜测席位。

## 内置内核与运行时

内置创建需要激活码，默认准备最新稳定包，也可指定完整包版本。
`KernelService::prepare(None)` 与 `exact_binary(version)` 位于内置 Provider 路径，
使用受管缓存、官方 SDK 和精确包校验；指定版本失败不替换为其他修订或最新包。
外部创建不要求 CloakBrowser 激活码或缓存，厂商负责自己的授权和内核。

v2 记录的 `kernel_version` 保存完整包版本，`binary_path` 保存本机路径，
可选 `provider_config.displayVersion` 单独保存 Chrome 显示版本。
启动和快照核对受管安装清单、精确包与二进制 `--version`；
下载新包不会修改已建窗口。批量内置创建在首个确认结果后固定完整包版本。

Node 启动和快照直接读取同一 v2 记录，只接受内置绑定，不保留旧 schema 读取器。
启动配置不可变；便携数据恢复完成后才发送内置 `NEXUS_READY`，
插件 `ready` 和外部 API 状态不使用这一信号。
细节见[浏览器接入](05-browser-integration.md)与[浏览器内核](27-browser-kernels.md)。

## 存储升级与迁移恢复

`database::open_database` 在启动初始化时对既有 SQL 窗口执行唯一一次 v2 升级，
非空窗口库先生成 SQLite 一致性备份，事务完成后记录 schema 版本。
保留 `profile_records(id, record_json, group_id)` 和既有关系，
增加 JSON 生成列、连接唯一索引、操作及观察表。
正常路径仅接受 v2，不扫描旧目录、不读取旧 `profile.json`；
失败不静默重建，详见[本地数据](07-data-storage.md)。

迁移只接受 manifest3 内置窗口，整批 Provider 预检先于快照、插件调用和目录复制。
导入保留加密、便携站点状态、SQLite 事务及插件收据补偿。
原生回滚先落盘检查点，再重试插件补偿；恢复失败阻断相关窗口。
旧 manifest 和旧记录没有导入适配器，数据库启动升级不扩展为通用旧格式兼容。

## 验证与分发边界

本次只核对文档与源码，未运行 Rust、真实厂商 API、真实浏览器或 Windows 测试。
开发依赖、发行运行时、平台签名及真实授权分别验收，
不能以 API 模拟、类型检查或源码存在替代。
插件信任边界见[插件宿主](17-plugin-host.md)，发行要求见
[桌面发行与更新](20-desktop-release-and-updates.md)，实际结果统一见
[质量与验证](09-quality-and-testing.md)。
