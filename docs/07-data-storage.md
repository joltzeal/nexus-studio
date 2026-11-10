# 本地数据与存储边界

## 当前数据所有者

桌面窗口、分组、浏览器连接、操作记录与会话观察已由 Rust 管理并存入应用数据目录的
`nexus.sqlite`；激活码与应用代理配置也使用 SQLite。窗口详情来自实际保存的记录，
查看详情不启动浏览器，也不表示平台账号已登录。

| 数据                     | 存储与所有者                                                      |
| ------------------------ | ----------------------------------------------------------------- |
| 窗口记录、分组及分组关系 | Rust `WindowStore` / `GroupStore`，SQLite                         |
| 浏览器连接、账户范围确认 | Rust `ConnectionStore`，SQLite                                    |
| 写操作及结果协调         | Rust `OperationStore`，SQLite                                     |
| 最近会话观察             | Rust `SessionStore`，SQLite；不等于当前进程状态                   |
| 内置浏览器数据           | `profiles/<Nexus UUID>/user-data`，内置 Provider 管理             |
| 内置内核                 | `cloakbrowser/` 中按完整包版本保存的缓存                          |
| 外部浏览器环境           | AdsPower 或比特浏览器自行存储，Nexus 不复制其目录                 |
| 插件安装及业务资料       | `plugins/` 与各插件私有存储，由插件宿主管理安装、插件管理业务资料 |
| 外观与工作区偏好         | 当前来源的 localStorage                                           |

React、Node 适配器和插件不直接打开主程序业务库。
浏览器预览与 Tauri WebView 的 localStorage 按来源隔离；
原生调用失败不能静默切回演示数据。历史演示键不是原生窗口或分组的数据源，
也不自动转换为真实浏览器环境。

## 窗口记录 v2

`WindowRecord` 只接受 `schema_version: 2`，记录顶层与 `binding` 使用 snake_case；
嵌套 `settings` 沿用当前 camelCase 序列化，例如 `fingerprintSeed`、`startUrl`：

| 字段                                         | 含义与约束                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `id`、`name`                                 | Nexus UUID 与窗口名称；插件关联使用该 UUID                               |
| `binding`                                    | `BrowserBinding { provider_id, connection_id, profile_id }`              |
| `binary_path`、`kernel_version`              | 可空；内置窗口保存本机二进制路径与完整包版本，外部窗口不据此使用内置内核 |
| `proxy_mode`                                 | `direct` / `manual` / `plugin` / `provider`，受 Provider 能力约束        |
| `proxy`、`proxy_plugin`、`proxy_endpoint`    | 手动地址、插件 ID、可空整数端点 ID；必须与代理模式一致                   |
| `settings`                                   | 平台、备注、出口匹配、语言、时区、尺寸、起始地址与可空指纹种子           |
| `origin`                                     | `created` 或 `attached`，区分创建和接管                                  |
| `provider_config`                            | Provider 专有 JSON；内置 Chrome 显示版本可放在 `displayVersion`          |
| `created_at`、`last_opened_at`、`sort_order` | 创建时间、可空最近打开时间与稳定排序值                                   |

业务窗口 ID 与厂商环境 ID 分离。Provider、连接、环境绑定以及内置内核、指纹种子
不能在普通编辑时修改。完整内核包修订号直接保存在 `kernel_version`，
与 Chrome 显示版本分开；正常读取不从显示版本推测包修订号。
外部版本未知时保留未知，不补入本机 CloakBrowser 版本。
在身份核对成功且没有待处理修改时，外部名称、明确报告的内核标签和提供方快照
通过独立事务刷新；空内核报告不清除已有观察。该事务保留本机业务关系，
不放宽内置内核与指纹身份的不可变约束。

`WindowStore::insert(&WindowRecord, Option<&str>)` 同时写入窗口记录和可空分组关系，
由校验保护绑定与字段约束。分组 ID 存在关系列中，不在插件复制一套窗口元数据。

## SQLite 表与关系

内部表名 `profile_records` 保留，基本列仍是 `id`、`record_json`、`group_id`。
`record_json` 已是 v2 记录；保留表名不表示仍支持旧 Profile 服务或旧命令。
分组删除通过外键清空分组关系，不删除窗口。

多浏览器数据增加以下表和索引：

- `browser_connections`：连接配置、启用状态和账户范围声明；
  部分唯一索引保证同一 Provider 只有一个启用连接。
