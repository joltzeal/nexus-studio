# 插件商店与在线更新

## AI 生图 1.4.3 下载文件夹修正

自动与手动导出统一写入系统下载文件夹的 `Nexus AI/`，不再使用插件私有 `exports/`。
Windows 读取系统登记的下载位置；旧记录补导出使用新目标，保留原文件并且不调用模型。
最低主程序仍为 `0.1.18`，通过独立 `plugin-ai-image@1.4.3` 标签构建与发布。
实际构件与 R2 回读证据见[质量记录](09-quality-and-testing.md)。

## AI 生图 1.4.2 导出修复

修复生成完成后没有写入导出目录的问题；普通生成和逐视角生成自动写入
AI 插件数据目录的 `exports/`。补导出复用相同副本，不覆盖已有不同内容，
也不会重新调用模型。最低主程序仍为 `0.1.18`。
使用独立 `plugin-ai-image@1.4.2` 标签构建，只发布 AI 新包并合并线上目录，
其他七项与历史包不覆盖。实际发布证据见[质量记录](09-quality-and-testing.md)。

2026-10-28 13:28（Asia/Shanghai）已完成 CI 构件启动与实际导出验证、
R2 上传和远端/公开回读。线上 AI 为 `1.4.2`，包大小 182991 字节，
SHA-256 为 `6bb48a24b4769e43cc3813a0d275bf8e532f8df75ce883d84cf3797524c70122`。
主程序 `0.1.18` 或以上可在“插件中心 → 检查更新”安装，无需更新主程序。

## AI 生图 1.4.1 独立更新

`studio.ai-image 1.4.1` 统一英文商品文案与提示词，并让自由提示词、场景预设、
测试和多视角生成使用自然手机实拍约束。行为见[英文文案与手机实拍](36-ai-english-phone-photos.md)。
最低主程序仍为 `0.1.18`，主程序本次不升版。

`.github/workflows/ai-plugin-release.yml` 由 `plugin-ai-image@<版本>` 标签触发，
只构建 AI 插件及依赖，校验代码、标签与清单、包摘要、包内文件和 21 方法启动握手，
产出 `plugin-market-plugin-ai-image@<版本>`。CI 不持有 R2 凭据或写商店目录。
下载该产物后只发布 AI 新包，并读取、合并线上完整目录；其他七项和历史包不覆盖。

2026-10-28 12:41（Asia/Shanghai）已完成独立 CI 运行 `40633444186`、
下载构件的摘要与启动检查、本地 HTTP 流式和英文生成流程验证，以及 R2 上传和远端/公开回读。
线上 AI 为 `1.4.1`，包大小 181290 字节，SHA-256 为
`eb5078af95e2bf1ae4029bbbf7329e20dd6d00a633d48e95ff7956c1d9ffee91`。
目录仍为八项，其他七项保持原值；主程序 `0.1.18` 或以上可在
“插件中心 → 检查更新”安装。完整证据见[质量记录](09-quality-and-testing.md)。

## AI 生图 1.4.0 与主程序 0.1.18

`studio.ai-image` 升为 `1.4.0`，默认生图等待 15 分钟，支持每服务商调整等待时间、
选择自动/流式/普通响应。文生图、改图、实际测试和逐视角生成共用新请求实现，
支持标准 Images SSE 和普通 JSON；读取响应与结果下载使用同一个截止时间。
配置迁移、兼容模式与异常处理见[生图请求](35-ai-streaming-and-timeouts.md)。

要求 `minCoreVersion: 0.1.18`，主程序同时提供设置页面和网络传输层修复。
从 `plugin-market-v0.1.18` CI artifact 取得新包，验证清单、摘要、包内文件和
21 方法启动握手后，仅发布 `plugins/studio.ai-image/1.4.0.nexuspkg`，
回读校验后再合并线上完整目录。其他七项及历史包保持原值；
artifact 中重新打包的同版本 Vinted 包不上传。
实际发布状态以[质量记录](09-quality-and-testing.md)中的远端和公开回读证据为准。

