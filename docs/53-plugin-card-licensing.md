# 第一方插件卡密授权

## 0.2.7 市场授权协议

Rust 宿主统一执行卡密兑换、签名租约验证、可用性判定和后台续租。
签名市场目录为受限插件提供授权发行方、验签公钥和 HTTPS 服务地址，
详见[插件商店目录](25-plugin-market.md)。安装后按本地记录选择发行方。
设备密钥、租约、重试退避按市场及发行方身份和插件 ID 隔离。
已有官方目录和无来源安装沿用原 Worker 地址、原公钥和已有租约。
这条兼容路径仅适用于既有第一方插件的旧契约。

授权协议版本为 1。宿主调用以下两个端点。

| 端点                      | 请求 JSON                             |
| ------------------------- | ------------------------------------- |
| `POST /v1/cards/redeem`   | `card`、`pluginId`、`devicePublicKey` |
| `POST /v1/leases/refresh` | `licenseId`、`devicePublicKey`        |

请求携带 `x-device-time`、`x-device-nonce`、`x-device-signature`。
Ed25519 签名消息为 `v1\nPOST\n{path}\n{timestamp}\n{nonce}\n{sha256(body)}`。
成功返回 `{ payload, signature }`。签名为标准 Base64，签发端按以下字段顺序
紧凑序列化 JSON 并签名。时间戳统一为 UTC Unix 秒。

```text
v, licenseId, pluginId, devicePublicKey, issuedAt, expiresAt,
offlineUntil, refreshAfter, revision, keyId, issuerId
```

新市场的 `issuerId` 必须与目录授权配置一致。使用 `apps/license-worker` 部署时，
为该 Worker 配置同值的 `LEASE_ISSUER_ID` 和 `LEASE_KEY_ID`。
主程序核对插件、设备、发行方、签名、租约版本和时间后决定可用性。
续租 HTTP 403 清除本地租约。网络失败或无效响应触发退避，
宿主在有效的离线窗口内继续使用旧租约。启动和 RPC 只判断本地租约，
已安装插件由宿主监督循环在后台续租。

`apps/license-worker` 已部署 Worker 和 D1，提供管理员发卡、单设备兑换、
设备签名刷新、撤销与签名租约。Desktop 宿主对 11 个第一方插件独立执行授权门禁，
覆盖安装、启动、重启、调用与 Agent gateway；插件中心提供逐插件激活入口。
本轮代码尚未做桌面发行安装验证，不能把现有已发布应用描述为已支持付费插件。
卡网回调、续费与换机尚未接入；现有静态 `catalog.json` 和 R2 包沿用内置盐值加密，
不能用作付费插件的可靠防复制措施。

当前 Worker 的确切接口、D1 初始化与本地运行步骤见
`apps/license-worker/README.md`。已实现管理员发卡/撤销、首次兑换、
同设备卡密恢复、设备签名刷新和签名租约；卡网回调、订单核验、续费、
换机和独立包密钥仍为后续设计。

所有第一方插件均有月、季、年套餐（15 / 30 / 100 元），SKU slug 如下：

| 插件 ID                    | SKU slug            |
| -------------------------- | ------------------- |
| `studio.address-generator` | `address-generator` |
| `studio.ai-image`          | `ai-image`          |
| `studio.email`             | `email`             |
| `studio.products`          | `products`          |
| `studio.proxy-pool`        | `proxy-pool`        |
| `studio.sales-agent`       | `sales-agent`       |
| `studio.shared-supply`     | `shared-supply`     |
| `studio.sim8`              | `sim8`              |
| `studio.vinted-accounts`   | `vinted-accounts`   |
| `studio.vinted-monitor`    | `vinted-monitor`    |
| `studio.window-sync`       | `window-sync`       |

套餐 SKU 由 `<slug>-month`、`<slug>-quarter`、`<slug>-year` 组成。
操作员发卡步骤与安全注意事项存放在仓库外的
`~/.config/raccoon/license-worker/ISSUE-CARDS.md`。

## 产品与售卡

