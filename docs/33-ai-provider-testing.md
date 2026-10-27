# 服务商生图测试

本节描述 AI 插件 `1.3.0` 与主程序 `0.1.17` 的新增能力。
既有 `1.2.0` 插件只提供模型列表连通性检查，新入口由主程序的 React 页面与
插件新增方法共同提供；两者需配套更新，发布证据见[插件商店](25-plugin-market.md)。

## 测试入口与结果

在 AI 生图的模型配置中，每个已保存的服务商提供“测试连接”和“测试生图”：

- 测试连接只请求 `GET /models`，可以验证地址、Key 和模型列表响应，
  不能证明某个模型在当前分组内有可用生图通道。
- 测试生图使用所选服务商已保存的地址、Key 和准确生图模型；
  未保存的配置草稿不会用于请求。需要先保存配置才能测试新的模型或 Key。
- 文生图测试发送文本提示词，图生图测试上传一张参考图片。
  图片复用现有本机 JPEG 转换与分块上传，直接进入生图模型，不额外请求识图模型。
- 用户点击“开始测试”才提交一个真实生图请求，固定一张输出，可能产生服务商费用；
  打开或关闭弹窗、读取进度均不会发起新的模型请求。
- 结果与错误作为普通生成记录保存，标记 `purpose: 'provider-test'`，
  可在历史中查看、按原模型手动重试和导出。测试不覆盖正式任务的最近模型选择。

测试请求立即返回记录，后续使用现有记录读取接口顺序轮询，
不让服务商响应占用一次宿主 RPC。自 `1.4.0` 起，测试使用该服务商保存的
等待时间（默认 15 分钟）和响应方式，详见[生图请求](35-ai-streaming-and-timeouts.md)。
关闭界面不会取消已接受的任务，
重新打开历史仍可查看结果。同一服务商的活动测试不能重复提交。
插件重启后，中断测试标为失败，不会自动向服务商补发付费请求。

## 插件契约

方法：`image.providers.testImage`，能力：`image.provider`。

```ts
{
  id: string // 已保存服务商 ID
  model: string // 必须等于当前配置的 imageModel，不做自动替换
  mode: 'generate' | 'edit'
  prompt: string // 非空，最多 12000 字符
  size: '1024x1024' | '1024x1536' | '1536x1024' | 'auto'
  inputFileIds: string[] // generate 必须为空，edit 必须恰好一张
}
```

返回 `{ record: GenerationRecord }`，记录先为 `running`，
用 `image.records.get({ id })` 读取 `success | failed`。
不接受 `count`、识图模型、场景方案或其他未声明参数。
测试任务共用生产生图的 HTTP 请求、图片持久化、错误处理和记录恢复流程，
不会维护另一套与正式生成行为不同的请求实现。

页面根据插件实际声明的 `image.providers.testImage` 方法启用入口，
旧插件提示更新，不使用猜测参数或降级重试。

## 通道错误的判读

`No available channel for model ... under group ... (distributor)` 是请求返回的服务商错误，
表示服务商没有为当前分组和模型找到可用通道。它不等价于 Key 无效，
也不能通过一次成功的 `/models` 查询排除。

保留所选模型名，不自动移除后缀或改用其他模型。检查对应服务商中的模型标识、
当前 Key 的分组和该分组的通道状态；服务商可用请求标识查自己的路由记录。
页面显示明确的中文原因，并保留有界的 HTTP 状态、原始说明和请求标识。
诊断不包含提交的参考图、提示词正文或完整 Key。

一次测试成功仅说明当次所选模型、模式与输入能够生成；不同模式应分别测试。
服务商返回非图片内容、无效结构或错误页时不能显示测试成功。

## 与旧版 vinted-scenes 的完整对照

参考仓库为相邻的 `nexus-cart`，审计版本 `399d2a2`。
完整阅读 `packages/platform/src/pages/vinted-scenes` 的全部 13 个文件：
`api.ts`、`form.tsx`、`providers-sheet.tsx`、`batch-reference-picker.tsx`、
`batch-detail-dialog.tsx`、`batch-list.tsx`、`detail-dialog.tsx`、
`history-dialog.tsx`、`index.tsx`、`workspace.tsx`、`templates.ts`、
`status.tsx`、`columns.tsx`。

