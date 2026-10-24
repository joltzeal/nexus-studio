# 共享货源插件 `studio.shared-supply`

本文说明仓库内共享货源插件的实际范围。插件规则见[插件对接开发规范](14-plugin-integration-guide.md)，
产品侧插件边界见[插件系统](06-plugin-system.md)，页面交互见[页面交互](11-demo-pages.md)。

## 当前事实

插件包位于 `plugins/shared-supply`，实现 `supply.catalog` 能力的 12 个方法、
私有存储与逐行 JSON RPC 服务端。页面位于 `apps/desktop/src/features/supply`。

- 商户、商品、关键词搜索、以图搜索与展示图片下载都由插件进程发起，页面不直接访问上游。
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
能力 `supply.catalog`、域名 `gz.aliyizhan.com` / `aliyizhan.com` / `product.aliyizhan.com` /
`thirdwx.qlogo.cn`（目录中的商户头像）、
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
| `supply.image.open`       | 校验图片 URL、下载字节，返回限时传输描述 |
| `supply.image.read`       | 读取指定传输的一个 base64 分块           |
| `supply.image.close`      | 释放图片传输快照，按 id 幂等             |
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

### 展示图片的网络与 WebView 边界

2026-10-24 排查确认，原商品网格、详情主图和缩略条把上游 URL 直接交给 WebView 的
`<img src>`；目录请求则走插件 Node `fetch`。宿主应用代理只注入到插件的 Node
dispatcher，不控制页面图片请求。与此同时，当前 Tauri `csp` / `devCsp` 的
`img-src` 没有允许供货方 CDN，普通 Vite 预览与打包 WebView 因此存在确定的策略差异。
既有 CSP 已允许 `blob:`，本次不扩大 CSP 或修改原生宿主。

本机只读公开探测中，目录、商品接口均返回 200；供货方商户图标的 HTTPS HEAD 返回
`image/jpeg`、5,432 字节，一个商品图返回 `application/octet-stream`、792,063 字节，
两者均未跳转。792,063 字节经 base64 编码为 1,056,084 个字符，超过宿主
1,048,576 字节的 JSON 单行上限，因此不能把整张图放进一个 RPC 响应。
这些结果是本机公开端点证据，不是用户故障电脑的日志，也不能证明所有图片当前可用。

随后直接运行本次 TypeScript 图片服务源码（未构建）下载这两张图及一个 QLogo 头像：
三者分别取得 5,432 / 792,063 / 7,088 字节并识别为 JPEG。商品图完整读出为 4 块，
最大模拟 JSON RPC 帧为 349,624 字节。该检查验证了真实 CDN 字节与新服务的兼容性，
没有经过打包 WebView，也没有验证用户配置的真实代理。

现在商品网格、详情主图、缩略条及商户图标共用以下链路：

1. 页面经现有 `plugin_call` 调用图片方法，插件使用与目录请求相同的 Node `fetch`
   网络机制，继承应用代理；代理失败不自动直连，不携带 Cookie、Authorization 或 Referer。
2. 只允许精确主机和路径：`product.aliyizhan.com/person/`、
   `product.aliyizhan.com/upload-file/` 与 `thirdwx.qlogo.cn/mmopen/`。
   拒绝 URL 凭据、非默认端口与其他协议/主机/路径；已有 HTTP 图片地址升级为 HTTPS，
   去掉片段，不降级回 HTTP。商品字段仍只接受 `/person/`，商户图标也进行归一化。
3. 最多跟随 3 次跳转，每次重新校验允许的主机、路径与 HTTPS；不允许降级跳转。
   单张图片最多 8 MiB，按流累计并在超限时取消读取，下载最多等待 20 秒。
   HTTP 状态、声明类型与 JPEG/PNG/WebP/GIF 魔数都要通过校验。已观察到的
   `application/octet-stream` 只有在魔数能识别为上述图片时才接受；拒绝 HTML、SVG、
   缺失类型、类型与内容不符或空响应。魔数校验不是完整解码，WebView 解码失败另行提示。
4. 插件把下载结果保留为不可变内存快照，每块原始字节最多 256 KiB，base64 加 JSON
   后远小于 1 MiB 帧限制。最多 4 个并发下载、8 个下载/传输名额，保留快照总量最多
   32 MiB；未关闭的快照在创建 60 秒后回收。下载中的流缓冲另受并发数与单张上限约束。
5. 页面校验传输描述、块偏移、base64 和每块长度后构造带正确 MIME 的 Blob，`<img>`
   仅接收本地对象 URL，并设置 `no-referrer`。成功、失败或取消后均尝试关闭传输；
   取消时正在等待的原生调用可能稍后才返回，但不会把迟到结果显示到已卸载的图片。
