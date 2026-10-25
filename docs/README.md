# Nexus 文档索引

Nexus 是面向 macOS / Windows 的多环境管理桌面产品，采用现代、克制的 B 端后台风格。
桌面端的“创建窗口”直接创建原生 Profile，支持编辑、删除、启动与停止；浏览器预览无法执行原生操作。
固定主页面为“窗口管理、分组管理、插件中心、应用设置”，插件中心的二级导航由宿主已启用插件动态生成。
代理池、地址生成器、共享货源、AI 生图、Vinted 账号、SIM8 接码和 Vinted 监控提供随应用发布的专用页面，
其他插件显示通用详情；安装和卸载后立即刷新入口。设置包含“外观、工作区、关于”。
窗口、分组、激活码与应用代理由桌面 Rust 核心管理并明文存入 SQLite；外观和工作区偏好存于 localStorage。
插件保有各自的明文业务存储，配置与详情不代表平台账号已登录。
真实 Profile 调用 CloakBrowser；插件由独立 Node.js 子进程托管，页面状态来自实际检查。
发布构建默认不带任何插件，插件以加密包从用户填写的商店安装，见[插件商店与在线更新](25-plugin-market.md)。
保留纸白与钴蓝，以紧凑侧栏、轻量顶栏、窗口 Table 与工具栏组织操作。
分组采用简洁卡片，插件能力卡无彩色装饰，设置不展示 ThemePreview，见[主题规范](04-theme.md)。

## 分模块文档

| 文档                                                     | 当前事实与规划                                          |
| -------------------------------------------------------- | ------------------------------------------------------- |
| [01 · 产品范围](01-product-scope.md)                     | 当前演示交付、现代后台方向与长期产品边界                |
| [02 · 系统架构](02-architecture.md)                      | 页面、Tauri 原生窗口核心、SQLite 授权与运行时边界       |
| [03 · 开发规范](03-development-standards.md)             | CLI、工具链、严格类型、语义 token 与真实反馈            |
| [04 · 主题与交互](04-theme.md)                           | 纸白与钴蓝、现代后台组件与可访问性                      |
| [05 · 浏览器接入](05-browser-integration.md)             | 当前窗口配置、未接入协议与长期 profile/代理契约         |
| [06 · 插件系统](06-plugin-system.md)                     | 当前宿主能力、页面状态与长期信任边界                    |
| [07 · 本地数据](07-data-storage.md)                      | localStorage、SQLite 授权存储、数据边界与错误           |
| [08 · 应用分发](08-distribution.md)                      | 当前开发构件与长期运行时、授权和双平台发布              |
| [09 · 质量与验证](09-quality-and-testing.md)             | 已执行的工程与页面检查、后续发布验证边界                |
| [10 · 初始化记录](10-initialization.md)                  | CLI 来源、历史 SQLite 方案与当前范围调整                |
| [11 · 页面交互](11-demo-pages.md)                        | 八主页面、窗口增删改查与当前交互边界                    |
| [12 · 核心后端](12-core-backend.md)                      | Rust 调度器、插件端口与双版本引擎取舍                   |
| [13 · 原生 Profile](13-native-profiles.md)               | 磁盘绑定、桌面试用步骤与分发边界                        |
| [14 · 插件对接规范](14-plugin-integration-guide.md)      | 插件 manifest、能力、宿主协议、安全边界与验收要求       |
| [15 · 代理池插件](15-proxy-plugin.md)                    | 仓库内 `studio.proxy-pool` 的实际范围、方法与限制       |
| [16 · CloakBrowser 授权](16-cloakbrowser-license.md)     | 应用内密钥管理、SQLite 存储、内核选择与并发边界         |
| [17 · 插件宿主](17-plugin-host.md)                       | 发现、安装、进程托管、权限检查与窗口启动阻断            |
| [18 · 插件发布与 CI/CD](18-plugin-release-and-cicd.md)   | 完整方案：加密打包已落地，服务端与收费部分暂缓          |
| [19 · 地址生成器插件](19-address-generator-plugin.md)    | 仓库内 `studio.address-generator` 的方法、上游与限制    |
| [20 · 桌面发行与更新](20-desktop-release-and-updates.md) | Node sidecar、发行工作流、签名与更新源边界              |
| [21 · 共享货源插件](21-shared-supply-plugin.md)          | 仓库内 `studio.shared-supply` 的目录协议、收藏与限制    |
| [22 · AI 生图插件](22-ai-image-plugin.md)                | 仓库内 `studio.ai-image` 的生图改图、明文模型配置与记录 |
| [23 · Vinted 监控插件](23-vinted-monitor-plugin.md)      | 独立采集代理、监控与商品表格、卖家资料及 AI 生图关联    |
| [24 · Vinted 账号池插件](24-vinted-accounts-plugin.md)   | 仓库内 `studio.vinted-accounts` 的账密、导入与窗口关联  |
| [25 · 插件商店与在线更新](25-plugin-market.md)           | 商店地址、`catalog.json`、`.nexuspkg` 加密包与定时更新  |
| [26 · 应用代理](26-application-network-proxy.md)         | 设置项、后台请求、系统代理与插件网络边界                |
| [27 · 浏览器内核](27-browser-kernels.md)                 | 本地清单、提前下载、真实进度、错误分类与窗口缓存复用    |
| [28 · 窗口加密迁移](28-window-transfer.md)               | 加密导入导出、浏览器站点状态、插件附件与导入恢复        |
| [29 · 窗口同步插件](29-window-sync-plugin.md)            | 设备配对、直连传输、完整性校验与手动快照同步            |
| [30 · SIM8 接码插件](30-sim8-plugin.md)                  | 仓库内 `studio.sim8` 的买号、取码、筛选与账号联动       |
| [31 · 智能场景规划](31-ai-scene-planning.md)             | AI 识图、场景推荐、可编辑多视角方案与部分失败重试       |
| [32 · 批量创建窗口](32-batch-window-creation.md)         | 窗口与账号池批量入口、统一代理、独立种子及部分失败重试  |

## 阅读与维护

开发先读产品范围、开发规范和演示页面，再读所改模块。
当前前端状态与长期完整产品契约分别表达，不能以规划代替实现。
contracts、plugin-sdk 和 browser-runtime 保留，但健康协议未接入页面。
Manager 只作参考，不成为依赖；既有上游证据不等于本产品测试结果。
窗口导入导出和设备同步共用加密快照，导出前必须关闭选中的窗口；
同机副本、跨设备首次同步与显式覆盖的标识规则见[窗口加密迁移](28-window-transfer.md)。
质量矩阵由主线填写真实检查，不虚构通过状态。
根开发入口见[项目说明](../README.md)，桌面入口见[桌面说明](../apps/desktop/README.md)。