2026-10-28 01:39（Asia/Shanghai）已完成 CI artifact 摘要核对、包内文件与启动检查、
下载包的本地流式/JSON 实际请求验证，以及 R2 上传和远端/公开回读。
线上 AI 为 `1.4.0`，包摘要为
`f8c7e58166f932a0d0140f57b6c3047ed27984fb119daae1d8feb1f958db379f`，
其他七项保持原值。`v0.1.18` 已触发主程序发行流程；先更新主程序，再在插件中心检查更新。
按约定没有等待桌面安装包编译完成。

## AI 生图 1.3.0 与主程序 0.1.17

`studio.ai-image` 升为 `1.3.0`，新增 `image.providers.testImage`，
实际测试文生图或单张参考图改图，复用生成记录、文件存储和错误反馈。
“模型列表可访问”和“所选模型可生图”分开检查；通道不可用时保留 HTTP
状态、经脱敏的服务商说明和请求标识。接口详见[生图测试](33-ai-provider-testing.md)。

要求 `minCoreVersion: 0.1.17`，需要先更新主程序再检查插件更新。
主程序的短信等待功能复用已有账号池方法，不更改账号池和 SIM8 包版本。

发布使用 `plugin-market-v0.1.17` CI artifact，验证 AI manifest、包摘要、
内部文件摘要和 21 方法启动握手，只新增 `plugins/studio.ai-image/1.3.0.nexuspkg`。
读取线上完整目录后仅替换 AI 条目，不上传 artifact 中同版本的 Vinted 重打包文件，
保留其他七项及历史版本对象；先写包并回读，再确认目录未被并行修改，最后写目录。
实际上传及公开入口回读结果见[质量记录](09-quality-and-testing.md)。

2026-10-28 00:07（Asia/Shanghai）已完成 CI artifact 摘要与提交核对、
包内文件检查、21 方法实际启动握手、R2 上传以及远端和公开入口回读。
线上 AI 包摘要为 `7f31bfba37decfe302688bf57dcdda04a5650743cd8a772eae87fa27583b540a`，
目录仍为八项，其他七项保持原值。主程序 `v0.1.17` 已触发发行工作流，
按约定未等待桌面编译；用户升级主程序后可在插件中心检查更新。

## AI 生图 1.2.0 与主程序 0.1.16

`studio.ai-image` 升为 `1.2.0`，模型仅保留识图、生图两项，服务商至少配置一种。
识图返回标题、描述和生图提示词；任务必须指定准确的服务商与模型，
最近选择随任务接受而保存，支持重启恢复。

插件 manifest 要求 `minCoreVersion: 0.1.16`。旧版主程序的配置表单和调用参数不兼容，
因此本次同步推送主程序 `v0.1.16`，用户先更新主程序，再检查插件更新。
旧版主程序会过滤不兼容商店条目，已安装旧插件保持原状。

复用桌面发行的 `plugin-market-v0.1.16` artifact，只上传 AI `1.2.0` 新包。
读取线上完整目录后仅替换 AI 条目，保留其他七项和历史版本对象；
artifact 内重新打包的 Vinted `1.1.1` 不覆盖线上原包。
包校验完成后先上传包、回读核对摘要，再检查目录未被并行修改，最后写合并目录。
实际发布与公开入口回读证据见[质量记录](09-quality-and-testing.md)。

2026-10-27 17:46（Asia/Shanghai）已完成 CI 产物验证、下载包实际启动、
双模型协议检查、R2 上传及公开目录/包回读。线上 AI 为 `1.2.0`，
包摘要为 `ccb2651dbdc9d19c046589c4a3899c151ed78321ca6697d300b3cb07b03b9cc6`，
其他七项保持原值。主程序 `v0.1.16` 已触发 CI，本次未等待桌面编译；
主程序更新完成后可通过“插件中心 → 检查更新”安装。

