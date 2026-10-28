# AI 生图插件 `studio.ai-image`

本文说明 `plugins/ai-image` 与 `apps/desktop/src/features/ai-image` 的当前实现。
宿主边界见[插件对接规范](14-plugin-integration-guide.md)与[插件宿主](17-plugin-host.md)。
当前工作区在已发布的上传格式校验、Vinted 原图本机 JPEG 转换及商品资料预填基础上，
将模型配置收敛为识图、生图两项。插件版本为 `1.4.2`，要求主程序 `0.1.18` 或更高版本；
主程序与插件需配套更新，实际发布结果见[插件商店](25-plugin-market.md)。

`1.3.0` 新增服务商实际生图测试与通道错误诊断。
该入口需要新的主程序页面与包含 `image.providers.testImage` 的插件配套使用，
旧插件只保留连通性检查。详细接口与参考项目核对见[生图测试](33-ai-provider-testing.md)。

`1.4.0` 将生图默认等待时间提高到 15 分钟，支持每服务商设置 1–60 分钟与
自动/流式/普通响应。文生图、改图、测试和多视角共用同一实现；
流式协议和截止时间见[生图请求](35-ai-streaming-and-timeouts.md)。

`1.4.1` 统一英文标题、描述、识图说明与生图提示词，所有生成入口采用自然手机实拍约束。
用户原始商品要求可通过现有识图模型转为英文；纯文生图与手动提示词使用英文。
语言校验、历史兼容和发布方式见[英文文案与手机实拍](36-ai-english-phone-photos.md)。

## 当前能力

插件提供 `image.provider` 的 21 个 RPC 方法，支持 `openai` 与 `openai_compatible`。
生图只走 `/images/generations` 与 `/images/edits`；识图使用 `/chat/completions`。
不支持网站自动化生图、chat 多模态出图或异步轮询型供应商通道。

- 只配置识图、生图两种模型；每个服务商至少填写一种，也可以两种都填。两种模型可使用不同服务商。
- 识图一次返回商品标题、描述和自动生图提示词，不再额外请求文案模型。
- 新任务必须显式提交服务商与模型，默认恢复上一次使用的准确组合；首次使用需手动选择。
- 带参考图生成时先识别一张参考图，或复用已完成的场景方案；生成完成后可在详情选择一张成片，明确点击识图。
- API Key **明文**保存于插件私有目录 `ai-image.json`（0600），只回显有无及末四位提示。
- 每次生成是一条记录，按 120 条回收旧记录，活动任务保留；图片在私有目录 `images/`，
  生成完成后自动写入导出副本到 `exports/`；多视角逐张导出已成功图片。
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
Vinted 入口会将标题、品牌、尺寸、成色以及已归档的文字描述带入此草稿，
不附带卖家资料、代理或原始详情对象；超长内容仍由生成表单提示用户自行精简。
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
来源元数据不会拼接到提示词，也不会发送给生图或识图模型。
初始失败、记录读取、进程重启、生成重试均保留来源；旧记录缺少来源时仍无来源，
不根据标题、图片或 URL 猜测关联。列表和详情显示来源标题与商品链接。
“查看来源商品”在桌面端通过 `external_url_open` 打开系统默认浏览器，
与 Vinted 商品/卖家外链共用适配器；打开失败显示提示，不导航当前 WebView。

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
下载后的字节在本机通过 `prepareReference` 解码并转为 JPEG，
再由 `uploadImage` 分块写入 AI 插件私有 `images/` 目录。
WebP、PNG、JPEG 统一为真实 JPEG 字节与 `.jpg` 文件，最长边不超过 1536 像素，
保持宽高比，不放大小图；透明区域合成白底，并应用原图方向。
编码为空、输出类型不符或超过 8 MiB 时明确失败，不能仅修改 MIME 或扩展名伪装格式。
Vinted 参考图继续使用监控插件的采集代理；
AI 网关仍沿用 AI/应用网络策略，不改全局代理。两个插件后端互不调用，
仅前端经 IPC 协调；WebView 不 fetch 远程 URL，也不直接用远程 URL 预览。
其他来源保留 AI 插件原有远程下载流程，本地文件仍按既有规则预处理。

传输失败的选择留在列表中并阻止生成，可按原选择重试或明确移除；
失败不自动回退为 AI 插件直连下载，也不悄悄少传一张。最多六张；
超量 handoff 会保留全部选择并阻止提交，第七张及之后先不传输，
需明确移除多余选择后再重试剩余未传图片。稳定选择 key 在重试时不变，
移除、卸载或新 handoff 会取消旧传输并忽略迟到结果。
下载或本地编码完成后再次检查取消状态，已取消的选择不会继续上传；
转码期间无论成功、失败或取消，均释放已解码位图及 canvas 像素缓冲。

