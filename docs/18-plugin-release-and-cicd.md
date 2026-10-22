# 插件发布、加密与整体 CI/CD 方案

> **状态：部分落地，其余暂缓。** 2026-10-22 已按第 14 节第 1 期的思路落地了不依赖服务端的
> 那一半：加密打包、`catalog.json`、静态对象存储分发与在线更新，见
> [插件商店与在线更新](25-plugin-market.md)。本文仍是完整方案，其中依赖账号体系、
> 服务端按会话下发密钥、收费链路与 beta 通道的部分没有实现，当前代码不依赖它们。

本文是方案，不是当前实现。第 13 节列出与现有代码的真实差距，第 14 节给出分期。
现状见[插件宿主](17-plugin-host.md)，应用分发现状见[分发](08-distribution.md)。

## 1. 已确定的决策与它带来的后果

| 决策             | 直接后果                                                           |
| ---------------- | ------------------------------------------------------------------ |
| 私有 GitHub 仓库 | Release 资产不能匿名下载，必须有服务端签发令牌；「纯静态分发」作废 |
| 插件加密做 L3    | 必须有账号体系 + 服务端按会话下发密钥；离线能力要打折              |
| 预留收费接口     | manifest 增加 `pricing`，宿主增加授权检查点与 `PAYMENT_REQUIRED`   |
| 没有代码签名证书 | macOS/Windows 首次安装会有系统拦截，需要写清代价与绕过方式         |
| 需要 beta 通道   | 通道由服务端过滤，不靠客户端自觉                                   |

结论：**GitHub Releases 当对象存储，另加一层薄控制面**。控制面只做四件事——发令牌、
下密钥、出目录、代理下载。业务逻辑一行都不放进去，这样它才能小到可以随时重写。

不引入控制面的路已经堵死了：私有仓库要令牌，L3 要会话密钥，收费要授权查询。
三者任意一个成立都得有服务端，三个同时成立更没必要假装没有。

## 2. 三层分工

```text
┌────────────────┐   ① 登录/租约/目录（JSON，签名）   ┌──────────────────┐
│  桌面应用       │ ────────────────────────────────> │  控制面服务       │
│                │ <──────────────────────────────── │  （6 个端点）     │
│  验签 / 解密    │   ② 数据密钥（TLS，短时效）        │  账号 · 授权 · 密钥│
│  校验 / 回滚    │                                   └────────┬─────────┘
└───────┬────────┘                                            │ ③ GitHub App
        │ ④ 下载包（经控制面代理）                              │   installation token
        ▼                                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 私有 GitHub 仓库：Release 资产 = .nexuspkg + catalog.json + app 产物    │
└──────────────────────────────────────────────────────────────────────┘
```

- **GitHub Releases** 只承担「存字节 + 版本留档」。私有仓库的好处是资产不可被搜索引擎
  和第三方镜像抓走；代价是所有读取都要令牌。
- **控制面** 持有 GitHub App 私钥，换取 1 小时有效的 installation token，再代理下载。
  令牌不出服务端，客户端只拿到一个 `GET /v1/packages/<id>/<version>` 的地址。
- **应用** 是唯一做验签的地方。目录签名、包签名、租约签名都在本地用内置公钥验证，
  控制面返回什么都只是「待验证的输入」。

控制面挂了的后果必须写清楚：已安装插件继续可用（租约未过期时），新装与升级不可用，
应用更新检查不可用。这是私有仓库换来的确定性代价。

## 3. 产物定义

### 3.1 插件包 `.nexuspkg`

确定性 tar.gz，解包后结构固定：

```text
package.json            # 打包器写入：id、version、apiVersion、entry
nexus.plugin.json       # manifest 明文，宿主与授权界面要读它
payload.bin             # AES-256-GCM(bundle.js)，nonce(12) | tag(16) | ciphertext
signature.ed25519       # 对 (manifest 字节 + payload.bin 的 SHA-256) 的签名
checksums.txt           # 逐文件 SHA-256，便于人工核对
```

要点：

- manifest 保持明文。用户授权时看到的能力、域名、密钥槽必须来自可校验的明文，
  不能藏在加密层里，否则「权限检查点」就成了自证。