## 0.1.15 配套 AI 生图插件

`studio.ai-image` 升为 `1.1.1`，完成上传时校验图片实际签名与声明 MIME 一致，
拒绝伪装格式和无效内容。主程序 `0.1.15` 负责将 Vinted 选图在本机转为 JPEG、
预填商品信息，并通过原生命令打开商品与卖家外链；两条更新通道分别安装。
已有模型配置、生成记录和商品来源保持兼容。

本次使用桌面发行流程的 `plugin-market-v0.1.15` artifact，仅发布其中新的 AI 包。
Vinted 监控后端未变，继续保留线上 `1.1.1` 的原包字节；artifact 中重新打包的
同版本 Vinted 包不上传。回读线上目录后仅替换 AI 条目，先上传包并验证摘要，
确认目录未发生并行修改后再更新目录，其他七项与历史包保持不变。
具体上传结果单独记录在[质量记录](09-quality-and-testing.md)。

2026-10-26 已完成远端 artifact 核对、AI 新包实际启动、R2 上传及公开目录/包回读。
线上 AI 为 `1.1.1`，其他七项保持原值；应用内“插件中心 → 检查更新”可安装。

## Vinted 监控 1.1.1 独立更新

`studio.vinted-monitor 1.1.1` 修复衣柜请求域名和匿名 Cookie 会话缺失造成的采集失败，
并提供带阶段、HTTP 状态的错误信息。插件数据和 RPC 方法保持兼容，
主程序版本不变，更新从现有插件商店分发。
2026-10-25 已完成远程构建、加密包实网采集验证、R2 上传和目录/包回读校验；
线上 Vinted 版本为 `1.1.1`，其他 7 个插件条目未变。证据见[质量记录](09-quality-and-testing.md)。

`.github/workflows/plugin-release.yml` 由 `plugin-vinted-monitor@<版本>` 标签触发。
仅在远程构建 Vinted 插件及其依赖，运行插件测试和 lint，
校验标签、package/manifest、目录和包摘要，再实际启动包核验全部 RPC 方法。
产物名称为 `plugin-market-plugin-vinted-monitor@<版本>`，只包含该插件与局部目录。

发布时下载这个 CI artifact，回读 R2 原目录，仅合并 Vinted 条目；
先上传新版本包并回读校验，确认原目录未变后再上传合并目录并复核。
其他插件及历史版本包保持原字节。CI artifact 完成不等于 R2 已上线，
实际结果单独记录在质量文档。用户在“插件中心 → 检查更新”安装该版本。

## 0.1.10 配套插件

本次主程序配套 AI 生图 `studio.ai-image 1.1.0` 与
Vinted 监控 `studio.vinted-monitor 1.1.0`。
AI 插件增加智能场景规划、逐视角生成与失败重试；Vinted 插件增加独立代理、
商品归档与过滤、卖家资料和供 AI 选图使用的图片传输。
插件私有数据目录不随版本变化，升级读取并保留既有资料。

发行工作流只为这两个有源码变更的插件产生新包和局部目录。
`plugin-market-v0.1.10` artifact 不能直接覆盖线上 `catalog.json`；
上传时先回读商店、合并这两项，再按下述流程上传新版本包与目录。
共享货源、SIM8、代理池等其他插件保留线上版本及包摘要。
本节说明发行配置，实际上传和回读结果见[质量记录](09-quality-and-testing.md)。

应用不再内置任何插件：安装包只带 Node 运行时和浏览器适配器，插件列表来自用户填写的商店地址。
插件以加密的 `.nexuspkg` 发布，本机下载后校验、解密、安装并立即启动，之后由定时扫描发现新版本。

## 0.1.9 配套插件发布流程（2026-10-24）

AI 生图 `studio.ai-image` 与共享货源 `studio.shared-supply` 均升为 `1.0.1`。
前者提供 100 个生活场景、独立识图模型及参考图选择；后者提供继承应用代理的图片下载与分块读取。
主程序页面和插件需配套更新，单独升级桌面安装包不会替换已安装插件。

