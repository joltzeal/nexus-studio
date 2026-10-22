# 开发规范

## 当前工作范围

窗口管理使用 Rust 原生 Profile 磁盘绑定、调度与 CloakBrowser 开发环境适配。
SQLite 已用于授权记录，受信任插件可通过宿主执行；业务数据迁移和正式发行打包仍待完成。
空白安装不预置样例窗口，未接入能力必须明确状态，不能伪装真实业务结果。
页面边界见[演示页面](11-demo-pages.md)，架构分期见[系统架构](02-architecture.md)。

## CLI 与工具链

优先使用官方 CLI 初始化 Tauri、shadcn 和工程配置，再作必要调整。
基线为 Node.js 24.18.0、pnpm 11.17.0、Rust 1.93.0、Tailwind 4。
版本来自仓库约定，不是“最新版本”声明；具体依赖以清单和锁文件为准。
使用 pnpm 工作区和唯一根 `pnpm-lock.yaml`，不混入其他 JS 锁文件。
依赖变更同步锁文件，不为无关修复顺带升级工具链。
所有 shell 命令必须加 `rtk` 前缀；工作区脚本使用 `rtk proxy pnpm run`。
使用 proxy 保留脚本语义，避免 RTK 替换同名 lint、typecheck 或测试命令。

## 根命令入口

| 命令                                       | 用途与边界                       |
| ------------------------------------------ | -------------------------------- |
| `rtk proxy pnpm install --frozen-lockfile` | 按锁文件安装开发依赖             |
| `rtk proxy pnpm run dev`                   | Vite 前端演示                    |
| `rtk proxy pnpm run desktop:dev`           | Tauri 壳内运行同一前端演示       |
| `rtk proxy pnpm run build`                 | 共享包与前端构建                 |
| `rtk proxy pnpm run desktop:build`         | 当前平台桌面开发构件             |
| `rtk proxy pnpm run typecheck`             | TypeScript 类型检查              |
| `rtk proxy pnpm run lint`                  | ESLint 检查                      |
| `rtk proxy pnpm run format:check`          | Prettier 格式检查                |
| `rtk proxy pnpm run test`                  | Vitest 行为测试                  |
| `rtk proxy pnpm run runtime:check`         | 独立运行时协议检查，非 UI 接入   |
| `rtk proxy pnpm run rust:check`            | Tauri Rust 核心编译检查          |
| `rtk proxy pnpm run rust:test`             | 调度器与插件边界测试             |
| `rtk proxy pnpm run rust:lint`             | Rust 格式与 Clippy 检查          |
| `rtk proxy pnpm run check`                 | 根脚本定义的 JS 与 Rust 聚合检查 |

入口存在不代表执行通过，实际结果由主线填入[验证记录](09-quality-and-testing.md)。
不能忽略失败退出码，也不能将纯调度器测试通过描述为真实浏览器验证通过。

## TypeScript 与页面

启用 strict TypeScript，外部输入与持久化读取先校验再缩窄类型。
组件聚焦呈现和交互，集中处理演示存储，不到处散落 localStorage 调用。
使用工作区公开导出，不跨包导入内部源文件，不用 `any` 绕开契约。
窗口管理、分组管理、插件中心、代理池、地址生成器、应用设置是六个主页面，设置含外观、工作区、CloakBrowser、关于。
使用 shadcn 基础组件、项目正式变体和[主题规范](04-theme.md)中的语义 token。
JSX 不写原始颜色，保留纸白与钴蓝，遵循现代、克制的后台方向。
左侧为 Nexus 标识、工作区和紧凑导航，顶栏为面包屑与主题切换。
窗口页使用 shadcn Table 与搜索；创建、编辑、详情用 Dialog，删除用 AlertDialog。
分组保持简洁卡片，插件能力卡不加彩色装饰，设置只保留普通控件。
不展示 ThemePreview、大标题、插画或营销式主视觉，避免厚重古典后台样式。
处理空状态、键盘焦点、长文本、保存错误与窗口缩放。

## 全局 compact 基准

全局采用紧凑尺度，以 shadcn 官方默认组件形态为基础，提高同屏有效信息量。
以下为项目统一尺度约定，不将这些数值描述为所有 shadcn 组件的官方默认值。

| 对象                            | 基准                                 |
| ------------------------------- | ------------------------------------ |
| 常规按钮、输入框、Select 等控件 | 高度 32px                            |
| 主导航项                        | 高度 36px                            |
| 卡片                            | 内边距与内容间距均为 16px            |
| 页面内容区                      | 内边距 16–20px                       |
| 表格单元格                      | 上下 8px，左右 12px                  |
| Dialog 内容区                   | `p-4`、`gap-4`，即内边距与间距 16px  |
| 设置项                          | 标准紧凑控件，不使用大尺寸 tile 选项 |

该基准适用于全部页面；密度选项不能让默认界面退回宽松的大块排版。
通过对齐、分隔和清楚标签保持可读性，保留可见焦点、完整错误反馈与可操作范围。
后续页面与组件复用本节尺度，具体主题 token 与状态遵循[主题规范](04-theme.md)。

## 演示行为与存储

演示数据必须与真实账号、真实浏览器运行状态区分，不存真实凭据。
窗口详情展示原生 Profile 配置，不自动启动；插件的安装、启用与调用反馈必须来自宿主真实结果。
写入 localStorage 成功后才显示本地演示保存成功，失败应保留可恢复输入。
浏览器与桌面 WebView 的 localStorage 按来源隔离，不承诺共享或同步。
浏览器预览不调用原生 Rust 命令，不把健康握手当成浏览器 ready。
初始化样例、缺失字段、无效数据和显式重置的行为应可解释。
不为未实现业务预建数据库表、环境 schema 或用户 `.env` 配置。

## 原生与适配器规范

Rust 业务以 `Result` 处理可恢复错误，避免在外部输入路径使用 panic。
SQLite 由 Rust 唯一持有。CloakBrowser 授权密钥当前以明文存储，并在界面说明风险；
插件密码是私有目录内的明文，不宣称加密。
Rust、Node.js、UI 采用明确适配器与版本化协议，保留生成绑定的后续计划。
真实代理要求失败阻断且不得自动直连，manifest 与权限声明不得称为沙箱。
未完成的代理流量集成与发行行为不能用局部测试冒充通过。

## 测试与维护

优先测试演示持久化、数据校验、状态转换和协议错误等有意义的行为。
不为低风险样式改动编写镜像实现测试，不以测试数量代替质量。
检查只报告实际结果，未执行的 Windows、签名和真实集成不得写为通过。
修改契约或当前范围时同步模块文档，保留用户修改与初始化来源。
不创建未经要求的提交或发布，不将未签名开发产物描述为可正式分发。
