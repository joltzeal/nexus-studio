# Raccoon 插件与插件仓库规范

适用于 desktop-v2 插件开发者、插件仓库维护者及授权服务运营者。插件交付可独立于主程序发布。主程序负责安装、授权和运行，插件负责业务能力，仓库负责交付经签名的目录和版本化安装包。

## 插件开发

| 项目     | 约定                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 源码     | `plugins/<name>/` 下维护 `package.json`、`nexus.plugin.ts` 和 `src/index.ts`。实现源码和 `market/` 留在本地                      |
| 公共接口 | 通过 `@nexus/plugin-sdk` 声明 manifest、能力和生命周期。主程序与插件共享的类型和 RPC 契约放在 `packages/plugin-contracts/`       |
| 安装标识 | `id` 使用发布者域名前缀，例如 `com.example.inventory`。发布后保持稳定。宿主清单中的 11 个官方 `studio.*` ID 保留给官方目录       |
| 版本     | `apiVersion` 当前为 `1`。`version` 和 `minCoreVersion` 使用完整 SemVer。`package.json`、manifest、安装包及目录所列的插件版本一致 |
| 权限     | 声明所需能力、精确网络域名、浏览器访问、存储范围和密钥槽。宿主按声明和用户授权执行能力检查                                       |
| 数据     | 用 Raccoon Profile UUID 关联业务数据。插件读写宿主提供的私有目录。凭据和卡密值不得写入 manifest、目录、包或日志                  |

最小 manifest 示例。

```ts
import { definePluginManifest } from '@nexus/plugin-sdk'

export default definePluginManifest({
  apiVersion: 1,
  id: 'com.example.inventory',
  version: '1.0.0',
  name: 'Inventory',
  minCoreVersion: '0.2.8',
  capabilities: ['product.catalog'],
  permissions: {
    networkDomains: [],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
})
```

插件在独立 Node 进程中运行。通过逐行 JSON 完成 `hello → handshake → ready`，成功后才能接收 RPC。stdout 留给协议，stderr 仅输出脱敏诊断。请求和响应按 `requestId` 关联，错误使用 `code`、`message`、`retryable`。具体方法、取消和超时规则见[插件对接开发规范](14-plugin-integration-guide.md)。

宿主决定插件可用性及过期状态，插件无需接收激活码或连接市场授权服务。源码调试入口与发行包启动路径分别见[插件本地开发](50-local-plugin-development.md)。独立 Node 进程用于生命周期管理和故障恢复，运行受信任的插件。

## 仓库目录与签名

发布根目录提供一个签名 v2 HTTPS JSON 入口和不可变的版本化安装包。客户端可填完整 `.json` 地址。填根地址时，宿主会补上 `/catalog-v2.json`。

```text
market/
├── catalog-v2.json
└── plugins/
    └── com.example.inventory/
        └── 1.0.0.nexuspkg
```

| 字段                             | 规则                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 外层 `schemaVersion`             | 值为 `2`                                                                                                                      |
| `signed.publicKey`               | Ed25519 目录签名公钥，原始 32 字节的标准 Base64                                                                               |
| `signed.payload`                 | 紧凑 UTF-8 JSON 的标准 Base64。解码后含 `schemaVersion: 2`、`market` 和 `plugins`                                             |
| `signed.signature`               | 对解码后的 payload 原始字节签名，再用标准 Base64 编码                                                                         |
| `market.id`、`market.catalogUrl` | 固定市场 ID 与用户实际访问的规范化 HTTPS 文件 URL。URL 使用最终地址，省略查询串、片段和内嵌凭据                               |
| `market.licensing`               | 付费市场声明 `issuerId`、`protocolVersion: 1`、`baseUrl`、`keyId`、`publicKey`。`baseUrl` 为 HTTPS origin。此公钥用于租约验签 |
| `plugins[].manifest`、`package`  | 完整 manifest，随包读取的大小、SHA-256 和下载 URL。推荐 `plugins/<id>/<version>.nexuspkg` 相对路径                            |
| `plugins[].requiresLicense`      | 每条显式声明布尔值。`true` 使用该市场的授权服务。全免费目录可以省略 `market.licensing`                                        |

单份目录最多 256 条和 1 MiB。同一目录内每个 ID 只出现一次。包上限为 32 MiB，版本 URL 一经发布即对应同一份字节。包里携带的 manifest 必须与目录条目一致。宿主与发布脚本读取签名内的条目。

宿主首次读取时记录该 URL 的市场签名身份，后续拒绝签名身份变化或降级。保留同一目录签名私钥用于后续更新，单独保管租约签发私钥。公钥可以公布。需要更换目录签名身份时，安排新的目录入口和受控迁移。

## 授权服务