- 只加密 `payload.bin`，也就是 esbuild 产出的单文件 JS。源码、注释、sourcemap 不进包。
- tar 固定 mtime、uid/gid、文件顺序，同一输入产出同一 digest（可复现构建，便于比对）。
- **包内不含任何密钥**。L3 的数据密钥由服务端在安装时下发，包本身可公开流传而不泄密
  ——这正是 L3 相对 L2 的唯一实质差别。

### 3.2 目录 `catalog.json`

控制面返回、同时被 Ed25519 签名的目录。它取代了静态 `plugins-index.json`：

```jsonc
{
  "schemaVersion": 2,
  "generatedAt": "2026-10-22T07:00:00Z",
  "channel": "beta",
  "plugins": [
    {
      "id": "studio.proxy-pool",
      "latest": "1.1.0",
      "pricing": {
        "model": "paid",
        "sku": "proxy-pool.yearly",
        "priceCents": 9900,
        "currency": "CNY",
        "trialDays": 14,
      },
      "versions": [
        {
          "version": "1.1.0",
          "assetId": 384729105,
          "size": 812345,
          "sha256": "…",
          "apiVersion": 1,
          "minCoreVersion": "0.1.0",
          "capabilities": ["proxy.provider"],
          "permissions": { "secrets": ["proxy-password"], "networkDomains": ["…"] },
          "publishedAt": "2026-10-22T06:00:00Z",
          "keyId": "data-2026-10",
          "requiresEntitlement": true,
        },
      ],
    },
  ],
}
```

- 用 `assetId` 而不是 URL：私有仓库的资产地址含可变 id，写死 URL 等于把内部结构固化到
  签名内容里；客户端拿 `assetId` 去请求 `/v1/packages/...`，由服务端解析。
- `requiresEntitlement` 是服务端根据账号算出来的，客户端只用来决定界面文案；
  真正拦截发生在 `/v1/leases`（服务端拒绝下密钥）。
- 目录签名与包签名用**不同**的密钥对，见 11.6。

### 3.3 应用产物

| 平台    | 产物                        | 说明                         |
| ------- | --------------------------- | ---------------------------- |
| macOS   | `Nexus_<ver>_aarch64.dmg`   | 无 Developer ID，不公证      |
| macOS   | `Nexus_<ver>_x64.dmg`       | 同上                         |
| Windows | `Nexus_<ver>_x64-setup.exe` | 无代码签名，SmartScreen 拦截 |

更新清单 `latest.json` 由 `tauri build` 生成并用 minisign 私钥签名。**它与操作系统代码
签名完全无关**——没有证书不影响自动更新的完整性校验，只影响首次安装时的系统拦截。
这个区别在第 12 节展开。

## 4. 控制面接口

六个端点，全部 JSON over TLS，除健康检查外都要求 `Authorization: Bearer <session>`。

| 方法   | 路径                       | 作用                                  | 状态    |
| ------ | -------------------------- | ------------------------------------- | ------- |
| `GET`  | `/v1/health`               | 存活与版本                            | 第 2 期 |
| `POST` | `/v1/auth/device/code`     | 设备码登录第一步，返回 `userCode`     | 第 2 期 |
| `POST` | `/v1/auth/device/token`    | 轮询换 session token（30 天，可续期） | 第 2 期 |
| `GET`  | `/v1/catalog?channel=beta` | 签名目录                              | 第 2 期 |
| `POST` | `/v1/leases`               | 签发租约 + 下发数据密钥               | 第 3 期 |
| `GET`  | `/v1/packages/<id>/<ver>`  | 代理下载，302 或流式转发              | 第 2 期 |
| `POST` | `/v1/checkout`             | **预留**，当前固定返回 501            | 第 4 期 |
| `POST` | `/v1/webhooks/payment`     | **预留**，当前固定返回 501            | 第 4 期 |

设备码登录而非浏览器回调：桌面应用没有稳定的 redirect URI，设备码流程不需要注册回调，
也不需要把 token 从浏览器传回来。

```jsonc
// POST /v1/leases
{ "pluginId": "studio.proxy-pool", "version": "1.1.0", "deviceId": "sha256:…", "channel": "beta" }

// 200
{
  "lease": "eyJ2IjoxLCJwbHVnaW5JZCI6…",   // 紧凑 JWS，Ed25519 签
  "keyId": "data-2026-10",
  "dataKey": "base64…",                    // 32 字节，AES-256-GCM 用
  "entitlement": "trial",                  // owned | trial | none
  "expiresAt": "2026-10-22T07:00:00Z",
  "graceUntil": "2026-10-30T07:00:00Z"
}

// 402 —— 付费插件但账号无授权
{ "error": "PAYMENT_REQUIRED", "checkoutUrl": null }
```

