# Vinted 账号池插件 `studio.vinted-accounts`

本文说明仓库内 Vinted 账号池插件的实际范围。插件规则见
[插件对接开发规范](14-plugin-integration-guide.md)，宿主协议见[插件宿主](17-plugin-host.md)。

## 当前事实

当前插件版本为 `1.4.0`，最低主程序 `0.1.29`，已发布至 R2。
新增供 ecom agent 使用的账号身份快照和局部观察写入，保留用户资料及邮箱、地址、号码关系。
新增完整地址快照、分页账号选择、地址复制与解除关联。已有主页账号的自动已售查询、Bark 推送与配置迁移见
[订单查询与 Bark 提醒](38-vinted-account-order-watch.md)。
宿主私有 `window.detach` 仅解除指定 Nexus UUID 的窗口关系，保留账号资料。
发行构件与商店上传的实际状态分别记录在[质量记录](09-quality-and-testing.md)。

插件包位于 `plugins/vinted-accounts`，实现 `account.pool` 能力的方法、
私有 JSON 存储与逐行 JSON RPC 服务端。页面位于
`apps/desktop/src/features/accounts`，在主导航里叫「Vinted 账号」。
账号与浏览器窗口的关联由插件维护，窗口页可发起关联并直接编辑已关联账号。
真实ecom agent 可通过独立的只读快照和局部观察写入方法接入账号池；
账号池本身不启动浏览器，不读取登录态，也不新增 SQLite 连接。

- 一条账号记录有九个业务字段：登录方式、账号、密码、手机号、邮箱接码地址、
  手机接码地址、状态、主页链接与备注。
- 手机号右侧的「号码池」按钮可以直接从
  [SIM8 接码插件](30-sim8-plugin.md) 的已购号码里选一个，选中后手机号与手机
  接码地址一起填好；SIM8 没装或没运行时按钮照常显示，点开只给一行说明。
  编辑时会传入当前账号标识，号码池标记当前账号使用的号码，并列出其他使用者；
  无法读取账号池时显示占用情况未知，不会误报号码未使用，也不禁止继续选择。
- 登录方式与账密是必填项，缺任何一项都不能写入；其余字段留空是合法状态，
  不做“猜一个默认值”的补齐。
- 登录方式只有四种：`email` / `google` / `apple` / `facebook`。
- 状态只有四种：`active`（正常）/ `pending`（待验证）/ `limited`（受限）/
  `blocked`（封禁）。状态来自操作者记录或ecom agent 的受限观察写入；
  插件不自行探测真实账号状态。
- 密码明文存在插件私有目录（文件权限 0600），宿主不加密、不代管。
  页面在表格里不显示密码，只在编辑弹窗里回读，默认隐藏。
- 保存与关联不执行账号登录。用户显式读取验证码时，插件请求账号已保存的
  邮箱或手机接码链接；自动订单查询访问 Vinted 用户主页与商品页面，
  明确确认已售后才请求用户配置的 Bark 服务。清单声明已知 Vinted 和默认 Bark 域名，
  `secrets` 为空，
  `wantsBrowserAccess: false`，这些声明不代表网络沙箱。
- Nexus 主应用 `0.1.17` 在窗口行的手机号旁提供「等待验证码」；
  复用现有 `vinted.accounts.list` / `vinted.accounts.otp`，不新增 RPC 或
  存储字段，也不提升账号插件版本。完整行为见[短信验证码等待](34-sms-waiting.md)。

## 包结构

```text
plugins/vinted-accounts/
├── package.json          # ESM、锁定依赖、dist 由构建生成
├── nexus.plugin.ts       # manifest 唯一来源，由 definePluginManifest 校验
├── src/
│   ├── index.ts          # 组装存储、能力与协议；进程入口
│   ├── agent-contracts.ts # 不含凭据的ecom agent schema、方法常量和类型
│   ├── capabilities/     # account.pool 方法表
│   ├── domain/           # 类型、zod 校验、表格解析、表头映射与错误码
│   ├── rpc/              # 协议、服务端、脱敏日志（与其他插件同源，按包自包含）
│   ├── services/         # 完整衣柜查询、商品页已售核查与 Bark 推送
│   └── store/            # 私有 JSON 文档（accounts / bindings）
└── dist/                 # 构建产物：dist/src/index.js 与 dist/nexus.plugin.json
```

## 方法表