| 动作 | 端点                      | 请求 JSON                             |
| ---- | ------------------------- | ------------------------------------- |
| 激活 | `POST /v1/cards/redeem`   | `pluginId`、`card`、`devicePublicKey` |
| 续租 | `POST /v1/leases/refresh` | `licenseId`、`devicePublicKey`        |

宿主在请求头附上 `x-device-time`、`x-device-nonce`、`x-device-signature`。签名覆盖 `v1`、`POST`、请求路径、Unix 秒、nonce 和准确请求体的 SHA-256，字段间以 LF 分隔，无尾部换行。服务端校验设备签名、时间窗口、nonce、插件 ID、卡状态和设备归属。卡首次兑换需原子绑定，防止并发重复兑换。

HTTP 2xx 响应返回 `{ "payload": { … }, "signature": "…" }`。租约签名覆盖按下列顺序紧凑序列化的 payload。时间均使用 UTC Unix 秒。

```text
v, licenseId, pluginId, devicePublicKey, issuedAt, expiresAt,
offlineUntil, refreshAfter, revision, keyId, issuerId
```

宿主核对签名、`issuerId`、设备和插件归属，以及时间和租约版本。`expiresAt` 决定到期，`offlineUntil` 决定断网时可继续使用到何时，`refreshAfter` 用于安排续租。`offlineUntil` 与 `refreshAfter` 均不得晚于 `expiresAt`。续租明确返回 HTTP 403 时清除本地租约。请求超时、服务不可用或响应无效时退避，旧租约最多使用到既定离线截止时间。线协议及第一方兼容说明见[插件卡密授权](53-plugin-card-licensing.md)。

不同市场即使有同一个插件 ID，设备、租约和私有数据也独立。换目录时，已安装插件继续使用原安装记录的来源。安装另一来源的同 ID 插件要由用户确认替换。宿主验证新包和授权后切换唯一安装记录，停止旧进程并保留旧来源私有数据。

## 生成并发布目录

1. 有插件改动时，更新源码 manifest 和 `package.json` 版本，设置实际最低主程序版本，在插件发布环境构建并打包。通过 `scripts/verify-package.mjs` 检查最终包启动握手。
2. 执行 `market:catalog` 生成本地 `market/package-index.json`，确保未更新的线上条目仍在其中。单独修改市场授权元数据时，可以直接复用已有安装包和 SHA-256。
3. 在发布机准备市场配置，字段示例见[插件商店与在线更新](25-plugin-market.md)。免费市场使用 `licensedPluginIds: []` 并省略 `licensing`。付费市场在配置中声明自己的发行方 ID、租约公钥和 HTTPS 服务地址。
4. 使用目录私钥签名。先检查签名和包名、大小、摘要，再把包上传到不可变版本路径，最后发布目录。发布后从公开 HTTPS 回读目录及改动的包并核对字节。

以下为本仓库官方目录命令，在仓库根目录执行。目录私钥由发布者在仓库外保管。

```sh
rtk proxy node scripts/sign-market.mjs \
  market/package-index.json market/official-market-v2.json \
  ~/.config/raccoon/market-catalog/official-v2.pem market/catalog-v2.json
rtk proxy pnpm run market:publish --catalog catalog-v2.json --dry-run
```

正式上传时去掉 `--dry-run`。发布脚本校验签名内条目，检查本地安装包的大小和 SHA-256，先上传包、最后上传所选目录。包使用长缓存，目录使用短缓存。目录内所有包已在线且回读字节一致的情况下，可只写入新的目录对象。字段、路径和签名身份应一并核对。

## 官方 11 个插件接入

官方 `catalog-v2.json` 使用独立的目录签名密钥，为下列包声明付费授权。

| 插件 ID                    | 包版本  | 插件最低主程序版本 |
| -------------------------- | ------- | ------------------ |
| `studio.address-generator` | `1.3.0` | `0.1.43`           |
| `studio.ai-image`          | `1.6.5` | `0.1.38`           |
| `studio.email`             | `1.2.1` | `0.1.35`           |
| `studio.products`          | `1.1.1` | `0.1.35`           |
| `studio.proxy-pool`        | `1.1.0` | `0.1.35`           |
| `studio.sales-agent`       | `1.1.2` | `0.1.35`           |
| `studio.shared-supply`     | `1.0.3` | `0.1.35`           |
| `studio.sim8`              | `1.0.6` | `0.1.35`           |
| `studio.vinted-accounts`   | `1.6.0` | `0.1.43`           |
| `studio.vinted-monitor`    | `1.1.5` | `0.1.35`           |
| `studio.window-sync`       | `1.0.2` | `0.1.35`           |

插件最低版本与目录版本是两项独立条件。宿主通过目录签名身份识别官方插件发布者，授权地址、发行方和租约公钥来自签名目录。官方签名目录继续使用已有的设备键、租约及插件私有目录，并验证官方服务已签发的省略 `issuerId` 的租约。第三方签名市场的租约必须携带对应的 `issuerId`。
