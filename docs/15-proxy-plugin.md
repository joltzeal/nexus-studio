# 代理池插件 `studio.proxy-pool`

本文说明仓库内代理插件的实际范围。插件规则见[插件对接开发规范](14-plugin-integration-guide.md)，
产品侧插件边界见[插件系统](06-plugin-system.md)。

## 当前事实

插件包位于 `plugins/proxy-pool`，已实现 manifest、`proxy.provider` 能力方法、
私有存储适配、密钥引用边界与逐行 JSON RPC 服务端。

宿主侧已实现发现、安装、进程托管、权限检查点与窗口启动阻断，
因此本插件可以在插件中心安装后直接作为窗口的代理来源，见[插件宿主](17-plugin-host.md)。
仍需区分：安装成功不等于代理可用；窗口指定 `endpointId` 时不需要默认代理，
未指定时才使用默认项。指定项不存在、已删除或停用、默认项缺失、所需密码不可用时阻断启动，
不会改用其他代理或回退直连。
`sdk` 类型检查、单测通过只证明本包内部契约，不证明宿主隔离或真实浏览器代理可用。

## 包结构

```text
plugins/proxy-pool/
├── package.json          # ESM、锁定依赖、dist 由构建生成
├── nexus.plugin.ts       # manifest 唯一来源，由 definePluginManifest 校验
├── src/
│   ├── index.ts          # 组装存储、密钥库、能力与协议；进程入口
│   ├── capabilities/     # proxy.provider 方法表
│   ├── domain/           # 类型、schema、凭据与指纹
│   ├── rpc/              # 协议、服务端、脱敏日志
│   ├── services/         # 库存、检测、信誉、订阅、传输
│   └── store/            # 私有存储与密钥库端口
└── dist/                 # 构建产物：入口 dist/src/index.js 与 dist/nexus.plugin.json
```

`dist/nexus.plugin.json` 由 `scripts/emit-manifest.mjs` 在构建时从
`nexus.plugin.ts` 生成，manifest 仍然只有一处来源；宿主按此文件读取并校验。

manifest 声明：`apiVersion: 1`、`id: studio.proxy-pool`、`version: 1.0.1`、
能力 `proxy.provider`、域名 `api64.ipify.org` 与 `proxycheck.io`、
`wantsBrowserAccess: false`、`storage: private`、
密钥槽 `proxy-password`、`proxycheck-api-key`、`subscription-token`。

## 与 nexus-cart 代理模块的对应关系

| 原模块                                       | 本插件                                          | 变化                                       |
| -------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| `model.py`（SQLAlchemy 模型）                | `src/domain/schemas.ts`、`src/store`            | 表结构改为私有 JSON 文档，软删除语义保留   |
| `schema.py`（Pydantic 校验）                 | `src/domain/schemas.ts`（zod）                  | 未知字段仍拒绝，错误信息不回显输入值       |
| `credentials.py`（Fernet + 指纹）            | `src/domain/credentials.ts`、密钥库端口         | 插件不再加密或保存密码，只保留 `secretRef` |
| `store.py`（去重、合并、删除）               | `src/services/inventory.ts`                     | 指纹改由“地址 + 密钥库摘要”组成            |
| `groups.py`                                  | `src/services/groups.ts`                        | 同名分组复用，行为不变                     |
| `service.py`（导入、Decodo、检测）           | `src/services/import.ts`、`check.ts`            | curl_cffi 改为自实现 SOCKS5 / CONNECT 隧道 |
| `reputation.py`（proxycheck + Redis）        | `src/services/reputation.ts`                    | Redis 缓存改为进程内 TTL 缓存与冷却键      |
| `subscriptions.py` / `subscription_names.py` | `src/services/subscription.ts`、`node-names.ts` | PyYAML 改为 `yaml`，渲染与命名规则保留     |
| `api.py` / `subscription_api.py`（FastAPI）  | `src/capabilities/proxy-provider.ts`            | HTTP 路由改为 RPC 方法，鉴权由宿主负责     |

## 方法清单

能力标识统一为 `proxy.provider`，方法按能力内命名：