## 模型配置与兼容性

| 字段          | 用途                                                             |
| ------------- | ---------------------------------------------------------------- |
| `visionModel` | 理解图片并返回商品标题、描述和生图提示词；不从其他旧模型字段推断 |
| `imageModel`  | 生图或改图；发起生成时必须明确指定                               |

`image.providers.save` 使用 `id/name/kind/baseUrl/apiKey/imageModel/visionModel`，
并支持 `imageTimeoutSeconds` 与 `imageResponseMode`；默认值、迁移与门禁见
[生图请求](35-ai-streaming-and-timeouts.md)。
两项模型至少一项非空；新表单默认都留空，示例仅作 placeholder。
编辑时省略 `apiKey` 保留原 Key；省略 `visionModel` 保留原识图配置，显式空字符串清空。
保存失败保留表单输入；保存已成功但列表刷新失败时，表单保留返回的 ID 并清空 Key 输入，
明确显示刷新失败，下次保存更新同一服务商，避免重复创建。
连通性测试仍只调用 `/models`，不证明具体模型支持相应协议。

`image.providers.list` 返回：

```ts
{
  items: ProviderView[]
  storageDurable: boolean
  modelConfigVersion: 2
  transportSettingsVersion: 1
  selections: {
    image: { providerId: string; model: string } | null
    vision: { providerId: string; model: string } | null
  }
}
```

选择随接受的生图、场景规划或成片识图操作一起写入私有文档，重启后恢复。
前端选择值同时包含服务商 ID 与模型名称，不以列表第一项作为回退。
服务商被删除、Key 缺失或模型名称改变时，标记旧选择失效并要求重新选择。
服务商只改名称不会使选择失效。新任务在调用上游前检查模型与当前配置一致；
历史重试仍使用原模型快照，不自动改为当前配置的模型。
配置读取按请求顺序保护，旧响应不能覆盖最新选择。关闭规划或成片详情弹窗只停止页面跟随，
已接受任务保存的模型选择仍会刷新到父页面，不因关闭弹窗而丢失。

旧文档和历史记录继续读取，旧 `textModel/supportsVision/copySupportsVision/copyError`
只用于历史兼容，不用于任何新模型请求。旧文案专用配置不会自动变成识图配置，
需要用户明确补填识图或生图模型后保存。旧文档的两种选择默认均为空。
主程序读取不到 `modelConfigVersion: 2` 时提示更新插件，阻止新模型配置和新任务，
历史记录仍可查看，不能静默退回三模型流程。

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

无预设时，仍加入手机实拍与商品保真规则，不添加特定预设；
用户文本包括首尾空格与换行保存在识图前记录，纯文字生成的空白提示词仍拒绝。
带参考图且选定识图模型时，可以不填写附加要求，由识图返回自动提示词。
未知预设明确拒绝，不静默退化为自由提示词。
生成前识图将观察与建议提示词加入上下文，并强调原图优先、保留真实商品状态，
要求模型将用户场景和约束完整整理成英文。最终生图提示词不再拼回原语言文本；
纯文字生成、测试及手动编辑直接要求英文。上游模型的提示词上限仍由上游决定，拒绝时显示错误。

## 生成前单张识图

`image.generate` 新任务必须显式指定生图模型。直接改图还需指定识图服务商与模型：

```ts
{
  providerId: string
  imageModel: string
  mode: 'generate' | 'edit'
  presetId: string | null
  prompt: string
  size: '1024x1024' | '1024x1536' | '1536x1024' | 'auto'
  count: number // 1-4
  inputFileIds: string[] // 0-6；改图至少 1 张
  source?: GenerationSource // 仅元数据，不作为模型指令
  visionProviderId?: string | null
  visionModel?: string | null
  visionFileId?: string | null
}
```

- 纯文字生成只需要明确的 `providerId/imageModel`，不请求识图或文案。
- 直接改图需要 `visionProviderId/visionModel`；两者成对提供，模型名称必须与服务商配置一致。
- 使用已完成的 `scenePlan` 时复用方案的识图结果，不重复请求识图。
- `visionFileId` 缺失或为 null 时取第一张输入；指定时必须属于本次 `inputFileIds`。
- 只指定图片而没有识图服务商、无图片、重复文件 ID、图片不属于本次输入均明确拒绝。
- 页面按稳定上传 key 解析具体文件，不按可能变化的数组下标猜测。
  上传失败不能偷偷跳过；需用户重新选择或明确移除。