`checkoutUrl` 现在恒为 `null`，界面显示「购买通道未开放」。这样第 4 期接支付时，
客户端一行不用改。

控制面规模估算：一张 `accounts` 表、一张 `entitlements` 表、一张 `devices` 表，
无队列、无定时任务、无缓存层。SQLite 足够，Postgres 只是图省事。

## 5. 私有仓库取包

GitHub App 而非 Personal Access Token：App 的 installation token 有效期 1 小时、
权限可限制到「单个仓库 + 只读 contents」，泄露窗口小且可随时吊销 installation。

```text
控制面启动 ──> 用 App 私钥签 JWT（10 分钟）──> POST /app/installations/<id>/access_tokens
                                                └─> token（1h），缓存到过期前 5 分钟
GET /v1/packages/<id>/<ver>
  ──> 查 catalog 得 assetId
  ──> GET api.github.com/repos/<owner>/<repo>/releases/assets/<assetId>
        Accept: application/octet-stream
        Authorization: Bearer <installation token>
  ──> 流式转发（支持 Range），并缓存到对象存储
```

- **代理转发而不是 302 到 `api.github.com`**：302 会把 installation token 或
  `browser_download_url` 暴露给客户端，私有仓库的 `browser_download_url` 需要 cookie，
  根本用不了。代理还能顺手做 Range、断点续传、命中率统计。
- 带宽成本可控：包体目标是 200–800 KiB（bundle 后），一个版本几千次下载不到 1 GB。
  量级上来再在控制面前面加 CDN，接口不变。
- 缓存：控制面本地磁盘按 `sha256` 缓存一份，命中直接回源本地，GitHub 只当冷备。
  这样即使 GitHub 限流（5000 次/小时/installation）也不影响已缓存版本。

## 6. L3 密钥下发与运行时解密

### 6.1 L3 到底防住了谁

先把边界说清楚，避免对客户做出错误承诺：

| 级别 | 做法                              | 挡住谁                   | 挡不住谁                   |
| ---- | --------------------------------- | ------------------------ | -------------------------- |
| L1   | esbuild 打包 + minify             | 随手翻包的人             | 任何愿意打开 DevTools 的人 |
| L2   | AES-GCM 封装，密钥随目录下发      | 直接解压包的人           | 抓一次目录请求就拿到密钥   |
| L3   | 密钥按账号 + 会话下发，包内无密钥 | 拿到安装包但没有账号的人 | 有账号且愿意 hook 进程的人 |
| L4   | 编译为原生 / WASM                 | 绝大多数逆向者           | 愿意逆汇编的人             |

L3 的实质是：**包可以自由流传，但没有账号拿不到能跑的明文**。它不是密码学意义上的
保密——密钥最终要进到客户端内存，因为 JS 必须在 V8 里执行。任何声称「无法破解」的
方案都是在骗人，本文不写这种话。

### 6.2 密钥派生与轮换

```text
master（服务端，永不出网） ──HKDF-SHA256(salt=pluginId, info=version)──> dataKey(32B)
```

- 每个 `(pluginId, version)` 一把独立密钥。一把泄露只打开一个版本，不牵连其他插件。
- `keyId`（`data-2026-10`）标识 master 代次。轮换时新版本用新 master，旧版本继续用旧
  master 直到没人装；应用内置当前与上一把**验签**公钥，但数据密钥不需要内置。
- 服务端只在租约签发时把 `dataKey` 放进响应体（TLS 内），不写日志、不进 trace。
  日志里出现 `dataKey` 视为事故。

### 6.3 运行时解密

宿主拿到包后：验签 → 请求租约 → 内存解密 → 交给插件进程。三条硬规则：

1. **明文不落盘。** 不写临时文件，不写 `runtime/`，不做「启动后删除」。
   Windows 上删除时机不可靠，而落过盘就等于留了取证副本。
