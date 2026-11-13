# SIM8 接码插件 `studio.sim8`

本文说明仓库内 SIM8 接码插件的实际范围。插件规则见
[插件对接开发规范](14-plugin-integration-guide.md)，宿主协议见[插件宿主](17-plugin-host.md)，
账号侧的字段含义见 [Vinted 账号池插件](24-vinted-accounts-plugin.md)。

## 当前事实

插件版本为 `1.0.3`，最低主程序 `0.1.21`，加入接口地址和 Token 配置迁移。
保留 `expire` 读取、到期前七天每日提醒及当天关闭提醒的持久化，
需同时更新主程序和插件；实际构件与上传状态见[质量记录](09-quality-and-testing.md)。

插件包位于 `plugins/sim8`，实现 `verification.provider` 能力的方法、私有 JSON
存储与逐行 JSON RPC 服务端。页面位于 `apps/desktop/src/features/sim8`，
安装后显示在「插件中心 → SIM8 接码」。Raccoon `0.1.8` 包含此专用页面，
侧栏根据宿主启用状态动态显示，未安装时不展示；单独安装插件包不会给旧版主程序增加页面。

- 覆盖 SIM8 OpenAPI 的全部 15 个 HTTP 端点，加上本地管理与接码链接请求共 24 个业务 RPC 方法（另有 3 个通用配置迁移方法）：
  买号、后分配、订单、续费、换链接、筛选检测与取码都能在页面里完成。
- 项目列表可能有上百条：买号与筛选检测的项目选择都是可输入筛选的下拉，
  打开后直接打字过滤，↑↓ 移动、回车选中，选中项在关闭状态下仍显示全名。
- 唯一凭据是后台的 API Token。它存在插件自己的 `secrets.json`（文件权限 0600），
  `sim8.json` 里只留 `tokenRef`；页面不回显 Token，留空保存表示不修改。
- 默认接口地址 `https://api.cc`，服务端给了专属域名时可以改，保存后立即生效。
- 只访问用户填写的那个域名，`wantsBrowserAccess: false`，不碰浏览器。
- 服务端信封固定是 `{ code, msg, time, data }`，HTTP 状态恒为 200：
  业务成功看 `code === 1`，401 / 403 / 429 分别是认证失败与限流。

## 包结构

```text
plugins/sim8/
├── package.json          # ESM、锁定依赖、dist 由构建生成
├── nexus.plugin.ts       # manifest 唯一来源，由 definePluginManifest 校验
├── src/
│   ├── index.ts          # 组装存储、能力与协议；进程入口
│   ├── capabilities/     # verification.provider 方法表
│   ├── domain/           # 类型、zod 校验、响应归一化、号码池与验证码提取
│   ├── rpc/              # 协议、服务端、脱敏日志（与其他插件同源，按包自包含）
│   ├── services/         # HTTP 客户端：信封解析、超时与错误映射
│   └── store/            # 私有 JSON 文档与 0600 凭据文件
└── dist/                 # 构建产物：dist/src/index.js 与 dist/nexus.plugin.json
```

## 接口覆盖

| 上游端点                          | 方法                      | 说明                                    |
| --------------------------------- | ------------------------- | --------------------------------------- |
| `GET /api/v1/profile/info`        | `sim8.profile`            | 账号与余额；`config.set` 也用它验 Token |
| `GET /api/v1/app/cate`            | `sim8.catalog.categories` | 项目分类                                |
| `POST /api/v1/app/list`           | `sim8.catalog.apps`       | 项目列表，可按分类、卡类型、名称筛      |
| `POST /api/v1/buy/prefix`         | `sim8.buy.prefixes`       | 指定项目当前可用的号码前缀与号源        |
| `POST /api/v1/buy/create`         | `sim8.buy.create`         | 直接购买，返回号码与接码链接            |
| `POST /api/v1/buy/deferred`       | `sim8.buy.deferred`       | 后分配下单，带 `request_id` 幂等键      |
| `POST /api/v1/order/list`         | `sim8.orders.list`        | 订单列表，支持分页与订单号精确查        |
| `POST /api/v1/order/api`          | `sim8.orders.apis`        | 订单下的全部号码，后分配靠它收号        |
| `POST /api/v1/order/apiOnce`      | `sim8.orders.one`         | 订单下的单条号码                        |
| `POST /api/v1/order/changeToken`  | `sim8.orders.changeToken` | 更换接码链接，旧链接立即失效            |
| `POST /api/v1/order/renewApiText` | `sim8.orders.renewText`   | 按 `+tel----url` 文本批量续费           |
| `POST /api/v1/order/renewApis`    | `sim8.orders.renewIds`    | 按记录 ID 批量续费                      |
| `GET /api/v1/filter/app`          | `sim8.filter.apps`        | 筛选检测项目与单价                      |
| `POST /api/v1/filter/create`      | `sim8.filter.create`      | multipart 上传号码，返回检测订单        |
| `GET /api/v1/filter/detail`       | `sim8.filter.detail`      | 检测订单状态、有效数与结果文件          |