| 方法                               | 作用                                         |
| ---------------------------------- | -------------------------------------------- |
| `proxy.list` / `proxy.get`         | 列表与详情，支持关键字、协议、分组、风险区间 |
| `proxy.create` / `proxy.update`    | 新建与编辑，密码只写入密钥库                 |
| `proxy.delete`                     | 批量软删除并释放密钥引用                     |
| `proxy.import`                     | 批量导入 URL 列表，单行失败整批不保存        |
| `proxy.strategy.decodo`            | 按端口范围生成代理                           |
| `proxy.check`                      | 出口 IP、属地与风险检测                      |
| `proxy.exportUrls`                 | 导出连接地址（不含密码）                     |
| `proxy.resolve` / `proxy.describe` | 供宿主解析指定项或默认项与启动连接配置       |
| `proxy.groups.list` / `.create`    | 代理分组                                     |
| `proxy.config.get` / `.set`        | 默认代理、风险查询开关与 API Key 引用        |
| `proxy.subscriptions.*`            | 订阅列表、增删改、预览、导出、令牌与追加     |
| `transfer.export` / `.import`      | 原生宿主专用的可移植库存快照与本地副本导入   |
| `transfer.rollback` / `.commit`    | 按持久化回执撤销本次导入或清理成功回执       |

`proxy.subscriptions.export` 与 `proxy.subscriptions.download` 把渲染结果写入
插件私有存储的 `exports/` 目录并以文件句柄返回，明文代理密码不经过 RPC 报文。
`proxy.subscriptions.preview` 返回的 YAML 中密码固定为 `***`，只用于界面预览。

### 可移植传输（原生宿主私有）

四个 `transfer.*` 方法仍在 `proxy.provider` 能力内，不新增能力或版本号。
这组 RPC 允许明文代理凭据经过插件 IPC，专供原生宿主构造加密 Profile 归档；
宿主只传递、归档插件返回的不透明 JSON，不读取或解析插件业务文件。
宿主必须禁止通用 WebView `plugin_call` 转发这些方法，不能把传输结果交给插件页面。
这里实现的是插件端契约，宿主路由限制、归档加密与 Profile 文件/SQLite 事务由宿主负责。
本地库存和 `secrets.json` 继续使用现有明文、0600 文件存储。

严格入参与成功结果如下；省略 `transactionId` 时由插件生成 UUID：

```ts
// transfer.export
type ExportInput = {
  windowIds: string[]
  endpointIds: number[]
  includeDefault?: boolean // 默认 true
}
type ExportResult = {
  schemaVersion: 1
  defaultEndpointId: number | null
  endpoints: PortableEndpoint[]
  groups: { id: number; name: string; createdAt: string }[]
}
type PortableEndpoint = Omit<
  EndpointRecord,
  'secretRef' | 'credentialFingerprint' | 'fingerprint' | 'deleted' | 'deletedAt'
> & { password: string | null }

// transfer.import
type ImportInput = {
  data: unknown // 必须通过插件的 ProxyTransferDataSchema
  windowIdMap: Record<string, string>
  transactionId?: string // UUID，建议使用宿主归档事务的标识
}
type ImportResult = {
  receipt: string // transactionId 或插件生成的 UUID
  endpointIdMap: Record<string, number> // 源 endpointId 的十进制字符串 -> 新本地 ID
}

// transfer.rollback / transfer.commit
type ReceiptInput = { receipt: string }
type ReceiptResult = { success: true }
```

`EndpointRecord` 定义见插件 `src/domain/schemas.ts`；快照包含名称、协议、地址、
用户名、真实密码（无凭据引用时为 `null`）、分组、启用与 UDP 标志，以及检测状态、
出口 IP 历史、属地、信誉、风险、延迟、错误与创建/更新时间。
历史检测值按快照保存，导入不发起检测、不表示代理当前可用。
不导出库存指纹或本地密钥引用，也不导出订阅、订阅令牌、风险 API Key、全局配置或授权密钥。
公开入口导出传输类型与 zod schema，未知字段、非法版本、重复源 ID、缺失分组引用均拒绝，
错误不回显凭据数据。

- `windowIds` 在此插件只作参数校验，代理选择以 `endpointIds` 为准；重复 ID 只导出一次。
- `includeDefault` 省略或为 `true` 时，把实际默认代理加入显式选择集合。
  因而混合“指定代理”与“跟随默认”的窗口可以一次导出。
  `endpointIds: []` 此时只导出默认项；未配置默认时导出空集合。
