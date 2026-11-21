# Raccoon 文档索引

> 0.2 重写进行中。Workspace 对应已配置的 connectionId，Profile 和 Folder 按连接隔离。
> desktop-v2 的 ShardBrowser 原生命令接入已落地源码，并完成受控 IPC 前端验证。
> Rust 编译、真实内核、代理、重启和双平台验收仍待完成。
> 下文涉及 0.1 页面和旧契约的说明作为历史记录，最新边界以 AGENTS.md 和模块文档为准。

Raccoon 是面向 macOS / Windows 的多环境管理桌面产品。0.2 重写中，
AdsPower 和比特浏览器为默认接入，CloakBrowser 只在实验室显式启用，
AliasMode Chromium / Firefox 的受管内核下载和窗口 Provider 已接入源码；浏览器提供方就是工作区，各自拥有独立分组。
固定主页面为“窗口管理、分组管理、插件中心、应用设置”，插件二级目录由已启用插件动态生成。
设置中的“实验室”可启停 CloakBrowser、AliasMode 和 ShardBrowser，分别管理各自内核；AliasMode Firefox 不支持自动化。Camoufox
仍为占位，旧 AliasMode 桌面 Local API 已移除，见[浏览器接入](05-browser-integration.md)。
窗口、分组、接入、激活码和应用代理由 Rust 明文存入 SQLite；外观与工作区偏好存于 localStorage。
插件保有各自的业务存储，业务关系使用 Raccoon UUID，配置和详情不代表平台账号已登录。
内置窗口创建时固定完整内核版本、目录与种子；外部指纹和内核由对应官方应用管理。
旧窗口 IPC、DTO 别名、运行时格式和快照导入兼容路径已删除；现有数据库只升级一次。
实际编译、厂商 API 和系统安装验证边界见质量记录，源码接入不等于这些验证已经完成。
发布构建默认不带任何插件，插件以加密包从用户填写的商店安装，见[插件商店与在线更新](25-plugin-market.md)。
保留纸白与钴蓝，以紧凑侧栏、轻量顶栏、窗口 Table 与工具栏组织操作。
分组采用简洁卡片，插件能力卡无彩色装饰，设置不展示 ThemePreview，见[主题规范](04-theme.md)。

## 分模块文档