`.github/workflows/release.yml` 的 `plugins` 任务与桌面打包并行执行：
按根锁文件安装依赖，只构建这两个插件及依赖，生成加密包、实际启动验证握手，
将两包和局部目录保存为 `plugin-market-<标签>` artifact。
该任务无需 Cloudflare 凭据；主程序自动公开 Release 前会检查插件任务成功。

本轮不在本地构建。发布操作下载远端产物，例如：

```bash
rtk gh run download <run-id> --repo joltzeal/nexus-studio \
  --name plugin-market-v0.1.9 --dir /tmp/nexus-v0.1.9-plugins
```

**artifact 中的目录只含本次两个插件，不能直接覆盖线上目录。** 上传流程为：

1. 用 Wrangler `--remote` 读取最新线上 `catalog.json`。
2. 校验 artifact 中两个包的 ID、版本、大小、SHA-256 与清单一致；拒绝降级或覆盖同版本不同字节。
3. 在保留其他插件条目的基础上合并这两个新版本，并保留旧包对象。
4. 先将两个新包上传到其版本路径，回读并核对 SHA-256。
5. 确认线上目录未被其他发布修改后，最后上传合并后的目录，再回读核对版本及其他条目。

插件包继续使用一年 immutable 缓存，目录使用 60 秒缓存。
用户可在插件中心点“检查更新”安装新版本，或等待现有后台扫描。
这里描述发布流程；实际 R2 上传完成应以远端回读结果为准，不能用 workflow artifact 代替。

## 2026-10-23 配套插件发布

本次向 `nexus-studio-market` R2 桶发布以下新包：

| 插件                                   | 版本    | 内容                                           |
| -------------------------------------- | ------- | ---------------------------------------------- |
| 窗口同步 `studio.window-sync`          | `1.0.0` | 设备配对与窗口快照直连传输，最低主程序 `0.1.3` |
| 代理池 `studio.proxy-pool`             | `1.0.2` | 代理资料迁移、导入补偿及提交接口               |
| Vinted 账号池 `studio.vinted-accounts` | `1.0.1` | 账号和窗口关联迁移、导入补偿及提交接口         |

三个包均通过解包后的实际启动与宿主握手检查。其余四个插件保留既有版本和包字节，
避免对设置了长期 immutable 缓存的同版本地址重新加密打包。
上传先写包，最后写包含七个插件的 `catalog.json`，全部使用 Wrangler `--remote`。
应用中点插件商店的“检查更新”可立即刷新目录；桌面应用标签发布不会代替插件上传。
回读与检查结果记录在[质量验证](09-quality-and-testing.md)。

## 1. 当前事实

| 项目             | 现状                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| 默认插件列表     | 空。发布构建不再扫描安装包内的插件目录                                     |
| 开发构建         | 仍列出 `plugins/*` 工作区插件，方便宿主开发；`NEXUS_PLUGIN_DEV_ROOTS` 可加 |
| 商店地址         | 手动填写，存于 `<应用数据>/plugins/store.json`（0600，临时文件 + rename）  |
| 检查时机         | 保存地址后立即检查；启动约 40 秒后首次扫描，之后每 30 分钟一次             |
| 安装来源         | `catalog.json` 里的 `package.url`，相对路径按商店根地址解析                |
| 完整性           | 下载后比对 catalog 中的 SHA-256，再逐文件校验包内摘要                      |
| 版本比较         | SemVer。高于已装版本才升级，同版本重装覆盖，低于已装版本直接拒绝           |
| 插件代码形态     | 单文件 ESM 打包 → AES-256-GCM 加密 → `payload.bin`，包内只有密文           |
| 进程入口         | 包内生成的 `bootstrap.cjs`，运行时解密到内存再加载                         |
| 发布构建的插件源 | 只有商店。安装包内不再随附明文插件                                         |

## 2. 商店目录结构

