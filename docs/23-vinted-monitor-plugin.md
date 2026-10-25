# Vinted 商品监控插件 `studio.vinted-monitor`

插件位于 `plugins/vinted-monitor`，能力为 `monitor.collector`，通过逐行 JSON RPC
提供监控、运行历史、全局商品归档、插件独立代理及图片分块读取。
接入规则见[插件对接规范](14-plugin-integration-guide.md)，宿主规则见
[插件宿主](17-plugin-host.md)，应用网络边界见[应用代理](26-application-network-proxy.md)。

`1.1.1` 修复匿名会话与衣柜请求地址，保留 `1.1.0` 的存储和 RPC 契约。
独立构建与商店上传步骤见[插件商店](25-plugin-market.md)。

## 与参考实现的对应

行为参考 `nexus-cart/packages/platform/src/pages/vinted-monitors`、`vinted-items`
和 `apps/api/backend/app/vinted` 的 schema、API、collector、store、availability、
seller_monitors、adapter、wardrobe。保留业务语义，使用本地插件进程和私有 JSON，
不引入 FastAPI、关系库、Redis、任务服务器或参考项目的密钥加密机制。

| 参考行为                           | 本插件行为                                                        |
| ---------------------------------- | ----------------------------------------------------------------- |
| `(domain, external_id)` 全局身份   | `id = domain:externalId`，domain 去除 `www.`                      |
| 首次列表快照，后续只刷新有效收藏数 | 首次标题、价格、图片集合、detail、viewCount 和 collectedAt 不覆盖 |
| 商品与多个监控关联                 | monitorIds 与每条关联的 firstSeenAt / lastSeenAt                  |
| 卖家占位、获取失败计数、成功缓存   | 全部页面先持久化，再获取尚无成功资料的卖家                        |
| 星标、人工状态、软删除             | 明文私有记录与永久删除标记                                        |
| 卖家监控去重、继承来源             | 同一站点与卖家只创建一次，继承 proxyId 和 intervalMinutes         |
| 条件过滤、排序与分页               | 插件服务端执行；RPC 页码从 0 开始                                 |
| 调度锁、重启恢复                   | 单进程全局采集锁，遗留 running 标记 interrupted                   |

缺失判定比参考实现更保守：必须是同一监控、相同 URL 和分页范围的两次完整成功
扫描，任何截断、列表错误、无效条目、卖家失败或存储错误均不能产生缺失判断。

## 监控与运行

监控字段为 `id,name,searchUrl,kind,host,userId,proxyId,intervalMinutes,maxPages,perPage,
enabled,createdAt,updatedAt,lastRunAt,lastStatus`。`proxyId` 始终为字符串或 null；
创建时省略默认 null，表示继承插件默认代理。更新时省略 `proxyId` 保留原引用，
兼容不发送该字段的旧版应用；只有显式传入 `proxyId: null` 才切换为继承。
更新后仍校验实际保留或选中的代理引用，不因省略字段绕过代理有效性检查。

- 支持 `/catalog` 搜索和 `/member/<数字>` 衣柜页；URL 归一化为 HTTPS，
  会员昵称后缀移除，`www.` 去除，不接受 URL 账号口令。
- 搜索白名单为 `search_text,catalog[],brand_ids[],color_ids[],size_ids[],status_ids[],
material_ids[],video_game_platform_ids[],price_from,price_to,currency`。
  `order` 固定为 `newest_first`；页码、搜索会话和筛选面板参数按 URL 模块白名单忽略，
  未知业务筛选拒绝，防止静默扩大采集范围。
- 搜索必须有 search_text、catalog[] 或 brand_ids[]；间隔 1–1440 分钟、
  最多 1–20 页、每页 1–96 件，最多 40 个监控。
- `run` 先持久化 running 再立即返回，页面轮询运行记录。已停用监控不能运行。
  手动运行与调度共用同步准入锁，同一时刻仅运行一个监控。
- 定时每 60 秒检查到期监控，优先从未运行或最早运行的监控；每次 tick 最多启动
  一个，采集中不叠加；进程关闭期间不采集、不补跑。
