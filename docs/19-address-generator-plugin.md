# 地址生成器插件 `studio.address-generator`

本文说明仓库内地址生成器插件的实际范围。插件规则见[插件对接开发规范](14-plugin-integration-guide.md)，
产品侧插件边界见[插件系统](06-plugin-system.md)，页面交互见[页面交互](11-demo-pages.md)。

## 当前事实

插件包位于 `plugins/address-generator`，实现 `address.generator` 能力的 7 个方法、
私有存储、密钥库边界与逐行 JSON RPC 服务端。页面位于 `apps/desktop/src/features/addresses`。

- 公开地址来自 OpenStreetMap 的 Overpass 接口，由插件进程发起，页面不直接访问上游。
- 地图选点由页面里的 Google Maps JavaScript API 完成反向地理编码，插件只负责把选点变成资料。
- 生成结果只存在于页面内存，插件不建表、不落盘。
- 插件唯一持久化的数据是 Google Maps Key，写在私有目录的 `secrets.json`（明文，0600）。
- 没有 Key 时地图选点不可用，公开地址生成不受影响。

本插件不连接任何交易平台，不创建账号，也不校验地址能否收件。

## 包结构

```text
plugins/address-generator/
├── package.json          # ESM、锁定依赖、dist 由构建生成
├── nexus.plugin.ts       # manifest 唯一来源，由 definePluginManifest 校验
├── src/
│   ├── index.ts          # 组装存储、密钥库、能力与协议；进程入口
│   ├── capabilities/     # address.generator 方法表
│   ├── domain/           # 地址与资料类型、CSV、zod 校验、错误码
│   ├── rpc/              # 协议、服务端、脱敏日志（与代理插件同源，按包自包含）
│   ├── services/         # 城市白名单、Overpass 查询、姓名池、用户名生成
│   └── store/            # 私有存储与密钥库端口
└── dist/                 # 构建产物：dist/src/index.js 与 dist/nexus.plugin.json
```

`rpc/` 与代理插件是同一份实现的两个副本。插件按独立目录安装、独立进程运行，
不跨插件共享运行时包，因此这里保留副本而不是引入第三个共享包。

manifest 声明：`apiVersion: 1`、`id: studio.address-generator`、`version: 1.0.0`、
能力 `address.generator`、域名 `overpass-api.de` 与 `maps.mail.ru`、
`wantsBrowserAccess: false`、`storage: private`、密钥槽 `google-maps-key`。

## 与 nexus-cart 地址模块的对应关系

| 原模块                                          | 本插件                                                   | 变化                                                 |
| ----------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `public_addresses.py`（Overpass + 缓存 + 单飞） | `src/services/overpass.ts`                               | httpx 改为 `fetch`，双镜像失败回退与 15 分钟缓存保留 |
| `maps_settings.py`（Fernet 加密存 SQLite）      | `src/store/secret-vault.ts`                              | 加密与数据库改为私有目录明文文件，仍只回传浏览器 Key |
| `api.py` 的 `/addresses/public`、`/maps-key`    | `src/capabilities/address-generator.ts`                  | HTTP 路由改为 RPC 方法，鉴权由宿主负责               |
| `locations.ts`                                  | `src/services/catalog.ts`                                | 城市表随插件分发，上游查询只能用它                   |
| `identity.ts`（faker + 随机数字）               | `src/services/names.ts`、`username.ts`                   | 改为按国家姓名池与贴近真实的用户名模板               |
| `address.ts`（归一化、去重、CSV）               | `src/domain/address.ts`                                  | 逻辑保留，字段名统一为 camelCase                     |
| `google-map.tsx`、`google-loader.ts`            | `apps/desktop/src/features/addresses/address-map.tsx` 等 | 迁移到桌面页面，SDK 用脚本加载而非 npm loader        |
| `us-base.ts`、`us-selector.tsx`（CSV 基础库）   | 已移除                                                   | 美国地址改走 Overpass，覆盖较薄时如实报告条数        |
| `error-notice.tsx`                              | 页面内错误文案                                           | 按错误码给出原因，不显示伪造结果                     |

## 方法清单

| 方法                 | 作用                                           |
| -------------------- | ---------------------------------------------- |
| `address.catalog`    | 返回插件支持的国家与城市（含中心坐标）         |
| `address.generate`   | 按城市抓取公开地址，随机抽样并生成资料         |
| `address.profile`    | 把一次地图选点转换成资料（姓名、用户名）       |
| `address.csv`        | 返回 CSV 文本，供页面复制                      |
| `address.export`     | 把 CSV 写入插件私有目录的 `exports/`，返回路径 |
| `address.config.get` | 读取地图 Key 状态与存储是否可持久化            |
| `address.config.set` | 保存或清除地图 Key                             |

`address.generate` 的入参是 `{ country, cityId, count }`，`count` 为 1–50。
返回 `{ items, requested, found, poolSize, endpoint, cached }`：`found` 小于 `requested`
时页面如实说明"该区域仅找到 N 条完整且不重复的地址"，不补齐、不编造。

## 上游查询