| 方法                                  | 入参                                          | 说明                               |
| ------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `vinted.accounts.list`                | `{ page?, pageSize?, revision? }`             | 分页账号、当页绑定与快照标识       |
| `vinted.accounts.save`                | `AccountInput`（带 `id` 即编辑）              | 新建或更新，重复登录直接拒绝       |
| `vinted.accounts.remove`              | `{ accountId }`                               | 删除账号并清掉它的绑定             |
| `vinted.accounts.import`              | `{ filename, text \| base64 }`                | 解析表格并 upsert，返回逐行报告    |
| `vinted.accounts.template`            | `{ format: 'csv' \| 'xlsx' }`                 | 返回文件名、MIME 与 base64 内容    |
| `vinted.accounts.bind`                | `{ accountId, windowId, confirmDuplicates? }` | 关联窗口，重复账号先返回冲突       |
| `vinted.accounts.unbind`              | `{ windowId }`                                | 解除该窗口的关联                   |
| `vinted.accounts.bindings`            | —                                             | 绑定列表，附带账号摘要             |
| `vinted.accounts.otp`                 | `{ accountId, channel: 'email' \| 'sms' }`    | 从账号已保存链接读取验证码与原文   |
| `vinted.accounts.address.targets`     | `{ query?, page?, pageSize? }`                | 分页选择账号，不返回凭据           |
| `vinted.accounts.address.set`         | `{ accountId, profile, expectedProfileId? }`  | 原子设置、替换或清空账号地址       |
| `vinted.accounts.mailbox.targets`     | `{ query?, page?, pageSize? }`                | 分页选择账号，仅返回账号及邮箱关系 |
| `vinted.accounts.mailbox.set`         | `{ accountId, mailbox, expectedMailboxId }`   | 原子关联、更换或解除邮箱           |
| `vinted.accounts.agent.snapshot`      | `{ windowId }`                                | 只读绑定身份、状态、主页与观察摘要 |
| `vinted.accounts.observations.record` | `AccountObservationInput`                     | 校验绑定后幂等持久化局部观察       |
| `window.detach`                       | `{ windowId }`                                | 原生宿主专用，幂等清理窗口关系     |
| `transfer.export`                     | `{ windowIds, endpointIds }`                  | 原生宿主专用的选中窗口账号快照     |
| `transfer.import`                     | `{ data, windowIdMap, transactionId? }`       | 本地副本、重映射绑定与持久化回执   |
| `transfer.rollback`                   | `{ receipt }`                                 | 撤销本次导入，恢复被替换的绑定     |
| `transfer.commit`                     | `{ receipt }`                                 | 清理成功回执，保留账号与绑定       |

上限：账号 2000 条，导入报告最多回传 50 条错误。单次导入内容不超过 512 KB
（宿主单行消息上限 1 MiB，base64 会放大 1.33 倍）。

## ecom agent 账号观察

两个方法继续使用 `account.pool` 能力。公开子路径
`@nexus/plugin-vinted-accounts/agent-contracts` 仅导出方法常量、严格 zod schema
与对应 TypeScript 类型，不加载插件入口、存储或浏览器。
类型入口直接引用随包携带的 `src/agent-contracts.ts`，可在没有本地构建时进行
TypeScript 消费方检查；运行入口仍为发行构建生成的 `dist/src/agent-contracts.js`。
宿主协调器核对窄字段，平台采集流程和 Playwright 会话由ecom agent 与浏览器宿主负责。
Rust 仍是 SQLite 的唯一所有者，账号业务继续保存在插件现有明文 JSON 文件中。

`vinted.accounts.agent.snapshot({ windowId })` 要求 Nexus 窗口 UUID，
在单份存储读取中取得当前绑定，严格返回：

```ts
type AccountAgentSnapshotResult = {
  account: {
    accountId: string // Nexus 账号 UUID
    account: string // 登录标识，仅用于身份核对
    status: 'active' | 'pending' | 'limited' | 'blocked'
    homepageUrl: string
    platformUserId: string | null
    observation: AccountObservationState | null
  }
  windowId: string
}
```

未绑定、重复窗口绑定或绑定账号不存在时明确拒绝，不返回空账号或模拟身份。
平台用户 ID 优先使用已有观察中的数字 ID，否则从受支持 Vinted 主页的
`/member/<id>`（可带昵称后缀）解析，无法确定时返回 `null`。
快照不返回密码、手机号、接码链接、邮箱关系、地址、用户备注或其他账号字段；
读取不会写存储，也不代表已经验证当前浏览器的实际登录身份。

`vinted.accounts.observations.record` 只接受以下严格对象，未知字段一律拒绝：

```ts
type AccountObservationInput = {
  operationId: string // UUID；同一次观察的重试沿用此值
  accountId: string // Nexus 账号 UUID
  windowId: string // Nexus 窗口 UUID
  observedAt: string // ISO 时间，允许时区偏移，最多 40 字符
  source: 'official' | 'page' | 'model'
  platformUserId?: string // 1–32 位数字，首位不能为零
  status?: 'active' | 'pending' | 'limited' | 'blocked'
  tags?: string[] // 最多 8 个，每个 1–24 字符
  summary?: string // 最多 160 字符；独立于用户 note
  rating?: number // 有限数值，0–5
  balance?: {
    currency: string // 三位大写币种代码
    available: string | null
    pending: string | null
  }
}
type AccountObservationResult = {
  operationId: string
  accountId: string
  applied: boolean
  storageDurable: boolean
}
```