- `includeDefault: false` 只导出显式选择，`defaultEndpointId` 仍报告该快照中的实际默认 ID，
  它可以不在 `endpoints` 中。宿主只要有窗口跟随默认，就必须传 `true` 或省略该字段。
- 任一显式选择不存在或已删除时整次导出失败；需要包含的默认项不存在时同样失败。
  密码引用不可解析也直接失败，不导出缺失认证的替代配置。停用项保留其停用状态。
  分组只带出所选代理引用的分组。

导入为每个代理与分组分配新本地 ID，为每个密码分配新密钥引用，
保留有效业务值并重新计算本地指纹；即使已有相同代理或同名分组，也不会合并或覆盖。
`windowIdMap` 在代理插件内不使用，但仍严格校验。
导入不会改变本地默认代理或风险配置；宿主用 `endpointIdMap` 重写 Profile 的代理引用，
并用导出数据的 `defaultEndpointId` 找到原来跟随默认的窗口所需的新引用。

回执与库存一起持久化在 `proxy-pool.json` 的 `transferReceipts` 中，旧文档缺少该字段时视为空，
本地存储 `schemaVersion` 仍为 1。先写入 `pending` 回执并预留新 ID、密码引用，
再写密钥文件，最后原子写入新库存与 `applied` 回执。
回执不存明文密码。失败时只补偿本次导入；清理也因 I/O 失败时保留恢复日志，
后续 `transfer.export` / `transfer.import` 会先重试未完成的清理，失败则阻断新传输。

宿主应始终传自己的 `transactionId`，这样进程在回包前中断也可按已知回执回滚。
同一未清理事务、相同数据和窗口映射的重复导入返回原结果，不创建第二份；
同一事务标识换用其他数据会被拒绝。该去重只在回执仍存在时有效，
提交或回滚后重用该 UUID 属于新导入，宿主应为新事务分配新 UUID。
`transfer.rollback` 物理移除该回执记录的新代理、仅由本次创建且未被其他记录引用的分组与密码；
不会删除此前已有的库存、密钥或配置。密钥清理完成前不丢弃回执，重启后可以继续回滚。
`transfer.commit` 只清理已完成回执，保留导入数据；`pending` 回执不能提交。
已清理或未知的有效 UUID 回执可重复提交/回滚，返回 `{ success: true }`。
成功导入的回执不会自动过期，宿主应在自身事务完成后提交或回滚。
未提供私有目录的内存模式沿用原有非持久化边界，不能承诺跨进程恢复。

### 启动解析 `proxy.resolve`

RPC 输入使用严格对象 `{ endpointId: number | null }`，省略字段或传 `null` 才跟随默认项；
不接受 `windowId`。宿主保留 `window_id` 方法参数以兼容调用方，但不把它发给插件，
这项输入修复不要求升级已安装插件。

成功响应包含 `configured: true`、不透明 `configHandle`、可选 `secretRef` 和
`connectionUrl`。插件只读取一次库存快照，从同一行生成引用，并通过自己的密钥库解析密码，
使用 `buildConnectionUrl` 构造含协议、主机、显式端口及认证信息的完整 URI。
用户名与密码按 RFC 3986 百分号编码；支持 `http`、`https`、`socks5`、`socks5h`，
多协议行沿用检测的协议优先级。密码引用缺失时返回 `NOT_CONFIGURED`，不得省略认证继续启动。
没有指定项且没有默认项时仍返回
`{ configured: false, configHandle: null, secretRef: null }`。

公开 SDK 的 `ProxyPool.resolve(): Promise<ProxyResolution | null>` 保持只返回引用。
`connectionUrl` 是启动专用的 RPC 扩展，不进入调度器 `ProxyReference`、窗口持久记录、
UI、错误消息或诊断日志。它只在内存中通过插件 IPC 交给宿主，再经标准输入交给浏览器适配器；
宿主不读取 `proxy-pool.json` 或 `secrets.json` 的业务结构。
已安装旧插件若未返回 `connectionUrl`，`resolve_browser_proxy` 明确要求更新或重新安装并阻断启动；
仅解析引用的 `resolve_proxy` 保持兼容。