- 监控编辑不会改变正在运行的 URL、页数或代理快照。
- 删除监控保留归档商品、运行记录、卖家资料及商品删除标记，仅移除当前关联。
  legacy `monitorId` 保留首次来源；`monitorIds` 表示当前关联集合。

运行记录包含原字段，以及 `userFailed`。状态为 running、success、partial、failed、
interrupted。达到分页上限且仍有下一页为 partial + truncated；后页失败保留此前数据；
无有效页面为 failed。卖家失败计入 userFailed，不能把商品已保存描述为整轮成功。
错误只使用安全短文案，不向运行记录、卖家 error 或日志写代理口令、Cookie 或原始
网络异常。结束记录写入失败会尝试记录失败并释放运行锁；持续写入失败保留原记录，
重启时识别为 interrupted，不报告保存成功。

历史保留最近 200 条，额外保留每个监控/扫描范围最近一次可比较成功基线。
商品不再使用旧的 4000 条自动淘汰机制，避免静默删除归档或删除标记。

## 商品与卖家

`items.get`、`items.star`、`items.availability` 返回完整 `ItemRecord`（前端 Item），
使用以下 camelCase 字段：

```text
id, externalId, domain, monitorId, monitorIds,
title, price, currency, brand, size, condition, url, imageUrl, seller,
userId, sellerProfile, images, detail, favouriteCount, viewCount, starred,
availabilityStatus, missingSince, missingMonitorId, statusCheckedAt, statusNote,
collectedAt, listedAt, firstSeenAt, lastSeenAt
```

`items.list` 仅返回 `ItemSummary`：省略完整记录的 `images` 和 `detail`，
sellerProfile 为省略 `detail` 的 `SellerSummary` 或 null；其余表格字段保持一致。
这样一页 100 条不会重复携带商品与卖家的原始快照。图库和详情先调用 `items.get`
读取完整归档；摘要转换不会裁剪或改写已保存的数据。

price 保留字符串，seller 保留旧版显示名称；sellerProfile 为独立卖家对象或 null。
images 包含首次快照的 photo/photos 图片，detail 保留原始首次列表对象，不额外请求
每件商品详情。合法收藏数包括 0 与下降值；缺失、负值、非整数或超出 JS 安全整数的
数值不覆盖已有收藏数。viewCount 保留首次快照。跨站同 externalId 是不同商品。

同一商品重复采集更新 lastSeenAt 与对应监控关联时间，不改变首次快照。星标和人工
状态属于全局商品，所有监控看到同一状态。删除商品保留带 deletedAt 的记录；
下一轮和已发出的旧请求都只能跳过该商品，不能复活或重新关联。

availabilityStatus 为 unknown、pending、available、sold、ignored。人工复核接受后四种，
写 statusCheckedAt 和最多 500 字符的 note（trim，空串变 null）；手动 pending 补
missingSince。完整扫描仅把缺失商品排入 pending，写缺失监控与时间，清空旧复核备注，
绝不推断 sold。其他关联在本轮之后观测到商品、当前扫描期间已有人工复核，以及已 sold、
ignored 或 pending 的商品均不会被自动改成 pending。重新发现 pending 商品时改为
available 并清除缺失来源；人工 sold/ignored 不被采集覆盖。

Seller 字段：

```text
id, externalId, domain, login, name, profileUrl, avatarUrl, country, city,
feedbackReputation, feedbackCount, followersCount, itemCount,
verification: Record<string, {valid, available, verifiedAt}>,
lastLogedOnTs, updatedOn, collectedAt, checkedAt, error, detail
```

卖家按站点与 externalId 共享。每轮每个卖家仅安排一次资料补全，
会话失效时允许下述一次刷新重试；
`GET https://www.<host>/api/v2/users/<id>` 的返回身份必须匹配。
失败保留占位、checkedAt、安全 error，下一次再出现会重试；成功资料按参考实现持续
缓存，不设置虚构刷新周期，不自动重抓已经成功的资料。profile 时间兼容秒、毫秒与
ISO 日期。整轮卖家获取预算为 120 秒，每个 HTTP 请求最多 20 秒。