| 文档                                                                | 当前事实与规划                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| [01 · 产品范围](01-product-scope.md)                                | 窗口与插件产品范围、现代后台方向与边界                         |
| [02 · 系统架构](02-architecture.md)                                 | 页面、Tauri 原生窗口核心、SQLite 授权与运行时边界              |
| [03 · 开发规范](03-development-standards.md)                        | CLI、工具链、严格类型、语义 token 与真实反馈                   |
| [04 · 主题与交互](04-theme.md)                                      | 纸白与钴蓝、现代后台组件与可访问性                             |
| [05 · 浏览器接入](05-browser-integration.md)                        | 当前窗口配置、提供方能力、连接与窗口代理契约                   |
| [06 · 插件系统](06-plugin-system.md)                                | 当前宿主能力、页面状态与长期信任边界                           |
| [07 · 本地数据](07-data-storage.md)                                 | localStorage、SQLite 窗口与接入存储、数据边界与错误            |
| [08 · 应用分发](08-distribution.md)                                 | 当前开发构件与长期运行时、授权和双平台发布                     |
| [09 · 质量与验证](09-quality-and-testing.md)                        | 已执行的工程与页面检查、后续发布验证边界                       |
| [10 · 初始化记录](10-initialization.md)                             | CLI 来源、历史 SQLite 方案与当前范围调整                       |
| [11 · 页面交互](11-demo-pages.md)                                   | 动态插件导航、窗口增删改查与当前交互边界                       |
| [12 · 核心后端](12-core-backend.md)                                 | Rust 调度器、插件端口与不可变内核绑定                          |
| [13 · 原生 Profile](13-native-profiles.md)                          | 磁盘绑定、桌面试用步骤与分发边界                               |
| [14 · 插件对接规范](14-plugin-integration-guide.md)                 | 插件 manifest、能力、宿主协议、安全边界与验收要求              |
| [15 · 代理池插件](15-proxy-plugin.md)                               | 仓库内 `studio.proxy-pool` 的实际范围、方法与限制              |
| [16 · CloakBrowser 授权](16-cloakbrowser-license.md)                | 应用内激活码、SQLite 存储、最新内核与并发边界                  |
| [17 · 插件宿主](17-plugin-host.md)                                  | 发现、安装、进程托管、权限检查与窗口启动阻断                   |
| [18 · 插件发布与 CI/CD](18-plugin-release-and-cicd.md)              | 完整方案：加密打包已落地，服务端与收费部分暂缓                 |
| [19 · VInted helper 插件](19-address-generator-plugin.md)           | v2 地图资料、地址持久化与账号关联、矢量 A6 面单提取            |
| [20 · 桌面发行与更新](20-desktop-release-and-updates.md)            | Node sidecar、发行工作流、签名与更新源边界                     |
| [21 · 共享货源插件](21-shared-supply-plugin.md)                     | 仓库内 `studio.shared-supply` 的目录协议、收藏与限制           |
| [22 · AI 生图插件](22-ai-image-plugin.md)                           | 生图改图、模型配置、队列与完整批次检索                         |
| [23 · Vinted 监控插件](23-vinted-monitor-plugin.md)                 | 独立采集代理、监控与商品表格、卖家资料及 AI 生图关联           |
| [24 · Vinted 账号池插件](24-vinted-accounts-plugin.md)              | 账号导入、窗口关联、独立地址与邮箱关系                         |
| [25 · 插件商店与在线更新](25-plugin-market.md)                      | 商店地址、`catalog.json`、`.nexuspkg` 加密包与定时更新         |
| [26 · 应用代理](26-application-network-proxy.md)                    | 设置项、后台请求、系统代理与插件网络边界                       |
| [27 · 浏览器内核](27-browser-kernels.md)                            | 官方最新版本查询、下载校验、本地清单与窗口固定绑定             |
| [28 · 窗口加密迁移](28-window-transfer.md)                          | 加密导入导出、浏览器站点状态、插件附件与导入恢复               |
| [29 · 窗口同步插件](29-window-sync-plugin.md)                       | 设备配对、直连传输、完整性校验与手动快照同步                   |
| [30 · SIM8 接码插件](30-sim8-plugin.md)                             | 买号、取码、筛选、账号联动与窗口页每日到期提醒                 |
| [31 · 智能场景规划](31-ai-scene-planning.md)                        | AI 识图、场景推荐、可编辑多视角方案与部分失败重试              |
| [32 · 批量创建窗口](32-batch-window-creation.md)                    | 窗口与账号池批量入口、统一代理、独立种子及部分失败重试         |
| [33 · 生图测试与旧流程核对](33-ai-provider-testing.md)              | 实际文生图/图生图测试、通道诊断与参考项目对照                  |
| [34 · 验证码等待](34-sms-waiting.md)                                | 窗口行 SMS/Email 五秒轮询、五分钟截止、可复制通知与数字语音    |
| [35 · 生图流式与等待时间](35-ai-streaming-and-timeouts.md)          | 服务商请求配置、SSE 解析、统一截止时间与兼容边界               |
| [36 · 英文文案与手机实拍](36-ai-english-phone-photos.md)            | 英文提示词与商品文案、原文转化和生活化摄影约束                 |
| [37 · 配置导入导出](37-configuration-transfer.md)                   | 设置与插件配置的明文迁移、预校验、逐项结果和业务数据边界       |
| [38 · 账号订单查询与 Bark](38-vinted-account-order-watch.md)        | 账号主页自动扫描、严格已售核查、Bark 提醒和失败恢复            |
| [41 · 邮箱插件](41-email-plugin.md)                                 | 微软邮箱、已读同步、定时收信、token 轮换与账号联动             |
| [42 · Ecom Agent 交互原型](42-sales-agent-demo.md)                  | 独立开发预览、运行前批量编辑、窗口分配与模拟执行               |
| [43 · 商品管理插件](43-products-plugin.md)                          | 独立商品库、生图整组导入、发布状态与使用窗口历史               |
| [44 · Ecom Agent 架构与执行](44-sales-agent-architecture.md)        | v2 工作台、LangGraph、Rust 任务协调、分配、结果核对与插件协作 |
| [45 · Ecom Agent 实施审计](45-sales-agent-implementation-audit.md)  | 实施计划逐项核对、独立审查问题、修复进度与验收边界             |
| [46 · Ecom Agent 操作与恢复](46-sales-agent-operations.md)          | 草稿模板、运行前检查、人工接管、审查、用量、通知与历史保留     |
| [47 · Vinted 业务流程方案](47-vinted-business-workflows.md)         | 执行前审核、页面分类优先、账号资料与确定性上架工具             |
| [48 · Vinted 分类数据](48-vinted-catalog-data.md)                   | 美国目录清洗已完成；本地兜底、字段、版本与重建方法             |
| [49 · Vinted 账号读取工具](49-vinted-account-read-tools.md)         | 主页、商品分页、余额、收款信息、窗口网络与受控回填             |
| [50 · 插件本地开发](50-local-plugin-development.md)                 | 源码与发布目录、公开契约、开发监听、对象存储和独立应用 CI      |
| [51 · 场景重建与做旧](51-ai-reconstruction-and-photo-aging.md)      | 独立做旧档位、商品风格重建、自然卖家英文与任务持久化           |
| [52 · 插件返回与关联确认](52-plugin-navigation-and-safe-actions.md) | 页面状态保留、返回历史、隐藏轮询与账号关系操作确认             |
| [53 · 第一方插件卡密授权](53-plugin-card-licensing.md)              | 11 个第一方插件的 Worker SKU、设备租约与宿主门禁               |
| [54 · AI 生图 EXIF 模板](54-ai-image-exif-template.md)              | 可选相机字段、JPEG 后置处理与 IMG 文件名                       |