- 没有图片时提示“请添加一张参考图片用于识图。”；指定图片被移除则提示重新选择。

直接改图顺序为 `queued -> vision -> image -> done`；纯文字生成跳过 `vision`。
识图请求只发送一张指定源图，返回 `title/description/prompt`。
标题与描述直接保存到生成记录；自动提示词与用户要求、预设及商品保真约束组合后用于生图。
改图仍发送全部已选参考图。场景方案生成直接复用方案中的标题与描述。
所有新任务都没有 `copy` 阶段，也不请求第三个模型。

识图 HTTP 错误、超时、无效 JSON、缺少标题/描述/提示词或超过长度限制均让任务失败并阻止生图。
缺失参考图也会失败，不能丢图继续或把改图退化为文生图。

## 详情内单张成片识图

用户先看到已生成的组图，点击缩略图“选择成片 1/2/…”选择目标，默认第一张。
在“成片识图服务商 / 模型”选择配置，点击“识别当前成片”才发出请求。
使用最近一次识图选择；只有当前成片被发送，返回标题、描述与建议提示词，
单独保存在 `outputVision` 中，不改写原生成记录的标题与描述。
远程参考图上传时用占位，成功后由 `RecordImage` 通过插件文件 API 显示；
本地 blob 可以即时预览，WebView 不直接加载远程预览 URL。

新增方法 `image.records.recognize`，与现有生成方法一样立即返回 `{ record }`：

```ts
// 新识图：省略或 null fileId 取第一张成片
{ id: string, providerId: string, model: string, fileId?: string | null }
// 原选择重试：不允许同时覆盖 providerId/model/fileId
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
vision?: {
  providerId: string
  providerName: string
  providerKind: 'openai' | 'openai_compatible'
  model: string
  inputFileId: string
  title?: string | null // 新识图一定有此字段；旧记录可能缺失
  description: string | null
  prompt?: string | null // 新识图一定有此字段；旧记录可能缺失
} | null
outputVision?: {
  providerId: string
  providerName: string
  providerKind: 'openai' | 'openai_compatible'
  model: string
  outputFileId: string
  status: 'running' | 'success' | 'failed'
  title?: string | null // 新识图一定有此字段；旧记录可能缺失
  description: string | null
  prompt?: string | null // 新识图一定有此字段；旧记录可能缺失
  error: string | null
} | null
```

`prompt` 记录实际生图提示词，`basePrompt` 保存识图前版本；旧记录无后者时使用原 `prompt`。
`vision` 保存源图识图快照，`outputVision` 保存最近一次成片识图的模型、图片、结果或错误。
文件 ID 与输入/输出的归属关系在私有文档读取时校验，损坏时拒绝而非猜测替代。

生成重试使用已记录的生图、识图模型和图片；成片识图重试使用已记录的模型与成片。
修改提供方配置不会把已有重试换成新模型；端点和 Key 仍取该提供方当前配置，
便于修正凭据。提供方删除、Key 缺失或文件丢失会明确失败。
旧记录不会因新增了 `visionModel` 而自动启用识图。

## RPC 方法

| 方法                        | 作用                                     |
| --------------------------- | ---------------------------------------- |
| `image.providers.list`      | 提供方列表，不回传明文 Key               |
| `image.providers.save`      | 保存配置；省略 Key/visionModel 保留原值  |
| `image.providers.remove`    | 删除配置，保留生成记录                   |
| `image.providers.test`      | GET /models 连通性检查                   |
| `image.providers.testImage` | 实际生成一张测试图，返回可轮询的生成记录 |
| `image.presets`             | 返回 100 个场景，含 category             |
| `image.upload.begin`        | 开始分块上传                             |
| `image.upload.chunk`        | 追加图片分块                             |
| `image.upload.finish`       | 校验总大小并写入图片                     |
| `image.upload.abort`        | 放弃上传会话                             |
| `image.upload.remote`       | 插件下载远程图片，按实际字节校验格式     |
| `image.file.chunk`          | 页面分块读取插件图片                     |
| `image.plans.create`        | 后台识图并规划场景与多视角提示词         |
| `image.plans.get`           | 读取规划进度、结果或错误                 |
| `image.records.list`        | 按状态与来源筛选，返回倒序分页摘要       |
| `image.records.get`         | 读取记录，含两类识图状态                 |
| `image.records.remove`      | 删除记录及其图片文件                     |
| `image.records.retry`       | 重试生成，沿用模型与选图快照             |
| `image.records.recognize`   | 识别单张成片，或按原选择重试             |
| `image.records.export`      | 补导出输出到私有 exports 目录并返回路径  |
| `image.generate`            | 创建记录并后台执行                       |

