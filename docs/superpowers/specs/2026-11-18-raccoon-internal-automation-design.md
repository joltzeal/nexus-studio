# Raccoon 内部自动化与多 Browser Provider 实现方案

日期为 2026 年 11 月 18 日。状态为已获用户确认，源码实施与验证进行中。

用户已确定自动化属于 Raccoon 内部能力，需要兼顾所有 Browser Provider，并完整采用 ShardBrowser 的实现方案，界面与交互像素级复用。本次交付为设计文档。本文中的新增服务、能力契约、持久化和适配行为均为拟实施内容。

## 产品目标与实现基线

用户在任一已配置的浏览器 Workspace 中，都能通过同一套自动化页面创建项目、编辑步骤、连接 Profile、查看实时画面、录制操作、执行流程和查看运行结果。浏览器差异由 Rust Provider 适配器处理。

上游基线固定为 `ProxyShard/ShardBrowser@99e780e2e685e5b3b5357c5baee8796e10b3ce1e`。2026 年 11 月 18 日读取的官方仓库 HEAD 与 `apps/desktop-v2/README.md` 的引入版本相同。实施时沿用这个可复核基线，后续升级单独审查。

采用上游的 React、TypeScript、Zustand、ShardX UI Kit、Tauri、Rust runner、Rust CDP 客户端和 Wasmtime 模块机制。前端沿用现有源码，后端引入并适配对应上游模块。流程语义、步骤参数和运行设置以固定版本源码为准。

Raccoon 的连接、Profile、Folder、SQLite、操作意图、代理和内核绑定遵循仓库现有领域边界。上游执行器通过这些边界访问资源。

## 当前源码事实

| 核查项             | 当前事实                                                                   | 实施影响                                        |
| ------------------ | -------------------------------------------------------------------------- | ----------------------------------------------- |
| 自动化页面         | `pages/automation` 已包含项目列表、编辑器、步骤详情和运行设置              | 直接在现有组件上接入                            |
| 画布与实时画面     | `BlockCanvas`、`LiveView`、`TrafficPanel`、`FleetMonitor` 等上游组件已存在 | 保留布局、交互和事件语义                        |
| 前端数据层         | `entities/automation` 仍使用上游 `automation_*` 命令和项目状态模型         | 增加显式 Raccoon adapter 与边界校验             |
| 网页预览           | `dev/mock/handlers.ts` 为自动化命令提供模拟响应                            | 预览数据必须保持明确的样例身份                  |
| 原生入口           | `raccoon/Application.tsx` 的自动化栏目仍显示未接入                         | 挂载页面并逐项接通真实服务                      |
| 原生调用边界       | `shared/api/invoke.ts` 在 Raccoon 原生模式拒绝上游通用调用                 | 按模块显式替换调用，逐项审计副作用              |
| Provider 接口      | `BrowserProvider` 已存在 `automation_session`，返回 CDP 或受管通道         | 核查并扩展会话契约，满足 Rust runner 的实际需求 |
| ShardBrowser       | 已有运行收据与 CDP 获取实现                                                | 可作为专有协议的首个接入对象                    |
| AdsPower 与比特    | 现有源码有运行状态查询及 CDP 端点发现                                      | 核验并适配到 0.2 作用域与新执行器               |
| AliasMode Chromium | 现有源码可获取运行实例的 CDP                                               | 实施标准 CDP 动作适配                           |
| CloakBrowser       | 当前接口返回受管动作通道                                                   | 需要新增供 Rust 执行器使用的受信任 CDP 会话出口 |
| AliasMode Firefox  | 当前明确拒绝自动化                                                         | 显示具体原因，保留未来协议适配入口              |
| Camoufox           | 当前为实验室占位                                                           | 实际 Provider 与协议实现完成后进入自动化验收    |

已逐字节比对的 `BlockCanvas.tsx`、`LiveView.tsx`、`entities/automation/model/api.ts`、`types.ts` 和 `useAutomation.tsx` 与上游一致。当前事实依据源码检查，真实内核、厂商环境和双平台运行证据仍待实施验收。

