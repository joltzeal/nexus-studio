# 共享货源插件 `studio.shared-supply`

本文说明仓库内共享货源插件的实际范围。插件规则见[插件对接开发规范](14-plugin-integration-guide.md)，
产品侧插件边界见[插件系统](06-plugin-system.md)，页面交互见[页面交互](11-demo-pages.md)。

## 当前事实

插件包位于 `plugins/shared-supply`，实现 `supply.catalog` 能力的 9 个方法、
私有存储与逐行 JSON RPC 服务端。页面位于 `apps/desktop/src/features/supply`。

- 商户、商品、关键词搜索与以图搜索都由插件进程发起，页面不直接访问上游。
- 收藏保存在插件私有目录的 `shared-supply.json`，是本插件唯一持久化的数据。
- 商品资料只做字段归一化，不落库、不建索引；页面刷新后重新向上游取。
- 插件不校验商品是否可下单、库存、价格有效性，也不代替用户下单。

## 包结构

```text
plugins/shared-supply/
├── package.json          # ESM、锁定依赖、dist 由构建生成
├── nexus.plugin.ts       # manifest 唯一来源，由 definePluginManifest 校验
├── src/
│   ├── index.ts          # 组装存储、能力与协议；进程入口
│   ├── capabilities/     # supply.catalog 方法表
│   ├── domain/           # 商品归一化、CSV、zod 校验、错误码
│   ├── rpc/              # 协议、服务端、脱敏日志（与另两个插件同源，按包自包含）
│   ├── services/         # 加密目录协议与以图搜索适配
│   └── store/            # 私有存储
└── dist/                 # 构建产物：dist/src/index.js 与 dist/nexus.plugin.json
```

manifest 声明：`apiVersion: 1`、`id: studio.shared-supply`、`version: 1.0.0`、
能力 `supply.catalog`、域名 `gz.aliyizhan.com` / `aliyizhan.com` / `product.aliyizhan.com`、
`wantsBrowserAccess: false`、`storage: private`、密钥槽为空数组（该接口不需要任何凭据）。

## 与 nexus-cart 共享货源模块的对应关系

| 原模块                                        | 本插件                               | 变化                                                  |
| --------------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| `shared_supply/client.py`（AES 加密目录协议） | `src/services/upstream.ts`           | `cryptography` 改为 `node:crypto`，算法与报文保持一致 |
| `client.py` 的 `product_public`、`image_urls` | `src/domain/product.ts`              | 逻辑保留，字段名统一为 camelCase                      |
| `shared_supply/api.py` 的 HTTP 路由           | `src/capabilities/shared-supply.ts`  | 路由改为 RPC 方法，鉴权由宿主负责                     |
| `SharedSupplyFavorite` 表                     | `src/store/private-store.ts`         | SQLite 表改为插件私有目录的单个 JSON 文档             |
| 分页查询参数                                  | 各方法的 `page` 入参                 | 页大小沿用上游固定值 80 / 30 / 15                     |
| `useSceneReferences`（导入套图生成）          | 未迁移                               | 依赖 AI 套图工作流与文件服务，本仓库没有对应能力      |
| 前端 `SceneWorkspace`、`Dialog` 组合          | `features/supply/product-dialog.tsx` | 保留详情、收藏与复制；套图入口去掉                    |
| TanStack Query 缓存                           | 页面本地状态                         | 不引入查询库，翻页与切换分区即重新请求                |

## 方法清单

| 方法                      | 作用                                     |
| ------------------------- | ---------------------------------------- |
| `supply.catalog`          | 返回 10 个固定商品分类                   |
| `supply.stores`           | 按分类取商户列表（每页 80）              |
| `supply.products`         | 按商户取商品列表（每页 30）              |
| `supply.search`           | 按关键词搜索商品（每页 15）              |
| `supply.imageSearch`      | 以图搜索，入参是页面转码后的 JPEG base64 |
| `supply.favorites.list`   | 返回收藏（含是否可持久化）               |
| `supply.favorites.add`    | 收藏或更新快照，返回是否已收藏           |
| `supply.favorites.remove` | 取消收藏，按 id 幂等                     |
| `supply.favorites.csv`    | 返回收藏 CSV 文本与条数                  |