本地状态与接码链接方法：

| 方法                  | 说明                                           |
| --------------------- | ---------------------------------------------- |
| `sim8.config.get`     | 接口地址、是否已存 Token、余额与号码条数       |
| `sim8.config.set`     | 改地址、存或清 Token；存前先验证一次           |
| `sim8.records.list`   | 本机号码池，可按号码、订单号或备注搜索         |
| `sim8.records.remove` | 从本机号码池删一条，不退号                     |
| `sim8.records.clear`  | 清空本机号码池                                 |
| `sim8.sms.read`       | 按号码或接码链接取码，只读不写                 |
| `sim8.expiry.list`    | 读取即将到期、当天未关闭的提醒，以及待检查号码 |
| `sim8.expiry.refresh` | 分批请求号码的接码链接，更新响应 `expire`      |
| `sim8.expiry.dismiss` | 将指定号码、指定到期时间的当天提醒标记为已关闭 |

## 号码池

上游的订单接口只能按订单号查，没有“列出我买过的号码”，所以插件自己留一份记录：
每次购买、每次按订单同步都会写进 `sim8.json` 的 `records`。

- 上限 2000 条，超出后按 `addedAt` 丢弃最旧的；旧号码仍可在上游订单里查到。
- 去重键是去掉 `+` 的号码本身，`+1415…` 与 `1415…` 是同一条记录。
- 合并时保留 `addedAt` 与最近一次取码结果；上游返回空字段不覆盖已有值。
- 只删本机记录，不退号、不影响上游账号里已购买的号码。

## 取码

`sim8.sms.read` 直接请求接码链接，不带账号 Token——链接自己就是凭据。

- 响应体最多读 256 KB，回传给页面最多 64 KB，超出部分标记 `truncated`。
- 提取规则：4 位或 6 位纯数字，排除 1900–2100 这样的年份，优先取关键字
  （`code` / `验证码` / `OTP` 等）附近的数字，**只有唯一匹配才返回**。
- 找不到唯一验证码时返回 `code: null` 和原文，页面把原文放出来，
  死链接和“短信还没到”因此可以区分。
- 取码结果写回该条记录的 `lastRead`，号码池表格直接显示最近一次验证码。
- 响应含有效 `expire` 时，同时更新号码到期时间；换过链接或删除后的迟到响应不再写回。

## 窗口页到期提醒

窗口页对本机 SIM8 号码池中的所有号码检查到期时间，包括尚未关联账号的号码。
号码在到期前 7 天（含整 168 小时边界）进入提醒，到期时退出“即将到期”列表；
号码池原有的过期标记继续保留。提醒按到期时间升序显示号码、到期日期以及关联账号、窗口，
同一号码关联多个账号或窗口只占一条。解绑只更新关联说明，不从号码池移除号码。

点击“今天不再提醒”后，插件将本机日历日期和该次到期时间写入号码记录的
`expiry.dismissedOn` / `expiry.dismissedFor`。写入成功才隐藏；写入失败保留提醒并显示错误。
退出页面或重启应用不会恢复当天已关闭的提醒，第二个本机日历日重新提醒，
前提是号码仍未过期且处于未来 7 天内。续费改变到期时间后使用新的提醒标识，
旧关闭记录不会屏蔽新有效期；相同时间的不同日期格式不会清除关闭状态。

读取规则：

