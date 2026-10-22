# Vinted 商品监控插件 `studio.vinted-monitor`

本文说明仓库内 Vinted 商品监控插件的实际范围。插件规则见
[插件对接开发规范](14-plugin-integration-guide.md)，宿主协议见[插件宿主](17-plugin-host.md)。

## 当前事实

插件包位于 `plugins/vinted-monitor`，实现 `monitor.collector` 能力的 8 个方法、
私有 JSON 存储与逐行 JSON RPC 服务端。页面位于
`apps/desktop/src/features/vinted-monitor`，在主导航里叫「Vinted 监控」。

- 一个监控 = 一个 Vinted 页面 + 一个采集节奏：名称、URL、间隔（1–1440 分钟）、
  最多页数（1–20）、每页商品数（1–96）、是否启用。
- 只支持两种页面：`/catalog` 搜索页（保留筛选条件）与 `/member/<id>` 会员衣柜。
  其他页面没有对应的采集接口，保存时直接拒绝，不做“尽力而为”的猜测。
- 每次采集都是一条运行记录，主页是监控列表，点「记录」看历史，点「商品」看归档。
- 采集是**先返回、后台跑**：`vinted.monitors.run` 立刻回一条 `running` 记录，
  页面轮询记录状态。一次 20 页的采集会超过宿主 120 s 的调用截止时间，
  所以记录才是真相，调用不是。
- 商品按 `(monitorId, itemId)` 去重：第一次见到记 `firstSeenAt`，之后再见到只更新
  `lastSeenAt` 与价格等字段，`firstSeenAt` 不动。这就是“新品”的判定依据。
- 采集请求由本机直连 Vinted，没有代理通道。IP 被限流或拒绝时，运行记录会写明原因
  （`请求过于频繁` / `拒绝了本次采集`），不会假装成功。

## 包结构

```text
plugins/vinted-monitor/
├── package.json          # ESM、锁定依赖、dist 由构建生成
├── nexus.plugin.ts       # manifest 唯一来源，由 definePluginManifest 校验
├── src/
│   ├── index.ts          # 组装存储、能力与协议；进程入口与调度器
│   ├── capabilities/     # monitor.collector 方法表
│   ├── domain/           # URL 归一化、列表解析、zod 校验、错误码与类型
│   ├── rpc/              # 协议、服务端、脱敏日志（与其他插件同源，按包自包含）
│   ├── services/         # Vinted 公开接口客户端与逐页采集循环
│   └── store/            # 私有 JSON 文档（monitors / runs / items）
└── dist/                 # 构建产物：dist/src/index.js 与 dist/nexus.plugin.json
```

manifest 声明：`apiVersion: 1`、`id: studio.vinted-monitor`、`version: 1.0.0`、
能力 `monitor.collector`、`wantsBrowserAccess: false`、`storage: private`、密钥槽为空。
域名列表由 `src/domain/urls.ts` 的 `VINTED_DOMAINS` 生成，每个站点的 `api.` 子域一并声明
（目录搜索走 `api.<host>`，衣柜走 `<host>` 本身）。这份列表是声明式的，宿主当前不按域名拦截；
真正的约束在 `normalizeMonitorUrl`：不在列表里的主机直接拒绝。

## 与 nexus-cart `vinted-monitors` 的对应关系

参考实现是 FastAPI + Redis 锁 + 关系库的服务端方案。本次只搬功能，不搬服务端形态：

