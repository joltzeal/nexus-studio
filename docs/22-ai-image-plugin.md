# AI 生图插件 `studio.ai-image`

本文说明 `plugins/ai-image` 与 `apps/desktop/src/features/ai-image` 的当前实现。
宿主边界见[插件对接规范](14-plugin-integration-guide.md)与[插件宿主](17-plugin-host.md)。

## 当前能力

插件提供 `image.provider` 的 20 个 RPC 方法，支持 `openai` 与 `openai_compatible`。
生图只走 `/images/generations` 与 `/images/edits`；独立识图与文案使用 `/chat/completions`。
不支持网站自动化生图、chat 多模态出图或异步轮询型供应商通道。

- 生图、识图、文案是三个独立模型字段。识图服务商可以不同于生图服务商。
- 生图前可识别一张参考图；生成完成后可在详情选择一张成片，明确点击识图。
- API Key **明文**保存于插件私有目录 `ai-image.json`（0600），只回显有无及末四位提示。
- 每次生成是一条记录，按 120 条回收旧记录，活动任务保留；图片在私有目录 `images/`，
  导出副本在 `exports/`。
- 支持从商品图库选择最多六张参考图，生成记录可保存来源，并从商品页查看来源专属历史。
- 支持智能识图推荐场景、编辑提示词与单图多视角生成，见[智能场景规划](31-ai-scene-planning.md)。
- 主程序与插件分别发布，页面和插件需配套更新；本地不运行构建或打包。

## 包结构与宿主边界

`nexus.plugin.ts` 是 manifest 来源；`src/domain` 定义预设、输入校验与类型，
`src/services/openai.ts` 负责请求，`src/capabilities/ai-image.ts` 组织流程，
`src/store` 负责私有文档与图片文件，`src/rpc` 提供逐行 JSON RPC。
页面只通过宿主调用插件，不直接持有服务商 API Key 或直连模型接口。

manifest 保持 `apiVersion: 1`、`studio.ai-image`，
`wantsBrowserAccess: false`、`storage: private`、`secrets: []`。
网络域名声明含 OpenAI 及常见兼容网关；这是权限声明，不将它描述为网络执行沙箱。

## 商品来源、图库选图与历史

前端共享类型从 `apps/desktop/src/lib/page-handoff.ts` 导出，也由 AI 页面类型模块转出：

```ts
interface GenerationSource {
  pluginId: string
  itemId: string
  title: string
  url: string
}

interface AiImageHandoff {
  images: string[]
  title: string
  source?: GenerationSource
  initialPrompt?: string
}
```

`images` 仅包含用户在图库选择的 URL，按选择顺序传入；不重新抓取整组图库。
`initialPrompt` 是可编辑的商品标题/描述，省略时为空，不自动添加方向性指令。
handoff 只打开现有 `GenerateDialog` 并传输参考图，不自动生成、识图或调用付费模型。
手动提交时仍使用原有预设、提示词与模型选择流程。
没有可用服务商时，“去配置”在原生成弹窗上覆盖打开 `ProvidersSheet`，不消费 handoff
或卸载 `GenerateDialog`。提示词草稿、来源、选图与已上传文件保留，进行中的传输继续；
保存配置后关闭侧栏即可回到原任务，只有关闭生成弹窗或成功提交才结束 handoff。

`image.generate` 新增可选 `source`，以相同结构保存到 `GenerationRecord.source`。
`pluginId/itemId` 各为 1–128 字符，`title` 为 1–500 字符，`url` 最多 2048 字符；
字段去除首尾空白，URL 必须为无内嵌账号密码的完整 HTTP(S) 链接，不接受额外字段。
调用方仅传公开商品信息，不能放入凭据或令牌。Vinted 的 `itemId` 使用监控插件的
完整内部标识 `domain:externalId`，不能只传数字或用标题关联。
来源元数据不会拼接到提示词，也不会发送给生图、识图或文案模型。
初始失败、记录读取、进程重启、生成重试均保留来源；旧记录缺少来源时仍无来源，
不根据标题、图片或 URL 猜测关联。列表和详情显示来源标题与商品链接。