## 完整功能范围

### 页面与交互

完整沿用项目列表、卡片和表格视图、新建、重命名、复制、删除、导入、导出、模块管理及首次导入和运行审查。

编辑器沿用上游工具栏、流程画布、步骤库、步骤详情、运行设置和浏览器区域。保留拖拽、停靠、连线、框选、缩放、自动整理、撤销、起点、启停步骤和成功失败分支。

实时浏览器区域保留导航、画面、鼠标键盘输入、元素拾取、录制、截图、流量查看与规则编辑。保留 Fleet 运行监控、每个 Profile 的步骤与轮次、停止操作、日志、HelperPanel 及表单辅助交互。

### 步骤清单

固定基线的 `palette.ts` 是步骤清单与参数定义的来源。所有内置步骤都进入实现与验收矩阵。

| 分组       | 上游步骤                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile    | `profile.temp`、`profile.create`、`profile.use`、`profile.keep`、`profile.read`、`profile.delete`、`proxy.swap`                                   |
| 代理       | `proxy.set`、`proxy.residential`、`proxy.generate`                                                                                                |
| 导航       | `goto`、`back`、`forward`、`reload`、`waitLoad`                                                                                                   |
| 触摸与方向 | `touch.tap`、`touch.longPress`、`touch.swipe`、`touch.drag`、`touch.pinch`、`screen.rotate`                                                       |
| 指针       | `click`、`doubleClick`、`rightClick`、`hover`、`drag`、`swipe`、`scroll`                                                                          |
| 键盘       | `type`、`press`、`clear`                                                                                                                          |
| 流程控制   | `flow.entry`、`flow.call`、`wait`、`waitFor`、`waitGone`、`waitText`、`waitUrl`、`ifExists`、`if.value`、`if.exists`、`if.text`、`if.url`、`stop` |
| 脚本与请求 | `script.run`、`http.request`、`http.endSession`                                                                                                   |
| 流量       | `traffic.observe`、`traffic.block`、`traffic.redirect`、`traffic.setHeaders`、`traffic.editResponse`、`traffic.fulfill`                           |
| 数据       | `log`、`readText`、`var.set`、`var.math`、`var.autofill`、`count`、`readAttribute`、`screenshot`、`var.random`、`file.readLine`、`file.append`    |
| 数据库     | `db.open`、`db.exec`、`db.query`、`db.close`                                                                                                      |

WASM 自定义步骤另按模块 manifest、动作请求和调用授权检查。现有项目中出现的上游可识别步骤别名也要从 runner 的实际分派中核查，不能仅按可视步骤库判断。

部分代理步骤依赖 ProxyShard 商业服务。实施时保留上游步骤及交互结构，接入 Raccoon 确实具备的服务能力。服务缺失时明确显示不可用原因，相关步骤在完成支持前保持未完成状态。

## 前后端职责

拟定调用链如下。

```text
上游自动化页面与组件
  → Raccoon automation adapter / domain store
  → Tauri 结构化命令与事件
  → Rust AutomationService
      → SQLite 项目、运行记录、步骤记录、操作意图
      → 上游 runner 的流程、变量、并发、分支和日志逻辑
      → 上游 Wasmtime 模块宿主
      → Raccoon Profile / Folder / Proxy 服务
      → ProviderRegistry
          → BrowserProvider 会话与能力
          → ShardBrowser 扩展 CDP 或标准 CDP 适配
          → 实际浏览器
```

前端负责呈现、编辑草稿、录制步骤展示和用户操作。Rust 负责项目保存、运行快照、调度、资源关系、会话归属、流程执行、模块执行及恢复。Profile 的创建、启停、删除和代理配置通过统一领域服务执行。

采用一份上游 runner 核心维护流程语义。Provider 实现提供会话、动作与生命周期适配，新 Provider 按能力接入。