- 写入在现有串行 `mutate` 内重新校验窗口仍唯一绑定该账号；取消或排队期间
  解绑、改绑、删除会阻止写入，不恢复被删除的账号或关系。
  提供平台 ID 时，还必须与已有观察 ID 和可解析的主页 ID 一致。
- `operationId` 对整个插件存储唯一。严格解析保留字段值，字段顺序不影响输入摘要；
  同 ID、同输入返回原 `applied`，不同输入拒绝。幂等重试仍须满足当前账号绑定。
  账号修改和操作收据在同一次文件替换中保存，文件失败时两者都不提交。
  收据最多 100,000 条，达到上限后拒绝新操作，不静默淘汰旧 ID；账号删除也不释放 ID。
- 每个账号独立按观察时间推进；较旧或相同时间的不同操作只保存
  `applied: false` 收据，不更新账号或最后观察，避免迟到结果覆盖较新的事实。
  同时间以先提交的观察为准。已知操作重试返回原回执，不重新应用。
- 仅更新输入中实际存在的观察字段；省略保留旧值，显式空 tags、空 summary 和
  rating 为零均可保存。标签与摘要要求格式完整的 Unicode 文本，不接受控制字符。
  登录标识、密码、手机号、接码链接、主页、用户 note、
  地址、邮箱关系和窗口绑定不变；普通编辑、CSV upsert、地址和邮箱更新保留观察。
- `official` / `page` 明确确认 `blocked` 才能把状态改为封禁。模型单独给出
  `blocked` 只保存观察，不封禁账号；已有官方或页面状态证据后，模型不覆盖其状态，
  也不能解除操作者标记的封禁。页面结果不能解除已有封禁或降级官方受限、
  待验证状态；较新的官方确认可恢复状态。普通网络失败不构成封禁证据。

`AccountRecord.observation` 与账号列表 DTO 均包含有界的
`platformUserId/tags/summary/rating/balance/statusEvidence/lastObservation`，
这些字段不复用用户备注。`lastObservation` 独立保存最后一次被采用的操作 ID、
账号/窗口 UUID、时间、来源、可选状态和原始余额读取结果；
不重复 tags、summary、rating 和平台 ID，避免撑大 16 个完整账号的默认分页。
最新状态证据单独保留，不因较新的模型或无状态观察而丢失。

余额只接受十进制字符串：最多 12 位整数、4 位小数，可带负号，总长不超过 18，
不接受数字、指数、逗号、自动四舍五入或补零。未知值始终为 `null`，不是零。
持久余额保留 `currency/available/pending`，另有独立的
`availableEvidence/pendingEvidence: { source, observedAt } | null`：
同币种的某一项读取未知时保留旧金额及其原始证据；初次未知仍为 `null`。
完全未知的新读取保留旧余额，原始未知结果可从 `lastObservation.balance` 识别。
换币种且至少一项已知时重新建立余额，另一项保持未知，不跨币种拼接。
这些数据是观察事实，不保证余额现在仍然相同。

### 账号池中的只读观察

账号名称下方紧凑显示观察标签、摘要与 0–5 评分，用户备注或主页链接仍独立保留；
没有这些观察字段时不补造内容，评分为零照常显示。展示使用现有 shadcn Badge，
摘要与长标签限制行内宽度，可通过原生悬停标题查看完整文本。

表格增加一个「余额」列，分两行显示可用、待结算金额及币种。
金额原样展示十进制文本，未知值显示 `—`，不补零或四舍五入。
点击余额打开只读 Popover，逐项显示该金额实际保存的来源和观察时间；
最新读取未知时仍沿用已有金额及其旧证据，并提示「最近读取未知，保留此前金额」。
不使用最后一次账号观察时间冒充两项余额的采集时间，也不把未知的新币种套在旧金额上。

桌面账号列表从公开 `@nexus/plugin-vinted-accounts/agent-contracts` 导入
`AccountObservationStateSchema` 校验可选 `account.observation`。
缺省观察的现有账号继续有效；存在观察但字段、嵌套证据或额外键不合法时，
整次分页列表读取失败，不丢掉坏字段后继续展示。校验不裁剪账号原有字段。
账号新增和编辑表单没有观察输入，保存仅提交原有可编辑字段；
窗口页的绑定摘要不复制整份观察。