商店就是一个静态目录（Cloudflare R2、S3、任意静态托管均可）：

```
catalog.json
plugins/studio.vinted-accounts/1.0.0.nexuspkg
plugins/studio.vinted-monitor/1.0.0.nexuspkg
```

`catalog.json`：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-22T09:00:00.000Z",
  "plugins": [
    {
      "manifest": {
        "apiVersion": 1,
        "id": "studio.vinted-accounts",
        "version": "1.0.0",
        "name": "Vinted 账号池",
        "minCoreVersion": "0.1.0",
        "capabilities": ["account.pool"],
        "permissions": {
          "networkDomains": [],
          "wantsBrowserAccess": false,
          "storage": "private",
          "secrets": []
        }
      },
      "description": "账号池与窗口关联",
      "changelog": "首个版本",
      "package": {
        "url": "plugins/studio.vinted-accounts/1.0.0.nexuspkg",
        "size": 94835,
        "sha256": "…64 位小写十六进制…"
      }
    }
  ]
}
```

宿主对 catalog 的容错规则：

- `schemaVersion` 必须是 `1`，`plugins` 最多 256 条。
- 单条解析失败或 manifest 校验失败时**跳过该条**，其余照常显示，不会整份清单作废。
- `package.sha256` 必须是 64 位十六进制，否则该条被丢弃。
- 同一 `id` 出现多次时只保留第一条。

`package.url` 可以是相对路径（按 `catalog.json` 所在目录解析），也可以是完整的 `http(s)://` / `file://` 地址。

## 3. `.nexuspkg` 容器

宿主只做切片和校验，不做解密，因此 Rust 侧不需要任何加密实现。

```
偏移 0   "NXP1"                     4 字节 magic
偏移 4   header 长度                 u32 大端
偏移 8   header                      UTF-8 JSON
其后     files[] 依次拼接的原始字节
```

header：

```json
{
  "schemaVersion": 1,
  "manifest": { …插件清单… },
  "entry": "bootstrap.cjs",
  "description": "…",
  "changelog": "…",
  "createdAt": "2026-10-22T09:00:00.000Z",
  "files": [
    { "path": "nexus.plugin.json", "size": 308, "sha256": "…" },
    { "path": "bootstrap.cjs", "size": 2219, "sha256": "…" },
    { "path": "package.json", "size": 88, "sha256": "…" },
    { "path": "payload.bin", "size": 91293, "sha256": "…" }
  ]
}
```

宿主安装时的约束（`core/plugin_host/package.rs`）：

- 包体上限 32 MiB，header 上限 128 KiB，文件数上限 64。
- 文件路径必须是纯相对路径：不接受 `..`、绝对路径、反斜杠、空段，只允许 `A-Z a-z 0-9 . - _`。
- 每个文件按 header 的 `size` 切片并比对 `sha256`，任何一个不符即整包拒绝。
- `entry` 必须出现在文件表里。

安装写入 `installed/<id>/<version>/`，先写暂存目录再整体 rename，失败不会留下半个版本。

## 4. 加密与密钥

`payload.bin` 的布局：

```
"NXPAY1\n"   7 字节
nonce       12 字节
密文        AES-256-GCM
tag         16 字节
```

密钥不在包里。宿主按插件 id 与版本推导后通过 `NEXUS_PLUGIN_KEY` 传给插件进程：

```
key = SHA-256(salt + "\n" + pluginId + "\n" + version)
```

- `salt` 存在 `apps/desktop/src-tauri/src/core/plugin_host/market.salt`，用 `include_str!` 编进应用二进制，打包脚本读同一个文件。
- 两侧各有一次已知向量测试（Rust 的 `package_key_matches_the_packer`、Node 的 `derives the same key the desktop host uses`），任何一边改动都会立刻失败。