### 前端适配

新增 `src/raccoon/automation` 模块，放置公开 DTO 校验、API、项目投影、Workspace 作用域和运行状态映射。现有 `entities/automation/model/api.ts` 在原生模式显式调用此 adapter，网页预览继续使用明确标识的预览通道。

逐项审计自动化页面涉及的 `profile_*`、`process_*`、Folder、代理、设置、团队状态、快捷命令、辅助窗口和事件监听。原生路径中的每一项读写都必须有明确的 Raccoon 实现或能力拒绝。

项目保存队列、撤销及画布交互沿用上游实现。异步响应携带连接上下文，Workspace 切换后的过期响应由适配层丢弃。自动化快捷键和命令同步接入 `raccoon/command-policy.ts`。

### Rust 适配

拟在 `core/automation/` 下组织命令、模型、存储、服务、上游 runner、CDP、动作适配和 WASM 宿主。具体文件拆分由实施时依据模块大小确定。

上游对 `space`、`store`、`launch`、`process` 的依赖逐项替换为 Raccoon 服务。保留分支、变量展开、并发、轮次、时长、子流程、日志、运行快照和模块 ABI 的可观察行为。

项目和运行数据由 Rust 保存至现有 `v2/raccoon.sqlite`，随 0.2 schema 正常升级。上游项目 JSON 作为带版本的有效负载保存，公开导入导出采用独立的版本化封装，保留上游 bundle 的转换能力。

## 多 Provider 能力适配

### 公共会话与能力契约

Provider 会话拟包含 Raccoon Profile UUID、`connectionId`、引擎类型、实例身份、会话代次和经校验的传输信息。原始调试地址只在 Rust 服务内部使用。

自动化能力按实际连接、具体 Profile 引擎和当前运行实例声明。拟涵盖导航、DOM 读取与拾取、指针、键盘、截图、实时画面、触摸、方向、脚本执行 world、流量观察、拦截及响应修改、代理热切换和 Profile 生命周期能力。

能力结果区分可用、尚未实现、当前引擎不支持和实例暂不可达，并携带原因。输入行为还要区分 ShardBrowser 原生 Motion 与标准 CDP Input。

执行前校验项目、子流程、规则和当前已知 Profile 的要求。变量产生的目标、动态创建的 Profile 和 WASM 动态动作在实际调用前再次校验。能力变化、会话切换和版本变化都会使旧结果失效。

### Provider 接入矩阵

| Provider / 引擎       | 会话取得方式                               | 目标执行方式                                           | 当前必须补齐或核验的内容                               |
| --------------------- | ------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------ |
| ShardBrowser          | 验证运行收据、进程身份与调试端点           | Rust CDP，保留原生 `Motion.*`、`Traffic.*`、`Script.*` | 接入完整 runner、事件、资源锁和恢复                    |
| AdsPower Chromium     | 已配置连接的本机 API 读取活动 Profile 端点 | Rust 标准 CDP 适配                                     | 0.2 作用域、厂商版本、实际域能力和生命周期闭环         |
| 比特浏览器 Chromium   | 本机 API 只读发现活动实例端口              | Rust 标准 CDP 适配                                     | 身份校验、域能力、厂商 API 失败与状态核对              |
| AliasMode Chromium    | 受管实例与运行收据                         | Rust 标准 CDP 适配                                     | 具体内核版本、触摸、拦截与事件行为                     |
| CloakBrowser Chromium | 受管启动链提供受信任 CDP 信息              | Rust 标准 CDP 适配                                     | 新增并验证 CDP 出口、固定启动参数和进程归属            |
| AliasMode Firefox     | 当前缺少可用的自动化会话                   | 进入同一能力与错误模型                                 | 当前显示不支持原因，真实执行需要实现并验收相应协议适配 |
| Camoufox              | 实际 Provider 尚待实现                     | 通过统一 Provider 契约扩展                             | 创建启停、连接、协议与能力实现后逐项验收               |

