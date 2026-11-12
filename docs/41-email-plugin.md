# 邮箱插件

## 目标与边界

新增 `studio.email` 邮箱插件，首个提供方为微软邮箱。支持按行导入
`邮箱----密码----client_id----refresh_token`，邮箱增删改查、分页筛选、
收件箱与垃圾箱列表、格式化/纯文本详情、已读未读同步、后台收信及 token 刷新。
密码仅作为用户资料明文保存，不用于密码登录或自动申请新的 OAuth 授权。

参考 `assast/outlookEmail` 的四段式导入、Graph/IMAP 收信和 token 轮换行为，
不引入其 Python、Web 服务或数据库，也不复制其实现。
本次不包含发信、删除远程邮件、附件下载或其他邮箱的虚假实现。

## 使用入口

邮箱插件 `1.1.0` 与账号池 `1.3.0` 已发布至商店，最低主程序为 `0.1.28`。
主程序 `v0.1.28` 标签已推送，安装包及应用内更新清单由 CI 验证后公开。
格式化阅读、已读未读、定时收信与账号联动需要同时更新三者；
旧主程序 `0.1.27` 的页面只包含原有纯文本阅读和 token 刷新。
实际构件与商店回读结果见[插件商店](25-plugin-market.md)。

安装并启用邮箱插件后，在“插件中心 → 邮箱管理”操作。
新增邮箱时填写邮箱、Client ID 和 Refresh token，密码可选。
批量导入在同一弹窗中选择 Graph 或 IMAP，按四段格式粘贴多行资料；
每批最多 500 行、512 KiB，逐行报告新增、重复或格式错误，不覆盖已有邮箱。
邮箱列表支持搜索、状态筛选、每页 20/50 条、编辑、删除、单个及选中刷新 token/收信。
表格另显示收件箱及垃圾箱未读数量、最近检查、下次检查和收信错误；
尚未检查的计数显示未知，不把它当作零封邮件。

收信与 token 刷新使用独立开关和间隔。关闭自动任务后，对应手动操作仍可入队，
排队意图会落盘，重启后继续处理；暂停的邮箱不执行新的刷新、收信或邮件读取。
“读取邮件”分别打开收件箱和垃圾箱，每页最多 20 封，支持全部/未读/已读筛选、
当前页多选与批量标记。成功载入未读邮件详情后才尝试标记已读；
权限不足时保留正文并提示失败，不把本地样式变化当作远端写入成功。
正文支持格式化与纯文本切换、复制，收件人、发件人与完整时间可查看。

## 提供方与抽象工厂

`EmailProviderFactory` 为每个已注册提供方创建配套的 `TokenRefresher` 与
`MailboxClient`。通用邮箱服务只依赖这两个接口，不包含微软 HTTP/IMAP 分支。
添加其他邮箱时注册新的工厂，按对应凭据定义边界校验；界面只展示实际实现的提供方。

微软提供方支持明确选择 Graph 或 OAuth IMAP。Graph 使用
`login.microsoftonline.com/common/oauth2/v2.0/token` 和 Microsoft Graph v1.0，
请求既有 Graph 授权的 `.default` scope。IMAP 请求
`https://outlook.office.com/IMAP.AccessAsUser.All offline_access`，
通过 TLS 连接 `outlook.office365.com:993`。
token 必须与 client ID 配对并已获得所选通道的权限；四段文本不能授予额外权限。
不在权限失败时偷偷更换收信通道，也不使用密码登录回退。

HTTP 请求使用宿主注入的 `fetch`；IMAP 显式继承 `NEXUS_NETWORK_PROXY`，
使用开源 ImapFlow 的代理连接。已配置代理连接失败时不回退直连。
Graph 标记已读/未读需要已有令牌具备 `Mail.ReadWrite` 权限；
只具备读信权限时仍可查看和定时检查邮件，标记失败不会禁用这些读操作。
IMAP 使用服务器确认的 `\Seen` 增删，读取内容不隐式设置已读。
HTML 在插件端通过允许列表移除脚本、样式、图片、表单、链接与属性，
桌面再次重建无属性标签，放入无脚本/同源权限的 sandbox iframe，
并以 CSP 禁止外部资源和导航；用户仍可切换到纯文本。

## 私有持久化

账号、密码、client ID、refresh/access token、到期时间、刷新结果、
目录计数、收信结果、独立调度时间及设置，
明文存入插件私有目录的 `email.json`，文件权限 0600。
Rust 仍是主程序 SQLite 的唯一所有者，插件不读写 SQLite 或其他插件的目录。
列表只返回凭据存在标记；token 和密码不回显，不进入日志、错误或 localStorage。
编辑时留空凭据保留原值。重复导入跳过已有邮箱，不能覆盖已轮换的 refresh token。