一键监控卖家在私有存储事务内去重，优先复用已启用的相同衣柜 URL；新建时从有效
来源关联中优先选已启用、最近观测的监控，继承其代理引用与间隔，使用 maxPages=20、
perPage=96、enabled=true。无卖家 ID 或无有效来源时拒绝创建。

## 插件代理

代理独立保存在同一私有 JSON。scheme 为 http、https、socks5、socks5h，
host 只能是域名/IP，port 为 1–65535，支持用户名与密码；IPv6 主机可带方括号输入。
密码明文保存，不接入 keychain、不加密，也不宣称安全保管。
省略 password 保留旧值，明确 `password: ""` 清除。

选择顺序为监控显式 proxyId → 插件 defaultProxyId → 宿主应用网络代理。
只有前两者均为 null 才继承应用网络。选中代理缺失、停用、格式无效、认证或连接失败
均报错，不回退到默认代理、应用代理或直连。默认/显式引用中的代理不能被删除，
需先解除引用；停用允许保存，后续运行会明确失败。停用监控可保留仍存在的停用代理，
但不存在的引用仍拒绝；启用监控或实际运行时必须是有效且已启用的代理。

`undici@7.16.0` 的 ProxyAgent 处理 HTTP(S) CONNECT/Basic；`socks@2.8.7` 处理
SOCKS5 用户名密码。socks5 在本机解析目标域名，socks5h 把域名交给代理解析。
HTTP(S) 代理域名仍需本机解析；目标 HTTPS 保留证书与主机名校验，HTTPS 代理本身也
校验证书。每个操作独立 dispatcher，不改全局代理，不受 NO_PROXY 绕过，不关闭 TLS。
一次采集的列表、后续页与卖家请求持有同一代理配置/dispatcher；编辑密码、默认代理或
停用配置只影响后续操作。

## 匿名采集会话

归档身份与已保存的监控 URL 继续使用去除 `www.` 的站点，保持旧商品 ID、
卖家缓存与监控关联不变。实际 HTTP 请求使用 `www.<host>` 首页、衣柜和卖家接口；
目录仍使用 `api.<host>`。不能把用于去重的站点字符串直接作为衣柜请求地址：
2026-10-25 实测 `vinted.com/api/v2/wardrobe/...` 返回 302，
此前 `redirect: error` 将这个跳转变成了笼统网络错误。
插件 manifest 的网络域名同步声明裸域、`www.` 与 `api.`，不依赖隐式子域权限。

参考 `nexus-cart` 的 `BoundSession` / `HttpSession`：

- 每轮先通过该轮所选代理 `HEAD https://www.<host>/` 建立匿名会话，再读取 JSON。
- 使用开源 `tough-cookie@6.0.2` 在内存处理 Cookie 更新、过期、域名和路径；
  同轮分页与卖家请求复用会话，下一轮重新建立。会话不读取浏览器 Profile、
  不复用登录账号、不写入业务存储，结束时清空。
- 首页匿名会话仅允许传给本国 `www.<host>` 与 `api.<host>`；
  目录接口沿用参考实现向同站点兄弟域传递首页 Cookie 的规则。
  其他国家、其他代理和其他轮次隔离，拒绝 Cookie 跳转到任意第三方。
- 补齐站点对应的 `Locale`、`Accept-Language`、`Platform: web`、
  `X-Next-App: marketplace-web`、`X-Money-Object: true`、`Origin` 和 `Referer`；
  衣柜带 `order=newest_first`。
- API 返回 401/403 时，清空并重新建立一次匿名会话后重试一次。429、跳转、
  网络错误和初始化失败不循环重试，也不切换代理或直连。
- 单次数据操作的初始化、刷新、重试与响应体共用 20 秒截止时间，
  不能因为增加会话步骤而无限延长等待。

运行错误保留 HTTP 状态与失败阶段（初始化会话、获取商品、获取卖家资料），
区分重定向、站点拒绝、限流、代理认证、代理连接、DNS、TLS 和超时。
不保存原始异常、响应体、跳转地址、Cookie 或代理口令。

## RPC