所有 Provider 都纳入统一工作台、项目、能力与错误模型。真实执行的完成度按 Provider 和步骤逐项记录。Firefox 和 Camoufox 的不可用反馈只满足状态呈现，真实执行部分仍计为待实现。

### ShardBrowser 专有协议的转换

| 动作类别         | ShardBrowser 原生方式                 | 其他 Chromium Provider 的拟定适配                                       |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| 鼠标与键盘       | `Motion.*`                            | 标准 CDP `Input.*`，保持点击目标、按键、顺序和取消语义                  |
| 导航与 DOM       | `Page.*`、`DOM.*` 等                  | 复用标准 CDP，核查 iframe、shadow DOM 和目标选择行为                    |
| 实时画面         | `Page.startScreencast`                | 支持该域时复用，对帧确认、缩放和坐标转换做一致性验证                    |
| 脚本             | `Script.run` 的 isolated / main world | 按实际能力映射到 CDP Runtime 与隔离 world                               |
| 流量观察与规则   | `Traffic.*`                           | 以 Network / Fetch 实现可等价的规则，对时序、响应体和规则作用域逐项验证 |
| 代理热切换       | `Traffic.setProxy`                    | 仅在 Provider 有真实热切换能力时开放                                    |
| 触摸、缩放、方向 | `Motion` 触摸与方向扩展               | 按 Input / Emulation 及具体内核能力逐项实现                             |

转换成功要以动作结果和语义验证为依据。标准 Input 的动作完成不代表复现了 ShardBrowser 原生 Motion 的轨迹、节奏和内核行为。相应差异通过既有参数说明、禁用原因和运行详情表达。

必需代理失效时阻断启动或相关操作。代理热切换无法实现时明确拒绝该步骤，不能将重启浏览器作为透明替代操作。录制所需的用户动作事件、选择器定位和坐标转换也属于能力验收范围。

## Workspace、项目与 Profile 关系

以下是为满足现有 Workspace 边界拟定的产品选择，待用户审阅。

- 一个项目归属一个 `connectionId`。运行快照、Profile 选择、Folder 查询和子流程解析使用相同连接作用域。
- 同一份流程可导出后在其他 Workspace 导入为新项目。跨连接导入需要重新绑定 Profile 和 Folder，不能沿用外部环境 ID 或静默按名称绑定。
- 单次运行中的所有持久 Profile 属于项目连接。不同 Workspace 的项目可以同时运行，Fleet 可显示全局运行汇总，每条操作仍按其运行绑定校验作用域。
- Workspace 切换清理临时选择、弹窗、录制和实时浏览器连接。Rust 中已提交的运行继续执行，切换回来后读取真实状态。
- 项目保存与运行互相独立。启动运行冻结项目内容、子流程版本、模块内容身份、运行设置和资源绑定。后续编辑影响下一次运行。
- `profile.*`、模块和子流程均使用 Raccoon UUID。厂商环境 ID 仅在 Provider 适配器内解释。

上游导入项目中的 `profile.use`、`profile.delete`、`flow.call`、规则和模块依赖需要完整检查。无法解析的引用保留为明确的待绑定状态，运行前给出具体位置。秘密参数沿用上游导出剔除和重新填写机制。

## 执行、锁与恢复

运行创建使用调用方稳定的操作 ID，先提交运行意图和快照，再开始调度。重复请求返回已有运行结果，避免重复启动项目。

同一 Profile 只有一个动作控制者。runner、实时编辑器和其他宿主调用共享 Profile 租约与锁，生命周期操作沿用现有 Profile 独占机制。资源锁顺序与超时处理在实施前结合现有服务统一，避免互相等待。

只读观察、真实输入、录制和流程执行分别声明会话用途。运行占用 Profile 时，编辑器根据上游交互规则拒绝冲突的控制操作。断开预览只释放预览会话。