- `browser_operations`：操作 ID、窗口和连接 ID、操作类型、阶段、请求快照及人工确认记录。
- `browser_session_observations`：最近观察状态、观察时间和是否由 Nexus 启动。
- `browser_schema`：当前浏览器数据库版本 `2`。
- `profile_records` 的 `connection_id`、`provider_profile_id`、`sort_order` 是从 JSON
  提取的生成列；连接与环境 ID 的组合唯一，分组列有查询索引。

所有这些存储共用 `database::open_database` 初始化入口。
Node 浏览器数据目录与 SQLite 记录有各自生命周期；
保存一条窗口记录不代表已产生可用浏览器会话或便携站点状态。

## 唯一一次启动升级

应用启动初始化时，对没有浏览器 schema 标记的既有 SQLite 数据执行一次升级，
把旧 SQL 窗口行写成 v2 内置绑定，并保留 Nexus UUID、业务字段与分组关系。
升级建立连接、操作、观察表和生成列索引，事务提交后记录数据库版本 `2`。
已有窗口行时先通过 SQLite `VACUUM INTO` 生成一致性备份，
备份名包含 `before-browser-v2-<UUID>.sqlite`；备份失败停止升级。

新数据库通过同一入口初始化。未知数据库版本、损坏记录或升级失败应明确报错，
不静默重建数据库。事务失败不标记升级成功；备份文件不等于自动恢复工具。

这条升级路径只处理现有 SQL 数据。普通读写、Node 运行时、导入和恢复流程不再维护
旧 schema 读取器，不扫描旧 Profile 目录、不导入 `profile.json`，
也不迁移 localStorage 演示窗口。旧版命令别名和旧快照适配器均不保留。

## 连接与操作持久化

外部连接保存 endpoint、可选 API Key、默认厂商分组、人工账户/工作区说明、
可空真实范围 ID、确认状态、启用状态和修订号。内置接入为
`builtin-cloakbrowser`，由应用自动建立并确认。
当前外部探测不提供稳定范围 ID，因此人工说明不等于厂商身份认证。
保存连接、应用重启或外部观察失败会清除外部确认，确认前阻断写操作。
切换账户应建立新连接，历史窗口继续保留原连接绑定。

创建请求携带稳定 `operationId`，先落盘请求及阶段，再调用 Provider。
同一 ID 不能用于不同请求。响应丢失或结果不明时保留待处理操作，
通过协调接口核对，不能按同名窗口猜测成功或直接重放创建。
配置修改还会保存实际提交字段的散列证据；恢复不会读取插件后来改变的代理来替代原请求。
人工关联保留预留的窗口 UUID；人工结束保存 `cancelled` 和确认时间，
不清除请求证据或自动重试。已结束操作不再进入待处理列表。
外部观察失效只按被观察的连接修订号更新确认标志，不能覆盖后来保存的地址、密钥或启用状态。
最近会话观察只是证据快照；连接不可用时不能把旧 `stopped` 当作当前停止证明，
`unknown`、`missing` 也不自动解除账号等插件关联。

## 保存、转移与秘密

SQLite 或 localStorage 实际写入成功后才能提示保存成功；失败保留可恢复输入。
页面筛选、弹窗开关与批量任务进度仍可只在内存中，
不能将其描述为跨重启自动恢复的任务队列。

内置窗口支持加密导出与手动设备同步，使用 manifest3 和 v2 记录；
旧 manifest 不兼容，外部环境整批拒绝，详见[窗口加密迁移](28-window-transfer.md)。
导入通过目录备份、SQLite 事务、持久日志和插件收据补偿协调，
不能将文件复制与多进程写入描述为断电原子事务。

本机 SQLite 未加密。激活码、连接 API Key、应用代理及手动代理中实际保存的凭据
受本机文件权限保护，不等于系统凭据库。
插件密码和 API Key 按各模块实现保存在插件私有明文文件中，例如 `secrets.json`。
Unix 数据库权限限制为当前用户，Windows 仍依赖应用数据目录 ACL；
不能把这些边界描述为 Keychain 或加密密钥保管已完成。
归档 AES-GCM 加密只保护导出容器，不改变本机存储的明文性质。
秘密不进入日志、源码、演示夹具或 localStorage；终端用户无需 `.env`。

## 验证边界

升级的备份、回滚、关系保留、重复操作协调、未知状态、导入补偿和保存失败都需要定向检查。
本次文档更新未运行 Rust、真实厂商 API、跨机器或 Windows 测试，
不以源码存在推定这些检查通过。
实际结果由主线填写[质量与验证](09-quality-and-testing.md)，
分层见[系统架构](02-architecture.md)，连接与生命周期见[核心后端](12-core-backend.md)。