包内生成的 `bootstrap.cjs` 做的事：读 `payload.bin` → 用 `NEXUS_PLUGIN_KEY` 解密 → 把明文写进系统临时目录的 0600 文件 → 把 `process.argv[1]` 指向它 → `import()` → 进程退出时删除。写临时文件是因为插件靠「`argv[1]` 与 `import.meta.url` 相同」判断自己是不是进程入口，加密包不能破坏这个约定。

**边界要说清楚**：这是「源码不可直接阅读与复制」级别的保护，不是密码学意义上的机密性。salt 编在应用里，拿到应用二进制的人可以逆出密钥；明文在进程运行期间短暂落在临时目录。它挡住的是「打开 R2 桶把 JS 拷走」这类复制，不挡有针对性逆向。

## 5. 应用侧行为

- 商店地址：`https://`、`http://`、`file://` 三种。省略协议时补 `https://`；末尾不是 `.json` 时补 `/catalog.json`；查询串和 fragment 会被丢弃。
- 拉取在 Rust 侧完成（`reqwest`，25 秒超时），**不经过 WebView，因此商店不需要配置 CORS**。
- 失败只记录在 `store.json` 的 `lastError` 上，后台扫描失败不会弹窗；页面把错误显示在商店面板里。
- 安装失败（校验不符、manifest 不合法、包损坏）不改动已安装版本。
- 升级流程：停旧进程 → 写新版本目录 → 换登记表记录 → 删除旧版本目录 → 启动新进程。插件私有数据目录 `data/<id>` 不随版本变化，升级后数据仍在。
- 已安装但没有商店时，插件照常运行；商店只是安装与升级的来源。

## 6. 本地执行方案

### 6.1 打包一个插件

```bash
pnpm build:packages                 # 编译 packages/* 与 plugins/*
pnpm market:pack                    # 产物写到 market/plugins/<id>/<version>.nexuspkg
pnpm market:catalog                 # 汇总成 market/catalog.json
```

只打一个插件：

```bash
node scripts/pack-plugin.mjs plugins/vinted-accounts
node scripts/build-market.mjs
```

`market:pack` 会打印包大小与打包后的源码大小；`catalog.json` 每个插件只保留最高版本。

### 6.2 上线前自检

```bash
pnpm market:verify market/plugins/studio.vinted-accounts/1.0.0.nexuspkg
```

它用宿主同样的密钥解开包、真正启动 `bootstrap.cjs`，等到 `ready` 才退出：

```
ok studio.vinted-accounts 1.0.0
   方法 8 个：vinted.accounts.list, …
   状态 {"storage":"file","storageDurable":true,"pid":16093}
```

这一步能抓住打包后才会暴露的问题：密钥派生不一致、loader 语法错误、依赖没打进 bundle、入口没有自动启动。

### 6.3 不联网自测整个商店

`file://` 商店不需要起服务：

```bash
node -e "console.log('file://' + require('node:path').resolve('market'))"
```

把打印出来的地址填进「插件中心 → 商店设置」。宿主的 `file://` 分支直接读磁盘，走的是和 HTTPS 完全相同的 catalog 解析、校验与安装路径。

想验证 HTTP 分支：

```bash
cd market && python3 -m http.server 8787
```

地址填 `http://127.0.0.1:8787`。

### 6.4 上传 Cloudflare R2

一次性准备：

```bash
npx wrangler login                          # 浏览器授权
npx wrangler r2 bucket create nexus-studio-market
npx wrangler r2 bucket list                 # 确认桶在远端存在
```

日常上传用仓库脚本，它按 catalog 只传最新包，先传包再传 catalog，缓存头也写好了：

```bash
pnpm market:publish                      # 默认桶 nexus-studio-market
pnpm market:publish -- --dry-run         # 只打印命令，不真的上传
pnpm market:publish -- --bucket 其他桶名
```

> **必须带 `--remote`。** Wrangler 4 把 `r2 object put/get/delete` 默认指向本地模拟器，
> 不带 `--remote` 时命令会「成功」，但文件只写进仓库下的 `.wrangler/state/v3/r2/`，
> 真实桶里什么都没有。脚本已经内置 `--remote`；手敲命令时别漏。

