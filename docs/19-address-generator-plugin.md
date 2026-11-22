# VInted helper 插件 `studio.address-generator`

## 目录与当前启用方式（2026-11-20）

源码文件夹已改为 `plugins/vinted-helper/`。保留安装 ID `studio.address-generator`、
包名 `@nexus/plugin-address-generator`、能力 `address.generator` 与私有地址文件，
目录改名不会创建第二份地址库；前端地址适配器仍沿用现有内部路径。

### 本地 Tauri debug

1. 完整停止并重新启动现有 `tauri dev`，让宿主重新扫描改名后的源码目录。
   仅刷新前端或重启旧插件进程仍可能使用宿主启动时记录的旧入口路径。
2. debug 宿主自动发现并运行源码插件，无需先 build 或安装本地 `dist`。
3. 打开 VInted helper 的面单工具，选择 PDF 后自动处理并下载。

源码模式直接运行 `src/labels/worker.ts`，继承父进程的 TypeScript source loader，
从已安装的 `@hyzyla/pdfium` 依赖解析 WASM 的绝对路径，不依赖当前工作目录或生成资源。
仓库依赖需要事先安装完整，应用不要求最终用户配置环境变量。

### 已构建的应用与发布包

正式应用不扫描工作区 TypeScript 源码，必须安装完整的新版 `.nexuspkg`。
维护者构建、打包、验证后，由插件中心更新安装；仅改源码或改名文件夹不会更新已经安装的包。
发布前手动步骤如下，本轮按用户约束不执行：

```sh
rtk proxy pnpm --filter '@nexus/plugin-address-generator...' build
rtk proxy node scripts/pack-plugin.mjs plugins/vinted-helper
rtk proxy pnpm run market:verify market/plugins/studio.address-generator/1.3.0.nexuspkg
```

加密包加载器已有 `NEXUS_PLUGIN_PACKAGE_DIR` 注入；客户端按该目录加载 Worker 与六段 WASM，
不回退工作区依赖。直接运行编译入口时从 `dist/resources/vinted-labels` 加载。
Worker 与 WASM 路径统一由客户端传入，避免资源位置随源码/打包入口不同而计算错误。
安装包缺少任一必要资源仍返回组件不可用，不能用开发机依赖掩盖不完整发布包。

## desktop-v2 面单提取（2026-11-20）

插件显示名称改为 **VInted helper**，本地源码版本 `1.3.0`。保留原安装 ID、
`address.generator` 授权与私有地址文件，更新显示名称不创建第二份地址库。
地图选点、firstname/lastname/username 生成、字段复制、地址保存和账号关联继续保留。
页面采用左侧工具分类、右侧内容的布局，外层沿用工作台 Card：

- **地址工具**：地图选点与已保存地址，保留姓名、用户名和地址字段复制、保存、导出及账号关联。
- **面单工具**：选择或拖入 PDF 即自动提取，直接提供 A6 下载；不显示待处理、手动开始和任务状态表格。

分类切换保留各工具内容与面单结果。面单不依赖地图 Key，也不受地图目录读取失败影响。

### 面单处理与下载

1. 同时选择或拖入一个或多个 PDF 后立即处理，无需再次点击开始。最多保留 20 个文件；
   每个不超过 10 MiB、50 页，当前页面的输入与下载结果合计最多 100 MiB。
2. 默认自动识别、A6 边距 3 mm，低频参数收在“选项”内。支持统一指定裁剪区，坐标为旋转后的可见页面左上角起算的
   左、上、右、下毫米值。边距可设为 0 至小于 52.5 mm；裁剪区必须在每页内部。
3. 插件串行执行文件，每个文件在独立 Node Worker 中处理；单文件最长 180 秒。
   任一页面失败使该文件失败，但不会中断批量的其他文件。处理期间只有上传按钮忙碌反馈和取消入口，
   不呈现任务流水账。取消后不启动剩余文件，失败或取消文件可按当前选项重试。
