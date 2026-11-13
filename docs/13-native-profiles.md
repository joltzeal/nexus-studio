# 原生窗口创建与运行

## 数据边界

窗口管理页通过 Rust 的统一 `WindowService` 管理内置 CloakBrowser、AdsPower 和比特浏览器。
`WindowStore` 将 `WindowRecord` schema 2 写入应用数据目录的 `nexus.sqlite`，
前端不直接读写 SQLite，也不使用 localStorage 保存窗口。

每条记录使用 Raccoon UUID 作为 `id`，并保存创建后不可变的
`binding: { provider_id, connection_id, profile_id }`。
其中 `profile_id` 是该接入下的浏览器环境 ID，必须与 `connection_id` 一起解释；
插件关联继续使用 Raccoon UUID，不使用厂商环境 ID。
记录还包括名称、可选 `binary_path` / `kernel_version`、代理来源与插件引用、
`settings`、`origin`、`provider_config`、创建和最近打开时间及 `sort_order`。
`origin` 区分 Raccoon 创建的 `created` 与接入已有环境的 `attached`。

内置接入固定为 `builtin-cloakbrowser`，其环境 ID 与 Raccoon UUID 相同，
浏览器数据位于 `profiles/<Nexus UUID>/user-data`。
`WindowService.builtin` 指向 `CloakBrowserProvider`，由它持有许可存储、
运行时路径、内核服务、应用网络配置和受管浏览器进程。
通用窗口服务负责绑定、操作意图、调度和插件协调，不直接持有这些内置资源。
外部环境由厂商应用管理，Raccoon 不创建或复制厂商浏览器数据目录，
也不向外部窗口分配内置二进制路径或数值指纹种子。

已有 SQLite 数据只在启动时通过 `database::open_database` 执行一次事务升级；
正常存储读取与内置运行时只接受 schema 2。迁移包只接受 manifest 3，
不提供旧命令、旧运行时记录或旧迁移格式的兼容读取。
账号资料由 `studio.vinted-accounts` 等插件保存，不属于 `WindowRecord`；
窗口名称和 Raccoon 元数据仍由主程序维护。

## 当前窗口 API

| 命令                         | 输入与行为                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `browser_window_list`        | `{ connectionId? }`，读取窗口摘要与观测状态                                                 |
| `browser_window_create`      | `{ input }`，包含稳定的 `operationId`、`connectionId`、配置及内置窗口可选的 `kernelVersion` |
| `browser_window_update`      | `{ input }`，更新可编辑配置，不接收新绑定或内核版本                                         |
| `browser_window_update_note` | `{ id, note }`，只保存备注并返回确认值                                                      |
| `browser_window_start`       | `{ id }`，按已保存绑定启动                                                                  |
| `browser_window_stop`        | `{ id }`，停止对应环境并确认状态                                                            |
| `browser_window_delete`      | `{ id, deleteEnvironment }`，明确区分移除 Raccoon 记录与删除浏览器环境                      |

外部已有环境通过 `browser_window_attach` 接入后使用同一组窗口 API。
创建意图先持久化，再调用 provider；同一 `operationId` 必须重发完全相同的输入。
已提交但结果未确认的操作先核对结果，不盲目重复创建。
批量与账号绑定重试规则见[批量创建窗口](32-batch-window-creation.md)。

## 列表顺序与备注

`WindowStore::list` 按 `created_at DESC, sort_order DESC, id DESC` 排序，
前端 `orderBrowserWindows` 使用相同规则。同一秒创建的窗口由持久化的
`sort_order` 决定先后，序号由 SQLite 的 `browser_sequences` 单调分配，
删除窗口或重启不会重用已经分配的序号。
修改备注和最近打开时间不会改变创建顺序。

`browser_window_update_note({ id, note })` 是独立的元数据写入口，最多 120 个 Unicode 字符，
去除首尾空白，空字符串用于清除备注。SQLite 用 `json_set` 只改 `settings.note`，
不使用前端的整条记录覆盖当前代理、分组、指纹、内核绑定和最近打开时间。
成功返回保存后的备注；前端收到确认后才更新对应行，失败保留草稿。
行内编辑失焦、Enter 或保存按钮共用同一入口，保存期间阻止重复写入；
Esc 和取消按钮不落盘。输入与显示保持相同行高，失败使用提示反馈而不扩张表格行。
此命令允许窗口运行时调用；窗口操作锁、迁移、恢复、待确认操作或应用更新安装会阻止写入。
修改名称、代理及浏览器运行配置需要先确认窗口已停止，并通过 provider 的能力检查；
备注、平台和分组等 Raccoon 元数据按本地存储规则保存。

## 创建与启动