操作收据在 `vinted-accounts.json` 的独立 `observationOperations` 中保存，
不进入账号分页或 Agent 快照；普通账号列表仍校验完整 RPC 行小于 1 MiB。
窗口传输保留账号业务资料与当前状态，观察与收据属于源账号/窗口，
不复制到重新分配 UUID 的迁移副本，目标环境须重新观察。
未提供宿主私有目录时仍如实返回 `storageDurable: false`，不承诺内存模式重启恢复。

## 邮箱联动（1.3.0）

账号池的“关联邮箱”列支持关联、更换、解除、复制邮箱和直接查看邮件。
邮箱插件也可以从邮箱行反向选择账号。搜索结果只投影
`id/account/status/mailbox`，不返回密码、手机号、接码链接或其他业务资料；
搜索同时匹配账号文字和已关联邮箱地址，默认每页 20 条、最多 50 条。
这些能力配套主程序 `0.1.28`、账号池 `1.3.0` 和邮箱 `1.1.0`，
实际发布结果见[插件商店](25-plugin-market.md)。

账号保存可空 `mailbox: { pluginId: 'studio.email', mailboxId, email, linkedAt }`。
关系由账号池独立持久化，绑定邮箱不改变账号的登录邮箱、手机号、地址或窗口关系。
同一邮箱可关联多个账号，一个账号仅关联一个邮箱。普通编辑、CSV upsert、
手机号修改和订单状态更新均保留邮箱关联。

`mailbox.set` 必须传最后看到的 `expectedMailboxId`，没有关联时传 `null`。
串行写入内核对账号与关系，仅改 `mailbox/updatedAt`；陈旧修改或账号已删除时拒绝，
磁盘失败不反馈已保存。解除关联只要求账号池可用，不依赖邮箱插件。
阅读时按 ID 和关联邮箱地址共同核对，已删除、改名或暂停的邮箱不会被自动替换。
窗口导出/导入将设备本地邮箱关联清空，副本应在目标设备重新选择邮箱。
详见[邮箱插件](41-email-plugin.md)。

## 关联与解除账号地址

在[地址生成器](19-address-generator-plugin.md)生成或选定资料后，点击「关联账号」。
一个账号保存一个独立的完整地址快照，同一地址可关联多个账号。地址列表移除条目、
重新生成或卸载地址生成器，不会修改已保存的账号地址。
账号表格的地址列提供紧凑弹层，显示姓名、用户名、门牌街道、城市、州/地区、邮编、
国家和关联时间，支持复制完整资料与解除关联。

`vinted.accounts.address.targets` 默认第 1 页、每页 20 个，最多 50 个，搜索最多 200 字符。
结果为 `{ items, total, page, pageSize, storageDurable }`，每项仅含
`id/account/status/address`，不返回密码、手机号或接码链接。
地址字段是资料快照（含来源、坐标及近似标记），另有 ISO 时间 `linkedAt`。

`vinted.accounts.address.set` 的 `profile` 为完整地址资料或 `null`；
成功结果为 `{ address, updatedAt, storageDurable }`。
替换或解绑携带最后看到的 `expectedProfileId`，无地址时传 `null`。
插件在同一次串行修改内核对账号存在性和当前地址，只改 `address/updatedAt`，
不覆盖并行更新的密码、状态、手机号、备注或主页。
地址已被其他操作替换时拒绝陈旧提交并提示刷新，账号删除后不会重新创建。
文件写入失败保留上一份内存与磁盘内容，不返回已保存。

普通账号编辑、CSV 更新和手机号修改均保留快照；删除账号时快照随账号删除。
窗口迁移附件中的账号记录包含地址；配置导入导出只迁移查询/Bark 设置，不包含业务地址。
地址在插件私有 JSON 中明文保存，不使用 SQLite 或 Keychain。

## 可移植传输（原生宿主私有）

`transfer.*` 沿用 `account.pool` 能力，不新增能力或版本号。
插件自行解析业务数据，宿主只归档与回传不透明 JSON，不读取 `vinted-accounts.json`。
新增传输中的明文密码与接码链接只允许交给原生归档宿主；
宿主必须禁止通用 WebView `plugin_call` 转发这些方法，传输结果不得进入页面状态或日志。
插件端不实现归档加密、Profile 文件/SQLite 事务或宿主的路由拦截；
账号本地存储继续是现有明文、0600 文件。

四个方法使用严格对象，成功结果如下：

```ts
// transfer.export
type ExportInput = { windowIds: string[]; endpointIds: number[] }
type ExportResult = {
  schemaVersion: 1
  accounts: AccountRecord[]
  bindings: { windowId: string; accountId: string; boundAt: string }[]
}

// transfer.import
type ImportInput = {
  data: unknown // 必须通过插件的 AccountTransferDataSchema
  windowIdMap: Record<string, string>
  transactionId?: string // UUID；省略时由插件生成
}
type ImportResult = { receipt: string } // 等于 transactionId 或插件生成的 UUID

// transfer.rollback / transfer.commit
type ReceiptInput = { receipt: string }
type ReceiptResult = { success: true }
```