| 原模块                                        | 本插件 / 页面                                        | 变化                                        |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| `vinted/api.py` 的 `/monitors` REST 路由      | `src/capabilities/vinted-monitor.ts` 的方法表        | HTTP 路由改为 RPC 方法，鉴权由宿主负责      |
| `vinted/urls.py` 的 `normalize_monitor_url`   | `src/domain/urls.ts`                                 | 保留两种页面与筛选白名单；未知参数仍然拒绝  |
| `vinted/collector.py` 的页循环                | `src/services/collector.ts`                          | 同样的 1..max_pages、去重、`truncated` 标记 |
| `monitors` / `runs` / `items` 三张表          | 一个 JSON 文档的三个数组                             | 关系库换成本地文档；上限见下                |
| Redis 采集锁                                  | 进程内 `active` 集合                                 | 单进程单实例，不需要分布式锁                |
| APScheduler 定时任务                          | 进程内 60 s tick + `lastRunAt` 判定                  | 只在应用运行时生效，关掉应用就不再采集      |
| `proxy_id` 与代理校验                         | 无                                                   | 桌面端还没有插件间调用，直连本机网络        |
| `vinted-monitors` 页的 DataTable + 表单 Sheet | `vinted-monitor-page.tsx` + `monitor-form-sheet.tsx` | 列改为中文，操作改为行内按钮                |
| `runs-sheet.tsx` 的 5 s 轮询                  | `runs-sheet.tsx` 的 4 s 轮询                         | 只在存在 `running` 记录时轮询               |
| 采集到的商品列表（原项目另有 items 页）       | `items-sheet.tsx`                                    | 放在监控行的「商品」入口，按上架时间倒序    |

## 方法清单

| 方法                     | 作用                                             |
| ------------------------ | ------------------------------------------------ |
| `vinted.monitors.list`   | 列出监控，附带每个监控的已归档商品数             |
| `vinted.monitors.save`   | 新增或修改；省略 `id` 即新增，URL 在写入前归一化 |
| `vinted.monitors.remove` | 删除监控，同时删除它的运行记录与商品             |
| `vinted.monitors.run`    | 建 `running` 记录并立刻返回，采集在后台执行      |
| `vinted.runs.list`       | 按监控筛选的运行记录，默认最近 20 条             |
| `vinted.runs.get`        | 取单条运行记录（页面轮询用）                     |
| `vinted.items.list`      | 按监控、关键词分页取商品，按上架时间倒序         |
| `vinted.url.inspect`     | 只校验并归一化 URL，不落库（表单失焦时用）       |

上限：40 个监控、200 条运行记录、4000 件商品。超出时丢弃最旧的商品，
不静默截断字段。

## URL 归一化规则

- 只接受 `http`/`https`，写入时统一成 `https`；带账号口令的 URL 直接拒绝。
- 主机必须是 `VINTED_DOMAINS` 里的站点，`www.` 前缀会被去掉。
- `/member/<数字>(-昵称)` → `member` 类型，URL 归一化成
  `https://<host>/member/<数字>`，查询参数全部丢弃（衣柜接口不吃筛选）。
- `/catalog` → `catalog` 类型，只保留白名单参数：`search_text`、`catalog[]`、
  `brand_ids[]`、`color_ids[]`、`size_ids[]`、`status_ids[]`、`material_ids[]`、
  `video_game_platform_ids[]`、`price_from`、`price_to`、`currency`。
  出现其他参数时报错并指出是哪个参数，而不是悄悄丢掉。
- `order` 一律重写为 `newest_first`：监控的意义是看新品，按相关性排序没有意义。
- 搜索页至少要有一个 `search_text` / `catalog[]` / `brand_ids[]`，否则等于在采集整站。

## 上游接口

| 类型     | 请求                                                                                   |
| -------- | -------------------------------------------------------------------------------------- |
| 目录搜索 | `GET https://api.<host>/svc-catalogue/items?<筛选>&page=&per_page=&order=newest_first` |
| 会员衣柜 | `GET https://<host>/api/v2/wardrobe/<id>/items?page=&per_page=`                        |

- 请求带桌面浏览器 `User-Agent`，`accept: application/json`；不请求压缩，
  避免为了省几十 KB 引入解压依赖。