启动、停止、创建、删除和永久代理变更都走持久化操作意图。临时 Profile 也先创建 Raccoon 记录与收据，标记所属运行，清理通过正常生命周期服务执行。`profile.keep` 将该记录转为持久保留并按本 Workspace 的 Folder 契约组织。

取消任务时停止分派新步骤，等待或中止当前动作，并记录结果。运行开始前已存在的浏览器、运行启动的浏览器及临时创建的浏览器分别记录资源归属，按照核验后的上游行为决定结束时的保留或清理。

页面操作超时可能已产生外部副作用。运行记录保存步骤结果已确认、失败或结果待核对的事实。重启后将未完成运行标为中断或待核对，展示最后步骤和可用日志。恢复前先核对浏览器实例及持久化意图，自动重放必须具有可证明的安全条件。

运行期间同样处理结果未知的情况。结果待核对时暂停对应 worker，其他独立 worker 可继续执行。当前步骤保留原操作 ID、调用代次和待核对记录，进入核对状态后暂缓解释 `on_done` 与 `on_fail`。重复查询、命令重送和恢复均先查原操作结果。

核对确认成功后进入 `on_done`。确认未提交或失败且可以重试后进入 `on_fail`，再按上游 `retry` 等分支执行。新的实际尝试先持久化为关联原步骤的新尝试记录。仍无法确认的结果保持待核对，并在原有状态、日志和停止入口中呈现，不能自动重新执行创建、启动、删除或结果未知的页面写操作。

这是为满足 Raccoon 持久化操作契约对上游错误处理增加的明确适配。结果已确认的步骤继续遵循上游分支语义。项目中的失败重试设置必须经过这层结果判断，子流程和 WASM 动作采用相同规则。

连接断开、实例身份变化或目标丢失时终止相应控制租约，保留业务记录。未知、Missing 和断线按各自事实呈现。

## 存储、文件与网络

拟持久化项目、运行快照、worker 状态、必要的步骤结果和待核对操作。模块内容存放在 v2 数据目录，以内容身份固定运行使用的版本。日志与截图作为带运行归属的文件保存，Rust 负责索引和有界清理。

项目列表、模块和运行状态通过真实命令读取。localStorage 仅保存明确的界面偏好。日志隐藏秘密字段、代理认证、敏感表单值及模块敏感参数。本地业务数据仍遵循当前明文存储事实。

HTTP 步骤保留上游 host、profile 或指定代理的路由语义与会话管理。`via=profile` 的具体实现按上游请求客户端及该 Provider 的实际代理能力验证，不能仅因取得 CDP 就标记支持。厂商本机管理 API 独立直连并验证 loopback。

文件与数据库步骤沿用上游 Rust 执行方案，包括原有数据库驱动范围。用户业务数据库与 Raccoon 自有数据库必须明确归属，执行器使用专用宿主 API 维护应用状态。SQLite 访问始终由 Rust 持有。

## WASM、自定义模块与附属入口

沿用上游 Wasmtime、模块描述、安装移除、bundle、变量交换、动作返回、日志、资源限额和停止机制。模块导入、调用授权、子模块及子流程调用的实际 ABI 以固定源码为准。所有动态动作经过同一 Raccoon 服务和 Provider 能力检查。

模块按应用安装，授权按上游模型映射到实际项目和调用目标。每个运行固定模块内容身份。安装更新、移除或授权变化的处理需要保证已经开始的调用有确定结果。

官方 HTTP API 和 MCP 中涉及自动化项目的管理、运行、停止、状态、导入导出和模块入口，后续接入同一 `AutomationService`。HTTP 服务采用上游 Axum 与 Bearer JWT 方案，MCP 沿用其 Node SDK 结构，资源身份与连接作用域转换为 Raccoon 契约。

桌面入口通过 Tauri 直接调用内部服务。对外 HTTP / MCP 入口作为完整功能的后续实施阶段分别验收。上游 SDK 的独立内核下载和 Profile 存储模式需要单独审查其与 Raccoon 数据所有权的关系，本文交付范围首先覆盖内部自动化及其服务入口。