2. **不缓存解密结果。** 每次启动重新解密。代价是几十到几百毫秒，换来「磁盘上永远没有
   明文代码」这个可验证的性质。
3. **交付方式用 `bootstrap` 预握手消息。** 宿主在 `hello` 之后、`handshake` 之前发分块
   消息（base64，单块 ≤ 1 MiB，总上限 32 MiB），插件拼完后
   `await import('data:text/javascript;base64,' + b64)`。

`bootstrap` 需要改动三处协议约定，都要在实现时一起改，不能只改一半：

- 新增消息类型 `bootstrap`（`seq`、`total`、`data`），插件侧必须在 `handshake` 前接受它；
- 行上限从 1 MiB 临时放宽到 1.4 MiB（base64 膨胀 4/3），收到 `ready` 后恢复；
- 协议错误计数在 `bootstrap` 阶段不清零也不累加，避免大包传输把进程判定为失联。

`data:` URL 导入 1–5 MiB 模块的启动耗时**未实测**。第 3 期的验收里必须包含这项测量，
超过 1.5 s 就改用 `vm.SourceTextModule` 或退回「私有目录 + 立即 unlink」，届时以实测
数据决定，不在文档里预设结论。

### 6.4 租约、离线与宽限

- 租约有效期 **12 小时**，宽限到 **7 天**。应用启动时若本地租约未过期直接用；过期则
  静默续签；续签失败但仍在宽限期内继续用，界面提示「离线，N 天后需要联网」。
- 宽限期结束仍无法续签：插件不启动，状态显示 `unauthorized` 并给出真实原因
  （网络不通 / 账号无授权 / 租约被吊销），不显示「加载失败」这种含糊话。
- 租约与 `deviceId` 绑定。`deviceId` 是安装时生成的随机 UUID 的 SHA-256，不采集硬件
  指纹——采集硬件指纹是隐私问题，而收益只是防多机共用，不值得。
- **已知弱点**：宽限期基于本机时钟，改系统时间可以延长。接受这个弱点，不引入可信时间源
  （那需要额外网络依赖，代价大于收益）。文档里写明。

## 7. 收费接口预留

### 7.1 manifest 增加 `pricing`

```jsonc
{
  "id": "studio.proxy-pool",
  "pricing": {
    "model": "paid", // free | paid | trial
    "sku": "proxy-pool.yearly",
    "priceCents": 9900,
    "currency": "CNY",
    "trialDays": 14,
  },
}
```

`pricing` 进签名覆盖范围。改了价格必须发新版，不能服务端偷偷改——用户看到的
「这个插件要 99 元」必须和包内声明一致。

### 7.2 宿主的授权检查点

新增 `EntitlementPort`，与现有 `permissions.rs` 的检查并列但独立：

```rust
pub enum Entitlement {
    Owned,
    Trial { until: SystemTime },
    None,
}
```

- `install()` 不检查授权。允许装、允许看到界面，只有 `enable()` 需要。
  「先装后买」比「买之前什么都看不到」转化率高，也方便试用。
- `enable()` 顺序：`check_call`（能力/域名/密钥槽）→ `entitlement`（付费）→ 启动。
  授权不足返回 `PAYMENT_REQUIRED`，界面弹「购买」而不是「无权限」。
- 已启用的插件授权过期：不立刻杀进程，等到下次重启或租约失效再拦，避免用户正在用的
  时候被中断。

### 7.3 现在就要留的三个口子

1. **`POST /v1/checkout` 返回 501**，body `{ "error": "NOT_IMPLEMENTED" }`。
   客户端区分「未实现」与「失败」，前者显示「购买通道未开放」，后者显示重试。
2. **`catalog.pricing` 与 `lease.entitlement` 字段现在就发**，即使全是 `free` / `owned`。
   字段先有、值后填，比事后改协议便宜得多。
3. **`webhooks/payment` 路由现在就注册**，直接 501。接支付时只改实现，不改路由与签名
   校验骨架。

### 7.4 不做的部分

不做应用内购买（App Store 抽成与审核周期不划算）、不做订阅自动续费的客户端逻辑
（放服务端 + 邮件提醒）、不做试用期多开检测。这三件都会把薄服务撑厚。

## 8. 信任链与校验顺序

