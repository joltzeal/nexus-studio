# Nexus 桌面前端演示

本目录包含 React / TypeScript / Vite 前端与 Tauri 2 桌面壳。
桌面窗口管理直接使用 Rust 原生 Profile；授权密钥由 Rust 写入 SQLite，分组和偏好等仍保留本地页面边界。
页面采用纸白与钴蓝的现代、克制 B 端后台风格，使用 Tailwind 4 与 shadcn/ui。

## 页面与状态

主页面为“窗口管理、分组管理、插件中心、代理池、地址生成器、共享货源、AI 生图、Vinted 监控、应用设置”。
设置内含“外观、工作区、CloakBrowser、关于”，具体职责见[页面交互](../../docs/11-demo-pages.md)。
分组和外观/工作区偏好沿用 localStorage；窗口与插件状态通过 Rust 命令读取。
浏览器预览和 Tauri WebView 各自按来源存储，不自动同步。
窗口创建即创建磁盘绑定 Profile；详情不自动启动，打开和停止是单独操作。
插件中心在桌面端安装和托管插件进程；窗口可选择直连、手动代理或代理插件。
授权密钥以明文存储在未加密 SQLite 数据库，不能描述为系统级安全存储。

## 从仓库根目录运行

工具链基线为 Node.js 24.18.0、pnpm 11.17.0、Rust 1.93.0。
浏览器预览需要 Node.js 与 pnpm；Tauri 开发另需 Rust 和平台编译前置条件。

```sh
rtk proxy pnpm install --frozen-lockfile
rtk proxy pnpm run dev
```

默认预览地址为 `http://localhost:1420`，具体以终端输出为准。
桌面壳使用 `rtk proxy pnpm run desktop:dev`，与 Vite 入口按需要分别启动。

## 工程边界

- `src` 承载前端页面、演示状态、存储适配与主题组件。
- `src-tauri` 包含 Profile 记录与调度、SQLite 授权和插件宿主。
- 工作区 contracts 与 plugin-sdk 保留公开契约，插件宿主仅接入部分能力。
- browser-runtime 包含健康协议与真实 CloakBrowser 子进程适配器。

集中处理 localStorage、结构校验和存储错误，组件不散落平台细节。
使用语义 token；主题值集中在 `src/App.css`，页面不直接写颜色。
左侧提供 Nexus 标识、工作区与紧凑导航，顶栏展示面包屑。
窗口页使用 Table、搜索及创建/编辑/详情 Dialog；原生分组尚未接入。
设置不挂载 ThemePreview，插件无彩色装饰，去掉大标题、插画和营销留白。
保持轻分隔、稳定对齐与适度圆角，避免古典后台厚重装饰。

## 检查与后续

从根目录使用 `rtk proxy pnpm run check` 检查工程。
独立协议检查为 `rtk proxy pnpm run runtime:check`，桌面构建为 `rtk proxy pnpm run desktop:build`。
入口存在不代表检查通过，实际结果由主线填入[质量矩阵](../../docs/09-quality-and-testing.md)。
未签名本机构件只作为开发演示，不证明 Windows 安装或正式分发可用。
原生 Profile 用法见[试用文档](../../docs/13-native-profiles.md)，
授权 SQLite 与发行适配边界见[系统架构](../../docs/02-architecture.md)。
完整文档入口见[文档索引](../../docs/README.md)与[开发规范](../../docs/03-development-standards.md)。