同时最多 6 个上传会话；单图最多 8 MiB，仅接受 PNG/JPEG/WebP。
分块上传完成时检查文件签名与声明 MIME 一致后才落盘；格式不符时丢弃上传会话，
不会把 WebP 直接保存成 JPEG 文件。此检查识别格式，不代替完整的图片解码验证。
本地上传及 Vinted 选图预处理会缩放到最长边 1536 像素，原图细节可能因此减少；
其他来源的远程下载保持原字节。监控图库可展示 GIF，但 AI 参考图
仅接受 PNG/JPEG/WebP；GIF 转运明确失败，不能自动转码或忽略该选择。

## 上游请求与外部数据

- 生图：JSON `POST /images/generations`，传 `model/prompt/n` 与可选 `size`。
- 改图：multipart `POST /images/edits`，参考图字段 `image[]`，其余参数同生图。
- 独立识图：`POST /chat/completions`，明确的识图 `model`，一条文字指令加
  **恰好一个** base64 `image_url`，要求返回 `{"title":"...","description":"...","prompt":"..."}`。
  三项均必须非空：标题最多 500 字符，描述与提示词各最多 6000 字符；错误不截断后当作成功。
- 智能规划：相同 chat 路径，只读取所选的一张参考图，返回经过校验的商品观察、
  预设 ID 和逐张视角提示词；生成使用单独的 `n=1` 改图请求，详见智能场景规划文档。
- 超时：生图默认 15 分钟，可按服务商设置 1–60 分钟；识图 5 分钟，
  连通性/参考图远程下载各 20 秒。单次生成与结果下载共用截止时间。
- 生图支持标准 Images SSE，仍接受返回普通 JSON 的兼容网关；
  只有最终完整图片才保存，不因流式失败自动重发请求。
- 保留既有尺寸映射与错误分类，供应商不支持模型/格式时显示真实错误。
- `/models` 成功不表示生图或改图通道可用；需分别实际测试对应模式。
  无可用通道错误提示检查当前 Key 分组、模型名称与服务商通道状态，保留 HTTP 状态和请求标识；
  不自动改名、换模型、切换接口或重试付费请求。

生图服务商收到提示词和改图参考图；独立识图服务商只收到所选的一张源图或成片。
生成前识图的观察结果还会发送给生图服务商。详情成片识图的结构化结果仅保存与显示。
所有请求可能产生供应商费用；用户明确触发，失败不自动重试。
不发送本机路径、窗口资料、代理配置或收藏内容。图片本身可能含背景信息。

## 存储与限制

私有文档用 `z.looseObject` 校验，保留未知字段，写入使用临时文件加 rename。
写入失败不报告已保存；损坏文档拒绝读写，不清空重建。
宿主未提供目录时使用内存，页面标记“仅本次运行”。导出重复文件名不会覆盖。

### 1.4.2 自动导出与失败恢复

此前生成只写 `images/`，必须手动点“导出图片”才会写 `exports/`。
现在普通生成、改图、生图测试和多视角生成会在保存成片后自动导出；
多视角中部分失败时，成功图片仍会导出。目标为宿主提供的 AI 插件数据目录下的
`exports/`，不会写入插件安装目录，也不依赖生成弹窗是否还打开。

导出使用文件 ID 命名并通过独占创建防止并发覆盖。再次导出相同成片时校验字节，
复用相同副本；文件丢失则补写，同名文件内容不同则另加后缀，不覆盖已有内容。
`exportedPaths` 与 `exportError` 保存在生成记录，旧记录无需迁移。
导出失败不会删除成片、把已生成图片改成失败，或再次调用模型；详情中显示补导出提示。
点击“导出图片”可处理旧记录或重试导出；只有导出全部成功才返回成功路径。
旧主程序仍使用现有详情和导出按钮，本次只更新插件。

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

## 验证边界

本次只运行无构建检查：定向 Vitest、ESLint、Prettier 与 `tsc --noEmit`，
以及真实 React 页面和实际插件服务配合受控上游响应的浏览器验证。
覆盖两种模型的配置、显式选择、重启恢复、模型变更失效、结构化识图、
识图到生图的请求顺序、场景方案复用、旧数据和原模型重试。
实际命令与结果以[质量与验证](09-quality-and-testing.md)为准。
没有调用真实付费模型，也未运行本地构建、打包、Rust、Windows 或签名验证。