```text
内置公钥 A（目录/包验签） ──验──> catalog.json 签名
                                    │
                                    ├─ semver 选版本、检查 minCoreVersion、channel 匹配
                                    ▼
                          下载 .nexuspkg（校验 sha256、size）
                                    │
                                    ├─ 验 signature.ed25519（覆盖 manifest + payload digest）
                                    ├─ 解包到 .staging/<uuid>
                                    ├─ 校验包内 manifest 与目录条目一致（id/version/能力/pricing）
                                    ├─ 检查 apiVersion 与当前核心兼容
                                    ▼
                          权限差异 → 需新授权则暂停升级并提示
                                    ▼
                          POST /v1/leases → 验租约签名 → 取 dataKey
                                    ▼
                          原子替换 installed/<id>/<version>，保留上一版用于回滚
```

硬性规则：

- 目录未签名、签名不匹配、包 digest 不符、包内 manifest 与目录不一致，全部拒绝，
  不降级处理、不「先装上再说」。
- **防降级**：登记表记录每个插件见过的最高版本，低于它的版本一律拒绝安装，除非用户
  显式选择「回滚」，且只允许回退到本机仍保留的上一版目录。
- **防权限静默扩大**：新版本声明的能力/域名/密钥槽是旧版本的超集时，不允许自动启用，
  必须走一次授权确认，复用现有 `enable()` 的收窄授权逻辑。
- 目录里的 `permissions` 只用于「升级前告诉用户会多要什么」，不作为授权依据；
  真正生效的永远是包内 manifest。
- 租约验签失败等同于无授权。**不存在「验签失败但先跑起来」的路径**，与宿主现有的
  「不静默回退直连」是同一个原则。

## 9. 应用内升级流程

```text
检查（手动 / 启动后延迟 60s / 每日一次）
  → GET /v1/catalog（带 ETag，失败静默重试，不阻塞界面）
  → 有新版：版本号 + 变更摘要 + 权限差异 + 价格变化
  → 用户确认 → 下载（进度、可取消、Range 续传）
  → 验签 → 请求租约 → 解密 → 安装 → 重启插件进程 → 握手成功才算升级完成
  → 握手失败：自动回滚到上一版目录并报告真实错误
```

状态机沿用现有四种状态，新增三个瞬时态：`updating`、`rolling-back`、`unauthorized`，
都带 `lastError`。绝不出现「升级成功」但进程没起来的假成功——这是仓库既有的诚实性要求。

## 10. 本地开发到上传

```bash
# 1. 开发：直接跑源码入口，不打包不加密
pnpm --filter @nexus/plugin-proxy-pool dev

# 2. 本地打包装进宿主验证（离线，用开发密钥，不请求控制面）
pnpm plugin:pack proxy-pool --channel dev --key-from-env PLUGIN_DEV_KEY
# 宿主「从本地文件安装」入口指向 dist-plugins/*.nexuspkg（当前只有目录安装，需新增）

# 3. 打 tag，CI 打包签名上传
git tag plugin-proxy-pool@1.1.0 && git push origin plugin-proxy-pool@1.1.0
```

开发通道（`channel: dev`）的行为差异必须写在文档里，否则迟早有人拿 dev 包当正式包：

- 用 `PLUGIN_DEV_KEY`（仓库里公开的固定值）加密，任何人可解——本来也不需要保密；
- 跳过租约请求，`entitlement` 恒为 `owned`；
- 安装时界面明确标注「开发包，未校验授权」。

`pack-plugin.mjs` 与 CI 用同一份脚本、同一个 Node 版本，保证本地产物与发布产物同构。
同版本重复上传直接失败，不允许覆盖——覆盖会让「用户装的 1.1.0」和「仓库里的 1.1.0」
变成两个不同的东西。

## 11. CI/CD

### 11.1 现有基础

`.github/workflows/ci.yml` 已覆盖 lint / format / typecheck / test / build / rust 三件套，
macOS 与 Windows 双平台跑原生检查。下面在它之上加三个工作流，不改动质量门禁本身。

### 11.2 插件发布 `plugin-release.yml`

触发：`push: tags: ['plugin-*@*']`（例如 `plugin-proxy-pool@1.1.0`）。