所有方法使用 `monitor.collector`。分页统一返回
`{items,total,page,pageSize,totalPages}`，page 从 0 开始，pageSize 为 1–100，
total 是过滤后总数，空集 total=0、totalPages=0，超出范围返回空页但保留总数。

| 方法                         | 请求与结果                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- |
| `vinted.proxies.list`        | `{}` → `{items: ProxyView[],defaultProxyId,storageDurable}`                 |
| `vinted.proxies.save`        | `{id?,name,scheme,host,port,username,password?,enabled}` → `{item,created}` |
| `vinted.proxies.remove`      | `{proxyId}` → `{removed}`                                                   |
| `vinted.proxies.default`     | `{proxyId: string \| null}` → `{defaultProxyId}`                            |
| `vinted.monitors.list`       | `{page?,pageSize?}`，带 itemCounts 与 storageDurable；`{}` 返回完整选项集合 |
| `vinted.monitors.save`       | 既有监控字段 + `id?,proxyId?` → `{item,created}`                            |
| `vinted.monitors.remove`     | `{monitorId}` → `{removed}`                                                 |
| `vinted.monitors.run`        | `{monitorId}` → `{run}`，后台继续采集                                       |
| `vinted.runs.list`           | `{monitorId?,page?,pageSize?,limit?}`；无分页参数兼容旧 limit（默认 20）    |
| `vinted.runs.get`            | `{runId}` → `{item}`                                                        |
| `vinted.items.list`          | 见下列过滤条件，返回 ItemSummary 数组与分页                                 |
| `vinted.items.get`           | `{itemId}` → `{item}`                                                       |
| `vinted.items.star`          | `{itemId,starred}` → `{item}`                                               |
| `vinted.items.availability`  | `{itemId,status,note}` → `{item}`                                           |
| `vinted.items.remove`        | `{itemId}` → `{removed}`，重复删除返回 false                                |
| `vinted.items.monitorSeller` | `{itemId}` → `{monitor,created}`                                            |
| `vinted.url.inspect`         | `{url}` → `{kind,host,userId,url}`，不写库                                  |

ProxyView 只返回 `id,name,scheme,host,port,username,hasPassword,enabled`，不返回 password。
商品列表请求必填 page/pageSize，可选 monitorId、keyword、externalId、availabilityStatus、
starred、order、favouriteCountOp、favouriteCount、favouriteCountStart、favouriteCountEnd。
keyword 匹配标题、品牌、旧版卖家显示名和 externalId；externalId 为最多 32 位数字精确匹配。
order 为 collected_desc、favourite_asc、favourite_desc；收藏数排序始终 null 最后，
再按 collectedAt、id 倒序保证稳定。

收藏数运算符为 eq、ne、gt、ge、lt、le、between、isNull、notNull。普通比较不匹配 null；
没有比较值时不施加该比较；between 可仅给单侧界限，两侧均省略则不限制；
倒置范围拒绝。所有过滤先执行，再分页，starred=false 不等价于省略。

## 图片分块传输

参考 shared-supply 的服务端分块读取机制，页面和 AI 参考图均由监控插件获取字节：

| 方法                 | 契约                                                     |
| -------------------- | -------------------------------------------------------- |
| `vinted.image.open`  | `{itemId,url}` → `{id: uuid,mime,size,chunkSize:262144}` |
| `vinted.image.read`  | `{id,offset}` → `{offset,data:base64}`                   |
| `vinted.image.close` | `{id}` → `{closed:true}`，可重复关闭                     |

初始 URL 必须属于该归档商品的图片集合/detail 或其关联卖家的头像/detail，
且只能是 HTTPS 的 `images.vinted.net` 或 `images0.vinted.net` 至 `images99.vinted.net`。
拒绝账号口令、非默认端口、fragment、非 CDN 和其他商品的未归档 URL。
最多三次重定向，每跳重新校验 CDN，不能跳到本机、任意域名或 HTTP。
不携带页面 Cookie、Referer 或账号凭据。

每次下载先按商品首次来源监控的当前 proxyId 选择代理并冻结，整次下载/重定向保持
同一 transport。来源监控删除时保留其最后的 proxyId 引用；被删或停用的显式代理仍然
阻断，不能因此改用应用网络。null 来源引用沿用插件默认/应用网络继承规则。