`image.records.list` 保留 `page/size/status`，新增一对可选字段：

```ts
{
  page: 0,
  size: 10,
  sourcePluginId: 'studio.vinted-monitor',
  sourceItemId: 'vinted.fr:123',
}
```

两字段必须同时提供，否则拒绝请求；不需要传完整 `source`、标题或链接。
先按两个标识及可选状态筛选，再按创建时间倒序分页，`total` 为筛选后的总数。
提供来源筛选时，响应额外返回
`sourceFilter: { sourcePluginId, sourceItemId }`，用于确认已实际应用筛选。
分页与来源筛选字段保持兼容。列表返回 `GenerationSummary`，仅携带页面需要的
预览与状态；完整识图观察、方案和各视角实际提示词通过 `image.records.get` 读取。
预览长度限制只作用于列表响应，不裁剪持久化记录，不改变实际发送给模型的内容。
列表提示词预览最多 500 个转义后 JSON UTF-8 字节，来源标题预览最多 120 字节，
按完整 Unicode 字符截取；来源标识和 URL 不截断。输出图片只包含 `id/mime`，
智能视角只包含 `status/outputFileId`，成片识图只包含状态。
输入图片、文案、错误明细、模型观察和完整方案在详情读取，不能将列表摘要作为重试输入。
页面检测旧插件拒绝字段、缺少筛选确认或返回其他来源记录时，明确提示更新 AI 生图插件，
不将其显示为“没有历史”。带来源的生成在提交前进行一次只读来源列表兼容检查；
不兼容时阻止提交，不能删除来源后再次请求。若提交响应意外丢失来源，则提示任务已提交、
先检查记录、不要重复生成，不假报关联成功。

父页面直接使用以下导出，不需要管理 AI 插件状态或模型提供方：

```tsx
import { SourceImageHistoryDialog } from '@/features/ai-image/source-image-history-dialog'
import type { GenerationSource } from '@/lib/page-handoff'

// props: { source: GenerationSource; onClose: () => void }
;<SourceImageHistoryDialog source={source} onClose={closeHistory} />
```

历史弹窗检查实际宿主目录，区分非桌面、未安装、已禁用、启动/重试中与运行状态；
仅读取已安装、已启用且运行中的 AI 插件。提供分页、空状态、读取错误与重试，
可见记录的生成或成片识图正在执行时轮询，完成后停止记录轮询。
选择记录复用 `RecordDetailDialog` 并载入当前模型提供方。切换来源或分页时丢弃旧请求回调，
删除最后一页记录后回到有效页码。

当 `source.pluginId === 'studio.vinted-monitor'` 时，参考图必须通过父页面导出的
`loadVintedImage(itemId, url, signal)`（`@/features/vinted-monitor/api`）下载，
再包为 `File` 传给 AI 插件现有 `uploadImage` 分块上传。此转运不调用 `prepareReference`，
不解码、缩放或重新编码，原始字节与 MIME 保留。Vinted 参考图继续使用监控插件的采集代理；
AI 网关仍沿用 AI/应用网络策略，不改全局代理。两个插件后端互不调用，
仅前端经 IPC 协调；WebView 不 fetch 远程 URL，也不直接用远程 URL 预览。
其他来源保留 AI 插件原有远程下载流程，本地文件仍按既有规则预处理。

传输失败的选择留在列表中并阻止生成，可按原选择重试或明确移除；
失败不自动回退为 AI 插件直连下载，也不悄悄少传一张。最多六张；
超量 handoff 会保留全部选择并阻止提交，第七张及之后先不传输，
需明确移除多余选择后再重试剩余未传图片。稳定选择 key 在重试时不变，
移除、卸载或新 handoff 会取消旧传输并忽略迟到结果。

## 模型配置与兼容性

| 字段             | 用途                                                      |
| ---------------- | --------------------------------------------------------- |
| `imageModel`     | 生图或改图；生成时必须非空                                |
| `visionModel`    | 独立图片理解；不会从 `textModel` 或 `imageModel` 自动推断 |
| `textModel`      | 标题与描述；留空跳过文案                                  |
| `supportsVision` | 既有文案模型能否直接读取生成成片，不控制独立识图          |