6. 页面下载并发为 4，同 URL 的主图和缩略图共享加载及 Blob；可见性驱动加载与引用释放。
   缓存最多 128 项、32 MiB，闲置 60 秒或容量不足时回收并 `revokeObjectURL`。
   活跃引用保留，缓存不能容纳新的活跃图片时明确报错。解码失败会使缓存项失效，
   重试重新取字节；最后一个使用者释放前不会撤销它仍在使用的对象 URL。

图片失败显示原因：检查网络/应用代理、超时、限流、过大、格式/解码错误等。
详情主图有“重试图片”，页面“刷新”会重试当前图片；紧凑图标/缩略条通过失败图标、
悬浮提示与无障碍文本反馈。已安装旧插件没有图片方法时显示
“请更新共享货源插件后重试图片加载”，不静默留空，也不回退成 WebView CDN 请求。
复制图片链接与发送到 AI 生图仍使用归一化的原始 HTTPS URL，不传 Blob URL。
重复点击当前分类或商户保持现有结果；重新请求使用“刷新”，避免清空列表后因查询条件未变而一直停在加载状态。

图片 RPC 都属于 `supply.catalog` 能力：

```ts
// supply.image.open
// 入参
{ url: 'https://product.aliyizhan.com/person/photo.jpg' }
// 返回
{ id: '<UUID>', mime: 'image/jpeg', size: 792063, chunkSize: 262144 }

// supply.image.read
// 入参：offset 从 0 开始，每次增加 chunkSize
{ id: '<UUID>', offset: 0 }
// 返回：data 是本块 base64，不含 data: 前缀，末块长度等于剩余字节数
{ offset: 0, data: '<base64>' }

// supply.image.close
{ id: '<UUID>' }
// 返回
{ closed: true }
```

实现参考 [Node fetch/dispatcher 文档](https://nodejs.org/api/globals.html#fetch)、
[W3C CSP img-src](https://www.w3.org/TR/CSP3/#directive-img-src) 与
[W3C File API 对象 URL 生命周期](https://www.w3.org/TR/FileAPI/#lifeTime)。

### 上传图片搜索

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
- 展示图片仅在插件传输快照和页面 Blob 缓存中短暂保留，不写磁盘或 localStorage。

## 外部服务、费用与数据发送

| 服务                    | 用途               | 发送内容                      | 费用与限制               |
| ----------------------- | ------------------ | ----------------------------- | ------------------------ |
| `gz.aliyizhan.com`      | 商户与商品目录     | 分类、商户标识、关键词、页码  | 供货方公开接口，无 SLA   |
| `aliyizhan.com`         | 以图搜索           | 转码后的 JPEG                 | 同上                     |
| `product.aliyizhan.com` | 商品图片、商户图标 | 不含凭据和 Referer 的图片请求 | 经插件下载，继承应用代理 |
| `thirdwx.qlogo.cn`      | 部分商户头像       | 不含凭据和 Referer 的图片请求 | 同上，仅允许 `/mmopen/`  |

插件不向这些服务发送本机路径、账号或收藏内容；收藏只在本机。

## 已知限制

- 上游是第三方公开接口，随时可能变更或限流；插件只能如实上报失败。
- 分页页大小固定为上游值，页面不能请求更多。
- 目录没有本地缓存，重复翻页会重复请求上游；图片仅有短时、限量的内存缓存。
- 以图搜索必须先由页面转成 JPEG，纯文本环境下无法使用该功能。
- 商品与商户字段按上游现状归一化，缺失就是空字符串，不猜测补全。
- 本次图片修复没有执行安装包、macOS WebView 或 Windows 实测，没有重新构建插件发行包。
  已安装旧插件需要与页面匹配的更新；本次不修改版本或发布包。历史 macOS 宿主安装测试
  不代表新图片链路的整机验证。

## 本地验证

遵守当前不在本地构建、打包或编译 Rust 的约定，直接运行工具：

```bash
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec vitest run plugins/shared-supply apps/desktop/src/features/supply --maxWorkers=4
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec eslint plugins/shared-supply apps/desktop/src/features/supply --max-warnings 0
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec tsc -p plugins/shared-supply/tsconfig.json --noEmit
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec tsc -p apps/desktop/tsconfig.json --noEmit
```

图片回归覆盖真实逐行 RPC 分块往返与帧大小、插件网络失败后的显式恢复、域名/跳转约束、
MIME/魔数错误、流式超限、传输过期与容量、前端分块校验、旧插件提示、
并发/缓存/取消/对象 URL 回收。外部网络边界使用可控响应，不作为真实代理或 Windows
集成通过记录。根 `test` / `typecheck` 脚本会先构建，不用于本轮检查。
Rust 既有共享货源宿主测试仅检查分类数、空收藏和能力拒绝，没有固定方法数或域名断言；
本次未修改或运行该测试。最终实际检查结果由主线整理到质量文档。