- `sim8.expiry.refresh` 接受 `{ tels: string[] }`，每批最多 8 个号码、同时最多 4 个链接。
  只请求本机已存的号码链接，不执行购买、续费或换号，不携带账号 API Token。
  并行调用按批串行处理，重复号码共享持久化的检查间隔。
- 从 JSON 响应根级 `expire` 或 `data.expire` 读取日期，即使短信尚未收到也可更新。
  不把订单的后分配队列时间或短信正文里的日期当作号码有效期。
  支持 10 位 Unix 秒、13 位 Unix 毫秒、带时区的 ISO 日期和 `YYYY-MM-DD HH:mm:ss`；
  无时区日期按本机时区解析，仅日期按本机当日零点解释，保存为 ISO 时间。
  缺失、无效或不支持的格式不推测日期，也不清空上次已知的有效期。
- 每次请求最多 20 秒，响应上限 256 KB；批次 RPC 上限 60 秒。
  成功后 6 小时内不重复请求；失败或缺少有效 `expire` 时 15 分钟后可重试。
  `expiry.attemptedAt` / `expiry.checkedAt` 持久化检查时间，重启不会绕过间隔。
  失败条数在提醒区域说明，不把网络故障标为号码过期。
- 到期检查不写入 `lastRead`、不消费验证码等待状态、不发验证码通知。
  检查期间若号码删除、链接替换或已同步更新有效期，旧响应不会覆盖新资料。

`sim8.expiry.list` 返回 `{ items, pendingTels, failed, storageDurable }`：
`items` 为 `{ tel, expiresAt, checkedAt }[]`，只含当日可见的提醒；
`pendingTels` 最多 8 条，不返回接码链接、Token 或短信正文。
`sim8.expiry.dismiss` 接受 `{ tel, expiresAt }`，到期时间已变化时拒绝关闭旧提醒。
三个方法均通过 `verification.provider` 调用，不要求设置购买 Token。

窗口页进入时先读本机结果，再处理待检查批次；停留期间每分钟重读本机结果，
跨日或电脑休眠恢复后在下一次读取时更新提醒。窗口页的“刷新”和提醒内的“刷新提醒”
也会重读，网络请求仍遵循检查间隔。应用关闭或离开窗口页后不继续定时检查，
下次进入时补查。插件停用时取消页面轮询结果接收；未安装时不显示提醒，
旧插件未声明这三个方法时提示更新，不反复调用未知方法。

检查和关闭状态沿用插件明文 `sim8.json`；旧文档缺少 `expiry` 时按未检查、未关闭加载。
无持久化目录的运行会明确提示关闭状态仅在本次运行期间有效。
此功能同时涉及主程序窗口页和 SIM8 插件；仅更新其中一个不会给旧版本补齐另一端能力。

## 与 Vinted 账号池联动

联动不新增方法、不改账号插件的存储格式：前端通过宿主调用账号池已有的
`vinted.accounts.list` 与 `vinted.accounts.save`，把号码写进 `phone`、
把接码链接写进 `smsOtpUrl`。之后在账号页点「手机验证码」读的就是这条链接。

三个入口共用同一条写入路径：

- 账号表单：手机号右侧的「号码池」按钮列出已购号码，选中后手机号与
  手机接码地址一起填好，保存账号时落库。编辑已有账号时传入当前账号标识。
- 窗口页：「Vinted 账号」列里已关联账号的行有一个手机图标，弹层里可以直接挑
  一个号码（号码与链接一起写入），也可以只粘贴接码链接——这条路径只改
  `smsOtpUrl`，账号原有的手机号保持不变。手机号显示在窗口行内，可以一键复制；
  号码与手机图标使用语义强调色标记已有手机号。
- SIM8 页面：号码池每行的「写入账号」，选账号后写入。

写入时先 `list` 取到完整记录，只替换要改的字段再 `save`，
其余已定义的业务字段保持原值，创建时间由账号插件保留。
账号契约新增字段时需要同步维护 `mergeAccountNumber`。字段没有变化时不发起 `save`，
但仍返回刚读取的账号；发生写入时返回 `save` 的实际账号记录，供窗口行与弹层立即更新。

窗口表格和 Vinted 账号池表格均支持在手机号旁直接解绑。
该操作清空账号的 `phone` 与 `smsOtpUrl`，保留账号其他资料、窗口绑定和号码池中的号码，
不会调用 SIM8 的删除、退号或上游购买接口。保存失败保留原值并允许重试，
同一账号的联系人写入按顺序执行，避免先前的号码分配在解绑后覆盖结果。