按插件 ID 出售卡密，例如 `studio.sales-agent` 的月卡 15 元（1 个月）、
季卡 30 元（3 个月）、年卡 100 元（12 个月）。价格由销售页面管理，
未来卡网接入必须只相信经过验签的售卡回调及其服务端产品映射，
不能信任客户端传来的价格、期限或插件 ID。当前仅管理员确认付款后手动发卡。
用户在卡网支付后获得随机一次性卡密，在「插件中心 → 插件授权」输入并激活。
不同插件的卡密不可通用；增加可售插件时配置独立商品 SKU/套餐。

建议从**首次成功兑换**开始计算有效期，按 UTC 日历月递增（保留时间；月底取目标月末日），
到期时间由服务端计算。用户在同一许可证上续费则从 `max(now, expires_at)` 起叠加时长，
避免提前续费吃掉剩余天数。卡密不可重复兑换；退款、拒付或人工撤销立即吊销。
支持卡网导出的批量卡密离线导入时，应由管理员以服务端签名写入 Worker，
不能将「知道卡密字符串」直接当成可激活的证据。

## Worker、D1 与 R2

Cloudflare Worker 处理兑换和设备验证；D1 保存许可证、兑换事件与设备绑定；
R2 继续保存插件包。卡网服务端签名 Webhook 使用原始请求体、时间戳、事件 ID、
HMAC 密钥与常量时间比较；按事件 ID 幂等处理，拒绝超时/重放事件。
如所选卡网没有可信的签名回调，必须由后端用卡网的服务端 API 核验订单，
或在管理后台导入发卡清单；绝不凭公开回调或客户端订单截图授予权限。

推荐 D1 表及唯一约束：

| 表         | 必要字段与约束                                                                           |
| ---------- | ---------------------------------------------------------------------------------------- |
| `products` | `plugin_id`, `sku`, `duration_months`, `price_cny`, `enabled`; `(sku)` 唯一              |
| `cards`    | `card_hash` 唯一, `sku`, `status`, `order_id`, `redeemed_at`, `license_id`; 不存明文卡密 |
| `licenses` | `id`, `plugin_id`, `status`, `expires_at`, `max_devices`, `revision`                     |
| `devices`  | `(license_id, device_public_key)` 唯一, `activated_at`, `revoked_at`, `last_seen_at`     |
| `events`   | `event_id` 唯一, `order_id`, `type`, `created_at`; 用于回调幂等和审计                    |

批量预制卡密用高熵随机数（至少 128 bit），只向卡网导出一次；
Worker 存储 `HMAC(server_pepper, normalize(card))`，查询采用限速，
错误统一为「激活码不可用」，避免枚举。密钥和卡网 API 凭据放 Worker Secret，
绝不进入客户端、R2、Git 或日志。运营后台可撤销卡密、换绑设备、
处理争议订单，并记录操作者与原因。

## 设备码与兑换协议

首启生成随机 `installation_id` 与 Ed25519 设备密钥对，设备码取公钥的短摘要，
供用户查看/复制；不能把可编辑的设备码当成身份。设备私钥、安装 ID
按当前产品约定可存本地 SQLite 明文，需明确这只能防止普通复制，
复制完整应用数据的攻击者可能冒充设备。若未来提高保护等级，
需要迁移至系统硬件或凭据保护，并提供换机恢复，不要静默改变存储承诺。

当前 `POST /v1/cards/redeem` 接受卡密、插件 ID、设备公钥、请求 nonce、
时间戳及设备私钥签名；尚未接入安装 ID。Worker 用 D1 batch 和条件更新
兑换并绑定设备；同设备丢失响应后可用新的 nonce 和原卡密重新取租约，
原 nonce 的重放会被拒绝，其他设备不可兑换。`POST /v1/leases/refresh`
校验许可证仍有效且设备未吊销后返回签名租约。
`POST /v1/devices/deactivate` 和换机订单核验/人工处理入口仍待实现。
严禁以客户端的本地时间决定续费或过期。