`AccountRecord` 包含 `id`、九个业务字段、可选的完整 `address` 与 `createdAt` / `updatedAt`，字段定义见
插件 `src/domain/types.ts`。快照保留真实密码的首尾空格、两种接码链接、状态、备注、
主页地址、账号地址快照与时间，不包含全局 API Key、授权密钥或其他插件的私有数据。
公开入口导出传输类型与 zod schema；未知字段、非法版本、重复账号/窗口 ID、
悬空账号引用、没有绑定的额外账号以及无效映射均拒绝，错误不回显凭据。

- 导出只包含 `windowIds` 中存在的绑定及其关联账号，同一账号在多个选中窗口间共享时只导出一次。
  不带出该账号在未选中窗口的绑定，也不导出未关联或仅关联到未选中窗口的账号。
  空窗口集合得到空快照，未关联窗口不构成导出错误。
- `endpointIds` 只校验类型，不用于账号选择。导出与导入不执行账号登录或接码请求。
- 导入给每个账号分配新 ID，保留有效业务值与原时间，并按 `windowIdMap` 重映射每条窗口绑定。
  每条源绑定必须有显式映射，多个源绑定不能指向同一目标；不会回退到源窗口标识。
- 已存在相同登录方式/账号时仍创建独立副本，不走表格导入的 upsert，不修改现有账号凭据。
  传输副本允许同一登录标识的多条记录；普通保存和表格导入沿用各自已有的重复处理规则。
  本地账号总量仍受 2000 条上限约束。
- 新窗口目标已有绑定时拒绝覆盖；仅 `源 windowId === 目标 windowId` 的同 ID 替换允许覆盖，
  并把原绑定保存在本次回执里。不可变内核/seed 的替换资格由宿主验证，插件不读取 Profile。

账号、副本绑定、被替换的原绑定和回执同处 `vinted-accounts.json`，
一次原子写入后才返回成功；校验失败或文件写入失败不会留下半批账号或绑定。
`transferReceipts` 是向后兼容的可选持久字段，旧文档缺少时视为空，本地 `schemaVersion` 保持 1。
回执只记录本次新增账号 ID、导入绑定、需恢复的原绑定与输入摘要，不复制已有账号的凭据。

建议宿主传自己的 `transactionId`，进程在回包前中断时仍可按该 UUID 回滚。
相同未清理事务、相同数据和映射的重复导入返回原回执，不再创建副本；
同一事务标识用于不同数据会被拒绝。提交/回滚清理回执后不再去重，新的宿主事务应使用新 UUID。
回滚只删除本次创建的账号及其绑定，并恢复同 ID 替换前的原绑定；
如果窗口后来已改绑到现有账号，则保留后来的绑定，不覆盖用户改动。
提交只删回执，不删账号/绑定；已清理或未知的有效 UUID 回执可重复提交或回滚，
返回 `{ success: true }`。回执不会自动过期，宿主应在归档事务完成后收尾。
未提供私有目录的内存模式不承诺重启后恢复。

## 表格导入

`src/domain/table.ts` 自带 CSV 与 XLSX 读写，不引第三方表格库：
插件随桌面应用打包，为读一行表头多带一个依赖不划算。

- CSV：RFC 4180，支持引号转义、字段内换行、BOM 与 CRLF；分隔符在逗号、分号、
  制表符里按表头自动判定（欧洲区 Excel 常用分号）。
- XLSX：自己实现 zip 读取（stored 与 deflate）与工作表 XML 解析，覆盖共享字符串
  （`t="s"`）、内联字符串（`t="inlineStr"`）与数值；只读第一张工作表。
- 模板写出：单工作表、内联字符串，Excel 与 Numbers 都能直接打开。

`src/domain/import.ts` 负责把单元格变成账号：

- 表头可用中文或英文，大小写与空格、下划线、连字符、括号都忽略；
  列顺序可以调换。识别不出表头时按模板列序读取。
- 首行是否算表头由两条规则决定：至少映射到两列，且整行没有 `@` 或 `http(s)://`
  这类明显的凭据形态。否则把首行当数据，避免丢掉唯一一行。
- 登录方式留空时，账号里带 `@` 视为邮箱登录，其余直接报错——不猜。
- 状态认不出时按 `active` 处理；主页链接缺协议时补 `https://`。
- 同一 `(登录方式, 账号小写)` 视为同一条记录，重复导入是更新，绑定不受影响。

