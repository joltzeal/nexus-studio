# 邮箱插件

## 目标与边界

新增 `studio.email` 邮箱插件，首个提供方为微软邮箱。支持按行导入
`邮箱----密码----client_id----refresh_token`，邮箱增删改查、分页筛选、
收件箱与垃圾箱列表、纯文本邮件详情，以及后台 token 刷新。
密码仅作为用户资料明文保存，不用于密码登录或自动申请新的 OAuth 授权。

参考 `assast/outlookEmail` 的四段式导入、Graph/IMAP 收信和 token 轮换行为，
不引入其 Python、Web 服务或数据库，也不复制其实现。
本次不包含发信、删除远程邮件、附件下载或其他邮箱的虚假实现。

## 使用入口

最低主程序为 `0.1.27`，邮箱插件版本为 `1.0.0`。旧版主程序没有邮箱能力与页面，
应先更新主程序，再在已配置的插件商店中安装邮箱插件。

安装并启用邮箱插件后，在“插件中心 → 邮箱管理”操作。
新增邮箱时填写邮箱、Client ID 和 Refresh token，密码可选。
批量导入在同一弹窗中选择 Graph 或 IMAP，按四段格式粘贴多行资料；
每批最多 500 行、512 KiB，逐行报告新增、重复或格式错误，不覆盖已有邮箱。
邮箱列表支持搜索、状态筛选、每页 20/50 条、编辑、删除、单个及选中刷新。

“刷新设置”控制自动刷新与间隔。关闭自动刷新后，手动刷新仍可入队，
排队意图会落盘，重启后继续处理；暂停的邮箱不执行新的刷新或邮件读取。
“读取邮件”分别打开收件箱和垃圾箱，每页最多 20 封；
打开详情不会主动将邮件标记为已读，也不会加载远程图片。

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
HTML 不直接挂载进 WebView，正文转换为文本，禁止远程跟踪图片或邮件脚本执行。

## 私有持久化

账号、密码、client ID、refresh/access token、到期时间、刷新结果、调度时间及设置，
明文存入插件私有目录的 `email.json`，文件权限 0600。
Rust 仍是主程序 SQLite 的唯一所有者，插件不读写 SQLite 或其他插件的目录。
列表只返回凭据存在标记；token 和密码不回显，不进入日志、错误或 localStorage。
编辑时留空凭据保留原值。重复导入跳过已有邮箱，不能覆盖已轮换的 refresh token。

写入使用串行队列、文档副本、临时文件和原子 rename；落盘成功才替换内存。
损坏存储显式失败，不重置为空数据。刷新失败保留上次成功 token 和成功时间。
配置迁移只包含自动刷新设置，不包含邮箱、密码、token 或邮件内容。

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
列表显示邮箱、收信通道、状态、最近成功刷新、到期时间、下次刷新、备注和操作。
提供新增、批量导入、编辑、删除、立即刷新、选中刷新和读取邮件。
邮件面板按收件箱/垃圾箱分栏并分页，展示主题、发件人、时间和纯文本详情。

能力为 `email.provider`，不借用 `account.pool`，不参与窗口删除与窗口迁移。
RPC 统一使用 `email.*`，列表分页最多 50 项，邮件列表最多 20 项，
正文限制 64 KiB；任何完整响应仍须低于宿主 1 MiB 单行上限。
Graph 分页游标绑定邮箱和目录，仅在当前插件进程中有效；
IMAP 邮件标识包含邮箱、目录、UIDVALIDITY 和 UID，防止目录重建后错读邮件。
页面按插件进程、邮箱和目录隔离请求；重启插件或切换目录后，迟到结果不能覆盖新页面。
新增能力、manifest 和专用页面需随主程序发布，单独更新插件不能为旧主程序增加页面。

| RPC                                    | 输入与结果                                              |
| -------------------------------------- | ------------------------------------------------------- |
| `email.accounts.list`                  | 搜索、状态、页码、页大小；返回无密码和 token 的分页摘要 |
| `email.accounts.save`                  | 新增或按 ID 编辑；编辑时省略密码/token 则保留原值       |
| `email.accounts.import`                | 四段式文本与收信通道；返回新增/跳过数量和行错误         |
| `email.accounts.remove`                | 邮箱 ID；删除本地资料，停止其后续任务                   |
| `email.refresh.queue`                  | 1–100 个邮箱 ID；返回排队与跳过数量                     |
| `email.settings.get/save`              | 自动刷新开关和 5–1440 分钟间隔                          |
| `email.messages.list`                  | 邮箱 ID、目录和可选游标；返回邮件摘要及下一页游标       |
| `email.messages.get`                   | 邮箱 ID、目录和邮件 ID；返回有界纯文本正文              |
| `configuration.export/validate/import` | 仅迁移刷新设置                                          |

## 扩展与源码

- `plugins/email/src/domain/types.ts` 定义抽象工厂、令牌刷新器和只读邮箱接口。
- `plugins/email/src/providers/factory.ts` 注册实际提供方；微软实现位于同目录。
- `plugins/email/src/services/refresh.ts` 负责通用调度、单飞、退避和待保存结果。
- `plugins/email/src/store/private-store.ts` 负责校验及原子持久化。
- `plugins/email/src/capabilities/email.ts` 负责业务 RPC 和配置迁移。
- `apps/desktop/src/features/email/` 负责经过边界校验的桌面页面。

新增提供方时实现自己的工厂及凭据校验，再扩展实际支持的提供方枚举与表单；
不在通用调度器加入厂商分支，不将密码登录或通道降级作为隐式兼容路径。
HTTP/IMAP 适配器应验证取消、代理失败、权限拒绝、分页上限与稳定的邮件身份。

## 验证

使用受控 HTTP/IMAP 响应验证导入、token 轮换、定时刷新、并发、重启、写入失败、
授权失败、取消、代理传递、分页和邮件内容边界。
真实微软账号、Windows 安装和正式发行尚需对应环境验证。
本地不构建、不打包、不执行 Rust 编译/测试，实际检查结果统一记录在质量文档。

## 参考

- [参考项目](https://github.com/assast/outlookEmail)
- [Microsoft refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)
- [Graph 邮件列表](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Microsoft OAuth IMAP](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)
- [ImapFlow](https://github.com/postalsys/imapflow)