`supply.favorites.add` 的入参是上游原始商品对象；插件只取它认识的字段，
但会把原始对象一并存下来，便于以后复用。收藏上限 500 件，超过时明确拒绝而不是静默丢弃。

## 上游协议

- 目录接口在 `https://gz.aliyizhan.com`，请求体是 JSON 经 AES-128-ECB（PKCS#7）加密后的
  base64，响应同样是加密 base64；`marketCode=gz` 固定。
- 加密用的 16 字节常量来自供货方公开移动端，是该协议的一部分，不是用户凭据，
  因此 manifest 的密钥槽为空，插件也没有任何可配置密钥。
- 非 ASCII 字符按参考实现转成 `\uXXXX` 再加密，避免依赖上游对原始 UTF-8 的宽容度。
- 以图搜索走 `https://aliyizhan.com/personProduct/getImgSearchResult.action` 的 multipart，
  响应是明文 JSON，和目录协议不同。
- 单个响应上限 4 MiB（目录）/ 8 MiB（以图搜索）；超时 25 s / 30 s。
- 失败原因映射为 `RATE_LIMITED` / `TIMEOUT` / `UNAVAILABLE`，
  “接口返回 success=false”会带上上游的 message，不会被当成空列表。

## 图片处理

参考实现用 Pillow 做 EXIF 方向纠正、转 RGB、限制 100–8000 像素后转 JPEG。
浏览器里等价的做法由页面完成（`features/supply/image-prepare.ts`）：

- 只接受 JPEG、PNG、WebP，单文件不超过 5 MB。
- 用 `createImageBitmap(..., { imageOrientation: 'from-image' })` 解码，等价于 `exif_transpose`。
- 最短边 ≥ 100、最长边 ≤ 8000 像素，画到 canvas 后以 JPEG 0.88 导出。
- 插件只接受 JPEG 字节（校验 `FF D8 FF` 魔数），因为上游不做转码。

## 数据边界

- 收藏写在 `shared-supply.json`（0600），与插件其他文件同目录；宿主不读取。
- 宿主未提供私有目录时退回内存存储，重启即丢，页面会标注“仅本次运行”。
- 页面不缓存商品数据；切换分类、翻页、切分区都会重新请求。

## 外部服务、费用与数据发送

| 服务                            | 用途           | 发送内容                     | 费用与限制                   |
| ------------------------------- | -------------- | ---------------------------- | ---------------------------- |
| `gz.aliyizhan.com`              | 商户与商品目录 | 分类、商户标识、关键词、页码 | 供货方公开接口，无 SLA       |
| `aliyizhan.com`                 | 以图搜索       | 转码后的 JPEG                | 同上                         |
| `product.aliyizhan.com`（页面） | 商品图片展示   | 图片请求                     | 页面直接加载，插件不代理图片 |

插件不向这些服务发送本机路径、账号或收藏内容；收藏只在本机。

## 已知限制

- 上游是第三方公开接口，随时可能变更或限流；插件只能如实上报失败。
- 分页页大小固定为上游值，页面不能请求更多。
- 没有做本地缓存，重复翻页会重复请求上游。
- 以图搜索必须先由页面转成 JPEG，纯文本环境下无法使用该功能。
- 商品与商户字段按上游现状归一化，缺失就是空字符串，不猜测补全。
- 仅在 macOS 上执行过类型检查、单测与宿主安装/启用/调用测试；Windows 未验证。

## 本地验证

```bash
pnpm --filter @nexus/plugin-shared-supply build
pnpm exec vitest run plugins/shared-supply apps/desktop/src/features/supply
pnpm exec eslint plugins/shared-supply apps/desktop/src/features/supply --max-warnings 0
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --locked
```

插件侧 43 个用例覆盖 manifest 校验、加密报文往返、图片域名过滤、时间戳边界、
收藏去重与上限、CSV 公式注入防护、存储损坏时失败关闭；
页面侧 13 个用例覆盖工具栏与空状态、图片校验与 base64 编码。

最后一条会启动真实 `node` 进程，把本插件从 `dist` 安装进宿主（安装即启动），
再调用 `supply.catalog` 与 `supply.favorites.list`，同时验证用 `address.generator`
调用会被拒绝。这些结果不代表上游数据质量，也不代表 Windows 行为。
