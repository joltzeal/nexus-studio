# Nexus

面向 macOS / Windows 的多环境管理桌面产品，采用现代、克制的 B 端后台风格。
当前桌面应用可创建、管理并启动独立的 CloakBrowser 窗口；分组和外观等非浏览器资料仍为本地页面状态。
保留纸白与钴蓝，使用紧凑侧栏、轻量顶栏、环境列表与工具栏。
五个导航为“窗口管理、分组管理、插件中心、代理池、应用设置”，移除大标题与插画营销感。

## 当前可以演示什么

- 窗口管理：创建窗口即创建原生 Profile，可编辑配置、删除浏览器数据、打开和停止窗口；内核版本在创建时固定。
- 分组管理：原生窗口分组尚未接入；旧本地分组不会显示为真实窗口。
- 插件中心和代理池：桌面端由插件宿主安装并运行受信任插件，代理池提供库存和配置；不是安全沙箱。
- 应用设置：本地外观/工作区偏好，以及 CloakBrowser 密钥校验、SQLite 保存和删除。

外观和工作区偏好使用 localStorage；浏览器预览与 Tauri WebView 按来源分别保存，不自动同步。
真实窗口记录与浏览器数据位于应用数据目录；CloakBrowser 密钥由 Rust 以明文保存在未加密的 SQLite 数据库中，不写入 localStorage。
窗口可选择直连、无凭据手动代理或代理插件。真实代理出口流量和许可席位尚未端到端验证。

## 本地开发

工具链基线为 Node.js 24.18.0、pnpm 11.17.0、Rust 1.93.0。
前端预览需要 Node.js 与 pnpm；桌面壳开发另需 Rust 及目标平台的 Tauri 编译前置条件。
从仓库根目录安装依赖并运行前端：

```sh
rtk proxy pnpm install --frozen-lockfile
rtk proxy pnpm run dev
```

Vite 预览地址为 `http://localhost:1420`，以实际终端输出为准。
需要创建真实窗口时使用 `rtk proxy pnpm run desktop:dev`，
在窗口管理页创建并打开。密钥在应用设置的 CloakBrowser 页输入，无需 CLI 登录。
以上是开发者工具链要求；免配置安装包仍需打包 Node 运行时及浏览器适配器。

## 工程入口

| 路径                       | 当前职责                                     |
| -------------------------- | -------------------------------------------- |
| `apps/desktop`             | React 页面、Tauri 壳与 Rust 原生窗口核心     |
| `packages/contracts`       | 共享类型与校验契约                           |
| `packages/plugin-sdk`      | 插件 manifest 与能力声明契约                 |
| `packages/browser-runtime` | 健康协议与 CloakBrowser Profile 子进程适配器 |
| `docs`                     | 各模块独立中文文档、长期规划与验证矩阵       |

```sh
rtk proxy pnpm run check
rtk proxy pnpm run runtime:check
rtk proxy pnpm run desktop:build
```

这些是检查和构建入口，不表示已经通过或已能正式分发。
实际结果由主线填入[质量与验证](docs/09-quality-and-testing.md)。

## 文档与后续规划

先读[文档索引](docs/README.md)、[开发规范](docs/03-development-standards.md)和[演示页面](docs/11-demo-pages.md)。
Rust 核心的调度和插件接口见[核心后端](docs/12-core-backend.md)；
业务数据 SQLite 迁移与免配置的浏览器适配器发行包仍需后续接入。
Manager 仅作参考，不依赖其服务、Python、FastAPI 或 Docker。
Windows 安装、签名、公证、代理集成和无开发工具运行需分别取证，见[应用分发](docs/08-distribution.md)。