请求及响应流整体最多 20 秒（宿主截止时间更短时取更短值）；按实际字节限制 8 MiB。
只支持 JPEG、PNG、WebP、GIF，校验内容签名与 MIME，不透传 HTML/SVG。
每块 256 KiB，base64 的 RPC 行低于 1 MiB；偏移必须合法且按块对齐。
传输在内存保留 60 秒，最多 4 个并行下载、8 个传输、32 MiB 已下载缓存，关闭后释放。
前端转给 AI 的是图片字节，不是代理配置或任何凭据。
图库与 AI 转运共用页面端的 4 并发队列。取消排队任务会立即移除；
已经发出的原生 RPC 等返回并关闭传输后才释放名额，防止切页时旧图库下载占满插件额度、
导致新生图参考图全部失败。

## 存储与 schema1 迁移

`vinted-monitor.json` 位于宿主提供的插件私有目录，文件权限 0600，使用临时文件 +
rename 和串行写队列。写失败不替换已提交的内存状态；并发首次读取共享加载过程。
未提供目录时才使用内存模式，并报告 storageDurable=false。

schemaVersion=2 包含 monitors、runs、items、sellers、proxies、defaultProxyId。
旧 schema1 在读取时迁移到内存，并在下一次成功写入时保存为 schema2，不删除原始资料：

- 按规范站点 + 原商品 ID 合并旧的每监控副本。
- 最早 firstSeenAt 的记录决定首次快照，同时间以 monitorId 字典序确定。
- 关联合并，保留各自首/末观测；全局 lastSeenAt 取最新，收藏数取最新有效值。
- 星标使用任一副本已标星，已有删除标记不移除。
- 未知字段深合并，冲突由最早记录优先；完整旧副本另存 legacyRecords，保留冲突值。
- 原有根、监控、运行和条目未知字段保留，新增 proxyId=null、userFailed=0 等默认值。
- 无效 JSON、无法识别来源或不支持的 schema 拒绝读写，保留原文件供备份修复。

## 上游与验证边界

目录请求 `https://api.<host>/svc-catalogue/items`，衣柜请求
`https://www.<host>/api/v2/wardrobe/<id>/items`，卖家请求
`https://www.<host>/api/v2/users/<id>`，其中 `<host>` 不含 `www.`。
列表/卖家响应最多 4 MiB，每次操作最多 20 秒，页间等待 400 ms；
重定向不自动跟随，明确记录状态。
分页块矛盾、页码重复、衣柜卖家不符或非零上游 code 均不能宣称完整扫描。
公共接口可能限流、拒绝或改变格式；未实现账号登录、验证码、反爬绕过或出售判定。

本次本地验证使用 Node 24.18.0 的直接工具入口：

```bash
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec vitest run plugins/vinted-monitor
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec eslint plugins/vinted-monitor --max-warnings 0
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec tsc --noEmit -p plugins/vinted-monitor/tsconfig.json
```

自动化测试使用假上游响应、临时私有文件、本机 HTTP/HTTPS/SOCKS 代理和专用测试证书，
不自动访问外部站点。会话回归覆盖规范地址、Cookie 轮换与隔离、401/403 有界重试、
429 不重试、跳转阻断、共用截止时间和安全错误分类。

2026-10-25 按用户明确指定，另通过实际插件源码对公开会员 `3192040080` 执行实网采集。
本机 `http://127.0.0.1:7890` 代理下结果为 success：1 页、12 件商品全部入库、
1 位卖家资料成功、failed=0、userFailed=0、truncated=false。
使用临时独立私有目录，重新打开文件仍有 12 件商品，未改动用户现有监控或商品。
同机直连初始化返回 HTTP 403，不能把代理下成功推广为任意出口都能采集。
本地未执行 build、Rust 编译/测试/Clippy、安装包、签名或 Windows 检查；
`1.1.1` 后续远程构建、正式插件包实网复验及商店发布证据见
[质量记录](09-quality-and-testing.md)。
