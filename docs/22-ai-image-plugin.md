# AI 生图插件 `studio.ai-image`

本文说明仓库内 AI 生图插件的实际范围。插件规则见[插件对接开发规范](14-plugin-integration-guide.md)，
页面交互见[页面交互](11-demo-pages.md)，宿主协议见[插件宿主](17-plugin-host.md)。

## 当前事实

插件包位于 `plugins/ai-image`，实现 `image.provider` 能力的 16 个方法、私有存储、
图片文件存储与逐行 JSON RPC 服务端。页面位于 `apps/desktop/src/features/ai-image`。

- 只支持两个服务商类型：`openai`（OpenAI 官方）与 `openai_compatible`（兼容接口）。
  参考实现里的 `website_tasks` 网站异步生图通道已删除，`mhoo_images` 与
  `chat_completions` 生图分支也未迁移：本插件只走 `POST /images/generations`
  与 `POST /images/edits`。
- 生图模型与文案模型都配置在插件里，API Key 按**明文**保存在插件私有目录的
  `ai-image.json`（0600）。宿主不托管这些密钥，也不提供回读接口。
- 文案模型的作用是看图写标题与描述；它在生图之后运行，读的是本次生成的成片。
- 每次生成都是一条记录，主页即生成记录列表；记录上限 120 条，超出后淘汰最旧的并删除其文件。
- 图片不落宿主，也不写系统相册：文件在插件私有目录的 `images/`，导出时复制到 `exports/`。

## 包结构

```text
plugins/ai-image/
├── package.json          # ESM、锁定依赖、dist 由构建生成
├── nexus.plugin.ts       # manifest 唯一来源，由 definePluginManifest 校验
├── src/
│   ├── index.ts          # 组装存储、能力与协议；进程入口
│   ├── capabilities/     # image.provider 方法表
│   ├── domain/           # 场景预设、zod 校验、错误码、类型与常量
│   ├── rpc/              # 协议、服务端、脱敏日志（与另三个插件同源，按包自包含）
│   ├── services/         # OpenAI 兼容接口调用（生图、改图、文案、连通性检查）
│   └── store/            # 私有 JSON 文档与图片文件存储
└── dist/                 # 构建产物：dist/src/index.js 与 dist/nexus.plugin.json
```

manifest 声明：`apiVersion: 1`、`id: studio.ai-image`、`version: 1.0.0`、
能力 `image.provider`、域名 `api.openai.com` / `api.deepseek.com` / `openrouter.ai` /
`api.siliconflow.cn` / `api.moonshot.cn` / `dashscope.aliyuncs.com`、
`wantsBrowserAccess: false`、`storage: private`、密钥槽为空数组。

密钥槽为空是有意的：API Key 由用户填在插件自己的配置里、存在插件自己的文档里，
不经过宿主的密钥槽写入命令，所以这里不需要声明槽位。域名列表是预置的常见兼容网关，
换成别的自建网关需要同步改 manifest，否则宿主会拒绝该请求。

## 与 nexus-cart `vinted-scenes` 的对应关系

参考实现是一个批量套图工作台（批次列表、参考图选择器、历史弹窗）。本次只搬功能，
不搬批量流程，对应关系如下：

| 原模块                                                | 本插件 / 页面                               | 变化                                                     |
| ----------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| `providers-sheet.tsx` 的 `image_api` 四选一           | `features/ai-image/providers-sheet.tsx`     | 只留 `images` 一种调用方式，删掉网站异步通道             |
| `api.ts` 的 `ProviderBody`（snake_case）              | `src/domain/schemas.ts`                     | 字段改 camelCase，用 zod 校验地址与尺寸                  |
| `templates.ts` 的 presentation × environment × camera | `src/domain/presets.ts`                     | 三个级联下拉改为 10 个一键场景预设，自由提示词照原样发送 |
| `batch-list.tsx` + `batch-reference-picker.tsx`       | `ai-image-page.tsx` + `generate-dialog.tsx` | 批次改为单次生成记录；参考图改为弹窗内 1–6 张上传        |
| `detail-dialog.tsx` 的左右并排对比                    | `compare-slider.tsx`                        | 改为滑动对比：一张叠一张，拖分割线看前后                 |
| `history-dialog.tsx`                                  | 主页记录列表 + `detail-dialog.tsx`          | 历史升为主页，详情单独成弹窗                             |
| `structuredScenePrompt`（策略 + 兼容矩阵）            | `composePrompt`                             | 去掉策略矩阵，固定“还原商品本体 + 场景句 + 附加要求”     |
| 后端任务表与轮询                                      | 插件记录 + 页面轮询                         | 记录即任务状态，页面每 2.5 s 读一次                      |
| 参考图文件服务                                        | `image.upload.*` / `image.file.chunk`       | 分块 RPC 代替 HTTP 上传与静态文件服务                    |