在桌面应用的“窗口管理”选择浏览器接入，再创建窗口或接入厂商已有环境。
外部接入先在“应用设置 → 浏览器接入”配置本机管理 API、探测连通性，
并由用户人工确认当前账号或工作区范围。API 可达不代表账号身份已经核验；
当前厂商探测没有稳定账号范围 ID。外部写操作要求接入已启用且范围已确认，
应用重启后需要重新确认；本机管理 API 独立直连并验证 loopback，不经过窗口代理。

创建表单按实际 provider 能力展示选项。内置窗口支持直连、手动代理或代理插件；
外部窗口还可保留厂商管理的代理配置，内核和指纹由厂商应用负责。
AdsPower 的配置编辑与插件代理能力当前关闭，需完成写入及结果核对验证后才能开放；
Raccoon 备注等本地元数据不受该配置编辑能力开关限制。
窗口管理与账号池的批量入口复用相同配置契约，只有内置窗口分配数值指纹种子。
创建命令返回已保存窗口；网页预览无法调用原生后端。

内置窗口创建前需要在内置浏览器设置中保存并验证 CloakBrowser 激活码。
`browser_window_create` 的 `input.kernelVersion` 省略或为 `null` 时准备最新稳定包，
显式选择时只复用或获取指定完整包，版本或修订不符即失败。
`WindowRecord.kernel_version` 保存包含 SDK 包修订的完整版本，
`provider_config.displayVersion` 单独记录 Chrome 显示版本；
窗口摘要分别返回 `kernelVersion` 和 `version`。
下载结果和启动路径只接受受管的 `chromium-<完整版本>-pro` 缓存。
可在内置浏览器设置提前下载其他版本，下载新包不会重绑已有窗口。
`browser_window_update` 不接受内核版本或绑定变更，内置窗口的二进制路径和指纹种子也不可修改。

内置启动与快照将 schema 2 记录直接经标准输入传给现有的 `profile-runner.js`
`launch` / `snapshot` 动作；该运行时只接受内置绑定，不读取旧版记录。
Rust 检查完整包身份，Node 再核对二进制版本；运行与快照关闭 SDK 自动更新。
激活码从 SQLite 读取后注入本次 Node 子进程，缓存内核不能绕过许可检查。
这些许可、内核准备和 Node 启动步骤只属于内置 provider，外部窗口通过厂商 API 操作。

不同内置窗口可以并行尝试启动，同一环境保持独占；运行中的环境再次收到打开请求时不会重复拉起。
CloakBrowser 根据当前密钥和计划裁决实际并发席位，Raccoon 不硬编码一个会话的限制。
席位不足时反馈启动失败，不自动换内核或回退直连。
窗口页的运行数量是观测结果，不代表 CloakBrowser 许可席位数。

## 失败与恢复

记录损坏、绑定不符或内置精确包不可用时返回错误，不重建记录或改绑其他版本。
创建失败不显示成功；结果未确认时保留操作意图，先核对再恢复。
状态区分 `stopped`、`starting`、`running`、`stopping`、`unknown` 与 `missing`；
厂商断线、未知状态或环境不可见均不等于已停止，也不自动清除窗口或插件关联。
内置浏览器手动关闭后由会话观测更新状态；Raccoon 退出时回收自己托管的内置进程，
不负责关闭外部厂商环境。

加密导出、导入副本、显式覆盖和窗口同步仅支持内置窗口、manifest 3。
导出或传输前检查整批绑定，含任一外部窗口就拒绝整批操作，不复制厂商目录。
导出前需要停止窗口；迁移期间不能启动、编辑或删除同一窗口。
导入保留精确内核包、指纹种子与插件关联，Cookie 和站点存储通过浏览器接口额外处理。
相同 Chrome 显示版本但不同 SDK 包修订不是同一内核身份。
格式与事务恢复见[窗口加密迁移](28-window-transfer.md)，
设备配对与网络边界见[窗口同步插件](29-window-sync-plugin.md)。

删除内置窗口必须使用 `deleteEnvironment: true`，会永久删除其受管浏览器数据。
外部窗口可仅移除 Raccoon 记录；显式删除厂商环境需要相应能力、范围确认和已停止状态。
插件关联的清理随明确删除流程执行，不由列表观测失败触发。

## 分发边界

开发模式使用仓库运行时与本机 Node.js；正式发行流程随应用分发受管 Node 与 JS 依赖。
Rust 编译与测试交给 CI；仍需分别验证
macOS/Windows 安装包的路径、退出清理与激活行为。CloakBrowser JS wrapper 为 MIT 授权，官方二进制另有许可，
发行约束见[分发](08-distribution.md)。