写入使用串行队列、文档副本、临时文件和原子 rename；落盘成功才替换内存。
损坏存储显式失败，不重置为空数据。刷新失败保留上次成功 token 和成功时间。
配置迁移只包含 token 刷新和自动收信设置，不包含邮箱、密码、token、计数或邮件内容。
正文按需读取，不把完整邮件缓存当作本地邮箱。

## 定时收信

默认开启，每 1 分钟检查，允许配置 1–60 分钟。调度器每 15 秒检查到期任务，
与 token 刷新独立，最多同时处理两个邮箱，同一邮箱收信单飞。
每轮读取收件箱、垃圾箱首页和全目录总数/未读数，不标记已读；
两个目录均成功后才一起保存计数、最近检查与最新邮件时间，避免混合不同轮次的结果。
token 不可用时复用令牌刷新调度器，不以重复刷新绕过权限错误。

手动收信会持久化意图；应用或插件重启后可恢复。
临时网络失败按 1–60 分钟退避，并保留上次成功计数。
永久授权或收信权限错误停止该邮箱重复自动收信，更新凭据/通道后恢复；
已读写入的权限错误单独反馈，不作为收信永久失败。
暂停、删除、更改凭据、切换通道或停止插件均取消旧任务，迟到结果不能覆盖新资料。
收信依赖主程序与插件保持运行；退出应用后不在系统后台收信。

## 与账号池联动

邮箱行可以搜索并选择 Vinted 账号，账号池的“关联邮箱”列可以反向选择邮箱、
查看邮件、更换或解除关联。匹配邮箱地址只作为搜索建议，不自动绑定。
一个账号保存一条邮箱关系，同一邮箱可以关联多个账号；这不修改登录账号、
密码、手机号、接码链接、地址或窗口绑定。

关系由账号池保存 `{ pluginId, mailboxId, email, linkedAt }`，
邮箱插件只公开不含密码/token 的目标投影。跨插件调用由主程序组合，
插件不直接打开对方存储。替换或解除携带最后看到的邮箱 ID，
账号池在同一次持久化修改中核对关系，仅更新关联字段与更新时间。
解除关联不依赖邮箱插件仍然安装。

读信按 UUID 找到邮箱，并在网络操作前后核对关联时的邮箱地址；
邮箱被删除、改名或暂停时需要用户处理，不按地址猜测另一个邮箱。
插件停用或更换进程后关闭旧阅读入口。窗口复制/迁移清空设备本地邮箱关联，
目标设备需显式重新绑定，不携带源设备的邮箱 ID。

## 刷新与恢复

默认启用自动刷新，每 60 分钟刷新，允许配置 5–1440 分钟。
下次刷新取配置间隔与 access token 到期前 5 分钟中的较早者，避免高频空转。
自动刷新开启时，新导入且启用的邮箱在下一轮检查中执行；
启动后检查持久化到期任务，不依赖页面打开。
每 15 秒检查到期任务，同时最多刷新两个邮箱，同一邮箱只执行一次。
手动批量刷新持久化排队意图后立即返回，页面轮询状态。

微软返回新的 refresh token 时，与 access token 和到期时间一并落盘；
未返回新 refresh token 时保留旧值，不能误判刷新失败。
失败按 1–60 分钟指数退避，遵守受限的 `Retry-After`。
`invalid_grant`、`invalid_client`、`interaction_required` 等不可自动恢复的授权错误
以及 `invalid_scope`、`unauthorized_client`、`access_denied` 等权限错误，
持久化分类、清除手动排队意图并停止自动重试；修改凭据或收信通道后恢复。
暂停再启用或重启插件不会重试相同的永久授权错误。
读取邮件先使用有效 access token，必要时复用同一邮箱的刷新任务。
403 权限不足与 token 失效分别反馈，不能以空收件箱掩盖错误；
桌面只把经过校验的错误类别映射为固定文案，不展示上游原始错误。

修改凭据、更换通道、删除或暂停邮箱后，旧任务结果不能覆盖新记录。
轮换响应拿到后须先尝试落盘；磁盘写入失败明确失败，保留旧文档，
并保留本进程中待持久化的刷新结果供重试，不能继续用旧 token 再发起轮换。
主程序退出或插件停止后取消网络并停止计时器；不提供应用退出后的系统服务。

## 页面与协议

邮箱页面使用现有紧凑表格、搜索、状态筛选、分页、导入和编辑弹窗。
列表区分收信状态与 token 状态，使用紧凑工具栏、未读计数和可检查的错误提示。
阅读器使用邮件列表与正文主从布局，在窄窗口内保持可滚动操作。
已读未读写入只应用服务端确认成功的 ID；部分失败保留失败项选择并给出分类提示。
刷新列表不主动清空当前正文；改变目录、筛选或页码时隔离旧请求。