```yaml
jobs:
  package:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    environment: plugin-release # 需要人工审批
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11.17.0 }
      - uses: actions/setup-node@v4
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter './plugins/*' build
      - run: pnpm exec vitest run plugins
      - name: Pack and sign
        env:
          PLUGIN_SIGNING_KEY: ${{ secrets.PLUGIN_SIGNING_KEY }}
          PLUGIN_DATA_KEY: ${{ secrets.PLUGIN_DATA_KEY }}
        run: node scripts/pack-plugin.mjs plugins/proxy-pool --out dist-plugins
      - name: Upload to private release
        env: { GH_TOKEN: ${{ github.token }} }
        run: node scripts/publish-plugin.mjs --channel stable --dir dist-plugins
      - name: Update catalog
        env: { CONTROL_PLANE_ADMIN_KEY: ${{ secrets.CONTROL_PLANE_ADMIN_KEY }} }
        run: node scripts/update-catalog.mjs --channel stable --dir dist-plugins
```

插件发布不需要 macOS/Windows 矩阵：产物是平台无关的 JS。这也是先做插件发布的原因。

`update-catalog.mjs` 有两种落法，第 2 期用前者，省一个后台：

- **仓库文件模式（先做）**：重写仓库里的 `plugins/catalog-<channel>.json` 并提交，
  控制面通过同一个 GitHub App 读 raw 内容，缓存 60 秒。目录变更有 git 历史，可审计。
- **服务端模式（后做）**：`POST /v1/admin/catalog` 直接写数据库。适合需要按账号过滤的
  场景（beta 白名单、灰度）。

### 11.3 应用发布 `app-release.yml`

触发：`push: tags: ['v*']`，矩阵 macOS + Windows。

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - os: macos-14 # arm64
        target: aarch64-apple-darwin
      - os: macos-13 # x64
        target: x86_64-apple-darwin
      - os: windows-latest
        target: x86_64-pc-windows-msvc
```

关键步骤：

1. `pnpm install --frozen-lockfile && pnpm check`，发布前再跑一次完整门禁。
2. `tauri build --target <target>`，**只注入 updater 签名密钥**：
   - `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（minisign，必须）；
   - macOS 设 `signingIdentity: "-"`（ad-hoc 签名），不设 `APPLE_*`；
   - Windows 不设证书相关环境变量。
3. `tauri build` 产出各平台 `latest.json` 片段，用 `scripts/merge-latest.mjs` 合并成一份。
4. 上传到**私有** Release，同时 `POST /v1/admin/app-release` 通知控制面刷新缓存。
5. 产物留存 90 天，Release 资产永久保留。

**应用更新也必须走控制面**。原因：私有仓库的 `latest.json` 不能匿名读，而把 GitHub
token 打进应用等于公开发布 token。所以 `tauri.conf.json` 的
`plugins.updater.endpoints` 指向 `https://<control-plane>/v1/app/latest.json`，
由控制面代理并附带 installation token。`latest.json` 本身不是秘密，端点不加鉴权。

### 11.4 控制面发布 `control-plane.yml`

触发：`push: branches: [main], paths: ['services/control-plane/**']`。

```text
test（node --test + 契约测试）
  → deploy（Fly.io / Render / 任意单机，一台足够）
  → 迁移（幂等 SQL，无 ORM）
  → smoke：GET /v1/health、GET /v1/catalog（用测试账号）、GET /v1/packages 一次真下载
```

smoke 里必须包含一次**真实下载**，否则「服务活着但拿不到包」这种故障永远发现不了。

### 11.5 版本与通道

- 版本唯一来源：`packages/*/package.json`、`plugins/*/package.json`、`Cargo.toml`、
  `tauri.conf.json`、`services/control-plane/package.json`，由 `scripts/version.mjs`
  统一写入，CI 校验全部一致。
- 通道：`stable` / `beta`。**由服务端过滤**，不是客户端自觉：
  - `GET /v1/catalog?channel=beta` 要求账号带 `betaTester` 标记，否则返回 stable 目录；
  - Release 侧用两个 tag 前缀：`plugin-<id>@<ver>`（stable）、`plugin-beta-<id>@<ver>`（beta）；
  - 应用设置里可切换通道，切换后立即清空目录缓存重新拉取。
- beta 准入目前手工：数据库里给账号打 `betaTester`。第 4 期再考虑邀请码，别提前做。
- 回滚：应用侧重发上一版的 `latest.json`；插件侧把目录 `latest` 指回旧版本，
  已升级的客户端下次检查时提示「可回退」，不静默降级。

