# 代理池插件 `studio.proxy-pool`

本文说明仓库内代理插件的实际范围。插件规则见[插件对接开发规范](14-plugin-integration-guide.md)，
产品侧插件边界见[插件系统](06-plugin-system.md)。

## 当前事实

插件包位于 `plugins/proxy-pool`，已实现 manifest、`proxy.provider` 能力方法、
私有存储适配、密钥引用边界与逐行 JSON RPC 服务端。

宿主侧已实现发现、安装、进程托管、权限检查点与窗口启动阻断，
因此本插件可以在插件中心安装并启用，并作为窗口的代理来源，见[插件宿主](17-plugin-host.md)。
仍需区分：安装成功不等于代理可用；没有选择默认代理时窗口启动被阻断，不会回退直连。
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

manifest 声明：`apiVersion: 1`、`id: studio.proxy-pool`、`version: 1.0.0`、
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
| `proxy.resolve` / `proxy.describe` | 供宿主解析默认代理并生成启动快照             |
| `proxy.groups.list` / `.create`    | 代理分组                                     |
| `proxy.config.get` / `.set`        | 默认代理、风险查询开关与 API Key 引用        |
| `proxy.subscriptions.*`            | 订阅列表、增删改、预览、导出、令牌与追加     |

`proxy.subscriptions.export` 与 `proxy.subscriptions.download` 把渲染结果写入
插件私有存储的 `exports/` 目录并以文件句柄返回，明文代理密码不经过 RPC 报文。
`proxy.subscriptions.preview` 返回的 YAML 中密码固定为 `***`，只用于界面预览。

`proxy.import` 每行一条标准链接 `scheme://user:pass@host:port`，不含认证信息时省略
userinfo；带路径、查询串、未知协议或端口越界会判为无效行。
部分服务商下发的 `scheme://host:port:user:pass` 连写格式不由插件解析，
由桌面端的“主机地址”输入框就地拆成字段后再走 `proxy.create`，插件只接收结构化字段。

## 配置与凭据

- 私有存储目录由宿主通过 `NEXUS_PLUGIN_STORAGE_DIR` 注入；未提供时使用内存存储，
  插件会在 `plugin.status` 与启动日志中声明“不可持久化”。插件不要求用户配置 `.env`。
- 代理密码、proxycheck API Key、订阅令牌由插件自己明文写入私有目录的 `secrets.json`
  （权限 0600），库存与订阅记录只保存引用。宿主不接收、不托管、不加密这些值。
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
rtk proxy pnpm --filter @nexus/plugin-proxy-pool build
rtk proxy pnpm exec vitest run plugins/proxy-pool
rtk proxy pnpm exec eslint plugins/proxy-pool --max-warnings 0
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --locked
```

最后一条会启动真实 `node` 进程，对本插件完成握手并调用 `proxy.list` 与 `proxy.get`。
单测覆盖 manifest 校验、库存去重与协议合并、写入失败不报成功、检测结果分类、
迟到与过期结果丢弃、取消、信誉限流、订阅渲染与令牌校验、协议错误与日志脱敏。
这些结果不代表真实代理链路已经可用，也不代表 Windows 行为。
