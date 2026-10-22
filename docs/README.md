# Nexus 文档索引

Nexus 是面向 macOS / Windows 的多环境管理桌面产品，采用现代、克制的 B 端后台风格。
桌面端的“创建窗口”直接创建原生 Profile，支持编辑、删除、启动与停止；浏览器预览无法执行原生操作。
主页面为“窗口管理、分组管理、插件中心、代理池、地址生成器、共享货源、AI 生图、Vinted 账号、Vinted 监控、应用设置”，设置包含“外观、工作区、关于”。
分组与偏好存于 localStorage；真实 Profile 与 CloakBrowser 授权由桌面 Rust 核心管理，配置与详情不代表账号已接入。
真实 Profile 调用 CloakBrowser；插件由独立 Node.js 子进程托管，页面状态来自实际检查。
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
| [18 · 插件发布与 CI/CD](18-plugin-release-and-cicd.md)   | 暂缓方案：打包加密、私有分发、L3 密钥与流水线           |
| [19 · 地址生成器插件](19-address-generator-plugin.md)    | 仓库内 `studio.address-generator` 的方法、上游与限制    |
| [20 · 桌面发行与更新](20-desktop-release-and-updates.md) | Node sidecar、发行工作流、签名与更新源边界              |
| [21 · 共享货源插件](21-shared-supply-plugin.md)          | 仓库内 `studio.shared-supply` 的目录协议、收藏与限制    |
| [22 · AI 生图插件](22-ai-image-plugin.md)                | 仓库内 `studio.ai-image` 的生图改图、明文模型配置与记录 |
| [23 · Vinted 监控插件](23-vinted-monitor-plugin.md)      | 仓库内 `studio.vinted-monitor` 的采集、运行记录与归档   |
| [24 · Vinted 账号池插件](24-vinted-accounts-plugin.md)   | 仓库内 `studio.vinted-accounts` 的账密、导入与窗口关联  |

## 阅读与维护

开发先读产品范围、开发规范和演示页面，再读所改模块。
当前前端状态与长期完整产品契约分别表达，不能以规划代替实现。
contracts、plugin-sdk 和 browser-runtime 保留，但健康协议未接入页面。
Manager 只作参考，不成为依赖；既有上游证据不等于本产品测试结果。
质量矩阵由主线填写真实检查，不虚构通过状态。
根开发入口见[项目说明](../README.md)，桌面入口见[桌面说明](../apps/desktop/README.md)。