服务商沿用 `id/name/kind/baseUrl/apiKey/imageModel/textModel/supportsVision`。
`image.providers.save` 新增可选 `visionModel`；省略保留已存值，显式空字符串清空。
旧文档读取时缺失的 `visionModel` 视为空字符串。只用于识图的配置可留空
`imageModel`，但三个模型字段至少填写一个。省略 `apiKey` 仍保留原 Key。

页面标签为“生图模型”“识图模型”“文案模型”“文案模型可直接读取成片”。
配置测试仍然只调用 `/models`，不证明某个模型支持识图、生图或结构化返回。

## 100 个原创场景

`src/domain/presets.ts` 固定提供 **100 个不同场景、10 类各 10 个**。
全部为本项目原创英文指令，未复制市场照片或第三方提示词，不声称来自实地摄影调查。
每项含稳定 `id`、中文短 `label`、中文 `category/hint` 与详细英文 `prompt`。
每个场景明确普通欧洲或美国住家环境、承托面、视角和日常光线。

| 分类     | 数量 | 内容举例                         |
| -------- | ---- | -------------------------------- |
| 素色家居 | 10   | 白墙小桌、灰墙边柜、软木垫桌     |
| 客厅角落 | 10   | 布艺沙发、茶几地毯、书柜下层     |
| 卧室织物 | 10   | 棉被床铺、床头小柜、短绒地毯     |
| 书桌餐桌 | 10   | 木质书桌、圆桌一角、折叶小桌     |
| 厨房日常 | 10   | 厨房台面、瓷砖台角、厨房推车     |
| 玄关收纳 | 10   | 家用储物架、玄关鞋凳、壁橱搁板   |
| 庭院阳台 | 10   | 阴天院桌、公寓阳台、门廊木凳     |
| 衣物鞋包 | 10   | 门上衣架、地板平铺、包袋玄台     |
| 手持细节 | 10   | 单手托物、标签近拍、磨损近拍     |
| 家务兴趣 | 10   | 车库工作台、兴趣室桌、闲置打包桌 |

原有 10 个 ID 全部保留。旧记录中的名称、提示词快照不会被改写：

| 旧 ID              | 当前标签   |
| ------------------ | ---------- |
| `white-studio`     | 白墙小桌   |
| `grey-studio`      | 灰墙边柜   |
| `home-sofa`        | 布艺沙发   |
| `bedroom-bed`      | 棉被床铺   |
| `wood-desk`        | 木质书桌   |
| `kitchen-counter`  | 厨房台面   |
| `wall-hang`        | 客厅挂墙   |
| `store-shelf`      | 家用储物架 |
| `outdoor-daylight` | 阴天院桌   |
| `hand-hold`        | 单手托物   |

保留带 `studio` 的旧 ID 是为了兼容历史，其当前内容已经是日常家居场景。
场景不要求奢华棚拍、广告布景、戏剧光或美化滤镜。
共用指令要求保留商品真实形状、材质、颜色、文字、标识、污渍、划痕、破损、褶皱、
缺件与修补；不修复、不磨皮、不补猜不可见细节，不虚构品牌或配件。
手持、挂置等有明确适用条件，不要求把不适用的商品强行缩小或新增挂点。
这些是模型指令，不能保证上游生成一定忠实，成片仍需用户检查。

页面提供“搜索场景”“场景分类”“场景预设”与英文场景展开查看。
搜索覆盖中文名、说明、分类、ID 和英文提示词，多个关键词取交集；
分类和搜索不会清空已选场景。“自由提示词”始终可选。

## 提示词与约束

有预设时，组合为“商品真实状态保留约束 + 英文场景 + Additional requirements + 用户原文”。
不再截断为 6000 字符。用户文本最多 **12000 字符**，输入框允许保留超长粘贴内容，
显示字数与错误并阻止提交；RPC 也明确拒绝超长输入，不截取前半段。