- 查询窗口是以城市中心为原点、±0.035° 的矩形，`out center 300` 最多 300 个元素。
- 只接受同时具备门牌号、街道、城市、邮编的要素；缺一项即丢弃，不用猜补全。
- 单个响应上限 2 MiB，超过即判为无效响应。
- 镜像顺序：`overpass-api.de`（12 s）→ `maps.mail.ru`（35 s），整体 50 s 超时。
- 同一城市 15 分钟缓存，同城并发请求合并为一次，不同城市之间 5 s 冷却。
- 失败原因映射为 `RATE_LIMITED` / `TIMEOUT` / `UNAVAILABLE`，由页面显示对应文案。

## 用户名生成

旧实现是 `faker.internet.username()` 加一个 10–9999 的均匀随机数，输出像
`marie.laurent4821` 这类现实中不存在的账号名。现在的规则：

- 姓名先去变音符号（`Łukasz` → `lukasz`、`Straße` → `strasse`），只保留 a–z。
- 模板按权重抽样：`first.last`、`firstlast`、`first_last`、`first.last94`、
  `firstlast94`、`mlaurent`、`last.first`、`first-last`、`first94`、`first-last94`、`last94`。
- 数字后缀模拟真实习惯：55% 为 1970–2005 的两位年份，25% 为 1–9，12% 为四位年份，
  其余为 10–99；不再使用 1000–9999 的均匀随机数。
- 结果固定为小写 ASCII、以字母开头、4–20 字符，不含连续分隔符，也不以分隔符结尾。
- 一批结果内保证唯一：冲突时重掷模板，仍有冲突则追加递增计数。

测试覆盖字符集、长度、变音符号、无数字比例（>40%）、四位数字比例（<15%）、
分隔符比例（25%–80%）与批内唯一性。

## 地图选点

- 页面用脚本标签加载 `https://maps.googleapis.com/maps/api/js`，Key 由
  `address.config.get` 提供；`tauri.conf.json` 的 CSP 只放行 `maps.googleapis.com`
  与 `maps.gstatic.com` 等必要主机。
- 点击地图后调用 Geocoding API，只接受 `street_address`、`premise`、`subpremise`
  级别的结果，并且国家必须与当前选择一致。
- `location_type` 不是 `ROOFTOP` 时标注为近似位置，页面照实说明。
- Maps JS 每个文档只能用一个 Key 加载一次；保存新 Key 后需要重启应用，页面会说明这一点。

## 密钥与数据边界

- 地图 Key 保存在插件私有目录的 `secrets.json`，权限 0600，与插件文档
  `address-generator.json` 同一目录；宿主不接收、不托管。
- 这是浏览器 Key，页面必须拿到它才能加载 SDK，因此它对本机进程可见；
  它不是服务端凭据，也不应被当作机密。推荐在 Google Cloud 控制台配置来源限制。
- 宿主未提供私有目录时退回内存存储，Key 重启即失效，页面会提示"只在内存中"。
- 生成的地址与用户名不写入任何文件；只有显式"写入 CSV 文件"才会落到 `exports/`。

## 外部服务、费用与数据发送

| 服务                                  | 用途           | 发送内容                           | 费用与限制                              |
| ------------------------------------- | -------------- | ---------------------------------- | --------------------------------------- |
| `overpass-api.de`                     | 公开地址查询   | 城市边界内的只读查询，无用户数据   | 公共免费实例，限流时切镜像              |
| `maps.mail.ru`                        | Overpass 镜像  | 同上                               | 公共镜像，无 SLA                        |
| `maps.googleapis.com`（页面直接调用） | 地图显示与反查 | 选点坐标、地图瓦片请求、浏览器 Key | 需要启用 Maps JS 与 Geocoding，按量计费 |

公开地址生成不需要任何密钥，也不向 Google 发送请求；只有地图选点会加载 Google SDK。
插件不向上述服务发送生成的姓名、用户名或已生成的地址。

## 已知限制

- 美国城市的 OSM 门牌覆盖较薄，`found` 常小于请求数量；插件不提供 CSV 基础库补齐。
- 地图选点依赖 Google Maps 的网络与配额；Geocoding 未启用时选点会失败，页面提示检查 API。
- 用户名是本地生成的合成数据，不保证在任何平台可用或未被占用。
- 插件不校验地址真实收件能力，也不做地址标准化（如邮编格式校验）。
- 仅在 macOS 上执行过类型检查、单测与宿主安装/启用/调用测试；Windows 未验证。

## 本地验证

```bash
pnpm --filter @nexus/plugin-address-generator build
pnpm exec vitest run plugins/address-generator apps/desktop/src/features/addresses
pnpm exec eslint plugins/address-generator apps/desktop/src/features/addresses --max-warnings 0
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --locked
```

插件侧 57 个用例覆盖 manifest 校验、用户名模板与批内唯一、Overpass 响应清洗与缓存、
CSV 公式注入防护、密钥保存与清除、能力方法表与错误码；
页面侧 14 个用例覆盖工具栏与服务卡片渲染、Google 结果归一化。

最后一条会启动真实 `node` 进程，把本插件从 `dist` 安装进宿主（安装即启动），
再调用 `address.catalog`，同时验证用 `proxy.provider` 调用会被拒绝。
这些结果不证明上游地址质量，也不代表 Windows 行为。