- 超时 20 s，响应体上限 4 MiB，超限按 `invalid-response` 处理。
- 状态码映射：429 → `rate-limit`，401/403 → `blocked`，404 → `upstream-refused`，
  5xx → `unavailable`，其他非 2xx → `upstream-network`。
- 分页判定优先用 `pagination.current_page` 与 `total_pages`；没有分页块时，
  “这一页是满的”就认为可能还有下一页。
- 页与页之间停 400 ms，避免连续请求被限流。

## 运行记录与状态

| 状态          | 含义                                              |
| ------------- | ------------------------------------------------- |
| `running`     | 正在采集；页面每 4 s 刷新一次                     |
| `success`     | 所有请求的页都成功                                |
| `partial`     | 前面的页成功、后面的页失败，已采集的数据保留      |
| `failed`      | 第一页就失败，什么都没采到                        |
| `interrupted` | 进程重启时发现遗留的 `running` 记录，标记为已中断 |

记录字段：`discovered`（本次发现）、`inserted`（新增）、`updated`（更新）、
`skipped`（重复或无法解析）、`failed`（失败页数）、`truncated`（是否达到页数上限）、
`pages`（实际请求页数）、`error`（可读原因）。

一次页失败会结束本次采集：Vinted 要么整段限流、要么正常返回，在第 6 页被拒之后
继续请求第 7 页只是浪费配额。

## 数据边界

- 全部数据在插件私有目录的 `vinted-monitor.json`（0600），宿主不读取。
- 文档用 `z.looseObject` 校验：已知字段必须合法，多出来的字段原样保留。
  `schemaVersion` 必须是 1；不是合法 JSON 或结构不符时拒绝读写并给出明确原因。
- 写入走“临时文件 + rename”，失败时保留上一版文档。
- 宿主未提供私有目录时退回内存存储，重启即丢，页面标注“仅本次运行”。

## 外部服务与数据发送

| 服务                    | 用途             | 发送内容                    | 费用         |
| ----------------------- | ---------------- | --------------------------- | ------------ |
| `api.<host>` / `<host>` | 读取公开商品列表 | 监控 URL 里的筛选条件、页码 | 无，公开接口 |

插件不发送本机路径、代理配置、收藏或窗口资料。采集到的商品标题、价格、图片地址
只存在插件私有目录，不会回传任何第三方。

## 已知限制

- 没有代理通道。Vinted 对机房 IP 较敏感，被拒时只能看到 `blocked` 原因，
  需要等网络环境变化或后续接入代理插件。
- 定时只在应用运行时生效；应用关闭期间不会补采，恢复后按 `lastRunAt` 判断是否到期。
- 采集是串行的：同一时刻只跑一个监控，避免对同一站点并发请求。
- 只解析 `items[].id/title/price/brand_title/size_title/status/url/photo/user/created_at_ts`，
  上游改字段名时对应字段会变成空字符串，不会导致整次采集失败。
- 商品不提供删除单条的操作；删除监控会连同商品一起清掉。
- 只在 macOS 上执行过类型检查、单测与宿主安装/启用/调用测试；Windows 未验证。

## 本地验证

```bash
pnpm --filter @nexus/plugin-vinted-monitor build
pnpm exec vitest run plugins/vinted-monitor apps/desktop/src/features/vinted-monitor
pnpm exec eslint plugins/vinted-monitor apps/desktop/src/features/vinted-monitor --max-warnings 0
```

插件侧 43 个用例：URL 归一化与接口拼装（11）、列表解析（6）、HTTP 状态映射与超时（12）、
能力层（14：保存与类型判定、跨页去重、二次采集只更新、后页失败算 partial、
首页失败算 failed、达到页数上限标 truncated、重复启动拒绝、删除级联、中断记录修复、
定时只跑到期的监控、禁用不调度、URL 试算、关键词筛选与分页）。

这些用例都替换了 `fetch` 或直接注入假客户端，不请求真实接口，因此不证明上游行为，
也不代表 Windows 上的表现。