## 像素级复制与行为验收

以固定基线的同页面、同状态截图为参考，直接复用页面、组件、UI Kit、图标、字体、token、尺寸和布局规则。先建立参考截图，再接真实数据。所有视觉变化都需能对应到 Raccoon 的连接作用域或真实能力反馈。

| 验收对象       | 核对内容                                                           |
| -------------- | ------------------------------------------------------------------ |
| 项目列表       | 卡片与表格、工具栏、空状态、排序、菜单、导入导出                   |
| 编辑器         | 画布比例、节点与连线、参数区、运行设置、浏览器列宽、滚动和窗口缩放 |
| 交互           | 拖拽、框选、停靠、快捷键、撤销、缩放、起点、分支和自动整理         |
| 浏览器区域     | 画面比例、导航、输入、元素拾取、录制、流量面板和截图               |
| 模块与辅助窗口 | 安装、授权、审查、HelperPanel、Fleet 的结构与状态                  |
| 错误与中间状态 | 保存失败、连接断开、不支持步骤、运行冲突、停止中和重启核对         |

截图比较固定视口、设备像素比、缩放、语言、主题、字体和数据。动态时间、浏览器内容和系统窗口装饰使用明确的差异说明。平台原生装饰按各平台单独建立参考。

自动截图差异要逐项核对。完成记录列出仍存在的差异及原因，像素级验收依据可查看的对照截图和交互证据。

## 实施顺序与完成条件

| 阶段     | 实施内容                                                       | 完成条件                                               |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| 1        | 固定上游来源、步骤与命令清单，建立项目、会话、能力和运行契约   | 每个上游入口均映射到明确的 Raccoon 服务或待实现能力    |
| 2        | 引入 Rust runner、CDP 与 WASM 核心，接通 SQLite 和统一生命周期 | 受控协议测试覆盖流程、锁、状态、写入失败和恢复         |
| 3        | 接通 ShardBrowser 完整自动化                                   | 原生页面、真实专有协议、录制、流程、模块和重启记录闭环 |
| 4        | 接通 AdsPower、比特、AliasMode Chromium、CloakBrowser          | 每个 Provider 独立完成能力矩阵和真实运行验收           |
| 5        | 完成前端全部入口、附属窗口及像素对照                           | 逐页面截图和交互对照通过，原生路径的预览响应全部排除   |
| 6        | 接通并验收 HTTP / MCP 的自动化服务入口                         | 同一项目、运行、授权和作用域行为从各入口一致执行       |
| 持续补齐 | Firefox、Camoufox 及 Provider 专有能力差距                     | 相应协议与实际 Provider 完成后逐项补充证据             |

阶段 3 的前端接入与阶段 5 的视觉核对可随实现推进。其他 Chromium Provider 的标准 CDP 适配应在阶段 1 明确接口，在阶段 4 完成全部已支持步骤。

以下场景作为有意义的验证对象。

1. 两个不同 `connectionId` 的项目、Profile、Folder、子流程与导入引用互不串用。
2. 图上的默认顺序、显式起点、成功失败分支、重试、循环、时长、子流程与变量行为符合上游源码。
3. 每个 Provider 的导航、定位、点击、输入、等待、读取、截图和录制完成真实闭环。
4. 专有 Motion、Traffic、Script、代理热切换及触摸能力分别验证支持与拒绝路径。
5. 创建、启停、删除、临时 Profile 保留与清理发生超时、断线和写入失败后可核对。配置 `on_fail=retry` 的创建步骤在结果未知时暂停，核对成功后进入成功分支，重复恢复不会再次创建。
6. 同一 Profile 的编辑器、运行和其他调用竞争时，独占与取消结果一致。
7. 保存失败保留草稿，导入缺少秘密参数或引用时能定位，WASM 更新和停止行为明确。
8. 应用重启后项目仍存在，未完成运行显示真实中断状态，实例身份变化后不会控制错误浏览器。
9. macOS 和 Windows 分别验证实时画面、键盘、辅助窗口、原生入口与截图一致性。
10. HTTP / MCP 使用同一内部服务时保持连接范围、资源身份、并发与错误语义。