4. 提取完成后立即分块读取、校验 SHA-256 并释放插件会话；结果在 helper 页面内存中暂存，
   切换地址/面单分类仍可下载，离开 helper 后清除。结果以紧凑文件列表显示，提供带 Tooltip 的下载、重试和移除图标。
   自动隔离失败时保留必要的整页回退提示，可调整裁剪区后重新提取，不伪装成已识别面单。
5. 点击下载使用已校验的缓存，调用通用原生命令 `plugin_pdf_export`，
   由系统“另存为”选择位置。Rust 再检查大小、PDF 标识和哈希，经同目录临时文件原子保存；
   取消不显示成功，写入失败保留原目标文件。默认文件名为原名加 `-A6.pdf`。

算法参考 `nexus-cart/apps/api/backend/app/vinted/labels/extractor.py`：检查页面实际调用的
Form XObject，以 `FROM:`、`TO:` 与 `TRACKING` 识别面单；多个候选明确拒绝。
处理 CropBox 与页面旋转，在 3 倍分辨率下测量灰度墨迹（阈值 245，最多 1200 万像素），
去除留白、保留约 1 pt 安全边缘，等比居中到 105 × 148 mm A6。
PDFium WASM 仅用于测量；结果使用 pdf-lib 嵌入原始 PDF 矢量内容，不把面单转成截图。
不做 OCR、物流商格式猜测、平台下载或第三方上传。提取阶段不改写原文件，默认另存为新文件名，
也不从本机其他目录读取资料。

加密 PDF、空白页、无效 PDF、超大页面和越界裁剪均返回可读错误。
只有结构化结果与受限分块进入宿主 IPC，不返回文件原文到诊断日志。
协议会话在插件进程内存中临时保留，闲置 30 分钟自动过期，退出/重启不恢复；
前端完成结果读取后立即关闭会话，因此已显示的下载结果不依赖该过期时间。
插件临时数据和前端文件缓存各自受 100 MiB 上限约束，下载后可移除文件释放缓存空间。

### 公开契约与资源

`@nexus/plugin-contracts/vinted-helper` 定义严格 schema、限额及公开类型。
新增方法沿用 `address.generator` 授权，完整方法组缺失时仅禁用面单工具：

| 方法                   | 用途                                       |
| ---------------------- | ------------------------------------------ |
| `vinted.labels.begin`  | 建立临时上传会话、校验文件名/大小/提取参数 |
| `vinted.labels.append` | 按偏移上传，单块最多 192 KiB               |
| `vinted.labels.start`  | 完整性检查后加入串行任务队列               |
| `vinted.labels.status` | 读取状态与逐页报告                         |
| `vinted.labels.read`   | 按偏移读取完成结果，单块最多 192 KiB       |
| `vinted.labels.close`  | 幂等释放上传、任务及结果，终止运行 Worker  |

Worker 与 PDFium WASM 由插件构建脚本显式准备至 `dist/resources/vinted-labels`，
随 `nexusResources` 打包；WASM 分为六段以遵循每个资源 1 MiB 的已有上限。
处理不依赖 Python、系统 PDF 工具、额外本地服务或网络下载。
当前只完成源码及直接检查，未执行插件构建/打包、原生另存为、实际面单打印或双平台验收。

## desktop-v2 地址功能基线（2026-11-19）

插件源码版本为 `1.2.0`，最低核心版本 `0.1.43`，用于当前 desktop-v2 插件宿主。
`apiVersion: 1` 是插件进程协议版本，不代表继续适配旧桌面页面。
本轮按用户要求移除 OpenStreetMap/Overpass 地址查询，只通过 Google Maps 地图选点。

- 页面：`apps/desktop-v2/src/pages/plugins/address-generator/`，按需加载，沿用 ShardX UI Kit、
  PageHeader、主题、表格、选择器和弹窗。未接原生桥的普通网页预览不调用插件或地图。