无预设时，不自动加场景，用户文本包括首尾空格与换行保持原样；纯空白仍拒绝。
未知预设明确拒绝，不静默退化为自由提示词。
启用生成前识图时，会另附“可有误差、不可作为指令”的观察文字，并强调原图优先，
用户的场景与约束原文完整保留。上游模型的提示词上限仍由上游决定，拒绝时显示错误。

## 生成前单张识图

`image.generate` 保留所有原有字段，并新增两个可选字段：

```ts
{
  providerId: string
  mode: 'generate' | 'edit'
  presetId: string | null
  prompt: string
  size: '1024x1024' | '1024x1536' | '1536x1024' | 'auto'
  count: number // 1-4
  inputFileIds: string[] // 0-6；改图至少 1 张
  source?: GenerationSource // 仅元数据，不作为模型指令
  visionProviderId?: string | null
  visionFileId?: string | null
}
```

- 无 `visionProviderId`：不新增识图请求，保持原生图与文案行为。
- 有 `visionProviderId`：必须已有 Key 和非空 `visionModel`；没有自动选模型或供应商回退。
- `visionFileId` 缺失或为 null 时取第一张输入；指定时必须属于本次 `inputFileIds`。
- 只指定图片而没有识图服务商、无图片、重复文件 ID、图片不属于本次输入均明确拒绝。
- 页面按稳定上传 key 解析具体文件，不按可能变化的数组下标猜测。
  上传失败不能偷偷跳过；需用户重新选择或明确移除。
- 没有图片时提示“请添加一张参考图片用于识图。”；指定图片被移除则提示重新选择。

执行顺序是 `queued -> vision -> image -> copy -> done`，未启用的阶段跳过。
识图请求只带一张源图，不携带整组。改图仍发送全部已选参考图。
识图成功后观察结果进入生图上下文；若配置文案模型，文案只接收观察文字，
不会把整组或成片再次送去看图，纯文本模型也可用于此阶段。
未启用独立识图时，保留 `supportsVision` 开启后文案读取最多两张生成成片的既有行为。

生成前识图的 HTTP 错误、超时、无效 JSON、空描述或超长描述会让任务失败并阻止生图。
缺失参考图也会失败，不能丢图后继续或把改图退化为文生图。
文案失败仍仅写 `copyError`，不使已经生成的图片作废。

## 详情内单张成片识图

用户先看到已生成的组图，点击缩略图“选择成片 1/2/…”选择目标，默认第一张。
在“成片识图服务商 / 模型”选择配置，点击“识别当前成片”才发出请求。
只有当前成片被发送，不重新生成图片、不改写既有标题与描述。
远程参考图上传时用占位，成功后由 `RecordImage` 通过插件文件 API 显示；
本地 blob 可以即时预览，WebView 不直接加载远程预览 URL。

新增方法 `image.records.recognize`，与现有生成方法一样立即返回 `{ record }`：

```ts
// 新识图：省略或 null fileId 取第一张成片
{ id: string, providerId: string, fileId?: string | null }
// 原选择重试：不允许同时覆盖 providerId/fileId
{ id: string, retry: true }
```

指定图片必须属于该记录的 `outputs` 且文件可读。其他记录图片、参考图、缺失成片
或未配置识图模型均拒绝，不退回第一张。失败在结果区显示，提供
“重试成片识图（原模型与原图片）”。新识图可以显式换图或换服务商；重试固定原选择。

成片识图用独立 `outputVision.status`，原记录的 `status` 保持生成结果；
页面按 `image.records.get` 轮询两种任务状态。进行中的同记录任务阻止删除和重试。

## 新增记录字段与重试

旧记录缺失这些字段仍可读取；`schemaVersion` 仍为 1：

