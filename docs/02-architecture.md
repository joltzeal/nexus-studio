# 系统架构与进程边界

## 当前架构

当前交付 React 页面、Tauri 2 桌面壳与原生窗口管理。
窗口管理页通过 Tauri command 创建原生 Profile 并写入应用数据目录，
并通过受管 Node 子进程调用官方 CloakBrowser JS 包装层。
插件由 `core::plugin_host` 托管为独立 Node.js 子进程，见[插件宿主](17-plugin-host.md)。
SQLite 目前只保存 CloakBrowser 授权记录，业务数据尚未迁入。
浏览器预览与桌面壳加载同一前端，各自使用所在来源的本地存储。
React、TypeScript、Vite、Tailwind 4 与 shadcn/ui 构成当前页面技术栈。
Node.js 是开发工具链和 CloakBrowser 适配子进程的运行环境；
当前原生 Profile 命令由 Rust 管理，页面不直接调用 Node。

## 目录职责

| 目录                       | 当前职责                                      | 后续职责             |
| -------------------------- | --------------------------------------------- | -------------------- |
| `apps/desktop/src`         | 六个主页面、原生窗口调用、主题与偏好存储      | 扩展平台适配器       |
| `apps/desktop/src-tauri`   | Tauri 壳、Profile 调度、SQLite 授权与插件宿主 | 更多业务 SQLite 数据 |
| `packages/contracts`       | 共享类型与校验契约                            | 扩展真实跨边界 DTO   |
| `packages/plugin-sdk`      | manifest 与能力声明契约                       | 真实插件宿主公开接口 |
| `packages/browser-runtime` | CloakBrowser Profile 与授权 SDK 适配          | 受管发行运行时       |
| `docs`                     | 当前演示边界与长期设计                        | 随真实能力同步更新   |

共享包通过公开导出使用，不反向依赖桌面页面。
包存在、包构建成功与页面接入是不同状态，不能互相替代。

## 当前页面数据流

```text
浏览器预览 / Tauri WebView
          |
React 页面与前端状态
          |
窗口/插件命令 → Rust → Profile 目录/插件宿主
偏好与旧分组 → 当前来源的 localStorage

contracts / plugin-sdk：保留契约
browser-runtime：独立健康协议与原生 Profile 适配进程
Rust core：磁盘绑定与调度；原生 Profile 通过 Tauri 命令接入
```

窗口资料来自原生 Profile；分组和偏好沿用本地数据；插件状态来自宿主检查。
紧凑侧栏提供窗口管理、分组管理、插件中心、代理池、地址生成器、应用设置六个入口。
顶栏以面包屑和主题切换 表达位置与模式，窗口页由 Table 与工具栏组织。
窗口详情和编辑通过 Dialog 展示，删除由确认弹窗保护；仅“打开”操作启动引擎。
插件中心在桌面应用中安装、启用并托管插件进程；非桌面环境只显示 manifest 声明。
页面不得因独立健康检查返回成功而显示真实浏览器已连接。
localStorage 失败应显示真实保存错误，不能宣称已写入数据库。

## 长期目标架构

未来其他业务数据可沿 React → 平台适配器 → Tauri command → Rust → SQLite 接入；
当前原生 Profile 仍使用独立磁盘记录而非 SQLite 表。
Rust 核心实现了引擎通道、代次快照、profile 独占、容量预留和代理能力端口；
另有磁盘绑定记录与开发环境的真实浏览器子进程。尚无可信许可容量来源和
完整发行包，详见[核心后端](12-core-backend.md)与[原生 Profile](13-native-profiles.md)。
Rust 是业务 SQLite 唯一所有者，Node.js 与插件不直接写入数据库。
Rust 监督 Node.js 浏览器适配进程，适配器封装真实引擎 SDK。
受信任 TypeScript 插件未来由单独进程承载，通过宿主公开能力调用。
Manager 仅作为参考，不成为服务、数据库或模块依赖。
不引入 Python、FastAPI 或 Docker 作为桌面业务运行前提。
当前演示 localStorage 不自动迁移为长期数据库或真实 profile。

## 协议与错误规划

保留协议包真实支持的健康与能力描述，不添加虚构浏览器会话结果。
跨进程接口应明确版本、请求关联、结构校验、成功结果与错误类别。
超时、进程退出、协议不兼容和取消需要各自确定的收敛行为。
未来 Rust 可恢复错误使用 `Result`，对 UI 暴露稳定错误类别。
内部路径、凭据与原始敏感堆栈不直接作为用户错误文本。
当前前端保存错误与未来引擎错误分别建模，不能共用误导性 ready 状态。

## 类型与适配方向

前端通过明确适配层访问存储，便于以后替换数据来源。
接入 Rust 时再引入从 Rust 或 schema 生成 TypeScript 绑定的确定性流程。
当前不宣称手写 contracts 已形成自动生成的跨语言绑定。
生成工具落地后固定命令、来源和校验方式，禁止手工改写产物。
新增业务 schema 随真实功能引入，不预建完整账号或环境模型。

## 关联设计

页面结构与模拟操作见[演示页面](11-demo-pages.md)。
当前 localStorage 与未来 SQLite 的边界见[本地数据](07-data-storage.md)。
引擎快照、profile 锁与代理规则见[浏览器接入](05-browser-integration.md)。
真实插件信任模型见[插件系统](06-plugin-system.md)。
发布目标与实际证据分别见[分发](08-distribution.md)和[质量矩阵](09-quality-and-testing.md)。