## 方法清单

| 方法                     | 作用                                               |
| ------------------------ | -------------------------------------------------- |
| `image.providers.list`   | 列出服务商，只回显 `hasApiKey` 与末四位提示        |
| `image.providers.save`   | 新增或修改；省略 `apiKey` 时保留原值               |
| `image.providers.remove` | 删除服务商，按 id 幂等                             |
| `image.providers.test`   | `GET /models` 检查地址与 Key，返回模型数量         |
| `image.presets`          | 返回 10 个场景预设（id、名称、说明、提示词）       |
| `image.upload.begin`     | 开始上传，返回 `uploadId` 与建议分块大小           |
| `image.upload.chunk`     | 追加一块 base64，累计不得超过声明尺寸              |
| `image.upload.finish`    | 校验总大小后写入 `images/`，返回文件描述           |
| `image.upload.abort`     | 丢弃未完成的上传会话                               |
| `image.file.chunk`       | 按偏移读取图片字节，供页面显示或导出前校验         |
| `image.records.list`     | 按状态筛选、按时间倒序分页，返回总数与是否可持久化 |
| `image.records.get`      | 取单条记录（页面轮询用）                           |
| `image.records.remove`   | 删除记录并清理它的输入与输出文件                   |
| `image.records.retry`    | 重置状态后重新执行同一条记录                       |
| `image.records.export`   | 把输出复制到 `exports/`，返回可复制的路径          |
| `image.generate`         | 建记录并立即返回 `running`，真正执行在后台         |

同时最多 6 个上传会话、120 条记录；单张参考图上限 8 MiB，只接受
`image/png`、`image/jpeg`、`image/webp`。超过上限是明确拒绝，不静默截断。

## 上游协议

- 文生图：`POST {baseUrl}/images/generations`，JSON 入参 `model`、`prompt`、`n`，
  需要固定尺寸时带 `size`（`auto` 不带）。响应取 `data[].b64_json`，没有 base64
  时按 `url` 回源下载一次。
- 改图：`POST {baseUrl}/images/edits`，multipart，参考图字段名为 `image[]`
  （多张即多个同名字段），其余字段与文生图一致。请求里不带 `size` 表示交给模型。
- 文案：`POST {baseUrl}/chat/completions`，一条文本指令加最多两张 `image_url`，
  要求只回 `{"title","description"}`。模型返回代码块或夹带说明时也能解析出 JSON；
  解析不出来算文案失败，不影响已生成的图片。
- 连通性：`GET {baseUrl}/models`，只用来确认地址与 Key 可用。
- `dall-e-3` 只认 1792 长边，`1024x1536` / `1536x1024` 会别名成 `1024x1792` / `1792x1024`。
- 超时：生图 180 s、文案 60 s、连通性 20 s；失败按 401/403、404、429、4xx、5xx
  分别映射成 `AUTH_FAILED`、`UNAVAILABLE`、`RATE_LIMITED` 等可读中文原因。

## 场景预设与提示词

预设不是模板填空，而是一句写好的场景描述。选择预设时，实际发出的提示词是：

```text
<还原约束：重建商品本体，保留形状/材质/颜色/图案/可见文字，去掉原背景与光影>
<场景句：白底棚拍、客厅沙发、手持随拍……>
Additional requirements: <用户填的附加要求>
```

不选预设时，用户输入的提示词原样发送，不加任何前缀。整段提示词截断到 6000 字符。
预设名称会快照到记录上，之后改名不影响历史。