窗口手机弹层使用「验证码 / 号码池 / 编辑链接」Tabs，顶部始终说明目标 Vinted 账号，
并提供当前手机号的复制入口。保存号码或链接成功后回到弹层的验证码页签，
用户可直接调用账号插件的 `readOtp(account.id, 'sms')`；此入口读取的是账号保存的
`smsOtpUrl`，不调用 SIM8 的 `sim8.sms.read`，也不要求 SIM8 正在运行。
验证码、原文、截断提示和错误在弹层内显示，验证码与原文均可复制。
未保存的链接草稿会阻止取码并提示先保存，写入失败保留草稿；
仅编辑链接不会清空手机号。弹层与列表限制高度，长内容在内部滚动。

- 账号池插件没装或没运行时，除「写入账号」外的功能照常可用，
  页面顶部给一行说明而不是整页报错。
- 一个号码可以写进多个账号；再次写入会覆盖该账号原来的手机号与接码链接。
- 账号表单与窗口的号码选择器每次打开会查询账号池，在每个号码上标记
  「当前账号」并列出所有其他使用者。比较只保留号码中的数字，忽略 `+`、空格、
  连字符、括号等格式字符；不推断国家码、不移除数字前缀或前导零。
  这里的占用比较不会改写 SIM8 号码池自身的去重或存储规则。
- 占用信息只作提醒：不会禁用已被使用的号码，也不会自动解除其他账号的关联。
  账号查询进行中或不可用时分别提示正在查询或占用情况未知，只有查询成功才显示
  「暂无账号使用」。缺少接码链接的号码仍沿用原有不可选择规则。

## 错误与限流

失败统一是 `PluginFailure`，码表：`INVALID_REQUEST`、`NOT_CONFIGURED`、
`UNAVAILABLE`、`RATE_LIMITED`、`TIMEOUT`、`CANCELLED`、`AUTH_FAILED`、
`PROTOCOL_ERROR`、`PERMISSION_DENIED`。错误文案不回声 Token，也不回声接码链接。

普通请求 20 秒超时；购买、续费、后分配、筛选提交这类上游要真正分配资源的调用
放宽到 60 秒，页面侧的 RPC 截止时间与之对齐。

## 已知边界

- 没有退号、退款与订单取消：上游 OpenAPI 不提供这些端点。
- 后分配订单不会自动轮询，需要在「订单」页按订单号同步一次。
- 筛选检测只给状态与结果文件链接，插件不下载、不解析结果文件。
- 号码池只在本机；换机器要靠订单号重新同步。
- 不校验号码能否收到短信，只如实回传接码链接返回的内容。

## 本地验证

按当前开发约定，不在本地构建、打包或运行需要重新构建入口的验证。
固定使用 Node.js 24.18.0，前端联动测试可直接执行：

```bash
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec vitest run apps/desktop/src/features/sim8/accounts-bridge.test.ts apps/desktop/src/features/sim8/number-picker.test.ts --maxWorkers=4
```

这些用例验证只改链接时保留手机号、账号字段完整性、保存后的最新账号回传、
保存失败与查询失败、格式不同的号码占用、当前账号标记及多个其他账号的提醒。
构建后的插件进程和加密包验证交由 CI；实际执行结果由主线统一记录。

插件自身的测试范围包括验证码提取、响应归一化、号码池合并、
HTTP 客户端（信封、错误码、超时、地址规范化）、能力方法表与 manifest 校验。
包验证脚本 `scripts/verify-package.mjs` 负责解密 `.nexuspkg` 并握手检查方法表。
前端与插件测试不代表真实账号买号、真实接码或上游限流策略已通过。

## 设置配置迁移

新增通用 `configuration.export / configuration.validate / configuration.import` 三个 RPC，
通过插件原有能力调用，统一接入「应用设置 → 配置迁移」。
迁移接口地址和实际 Token；导入离线完成并清除旧账户缓存，
不迁移号码、订单或每日关闭提醒记录。首页不展示插件升级或不可用状态提示。
文件、校验和失败写入规则见[配置导入导出](37-configuration-transfer.md)。