模板只有表头，没有示例行：示例行很容易被连同样例一起导进去。

## 窗口关联

账号池表格使用客户端分页，每页默认 20 条，可切换 20 / 50 / 100 条，
显示筛选后的总数、当前页和总页数，提供上一页和下一页。
底层列表接口分页读取（默认每页 16 条、最多 16 条），避免完整地址快照使单个响应超过 1 MiB。
页面的公共 `listAccounts()` 适配器按同一 revision 逐页读取并合并账号和绑定，
供账号页、窗口关联、批量建窗与 SIM8 使用。中途发生修改或任意页面失败时，
整次读取失败，不把部分清单当成全部账号；页面再按 20 / 50 / 100 条展示和筛选。
RPC 响应为 `{ items, bindings, total, page, pageSize, revision, storageDurable }`，
其中 `bindings` 只含当前页账号的窗口关系；后续页携带首页返回的 `revision`。
revision 根据账号与窗口关系的规范化内容计算，重启回读保持稳定，
订单查询运行状态变化不影响它。插件检查完整成功响应（含请求 ID、换行）的 UTF-8 字节数；
极端单页窗口关系仍超出 1 MiB 时返回明确错误，不截断、不让宿主静默丢弃。
记录按 `createdAt` 从新到旧排列，相同时间保持接口原顺序；无效时间排在末尾。
「创建时间」列显示完整本地日期时间，包含秒；有效的未来日期照常显示，无效值显示破折号。
封禁账号名称使用语义错误色，状态继续显示封禁 Badge。

搜索匹配账号、手机号和备注，并与状态、登录方式、是否有手机号、
是否关联窗口四个筛选条件取交集。状态和登录方式分别提供全部及既有四种值，
手机号仅含空白时视为未填写，窗口关联来自实际 `bindings`。
更改筛选、重置筛选或修改每页条数都回到第一页；删除、刷新或资料更新使当前页
超出范围时，自动回到最后一个有效页，不保留空的越界页。

账号池表格支持多选，表头复选框明确为「全选当前页账号」，只影响当前页记录。
翻页、搜索、筛选和重置筛选均保留其他页面及筛选条件下的选择；
工具栏显示全部已选账号数，「清空选择」清除全部选择，刷新后只移除已删除的账号。
「批量创建窗口」使用全部已选账号，不限制为当前页；超过 100 个时提示调整选择，
不会静默截取。成功创建并关联的账号取消选择，未完成项继续保留。
主应用为每个选中账号调用一次原生创建，再调用现有 `vinted.accounts.bind` 关联；
可统一设置代理、分组和浏览器参数，每个窗口随机独立种子。已有窗口关联的账号
需要显式确认，关联失败只重试关联。完整流程见[批量创建窗口](32-batch-window-creation.md)。
本功能没有增加插件 RPC 方法，也不执行账号登录。

关联关系存在插件的 `bindings` 数组里，键是窗口标识：

```text
bindings: [{ windowId, accountId, boundAt }]
```

- 一个窗口最多一条绑定：写入前先按 `windowId` 删旧记录，再插入新的。
- 一个账号可以出现在多个窗口上。`vinted.accounts.bind` 发现同账号已绑在别的窗口时，
  在没有 `confirmDuplicates: true` 的情况下**不写入**，只返回 `duplicates` 数组；
  页面据此弹出 AlertDialog，写明已经关联了哪些窗口，确认后再调一次。
- 删除账号会连带删掉它的绑定，不会留下指向空记录的窗口。
- 插件只存窗口 UUID，不存窗口名称。名称属于主程序的 Profile 记录，
  插件复制一份只会过期；提示文案里的窗口名由窗口页自己拼。

窗口页（`spaces-page.tsx`）在插件运行中读取 `vinted.accounts.bindings` 与
`vinted.accounts.list`，在表格里显示已关联账号；已有手机号以语义强调色显示，
点击号码即可复制，手机图标也标记已有手机号。点击账号名称旁带铅笔图标的入口，
或在每行 `…` 菜单选择「编辑账号资料」，可打开与账号池共用的完整编辑弹窗；
登录方式、账号、密码、状态、手机号、两种接码地址、主页链接与备注均可修改，
密码默认隐藏，未修改的字段原样保留。

编辑沿用 `vinted.accounts.save`，不重新关联、不改变账号 ID 或窗口绑定。
弹窗提示共用此账号的窗口数，保存成功后直接使用插件返回的账号更新全部关联行、
手机号与短信弹层及绑定摘要，不需要刷新页面。失败时保留弹窗、草稿和错误，
保存过程中阻止重复提交和关闭；插件未就绪时不能保存。
行菜单仍提供“关联账号 / 更换账号 / 解除关联”，未就绪的关联弹窗会说明原因。