## 多浏览器重构

- [Raccoon 内部自动化与多 Browser Provider 实现方案](superpowers/specs/2026-11-18-raccoon-internal-automation-design.md)：
  已确认并完成本轮源码接入，沿用 ShardBrowser 自动化界面、Rust runner、CDP 和 WASM 机制。
  Provider 能力适配、Workspace 隔离及恢复逻辑的交付状态见
  [实施记录](superpowers/plans/2026-11-18-raccoon-internal-automation.md)。
  Rust 编译、真实 Provider、重启及双平台验收仍待完成。
- [ShardBrowser 前端独立基线](../apps/desktop-v2/README.md)：
  0.2 新前端目录与上游源码版本；当前构建不代表原生命令已接通。
- [Raccoon 0.2 浏览器接入重构方案](superpowers/specs/2026-11-17-raccoon-02-provider-architecture-design.md)：
  新分支重写工作台领域核心和页面；AdsPower / 比特浏览器为默认接入，两个
  受管内核由实验室维护。0.2 不读取 0.1 数据，旧数据以后由独立脚本迁移。
- [Raccoon 0.2 跨平台界面重构方案](superpowers/specs/2026-11-17-raccoon-02-native-interface-design.md)：
  参考用户提供的 AliasMode 页面结构，定义窗口、设置、插件与 macOS/Windows
  系统交互的设计方向；尚未实施。
- [Provider 工作台重构草案](superpowers/specs/2026-11-17-provider-workbench-design.md)：
  历史草案，0.1 数据兼容与旧 AliasMode Local API 保留建议已被 0.2 方案取代。
- [AliasMode Chromium 直管内核技术细节](superpowers/specs/2026-11-17-aliasmode-managed-chromium-design.md)：
  下载、启动与版本固定的技术参考；产品定位以 Raccoon 0.2 方案为准。
- [多指纹浏览器接入重构](superpowers/specs/2026-11-10-multi-browser-provider-design.md)：
  统一接口、窗口 Tabs、作用域、持久化操作和验收边界；已获批准并实施。
- [实施计划](superpowers/plans/2026-11-10-multi-browser-refactor.md)：任务清单、删除旧兼容路径的补充约束和真实验证记录。

## 界面规范

- [Raccoon 插件中心设计规范](superpowers/specs/2026-11-18-raccoon-plugin-center-design.md)：
  定义 desktop-v2 插件目录、商店、授权、表格、弹窗和状态语言，并给出旧版
  `plugins-page.tsx` 对齐 ShardBrowser 设计语言的迁移规则。
- [插件自主声明导航图标方案](superpowers/specs/2026-11-19-plugin-navigation-icons-design.md)：
  插件内部维护静态路径，宿主统一校验和侧栏渲染；当前为待确认方案，尚未更改图标契约。

## Vinted 业务工具重构方案

- [业务流程](47-vinted-business-workflows.md)：当前工具执行、无浏览器内容准备及未接入能力。
- [技术设计](superpowers/specs/2026-11-14-vinted-listing-tools-design.md)：
  已批准的无浏览器内容准备、页面分类优先与本地兜底、账号回填、固定工具及提交恢复约束。
- [账号读取工具](49-vinted-account-read-tools.md)：用户补充的四个接口、字段投影与财务跨域边界。

## 阅读与维护

开发先读产品范围、开发规范和演示页面，再读所改模块。
当前前端状态与长期完整产品契约分别表达，不能以规划代替实现。
contracts、plugin-sdk 和 browser-runtime 保留，但健康协议未接入页面。
Manager 只作参考，不成为依赖；既有上游证据不等于本产品测试结果。
窗口导入导出和设备同步共用加密快照，导出前必须关闭选中的窗口；
同机副本、跨设备首次同步与显式覆盖的标识规则见[窗口加密迁移](28-window-transfer.md)。
质量矩阵由主线填写真实检查，不虚构通过状态。
根开发入口见[项目说明](../README.md)，桌面入口见[桌面说明](../apps/desktop/README.md)。