- 适配：`src/raccoon/plugins/address-generator/` 包含 RPC 响应校验、能力门禁、地图加载、
  地址解析、选点生命周期和账号关联协调。
- 插件：`plugins/vinted-helper/` 保留国家/城市目录、姓名/用户名生成、地址保存与
  CSV。插件进程不再请求网络，manifest 的 `networkDomains` 为空。
- Overpass 服务、镜像回退、缓存、随机批量抽样及 `address.generate` 方法均已移除。
  不删除已有地址文件；历史地址仍可查看、复制、导出和关联，不再通过 OSM 产生新地址。

这是本轮源码和本地检查范围。Google 实际 Key、配额、Tauri WebView、Windows 与正式安装
仍须单独验收，受控 SDK/IPC 浏览器检查不能替代真实地图联调。

## 使用流程

1. 在插件中心安装、启用并授权地址生成器。
2. 应用构建时已配置地图服务，无需用户填写 Key；未配置的版本明确提示地图暂不可用。
3. 选择国家和定位城市，在地图中放大并点击建筑物。
4. 地图 SDK 反向解析坐标；只接受当前国家下带门牌、街道、城市和邮编的建筑级结果。
5. 插件为这个地址生成 firstname、lastname 和 username；右侧逐字段显示姓名、地址、
   坐标、精度和来源，每个字段均有独立复制按钮，另可复制完整地址。
6. 点击“保存地址”后才写入插件私有文件；“已保存地址”提供搜索、分页、复制与 CSV 导出。
7. “关联账号”可将资料保存后关联到 Vinted 账号，确认前展示将被替换的旧地址。

城市目录仅定位地图中心。可以在地图内平移选点，不把城市中心或坐标本身当作收件地址。
地址不完整、国家不符、授权失败或服务错误时给出原因，不补门牌、不猜邮编。
姓名和用户名是本地合成资料，不保证平台可用，也不校验地址收件能力。

## 地图与生命周期

Maps JavaScript API 由页面脚本加载，Geocoding 在 SDK 内完成。Key 只用于现有地图链路，
没有新增页面直连地址搜索 API。地图按应用浅色/深色主题创建。
选中位置通过标准 OverlayView 标记，不依赖示例 Map ID 或已弃用的 Marker。

- 一个文档复用一次 SDK 加载；并发请求复用同一 Promise，网络加载失败可重试。
- 更换构建 Key 后需重新构建应用；开发期更换环境变量需重启开发服务。
- 连续点击仅接收最后一次结果；旧反查在生成资料前以及返回后都会核对会话。
- 切换城市/主题或离开地图会使在途反查失效，清理点击监听、标记和地图绑定。
- 缺少构建 Key 时提示应用尚未配置地图，已保存地址的查看、复制、导出不受影响。
- `location_type` 不是 `ROOFTOP` 时标记近似位置；建筑精度同样不代表已验证收件。

`tauri.conf.json` 分别声明生产 CSP 和开发 CSP，允许 Google Maps 脚本、服务连接、
瓦片、字体与样式。脚本来源只增加 `maps.googleapis.com` 和 `maps.gstatic.com`，
不使用任意 HTTPS 脚本白名单；Maps 脚本执行需要的 `unsafe-eval` 限定在 v2 配置中。
这属于原生配置修改，应完整重启 `tauri dev` 父 CLI，不能只刷新前端。

## RPC 与能力门禁

页面使用统一 `plugin_call`，能力为 `address.generator`。基础门禁要求插件已启用、
运行中、声明且获准该能力，并支持全部基础方法。可选功能单独检查，不阻塞地图选点。

| 分组         | 方法                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| 基础         | `address.catalog`、`address.profile`                                     |
| 已保存地址   | `address.saved.list`、`address.saved.save`、`address.saved.remove`       |
| 复制 CSV     | `address.csv`                                                            |
| 写入私有 CSV | `address.export`                                                         |
| 通用配置迁移 | `configuration.export`、`configuration.validate`、`configuration.import` |