本地仅执行仓库允许的无产物类型检查、lint、直接测试工具、前端受控验证和 rustfmt。Rust 编译、测试、Clippy、应用构建与打包按现有约定交由 CI。真实厂商测试需要用户提供受控环境，实际结果由主线记录至 `docs/09-quality-and-testing.md`。

## 本方案中的拟定选择

用户已明确内部自动化归属、所有 Provider 的适配方向以及完整采用上游方案和像素级复制。

以下细节由本次设计提出，尚待用户审阅。

- 项目按 `connectionId` 隔离，同一流程通过显式导入复制到其他 Workspace。
- 上游项目有效负载由 Rust 存入 v2 SQLite，并建立 Raccoon 的版本化导入导出封装。
- 其他 Chromium Provider 在 Rust 中映射标准 CDP，单独标明原生 Motion 等行为差异。
- 工作台切换后后台运行继续执行，Fleet 汇总运行并保留各自作用域。
- 重启后先核对中断运行和外部副作用，再决定后续执行。
- 运行中的结果未知也先暂停并核对，核对完成后再处理上游分支与重试。
- CloakBrowser 需要新增受信任 CDP 会话出口，Firefox 和 Camoufox 的真实执行作为明确的实施差距跟踪。

## 源码证据与实施定位

上游仓库地址为 `https://github.com/ProxyShard/ShardBrowser`，以下路径均相对于固定基线 `99e780e2e685e5b3b5357c5baee8796e10b3ce1e`。

| 来源证据                                                                     | 核查结果                            | Raccoon 实施定位                     |
| ---------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------ |
| `src/entities/automation/model/types.ts`、`palette.ts`                       | 项目、分支、参数及完整步骤库        | 保留有效负载与语义，增加领域适配     |
| `src/widgets/BlockCanvas/BlockCanvas.tsx`                                    | 自研 DOM / SVG 画布和交互           | 原组件复用与截图对照                 |
| `src/widgets/LiveView/LiveView.tsx`                                          | 实时画面、输入与录制交互            | 原组件与 Rust 会话事件对接           |
| `src-tauri/src/lib.rs`                                                       | 自动化 Tauri 命令与事件             | 显式迁入 Raccoon 命令边界            |
| `src-tauri/src/runner.rs`                                                    | Rust 流程执行、并发、步骤和模块分派 | 引入 runner，替换领域服务与动作出口  |
| `src-tauri/src/cdp.rs`                                                       | Rust WebSocket CDP、目标与实时帧    | 受信任会话与多 Provider 动作适配     |
| `src-tauri/src/wasm.rs`、`modguard.rs`                                       | Wasmtime 宿主与模块调用授权         | 保留 ABI 与检查，接入 Raccoon 作用域 |
| `src-tauri/src/space/local/automation.rs`                                    | 项目存储、导入导出与模块文件        | 转为 Rust 持有的 v2 存储             |
| `src-tauri/src/api.rs`、`mcp/`                                               | HTTP 与 MCP 自动化入口              | 统一路由内部服务                     |
| 本仓库 `apps/desktop-v2/src/raccoon/`                                        | 原生前端和显式 adapter 模式         | 增加自动化 adapter 与页面挂载        |
| 本仓库 `apps/desktop/src-tauri/src/core/browser/provider.rs` 及 `providers/` | Registry、Provider 会话与生命周期   | 扩展能力、会话、身份和恢复契约       |

引入和改写上游 Rust 文件时保留 MIT 许可证与来源记录。实现后的源码范围、支持矩阵及真实验证结果分别同步到对应模块文档和质量记录。