### 11.6 密钥管理

| 密钥                           | 用途                  | 存放                                      |
| ------------------------------ | --------------------- | ----------------------------------------- |
| 插件签名私钥（Ed25519）        | 包签名                | GitHub Environment secret，发布需人工审批 |
| 目录签名私钥（Ed25519）        | 目录签名              | 同上，与包签名分开                        |
| 租约签名私钥（Ed25519）        | 租约签名              | 控制面环境变量                            |
| 插件数据 master（32B）         | 派生 payload 密钥     | 控制面环境变量；不进 CI                   |
| GitHub App 私钥（RSA）         | 换 installation token | 控制面环境变量，只读单仓库                |
| 控制面 admin key               | CI 调管理端点         | GitHub Environment secret                 |
| Tauri updater 私钥（minisign） | 应用更新清单签名      | GitHub Environment secret                 |

公钥内置在应用里：目录/包验签公钥、租约验签公钥、updater 公钥（`tauri.conf.json`）。
私钥轮换：目录带 `keyId`，应用内置当前与上一把公钥，支持平滑换钥。
`master` 轮换走版本号自然过渡，不重加密历史版本。

## 12. 无证书分发的真实代价

没有 Apple Developer ID、没有 Windows 代码签名证书，会得到这些具体现象。写在这里，
是因为它们会被用户当成 bug 报上来。

| 平台    | 现象                                               | 缓解                                                                                                   |
| ------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| macOS   | 首次打开提示「无法验证开发者」，只有「移到废纸篓」 | 安装说明里给 `xattr -dr com.apple.quarantine /Applications/Nexus.app`；或 DMG 内附一个 `.command` 脚本 |
| macOS   | 无法公证，`spctl --assess` 永远失败                | 接受。除购买 Developer ID（99 美元/年）无解，没有技术绕法                                              |
| Windows | SmartScreen「Windows 已保护你的电脑」              | 说明「更多信息 → 仍要运行」；EV 证书或 Azure Trusted Signing 才能消除                                  |
| Windows | Defender 可能对未签名安装器启发式告警              | 提交误报申诉；仍可能复发                                                                               |

能做的三件事：

1. **ad-hoc 签名 macOS 产物**（`signingIdentity: "-"`）。这不让 Gatekeeper 满意，但保证
   二进制在 arm64 上能执行（arm64 强制要求至少 ad-hoc 签名，不签直接崩）。
2. **在下载页和 README 里写清步骤**，不要假装没有拦截。用户点三次就能装上，
   但必须知道点哪三次。
3. **应用内自动更新不受影响**：minisign 校验与系统代码签名无关。已装好的用户能一直
   收到更新，只有首次安装需要手动绕过。

如果以后要正经分发，只有两条路：买 Developer ID + Windows 证书，或走 Mac App Store /
Microsoft Store 让别人替你签。两者都要改打包流程，但本文的其余部分不用动。

## 13. 与现有代码的差距

| 能力           | 现状                                    | 需要新增                                     |
| -------------- | --------------------------------------- | -------------------------------------------- |
| 插件安装来源   | 只接受本地**目录**                      | `.nexuspkg` 安装 + 文件选择入口              |
| 完整性         | 安装时比对 manifest digest              | 包级 sha256 + Ed25519 验签                   |
| 加密           | 无                                      | `payload.bin` + `bootstrap` 运行时解密       |
| 目录与检查更新 | 无                                      | `plugin_update_check` 命令 + 目录缓存 + ETag |
| 升级与回滚     | 只能卸载重装                            | 保留上一版目录、失败回滚、`updating` 状态    |
| 防降级         | 无                                      | 登记表记录最高版本                           |
| 权限升级确认   | `enable()` 已收窄授权                   | 升级路径复用该检查，检测超集                 |
| 授权检查       | 无                                      | `EntitlementPort` + `PAYMENT_REQUIRED`       |
| 协议           | `hello`/`handshake`/`ready`/`request`   | 新增 `bootstrap` 分块消息 + 行上限临时放宽   |
| 应用更新       | `tauri.conf.json` 无 updater 配置       | `tauri-plugin-updater` + 控制面代理端点      |
| 打包依赖       | 安装时复制 `node_modules`（约 1900 项） | esbuild bundle 后无需依赖树                  |
| 控制面         | 无                                      | 新目录 `services/control-plane`，6 个端点    |
| CI             | 只有质量门禁                            | 三个发布工作流                               |