`proxy.import` 每行一条标准链接 `scheme://user:pass@host:port`，不含认证信息时省略
userinfo；带路径、查询串、未知协议或端口越界会判为无效行。
部分服务商下发的 `scheme://host:port:user:pass` 连写格式不由插件解析，
由桌面端的“主机地址”输入框就地拆成字段后再走 `proxy.create`，插件只接收结构化字段。

## 配置与凭据

- 私有存储目录由宿主通过 `NEXUS_PLUGIN_STORAGE_DIR` 注入；未提供时使用内存存储，
  插件会在 `plugin.status` 与启动日志中声明“不可持久化”。插件不要求用户配置 `.env`。
- 代理密码、proxycheck API Key、订阅令牌由插件自己明文写入私有目录的 `secrets.json`
  （权限 0600），库存与订阅记录只保存引用。密钥文件由插件自己管理，宿主不读取或加密该文件；
  启动所需的代理密码通过上述 `connectionUrl` 临时传递，不能据此宣称凭据不经过宿主。
  没有宿主私有目录时退回进程内内存密钥库，重启即失效，不落盘。
- 订阅令牌在记录中只保留 SHA-256 摘要；公开下载地址的令牌值由宿主从密钥库解析后拼装。

## 外部服务、费用与数据发送

| 服务              | 用途          | 发送内容                     | 费用与限制                     |
| ----------------- | ------------- | ---------------------------- | ------------------------------ |
| `api64.ipify.org` | 出口 IP 检测  | 仅一次 HTTPS GET，无业务数据 | 公共免费服务，无 SLA           |
| `proxycheck.io`   | IP 风险与属地 | 出口 IP、可选的 API Key      | 免费额度有限，超额返回限流分类 |

代理账号与密码不会发送到上述服务；风险查询只使用检测到的出口 IP。
风险查询可在插件配置中关闭，关闭后不产生任何外部请求，属地显示为“已关闭”。

## 已知限制

- 密码是 `secrets.json` 里的明文，与库存文件同级；能读取该目录的程序都能读到。
- 仅支持通过 SOCKS5 / HTTP(S) 代理检测 IPv4 与域名目标；经 SOCKS5 连接 IPv6 目标会返回协议错误。
- 风险与属地缓存只在进程内，重启后重新查询。
- 只实现 `proxy.provider`；平台账号、接码、图片与环境配置未涉及。
- 进程隔离只用于故障管理，不是安全沙箱；manifest 不是权限执行结果。
- 订阅导出文件写在插件私有目录内，内容包含明文代理密码，宿主不额外加密。
- 仅在 macOS 上执行过类型检查、单测与本地隧道测试；Windows 未验证。

## 本地验证

```bash
rtk proxy pnpm --filter @nexus/plugin-proxy-pool run build
rtk proxy pnpm exec vitest run plugins/proxy-pool
rtk proxy pnpm exec eslint plugins/proxy-pool --max-warnings 0
rtk proxy cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --locked core::plugin_host
```

使用仓库固定的 Node.js 24.18.0；pnpm 11 默认自动检查依赖并可能尝试重装，
复用现有依赖验证时可加 `pnpm_config_verify_deps_before_run=false`，不改变锁文件或安装配置。
必须先构建本插件再运行宿主回归。最后一条使用临时目录安装实际构建包并启动真实 `node`，
除握手、`proxy.list` 与 `proxy.get` 外，还覆盖无默认项时指定代理的引用与精确连接地址、
认证百分号编码、密码引用缺失、指定项停用或删除后失败关闭；不修改应用用户数据。
单测覆盖 manifest 校验、库存去重与协议合并、写入失败不报成功、检测结果分类、
迟到与过期结果丢弃、取消、信誉限流、订阅渲染与令牌校验、协议错误与日志脱敏，
并覆盖缺失密码阻断与同一行快照生成引用和连接。
插件目录中的传输测试会启动实际构建后的 Node.js 入口，经握手和逐行 RPC 验证选择范围、
真实凭据与分组快照、本地副本、调用方事务回执、重复导入、重启后回滚/提交以及真实文件写入失败。
另有库存/密钥分步失败与取消的补偿测试；运行前必须先构建本插件，
不能用旧 `dist` 的通过结果代表新源码已经验证。
这些结果不代表真实代理链路已经可用，也不代表 Windows 行为。