```ts
basePrompt?: string // 识图前的预设与用户约束，重试避免重复附加观察
source?: GenerationSource // 缺失保持无来源，重试与读取时保留
copySupportsVision?: boolean
vision?: {
  providerId: string
  providerName: string
  providerKind: 'openai' | 'openai_compatible'
  model: string
  inputFileId: string
  description: string | null
} | null
outputVision?: {
  providerId: string
  providerName: string
  providerKind: 'openai' | 'openai_compatible'
  model: string
  outputFileId: string
  status: 'running' | 'success' | 'failed'
  description: string | null
  error: string | null
} | null
```

`prompt` 记录实际生图提示词，`basePrompt` 保存识图前版本；旧记录无后者时使用原 `prompt`。
`vision` 保存源图识图快照，`outputVision` 保存最近一次成片识图的模型、图片、结果或错误。
文件 ID 与输入/输出的归属关系在私有文档读取时校验，损坏时拒绝而非猜测替代。

生成重试使用已记录的生图、文案、识图模型和图片；成片识图重试使用已记录的模型与成片。
修改提供方配置不会把已有重试换成新模型；端点和 Key 仍取该提供方当前配置，
便于修正凭据。提供方删除、Key 缺失或文件丢失会明确失败。
旧记录不会因新增了 `visionModel` 而自动启用识图。

## RPC 方法

| 方法                      | 作用                                    |
| ------------------------- | --------------------------------------- |
| `image.providers.list`    | 提供方列表，不回传明文 Key              |
| `image.providers.save`    | 保存配置；省略 Key/visionModel 保留原值 |
| `image.providers.remove`  | 删除配置，保留生成记录                  |
| `image.providers.test`    | GET /models 连通性检查                  |
| `image.presets`           | 返回 100 个场景，含 category            |
| `image.upload.begin`      | 开始分块上传                            |
| `image.upload.chunk`      | 追加图片分块                            |
| `image.upload.finish`     | 校验总大小并写入图片                    |
| `image.upload.abort`      | 放弃上传会话                            |
| `image.upload.remote`     | 插件下载远程图片，按实际字节校验格式    |
| `image.file.chunk`        | 页面分块读取插件图片                    |
| `image.plans.create`      | 后台识图并规划场景与多视角提示词        |
| `image.plans.get`         | 读取规划进度、结果或错误                |
| `image.records.list`      | 按状态与来源筛选，返回倒序分页摘要      |
| `image.records.get`       | 读取记录，含两类识图状态                |
| `image.records.remove`    | 删除记录及其图片文件                    |
| `image.records.retry`     | 重试生成，沿用模型与选图快照            |
| `image.records.recognize` | 识别单张成片，或按原选择重试            |
| `image.records.export`    | 复制输出到私有 exports 目录             |
| `image.generate`          | 创建记录并后台执行                      |

同时最多 6 个上传会话；单图最多 8 MiB，仅接受 PNG/JPEG/WebP。
本地上传预处理会缩放到最长边 1536 像素，原图细节可能因此减少；
远程下载与 Vinted 插件间参考图转运保持原字节。监控图库可展示 GIF，但 AI 参考图
仅接受 PNG/JPEG/WebP；GIF 转运明确失败，不能自动转码或忽略该选择。

## 上游请求与外部数据

- 生图：JSON `POST /images/generations`，传 `model/prompt/n` 与可选 `size`。
- 改图：multipart `POST /images/edits`，参考图字段 `image[]`，其余参数同生图。
- 独立识图：`POST /chat/completions`，明确的识图 `model`，一条文字指令加
  **恰好一个** base64 `image_url`，要求返回 `{"description":"..."}`。
  描述必须非空且不超过 6000 字符，否则报错，不能截断后当作成功。
- 智能规划：相同 chat 路径，只读取所选的一张参考图，返回经过校验的商品观察、
  预设 ID 和逐张视角提示词；生成使用单独的 `n=1` 改图请求，详见智能场景规划文档。
- 文案：相同 chat 路径，使用 `textModel`，要求 `{"title":"...","description":"..."}`。
  独立识图路径不附图片；旧路径最多附两张生成成片。
- 超时：生图 180 秒、识图/文案各 60 秒、连通性/远程图片下载各 20 秒。
- 保留既有尺寸映射与错误分类，供应商不支持模型/格式时显示真实错误。