## 14. 分期

**第 1 期 · 打包与签名（无服务端，1 周量级）**
esbuild bundle、`.nexuspkg` 打包脚本、Ed25519 签名与验签、宿主支持从包安装、
CI 产出未签名包作为 PR 校验产物。

验收：本地打包 → 安装 → 启用 → 调用通过；改一个字节后安装被拒；
安装后的包内不含 `node_modules`，条目数从约 1900 降到 < 10。

**第 2 期 · 控制面骨架与私有仓库取包（1–1.5 周）**
设备码登录、`/v1/catalog`、`/v1/packages` 代理、GitHub App 换 token、
目录签名与缓存、`plugin_update_check`、下载校验、原子替换与回滚、`updating` 状态。

验收：干净机器登录 → 拉到目录 → 下载 → 安装 → 升级；控制面停机时新装失败但
已装插件仍可用，错误信息准确。

**第 3 期 · L3 密钥（1 周）**
AES-GCM 封装、`/v1/leases`、租约签名与宽限期、`bootstrap` 分块解密、Windows 实测、
`unauthorized` 状态。

验收：包内无明文源码；无账号时即使拿到包也无法启动；断网 7 天内可用、第 8 天拒绝并
说明原因；解密后启动耗时实测记录（目标 < 1.5 s，超了改方案）。

**第 4 期 · 收费预留与 beta（3–5 天）**
`pricing` 字段、`EntitlementPort`、`PAYMENT_REQUIRED`、`/v1/checkout` 与 webhook 的
501 桩、`betaTester` 过滤、通道切换界面。

验收：把某个插件标成 `paid` 后，安装正常、启用被拦、界面显示「购买通道未开放」而不是
「无权限」；beta 账号能看到 beta 版本，非 beta 账号看不到。

**第 5 期 · 应用发布链（1 周，不含买证书）**
updater 配置与代理端点、ad-hoc 签名、三平台矩阵、`latest.json` 合并、版本统一脚本、
安装说明文档。

验收：干净机器安装（记录 Gatekeeper / SmartScreen 实际拦截文案）→ 收到更新 →
升级成功；两个平台分别记录。

## 15. 还需要你定的四件事

1. **控制面放哪**：一台 5 美元/月的 VPS 就够，也可以 Fly.io / Render 免费档起步。
   要国内访问稳定就得国内云 + 备案，这会显著拉长第 2 期。
2. **beta 怎么放人**：手工打标记（先这样），还是做邀请码。
3. **宽限期定 7 天是否合适**：短了误伤出差用户，长了削弱 L3 的意义。
4. **收费粒度**：按插件卖（`sku` = 插件），还是按套餐卖（一份钱解锁多个插件）。
   这决定 `entitlements` 表结构，改起来不便宜。

## 16. 风险与限制

- L3 不阻止运行期提取。有账号、愿意 hook 进程的人仍能拿到明文。对客户的说法只能是
  「需要账号才能运行」，不能是「无法破解」。
- 控制面是单点。它挂了，新装与升级停摆；已装插件在租约有效期内不受影响。这是选择
  私有仓库 + L3 的必然代价，不是可以优化掉的。
- `data:` URL 导入大模块的启动开销未实测，超过 1.5 s 需要改方案（见 6.3）。
- 没有证书时首次安装必然被系统拦截，转化率会掉。这是钱的问题，不是工程问题。
- 应用与插件版本会分叉：插件必须靠 `minCoreVersion` 自我约束，否则会在旧核心上装不上。
- 签名私钥泄露等于攻击者可发布任意插件。私钥必须走审批环境，并准备吊销流程
  （换钥 + 应用内置新公钥 + 旧钥签名失效 + 强制升级）。
- 私有仓库 + 代理下载意味着所有下载流量过控制面。量级上来要加 CDN，接口不变但成本模型变。
- 目录走「仓库文件模式」时，发布流程依赖一次 git 提交，存在短暂不一致窗口
  （包已上传、目录未更新）。客户端遇到 404 应静默跳过而不是报错。