`address.profile` 只接受 `source: map` 的新选点。保存、读取与 CSV 保留历史记录的来源。
响应在进入页面状态前校验：目录对应关系、完整地址、经纬度、资料标识、
持久化标志、分页计数、重复标识、保存时间和导出计数。

## 保存与账号关联

地址文件为插件私有目录的 `address-generator.json`，最多 2000 条。默认每页 20 条，
后端上限 50 条；支持姓名、用户名、地址、州、国家和邮编搜索。
写入通过队列与临时文件替换完成，失败时保留旧文件。页面在成功回读前不显示已保存。
同一规范化地点沿用首次保存的 ID、姓名和用户名，重复选择不会覆盖原资料。

账号关联要求 Vinted 账号池已启用、运行中、获准 `account.pool`，并提供：

- `vinted.accounts.address.targets`：只读账号标识、状态与已有地址，不读取密码。
- `vinted.accounts.address.set`：保存完整地址快照，传入确认时的 `expectedProfileId`。

关联先保存地址，再使用返回的规范资料写账号快照，避免重复地址带来两个资料 ID。
地址保存失败不写账号；账号写入失败则保留已保存地址及弹窗选择。离开会话后不再发起
后续账号写入。并发变更由账号池的旧地址标识检查拒绝，需重新读取目标后确认。
删除保存列表中的地址不影响账号已有快照；双方数据继续由各自插件独立持有。

## 构建注入 Key、费用与数据边界

构建主程序前设置 `VITE_GOOGLE_MAPS_API_KEY`，Vite 将其替换进前端产物。
没有要求用户创建 `.env`；可直接从构建机/CI 环境提供。`client.ts` 读取构建值，
只交给当前主程序 WebView 中的地图 SDK，不放入插件 RPC、地址资料或插件私有文件。
Node 插件进程不会自动继承打包时的前端变量，也不需要这个 Key：它只接收规范地址、
生成资料并处理本地保存。更新插件包不能更改已打入主程序的 Key。

这是包含在前端产物中的浏览器 Key，不能作为服务端密钥保密。
应启用 Maps JavaScript API 与 Geocoding API，并在 Google 控制台配置合适的应用来源限制。
地图请求使用用户自己的 Google 服务配额，地址选点坐标、瓦片请求和浏览器 Key 会发往 Google。
本地生成的姓名、用户名和账号密码不发给地图服务。

旧插件已有的 Key 配置/迁移 RPC 与私有文件暂未删除，以免破坏已有数据；v2 页面
不调用它们，不读取旧 Key，也不在缺少构建 Key 时回退到用户填写。
宿主没有提供私有目录时使用内存存储，页面明确提示地址在退出后失效。
CSV 显式写入私有目录 `exports/`，返回路径不等于系统下载目录。
旧配置迁移不包含新的构建 Key、已保存地址、CSV 或账号快照。

## 本地检查入口

```sh
rtk proxy pnpm exec vitest run plugins/vinted-helper plugins/integration/src/plugin-configuration.test.mjs --maxWorkers=2
rtk proxy node --experimental-strip-types --test apps/desktop-v2/src/raccoon/plugins/address-generator/{contract,google-maps,picker-session,profile-fields,relations}.test.ts
rtk proxy pnpm exec vitest run packages/plugin-contracts/src/vinted-helper.test.ts apps/desktop-v2/src/raccoon/plugins/address-generator/labels.test.ts apps/desktop-v2/src/raccoon/plugins/address-generator/label-download.test.ts --maxWorkers=2
rtk proxy pnpm exec tsc -p plugins/vinted-helper/tsconfig.json --noEmit --rootDir . --customConditions development
```

后续按用户最新要求不运行插件/应用构建、Rust 编译/测试或图像验证。
实际执行结果见[质量记录](09-quality-and-testing.md)，不将历史 0.1 页面检查当作 v2 验收。