窗口页和账号池表格中，已有手机号旁的解绑图标可直接清空此账号的 `phone` 和
`smsOtpUrl`，不额外弹确认框。按钮可访问名称为「解绑 … 的手机号」。
按钮提示说明操作会同步所有关联窗口，并保留 SIM8 号码池中的号码。
解绑先读取账号最新记录，再通过现有保存方法只替换这两个字段；
账号与窗口的绑定、密码、登录方式、状态、邮箱接码地址及其他资料保持原值。
联系人更新按账号依次执行，先前发起的号码保存结束后才读取并清空最新资料，
避免先前的保存覆盖解绑结果；不同账号可独立更新。
同一账号的所有行共享解绑忙碌状态，期间禁止重复解绑、编辑账号或操作短信弹层，
手机号仍可复制。保存成功才更新各行并反馈成功，后续取码不再使用旧短信接码链接；
读取或保存失败保留原手机号与链接、显示错误并允许重试。插件未就绪时不能解绑。

账号池解绑复用 `updateContact(accountId, { phone: '', smsOtpUrl: '' })`，
只在写入成功后合入返回的最新账号，保留列表中的窗口关联。
请求期间用账号级占用状态阻止重复解绑、编辑、删除和读取短信；
失败保留账号资料、显示错误并允许原地重试。
成功解绑清除该账号缓存的短信结果，邮箱结果继续保留。
解绑开始后，先前的短信请求即使迟到成功或失败，也不会重新写回旧验证码、
弹出旧短信结果或清除更新请求的忙碌状态；较早发起的列表刷新同样不能恢复旧手机号。
列表读取顺序与联系人保存顺序分别记录：较新的完整列表保留其他账号的新增、删除、
编辑及窗口关联结果，只对其中仍存在的账号合入读取期间成功返回的联系人保存结果。
不会因解绑而丢弃其他操作的完整刷新，也不会重新插入列表中已删除的账号；
下一次在保存完成后发起的读取仍以后台完整列表为准，不永久覆盖后续资料更新。

未关联行的「添加账号」使用 shadcn Tabs，在「选择已有 / 新建账号」之间切换，
搜索列表与创建表单不同时展开；弹层和内容区限制高度，长列表可滚动。
保存失败保留输入与错误反馈，重复账号关联仍沿用已有确认流程。

手机图标弹层明确显示账号身份与可复制的当前手机号，提供
「验证码 / 号码池 / 编辑链接」三个互斥页签：

- 选择 SIM8 号码，把 `phone` 与 `smsOtpUrl` 写入这个账号；仅编辑链接时只更新
  `smsOtpUrl`，保留该账号的手机号以及其他业务字段，不把号码写在窗口记录上。
- 写入成功后使用插件返回的账号立即更新窗口行与弹层，停留在「验证码」页签；
  同一账号关联的其他窗口行也更新。写入失败保留链接草稿，不提示保存成功。
- 「读取短信验证码」通过 `readOtp(account.id, 'sms')` 读取账号已保存的链接，
  结果、无唯一验证码时的说明、响应原文与请求错误都在弹层内展示，验证码与原文
  可以复制；原文按文本展示，不执行返回的 HTML。
- 编辑链接产生未保存的修改时禁止取码并提示先保存；切换页签和关闭后重新打开
  都保留草稿，不会悄悄用未保存链接发起请求。更新链接会清掉旧取码结果。

## 窗口行等待短信验证码

主应用 `0.1.17` 提供手机号旁的「等待验证码」按钮，与短信弹层内的单次取码
并存。需要已关联账号、已保存的手机号和短信接码链接，以及就绪的账号插件与
账号资料；无手机号时不显示，缺少链接或不可用时不能开始。不会因为打开页面、
弹层或保存号码而自动查询，也不要求 SIM8 插件正在运行。

手动开始后立即尝试读取，此后按 5 秒时点查询，最多等待 5 分钟。
同账号已有读取未结束时跳过时点，不重叠请求；停止后重开也要等待旧读取结束。
查询失败保留最近错误并在后续时点重试，不延长截止时间；收到 4 位或 6 位数字
短信验证码、手动停止或超时后结束，继续等待必须再次点击。

同一账号的多条窗口行共享一项任务与等待状态，任一共享行可手动停止。
窗口改绑、解除关联或删除触发的自动停止，只影响由该窗口发起的任务；
同账号其他窗口的此类操作不会打断原窗口的等待。手机号解绑或已保存的手机号、
接码链接变化则按账号停止，影响所有共享行。
每轮取码前后检查账号、手机号、链接及发起窗口绑定，拒绝失效资料对应的结果。