Worker 用 Ed25519 私钥签发固定版本的租约，Desktop 内置轮换公钥并验证：
`license_id`、`plugin_id`、`device_public_key`、`status`、`issued_at`、
`expires_at`、`refresh_after`、`offline_until`、`revision`、`key_id`、
`signature`。序列化字段/签名域必须固定，禁止字段拼接歧义。
首次兑换必须联网；正常定时刷新（如 12 小时）和应用恢复时刷新。
默认建议离线宽限不超过 72 小时，且 `offline_until <= expires_at`。
吊销无法在设备离线时即时生效：如需即时停用，必须在线校验或将离线宽限设为 0。
时钟回拨不能延长租约；记录上次可信服务端时间并在异常时要求联网核验。

## 宿主强制门禁（付费插件）

宿主使用编译入应用的 11 个第一方插件 ID 清单判定收费范围，未知和第三方 ID
不因命名空间而被错误加锁。该固定清单不依赖可编辑 UI 或未签名 `catalog.json`；
新增第一方插件必须同步更新 Rust 清单、前端清单、Worker SKU 与回归测试。

- 未激活：可以浏览价格和说明；不允许安装包解密、进程启动、后台任务或 RPC 调用。
  已安装且失效的插件保留私有数据/配置和卸载入口，但显示「未激活」并停止进程。
- 有效租约：宿主在安装、启动/重启、调用入口、后台调度入口和升级后重新验证，
  统一使用 `plugin_id` 和设备公钥检查，不能由插件返回值决定是否已授权。
- 过期/撤销：阻止新任务并停止付费进程；有进行中的写操作先保留结果未知状态，
  不能在停止时伪造失败，也不能凭重新激活自动重试上架/发消息。
- 免费插件：仍按现行路径安装使用，不受卡密系统故障影响。

现有宿主 `install`、`install_from_package`、`install_from_market`、`ensure_started`、
`call`、Agent caller/generation 与 supervisor 均经过相同门禁；插件中心禁用未激活的
安装、更新、重装操作，保留授权和卸载入口。“全部更新”先刷新授权状态，跳过未授权项
并汇报数量。侧栏不能把「已安装但不可用」显示成可执行的插件。
宿主仍只是受信任的本地进程管理器，不是防篡改沙箱。

插件目录、授权状态和插件代理列表在后台读取本地状态。每个插件的激活与续租串行执行，
联网时释放 SQLite 访问锁，安装与启动也在取得进程管理锁前完成联网核验。
同一插件已有联网操作时，并发调用使用经签名校验且仍在离线期限内的本地租约。
续租遇到网络或服务暂时不可用时，从 30 秒开始逐次翻倍重试，最多间隔 5 分钟。
退避不延长离线期限，服务端明确拒绝续租时立即清除本地租约。

现有包由编入二进制的固定盐值推导密钥，**不能**作为付费保护。
付费包每插件每版本使用独立随机内容密钥，R2 只存密文；
Worker 授权后下发按设备封装的短期解密凭据，服务端包密钥不进入公开目录。
Ed25519 设备签名密钥不能用于加密；若要封装给设备，需额外生成 X25519
密钥对并绑定在签名租约中，或由 Worker 在经过设备签名挑战的 HTTPS 会话中
下发短期密钥。两种方式都不能防止已获授权的本机用户在运行时提取密钥。
设备解密/缓存过期时仍需满足租约门禁；本机进程可被调试，
因此即使改造密钥下发，也不能承诺插件源码绝对不可复制。

## 页面与上线边界

插件中心逐项显示激活状态与激活入口；未授权第一方插件不能安装、更新、重装或调用，卸载仍可用。
“全部更新”仅更新已授权的第一方插件及其他无须许可的插件，并报告被跳过的数量。
实际代码覆盖、部署与验证边界见[质量记录](09-quality-and-testing.md)。

尚未完成：卡网订单校验/签名回调及退款通知、续费与换机、付费包独立密钥，
商店 catalog 签名。后续验收需覆盖重复兑换、并发占名额、断网、
续费跨月、退款、过期、换机、离线旧清单与进程重启，
并验证未激活插件既不会启动也不会收到任何 RPC。