能力为 `email.provider`，不借用 `account.pool`，不参与窗口删除与窗口迁移。
RPC 统一使用 `email.*`，列表分页最多 50 项，邮件列表最多 20 项，
纯文本正文限制 64 KiB、HTML 限制 128 KiB，任一截断都反馈 `truncated`；
任何完整响应仍须低于宿主 1 MiB 单行上限。
Graph 分页游标绑定邮箱、目录和已读筛选，仅在当前插件进程中有效；
IMAP 邮件标识包含邮箱、目录、UIDVALIDITY 和 UID，防止目录重建后错读邮件。
页面按插件进程、邮箱、目录、筛选和页码隔离请求；
重启插件或切换目录后，迟到结果不能覆盖新页面。
新增能力、manifest 和专用页面需随主程序发布，单独更新插件不能为旧主程序增加页面。

| RPC                                    | 输入与结果                                                           |
| -------------------------------------- | -------------------------------------------------------------------- |
| `email.accounts.list`                  | 搜索、状态、页码、页大小；返回无密码和 token 的分页摘要              |
| `email.accounts.get`                   | `{ id }`；返回一个无凭据邮箱视图                                     |
| `email.accounts.targets`               | 搜索、分页；只返回 ID、邮箱、启用状态与状态分类                      |
| `email.accounts.save`                  | 新增或按 ID 编辑；编辑时省略密码/token 则保留原值                    |
| `email.accounts.import`                | 四段式文本与收信通道；返回新增/跳过数量和行错误                      |
| `email.accounts.remove`                | 邮箱 ID；删除本地资料，停止其后续任务                                |
| `email.refresh.queue`                  | 1–100 个邮箱 ID；返回排队与跳过数量                                  |
| `email.receive.queue`                  | 1–100 个邮箱 ID；手动排队收信，返回排队与跳过数量                    |
| `email.settings.get/save`              | token 刷新 5–1440 分钟、收信 1–60 分钟及独立开关                     |
| `email.messages.list`                  | 邮箱 ID、目录、已读筛选和可选游标；返回摘要、目录总数/未读数及下一页 |
| `email.messages.get`                   | 邮箱 ID、目录和邮件 ID；返回有界纯文本及安全 HTML                    |
| `email.messages.read`                  | 邮箱 ID、目录、1–20 个邮件 ID、isRead；返回成功 ID 和分类失败        |
| `configuration.export/validate/import` | 仅迁移 token 刷新和自动收信设置                                      |

消息 list/get/read 可以传 `expectedEmail`，桌面阅读器固定传入打开时的邮箱地址。
`1.1.0` 协议共 16 个方法（含 3 个配置迁移方法），原 `1.0.0` 为 12 个。

## 扩展与源码

- `plugins/email/src/domain/types.ts` 定义抽象工厂、令牌刷新器和邮箱读写接口。
- `plugins/email/src/providers/factory.ts` 注册实际提供方；微软实现位于同目录。
- `plugins/email/src/services/refresh.ts` 负责通用调度、单飞、退避和待保存结果。
- `plugins/email/src/services/reception.ts` 负责独立收信调度、目录计数及恢复。
- `plugins/email/src/providers/content.ts` 负责有界文本和 HTML 允许列表。
- `plugins/email/src/store/private-store.ts` 负责校验及原子持久化。
- `plugins/email/src/capabilities/email.ts` 负责业务 RPC 和配置迁移。
- `apps/desktop/src/features/email/` 负责经过边界校验的桌面页面。

新增提供方时实现自己的工厂及凭据校验，再扩展实际支持的提供方枚举与表单；
不在通用调度器加入厂商分支，不将密码登录或通道降级作为隐式兼容路径。
HTTP/IMAP 适配器应验证取消、代理失败、权限拒绝、分页上限与稳定的邮件身份。

## 验证

使用受控 HTTP/IMAP 响应验证导入、token 轮换、定时刷新/收信、并发、重启、
写入失败、已读未读部分失败、权限分离、取消、代理传递、分页、
格式化邮件边界及账号关系一致性。
`1.1.0` 已从 CI 构件发布至 R2，包内文件、16 个 RPC 启动及公开入口回读验证通过。
真实微软账号、原生 WebView、Windows 安装和真实代理仍需对应环境验证。
本地不构建、不打包、不执行 Rust 编译/测试，实际检查和发布结果统一记录在质量文档。

## 参考

- [参考项目](https://github.com/assast/outlookEmail)
- [Microsoft refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)
- [Graph 邮件列表](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Microsoft OAuth IMAP](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)
- [ImapFlow](https://github.com/postalsys/imapflow)