后端追踪覆盖 `apps/api/backend/app/ai/` 的 `api.py`、`service.py`、
`provider.py`、`website_images.py`、`batches.py`、`vinted_reference.py`、
`diagnostics.py`、`schema.py`、`model.py` 与 `__init__.py`，
以及文件上传控制器、FileService、Vinted 选图、Celery 任务与已安装 LiteLLM
的图片字段转换和 HTTP 调用层。以下是源码对照，不代表完成真实服务商请求验收。

| 链路               | 旧项目实际行为                                                                        | 当前处理                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 连通与生图测试     | `test-image/test-generation` 实际调用服务商，下载并验证图片，仅返回可用性、耗时与错误 | 连通性检查单列；真实测试走异步任务，保留成片、错误、耗时和历史                                    |
| 标准图生图         | LiteLLM 最终发送 `POST /images/edits`，multipart 字段也是 `image[]`，`n=1`            | 保留 `image[]`，测试单张、正式任务最多六张输入；不因通道错误擅自改字段                            |
| 标准文生图         | `POST /images/generations`，JSON 模型、提示词和尺寸                                   | 测试复用正式请求，固定 `n=1`，模型原样发送                                                        |
| 图片验证           | 严格 Base64 与 Pillow 解码校验，限制格式、尺寸与体积                                  | 本轮补齐响应结构、Base64 与图片签名校验，不把错误页默认当作 PNG；未引入 Pillow 或完整图片解码依赖 |
| 本地与 Vinted 图片 | 私有文件上传、后端校验商品引用；标准 Images 路径不主动转码                            | 继续复用本机 JPEG 转换、最长边 1536、透明区域白底与分块 IPC                                       |
| 模型名称           | SDK 的 `openai/` 是内部路由前缀；直接 HTTP 分支发送配置中的原模型名                   | 不移植 SDK 路由前缀，不自动改后缀或替换模型                                                       |
| 超时               | 旧图片测试同步等待，外层默认 275 秒；普通后台任务读响应可无限等待                     | `1.4.0` 起生图默认 15 分钟，可配置并读取 SSE；创建测试立即返回记录，通过现有接口轮询              |
| 多图与重试         | 旧套图通常为 2–10 张不同原图，各自一个任务，共享场景约束                              | 当前为一张选定图规划 1–4 个视角，各视角用原参考图集合；已有成功视角保留                           |
| 手动重试           | 旧普通任务读取当前服务商模型；保存过的文案可跳过                                      | 保持当前原模型快照；普通任务可能再次识图，测试从不识图，多视角只补未成功项                        |

旧项目还具有三种独立协议，不能根据模型后缀自动推断，也不能作为付费请求失败后的自动回退：

- Mhoo：显式使用单个 `image` 字段、`size=1K` 和 `response_format=b64_json`。
- Chat 出图：通过 `/chat/completions` 发送文本或图片消息，解析图片块、Data URL 或 Markdown 图片。
- 网站任务：通过 `/images/generate` 提交，保存远端任务 ID 后查询 `/images/tasks/{id}`；
  其输入、响应和恢复协议与标准 Images 不同。

本轮未加入上述专用适配器，仍要求服务商支持已选择的标准 Images 接口。
旧版所谓“自由生图”仍要求参考图，只跳过文案与预设包装；当前文生图确实不发送参考图。
旧代码用于重新构建商品的提示词不移植，保留当前对实际颜色、图案、缺陷与成色的约束。
不引入 Python、Celery 或 LiteLLM，也不移植 SDK 内部异常后的隐式二次 POST。

主要源码定位（相对于 `nexus-cart`）：

- `apps/api/backend/app/ai/api.py:78`：测试路由。
- `apps/api/backend/app/ai/service.py:294`：旧图生图测试的合成参考图。
- `apps/api/backend/app/ai/service.py:333`：真实图片测试与超时。
- `apps/api/backend/app/ai/provider.py:158`：标准改图；`:174` 为标准文生图。
- `apps/api/backend/app/ai/provider.py:195`：Mhoo；`:280` 为 Chat 出图。
- `apps/api/backend/app/ai/website_images.py:157`：网站任务提交与轮询。
- `apps/api/backend/app/ai/batches.py:203`：共享场景约束；`:279` 为批次串行执行。
- `apps/api/.venv/lib/python3.13/site-packages/litellm/llms/openai/image_edit/transformation.py:116`：
  已安装 LiteLLM 1.104.2 将参考图转换为 `image[]`。