生图服务商收到提示词和改图参考图；独立识图服务商只收到所选的一张源图或成片。
生成前识图的观察结果还会发送给生图/文案服务商。详情成片识图的观察结果仅保存与显示。
所有请求可能产生供应商费用；用户明确触发，失败不自动重试。
不发送本机路径、窗口资料、代理配置或收藏内容。图片本身可能含背景信息。

## 存储与限制

私有文档用 `z.looseObject` 校验，保留未知字段，写入使用临时文件加 rename。
写入失败不报告已保存；损坏文档拒绝读写，不清空重建。
宿主未提供目录时使用内存，页面标记“仅本次运行”。导出重复文件名不会覆盖。

- 上游需支持相应图像/多模态协议；不保证任意兼容网关或任意模型可用。
- 识图可能误读文字或瑕疵，不能作为成色、真伪或工作状态的保证。
- 成片识图只保存最近一次结果；新识图替换旧识图结果，不建立完整识图历史。
- 进程重启不会自动重发请求。记录列表（含来源筛选）与详情共用读取恢复逻辑，将没有
  活动任务的中断成片识图持久化为失败，允许按原模型与原图片手动重试。
  写入队列内重新检查当前识图状态与活动任务集合，保护真正执行中的生图/识图和已完成结果；
  来源、成片、原生成结果与模型/选图快照保留。恢复失败会报告读取错误，后续读取可重试，
  不伪报已恢复；已恢复的记录不重复写入。历史列表无需先打开详情才能停止中断识图的轮询。
  原生图任务没有自动续跑。没有全局任务并发上限；每条记录独立执行。
- 超过 120 条会淘汰未执行中的旧记录，并清理没有其他记录、方案或正在接入的任务引用的图片；
  活动任务不会被淘汰，导出副本不受影响。
- 导出到私有目录，由用户复制路径取文件；尚无系统保存对话框。

## 本次定向验证

本次只运行无构建的检查，命令使用仓库固定 Node/pnpm：

```bash
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec vitest run plugins/ai-image apps/desktop/src/features/ai-image apps/desktop/src/lib/page-handoff.test.ts --maxWorkers=4
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec eslint plugins/ai-image apps/desktop/src/features/ai-image apps/desktop/src/lib/page-handoff.ts apps/desktop/src/lib/page-handoff.test.ts --max-warnings 0
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec tsc -p plugins/ai-image/tsconfig.json --noEmit
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec tsc -p apps/desktop/tsconfig.json --noEmit
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec tsc -p tsconfig.tests.json --noEmit
rtk proxy env PATH="/Users/ameno/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm_config_verify_deps_before_run=false pnpm exec prettier --check plugins/ai-image apps/desktop/src/features/ai-image apps/desktop/src/lib/page-handoff.ts apps/desktop/src/lib/page-handoff.test.ts docs/22-ai-image-plugin.md
```

测试验证 100 项唯一性与旧 ID、搜索、完整约束、实际请求的提供方/模型/单张图片字节、
旧流程、识图失败阻断、文件缺失、原选择重试，以及旧文档和识图快照持久化。
来源测试覆盖生成失败/重启/重试持久化、来源不进入模型请求、成对过滤先于分页、
旧记录无来源、旧插件更新提示、图库选择顺序和超量保留、原始字节分块传输、
下载失败不回退、移除/重试的迟到结果抑制，以及实际插件状态门禁。
测试替换 `fetch`，不证明真实接口效果、计费或模型能力；未执行真实付费请求、
Windows、Rust、构建、打包或签名验证。主线质量记录由主线维护。

本轮审查修复只定向运行 `plugins/ai-image/src/capabilities/ai-image.test.ts`。
新增覆盖详情/普通列表/来源历史的中断恢复与重试、跨分页恢复、真实活动任务保护、
排队恢复期间任务启动或完成的竞态、恢复持久化失败与重复读取幂等。
模型配置覆盖打开后的草稿保留由父线继续进行浏览器交互验收，不重复整页联动测试。