任务跨应用内页面导航继续运行，不随表格行卸载而取消。
账号插件不可用、版本或进程身份改变时停止；应用壳卸载清理任务和音频资源。
等待进度不持久化，刷新或重启后不自动恢复。取消信号只终止前端后续步骤，
**不取消已经发出的原生 IPC 或插件网络请求**，迟到结果会被忽略。

成功提示包含发起窗口、账号、手机号和验证码，可复制且不自动消失，
并尝试一次双音提示。全局最多显示 3 条提示，额外常驻提示排队并显示待展示数量，
关闭可见提示后补入，不因同时收到多个验证码而丢弃常驻结果。
音频在点击开始时准备，不提前播放；不可用或受阻时保留文字结果并提示声音失败，
不能保证操作系统扬声器实际发声。

既有 `fetchedAt` 只表示查询完成时间，不是短信时间戳。
上游可能返回旧码；本功能不保证短信新鲜度，也不在手动重开时去重先前验证码。
详细的重试、停止时机、资料校验与音频边界见[短信验证码等待](34-sms-waiting.md)。

## 已知边界

- 没有账号登录能力：关联只是记录，不会把密码填进浏览器，也不会校验账号能否登录。
- 没有加密与主密码：能读到用户目录的人就能读到密码明文。
- 没有批量改状态、批量删除与去重合并。
- 没有 `.xls`（旧二进制格式）支持，读取时直接提示另存为 `.xlsx` 或 `.csv`。
- 表格只读第一张工作表，多工作表的文件其余部分被忽略。
- 表格导出只提供空模板，不提供“把现有账号导成表格”；选中窗口的宿主私有归档使用上述传输协议。

## 本地验证

按当前开发约定，本地只直接运行测试、lint、格式与无产物类型检查，不构建或打包。
使用仓库固定 Node.js 24.18.0，并在复用已安装依赖时设置
`pnpm_config_verify_deps_before_run=false`。账号插件的直接检查入口：

```bash
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec vitest run plugins/vinted-accounts --maxWorkers=4
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec tsc -p plugins/vinted-accounts/tsconfig.tests.json --noEmit
```

观察测试覆盖局部保留、重复操作与冲突、重启后的收据和证据、迟到观察、绑定竞态、
取消、真实文件失败与重试、封禁证据优先级、严格无凭据快照及实际逐行 RPC。
分页压力测试同时携带有界观察、完整地址、邮箱关系和多条窗口绑定，检查最大长度
Unicode 与 JSON 转义内容仍低于 1 MiB。这些测试使用合成资料，不访问真实平台账号，
不替代浏览器登录态、代理、Windows 或正式 Agent 端到端验收。

前端联动回归入口：

```bash
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec vitest run apps/desktop/src/features/accounts/accounts-page.test.ts apps/desktop/src/features/sim8/accounts-bridge.test.ts apps/desktop/src/features/sim8/number-picker.test.ts apps/desktop/src/features/spaces/spaces-page.test.ts --maxWorkers=4
```

前端回归覆盖窗口内账号编辑的两种入口、完整字段提交、凭据保留、共享账号行与
绑定摘要同步、保存失败后的草稿与重试、插件未就绪及重复提交拦截，
以及手机号与短信链接一起解绑、解绑期间的共享忙碌状态、同账号写入顺序与失败恢复、
号码规范化与占用提醒。账号池的 `accounts-page.test.ts` 与 `account-table.test.ts`
覆盖分页、筛选交集、跨页及跨筛选选择、批量数量限制、刷新与删除后的页码收敛、
手机号解绑成功和失败、旧短信响应隔离及邮箱验证码保留。
组件状态与事件处理在 Node 测试环境验证，
不替代桌面 WebView 中的布局、键盘和焦点检查。
账号观察的 `account-observation-api.test.ts`、`account-observation.test.ts` 与
`account-observation-page.test.ts` 覆盖严格读取校验、无观察记录、旧金额证据、
未知与零值、原始金额精度、摘要文本转义、实际账号表格和编辑提交不携带观察。
可用以下直接入口执行这些检查：

```bash
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec vitest run apps/desktop/src/features/accounts/account-observation-api.test.ts apps/desktop/src/features/accounts/account-observation.test.ts apps/desktop/src/features/accounts/account-observation-page.test.ts --maxWorkers=4
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec tsc -p apps/desktop/tsconfig.json --noEmit
```

传输测试启动实际构建的 Node.js 入口，经握手和逐行 RPC 验证选中范围、完整凭据、
共享账号的窗口重映射、调用方事务 UUID、重启后的回滚/提交、同 ID 替换恢复、
真实文件写入失败与重试。另有取消、幂等重试与账号上限的原子性测试。
依赖构建的真实进程测试交由 CI；这些验证不代表账号登录、Windows 或完整宿主归档集成已通过。