| id                 | 名称       | 适用           |
| ------------------ | ---------- | -------------- |
| `white-studio`     | 纯白棚拍   | 电商主图       |
| `grey-studio`      | 浅灰棚拍   | 需要材质质感   |
| `home-sofa`        | 客厅沙发   | 家居生活场景   |
| `bedroom-bed`      | 卧室床铺   | 床品、纺织     |
| `wood-desk`        | 木质书桌   | 桌面平铺       |
| `kitchen-counter`  | 厨房台面   | 厨具、餐具     |
| `wall-hang`        | 墙面挂置   | 画类、挂件     |
| `store-shelf`      | 货架陈列   | 零售陈列       |
| `outdoor-daylight` | 户外自然光 | 户外用品       |
| `hand-hold`        | 手持随拍   | 二手平台实拍感 |

## 数据边界

- `ai-image.json`（0600）存服务商与记录，`images/` 存上传的参考图与生成的图片，
  `exports/` 存导出副本。三个位置都在宿主注入的插件私有目录下，宿主不读取。
- 私有文档用 `z.looseObject` 校验：已知字段必须合法，多出来的字段原样保留，便于以后加字段。
  `schemaVersion` 必须是 1；不是合法 JSON 或结构不符时拒绝读写并给出明确原因，
  不会把旧文档清空重写。
- 写入走“临时文件 + rename”，修改失败时保留上一版文档，本次修改不落盘。
- 导出文件名带序号，重复导出不会覆盖已有文件。
- 宿主未提供私有目录时退回内存存储，重启即丢，页面标注“仅本次运行”。

## 外部服务、费用与数据发送

| 服务                                                                               | 用途              | 发送内容                               | 费用与限制                       |
| ---------------------------------------------------------------------------------- | ----------------- | -------------------------------------- | -------------------------------- |
| `api.openai.com`                                                                   | 官方生图与文案    | 提示词、参考图、生成的图片（文案阶段） | 按官方计价，图片按张计费         |
| `api.deepseek.com` 等兼容网关                                                      | 兼容接口生图/文案 | 同上                                   | 取决于所选服务商，插件不代为计费 |
| `api.siliconflow.cn`、`api.moonshot.cn`、`dashscope.aliyuncs.com`、`openrouter.ai` | 兼容网关          | 同上                                   | 同上                             |

插件不发送本机路径、窗口资料、代理配置或收藏内容；参考图只在生图与文案请求中出现。
图片里可能包含商品实拍的背景信息，是否上传由用户自己决定。

## 已知限制

- 只实现了 `/images/generations` 与 `/images/edits`。走 chat 多模态出图、或需要
  异步任务轮询的接口，本插件不支持。
- 文案模型必须支持看图；关掉“支持看图”开关后不会调用文案阶段，记录里标题与描述为空。
- 后台任务按记录独立执行，没有并发上限；同时提交多条会并行请求上游。
- 记录上限 120 条，淘汰最旧记录时会删除其图片文件，已导出的副本不受影响。
- 导出是把文件复制到插件私有目录，需要用户自己复制路径去取；桌面端没有保存对话框。
- 只在 macOS 上执行过类型检查、单测与宿主安装/启用/调用测试；Windows 未验证。

## 本地验证

```bash
pnpm --filter @nexus/plugin-ai-image build
pnpm exec vitest run plugins/ai-image
pnpm exec eslint plugins/ai-image apps/desktop/src/features/ai-image --max-warnings 0
```

插件侧 33 个用例：预设组合与截断（5）、地址归一化与凭据拒绝（3）、
私有存储持久化与损坏拒绝（5）、图片分块读写与导出不覆盖（5）、
能力层 15 个（服务商保存与密钥保留、文生图落盘、改图走 multipart 且带 `image[]`、
文案读取成片、鉴权失败映射、文案失败不影响图片、空提示词与缺参考图拒绝、
记录筛选与删除清理文件、上传未完成拒绝、内存存储拒绝导出）。

这些用例都替换了全局 `fetch`，不请求真实接口，因此不证明上游行为、不证明计费，
也不代表 Windows 上的文件权限表现。