不想用脚本时，手动等价命令是（`catalog.json` 必须短缓存，插件包可以长缓存）：

```bash
for file in $(find market -name '*.nexuspkg'); do
  npx wrangler r2 object put "nexus-studio-market/${file#market/}" \
    --file "$file" --content-type application/octet-stream \
    --cache-control "public, max-age=31536000, immutable" --remote
done
npx wrangler r2 object put nexus-studio-market/catalog.json \
  --file market/catalog.json --content-type application/json \
  --cache-control "public, max-age=60" --remote
```

顺序很重要：先传包，最后传 catalog。中途失败时线上 catalog 仍然只指向已经存在的包。

传完可以验证一次，确认东西真在远端：

```bash
npx wrangler r2 object get nexus-studio-market/catalog.json --remote --file /tmp/catalog.json
```

Wrangler 4 没有 `r2 object list`（只剩 `get` / `put` / `delete`），所以「桶里到底有什么」只能靠逐个 `get` 来确认。想连内容一起核对，就把 catalog 里每个包的 sha256 跟下载回来的文件对一遍：

```bash
node -e "for (const p of require('./market/catalog.json').plugins) console.log(p.package.url, p.package.sha256)" |
while read -r key want; do
  npx wrangler r2 object get "nexus-studio-market/$key" --remote --file "/tmp/$(echo "$key" | tr '/' '_')"
  shasum -a 256 "/tmp/$(echo "$key" | tr '/' '_')" | grep -q "$want" && echo "OK   $key" || echo "DIFF $key"
done
```

本地模拟器留下的 `.wrangler/` 可以直接删掉，它不影响任何东西，并且已经在 `.gitignore` 里。

> **`npx` 报 `EBADDEVENGINES`**：`package.json` 的 `devEngines.packageManager` 声明了 pnpm，
> 而 npm 只认识 `onFail` 的 `warn` / `error` / `ignore` 三个值。历史上这里写的是 pnpm 专用的
> `download`，npm 会把它当成非法配置直接报错，导致仓库内任何 `npx` 都跑不起来。
> 现已改为 `warn`：版本不匹配时 pnpm 只提示而不自动下载，npm 也能正常执行 `npx`。
> 如果你的分支还是旧值，改成 `warn` 即可，或改用 `pnpm dlx wrangler@4 …`。

开放读取（二选一）：

- 桶设置里开启 **Public Development URL**，得到 `https://pub-xxxxxxxx.r2.dev`。
- 绑定自定义域名，例如 `https://market.example.com`。

应用里填桶根地址即可，`/catalog.json` 由宿主补上：

```
https://pub-xxxxxxxx.r2.dev
https://market.example.com
```

不需要配置 CORS —— 请求由 Rust 发起，没有浏览器同源限制。

### 6.5 发一个新版本

1. 改 `plugins/<name>/nexus.plugin.ts` 的 `version`。
2. `pnpm build:packages && pnpm market:build`。
3. `pnpm market:verify market/plugins/<id>/<新版本>.nexuspkg`。
4. `pnpm market:publish`。
5. 应用侧最迟 30 分钟看到更新；点「检查更新」立即生效。

旧版本的 `.nexuspkg` 留在桶里没有害处：catalog 只引用最新版，旧包可以在需要时手工回滚。

## 7. 已知边界

- 没有签名验证。完整性靠 catalog 里的 SHA-256，可信度等于商店地址本身；商店被接管就能推任意插件（但密钥仍由应用侧推导，攻击者只能发布自己打包的插件，无法读出你的源码）。
- 没有增量下载，每次升级下载完整包（当前单包 100 KB 量级）。
- 不支持多商店，也不支持私有商店鉴权头。需要时再加。
- 降级只能手工：把 catalog 的版本改低后应用会拒绝安装，必须先卸载。
- 明文在进程运行期间短暂存在临时目录，见第 4 节的边界说明。
