# SIM8 接码插件 `studio.sim8`

本文说明仓库内 SIM8 接码插件的实际范围。插件规则见
[插件对接开发规范](14-plugin-integration-guide.md)，宿主协议见[插件宿主](17-plugin-host.md)，
账号侧的字段含义见 [Vinted 账号池插件](24-vinted-accounts-plugin.md)。

## 当前事实

插件包位于 `plugins/sim8`，实现 `verification.provider` 能力的方法、私有 JSON
存储与逐行 JSON RPC 服务端。页面位于 `apps/desktop/src/features/sim8`，
安装后显示在「插件中心 → SIM8 接码」。Nexus `0.1.8` 包含此专用页面，
侧栏根据宿主启用状态动态显示，未安装时不展示；单独安装插件包不会给旧版主程序增加页面。

- 覆盖 SIM8 OpenAPI 的全部 15 个 HTTP 端点，落在 21 个 RPC 方法上：
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

剩下几个方法不走上游 API：

| 方法                  | 说明                                     |
| --------------------- | ---------------------------------------- |
| `sim8.config.get`     | 接口地址、是否已存 Token、余额与号码条数 |
| `sim8.config.set`     | 改地址、存或清 Token；存前先验证一次     |
| `sim8.records.list`   | 本机号码池，可按号码、订单号或备注搜索   |
| `sim8.records.remove` | 从本机号码池删一条，不退号               |
| `sim8.records.clear`  | 清空本机号码池                           |
| `sim8.sms.read`       | 按号码或接码链接取码，只读不写           |

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

## 与 Vinted 账号池联动

联动不新增方法、不改账号插件的存储格式：前端通过宿主调用账号池已有的
`vinted.accounts.list` 与 `vinted.accounts.save`，把号码写进 `phone`、
把接码链接写进 `smsOtpUrl`。之后在账号页点「手机验证码」读的就是这条链接。

三个入口共用同一条写入路径：

- 账号表单：手机号右侧的「号码池」按钮列出已购号码，选中后手机号与
  手机接码地址一起填好，保存账号时落库。
- 窗口页：「Vinted 账号」列里已关联账号的行有一个手机图标，弹层里可以直接挑
  一个号码（号码与链接一起写入），也可以只粘贴接码链接——这条路径只改
  `smsOtpUrl`，账号原有的手机号保持不变。
- SIM8 页面：号码池每行的「写入账号」，选账号后写入。

写入时先 `list` 取到完整记录，只替换要改的字段再 `save`，
其余已定义的业务字段保持原值，创建时间由账号插件保留。
账号契约新增字段时需要同步维护 `mergeAccountNumber`。字段没有变化时不发起 `save`。

- 账号池插件没装或没运行时，除「写入账号」外的功能照常可用，
  页面顶部给一行说明而不是整页报错。
- 一个号码可以写进多个账号；再次写入会覆盖该账号原来的手机号与接码链接。

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

```bash
pnpm --filter @nexus/plugin-sim8 build
pnpm exec vitest run plugins/sim8
pnpm exec eslint plugins/sim8 --max-warnings 0
node scripts/verify-package.mjs market/plugins/studio.sim8/1.0.1.nexuspkg
```

`plugins/sim8` 下 6 个测试文件共 91 个用例：验证码提取、响应归一化、号码池合并、
HTTP 客户端（信封、错误码、超时、地址规范化）、能力方法表与 manifest 校验。
打包后的 `.nexuspkg` 经上述 `verify-package.mjs` 解密并握手，确认 21 个方法齐全。
这些验证不代表真实账号买号、真实接码或上游限流策略已通过。
