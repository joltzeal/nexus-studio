# CLI 初始化与范围调整记录

## 记录用途

本文件保留项目初始化来源，不要求在现有工作区重新执行初始化命令。
历史记录与当前范围分开阅读：桌面端后来接入原生窗口、插件宿主及 SQLite 授权。
早期 SQLite 偏好方案已退出；当前 bundled rusqlite 用于授权密钥，而非偏好业务。
初始化中曾添加某项依赖，不表示最终工程仍使用该项能力。
当前验收以[质量矩阵](09-quality-and-testing.md)中的主线结果为准。

## 根工程与桌面脚手架

初始空目录使用 pnpm 根工程和官方 create-tauri-app。
没有复制 Manager，也没有引入 Python、FastAPI、Docker 或其数据库。
以下为已记录的历史命令，不是现有工程升级步骤。

```sh
rtk proxy pnpm init
rtk proxy pnpm create tauri-app apps/desktop \
  --template react-ts \
  --identifier com.nexusstudio.desktop \
  --manager pnpm \
  --tauri-version 2 \
  --yes
rtk git init -b main
```

历史记录中 create-tauri-app 安装包版本为 4.7.5，CLI 自报版本为 4.8.0。
保留两种来源，不将任何一个标为当前最新版本。
Node.js 24.18.0、pnpm 11.17.0、Rust 1.93.0 是仓库开发工具链基线。
工具链文件、packageManager、devEngines 与锁文件共同约束开发环境。

## shadcn/ui 初始化

历史解析版本为 shadcn 4.22.1，配置为 Radix / Nova。
使用 `--preset nova --base radix`，不把组合名误作单个 preset。
以下命令用于追溯来源；在现有工程新增组件时先比较项目变体。

```sh
rtk proxy pnpm dlx shadcn@4.22.1 init \
  --cwd apps/desktop --preset nova --base radix --no-monorepo --yes
rtk proxy pnpm dlx shadcn@4.22.1 info --cwd apps/desktop --json
rtk proxy pnpm dlx shadcn@4.22.1 add \
  @shadcn/button @shadcn/field @shadcn/toggle-group \
  @shadcn/switch @shadcn/tabs @shadcn/card @shadcn/alert-dialog \
  @shadcn/tooltip @shadcn/alert @shadcn/skeleton @shadcn/input \
  @shadcn/separator --cwd apps/desktop --yes
```

CLI 生成 components.json、工具函数、基础组件与 Tailwind 入口。
初期按[主题规范](04-theme.md)调整 Paper Play 主题和正式组件变体，作为历史记录保留。
最新方向保留纸白与钴蓝，转为紧凑侧栏、轻量顶栏与列表工具栏的现代后台。
此前无侧栏、无表格约束已取消，移除营销式大标题、插画与设置页 ThemePreview。
后续 CLI 新增 Table、Dialog、Select、Badge、Empty，支持现有页面结构：

```sh
rtk proxy pnpm dlx shadcn@4.22.1 add \
  @shadcn/table @shadcn/dialog @shadcn/select @shadcn/badge @shadcn/empty \
  --cwd apps/desktop --yes
```

以上记录组件来源，不要求在已初始化的工作区重复执行或覆盖已有变体。

## 历史 Rust 调整与当前取舍

早期方案使用 CLI 添加 bundled rusqlite 与测试用 tempfile，并移除模板 opener。
那一阶段计划用 Rust SQLite 保存偏好，不再作为当前演示架构。
已移除 SQLite 偏好业务；此后 Tauri 接入原生窗口、插件宿主和独立的 SQLite 授权表。
不在此列出重新添加数据库的操作，以免将历史方案误作当前复现要求。
偏好与旧分组使用 localStorage，真实窗口位于 Profile 目录，详见[本地数据](07-data-storage.md)。

## 工作区与保留协议

contracts、plugin-sdk 与 browser-runtime 通过独立 TS 包维护边界。
唯一 JS 锁文件为根 pnpm-lock.yaml；Tauri 壳保留自己的 Cargo.lock。
browser-runtime 保留健康协议，并提供原生 Profile 与授权适配器。
桌面端可准备浏览器内核和运行受信任插件；真实代理出口与电商业务尚未完成验证或接入。
模板调整的最终结果以主线文件为准，不凭初始化成功推断页面完成。

## 当前开发入口

在已经安装仓库开发工具链的机器上，从根目录执行：

```sh
rtk proxy pnpm install --frozen-lockfile
rtk proxy pnpm run dev
rtk proxy pnpm run desktop:dev
rtk proxy pnpm run runtime:check
```

Vite 与 Tauri 入口按需要分别运行，协议检查独立于页面演示。
完整检查入口为 `rtk proxy pnpm run check`，结果由主线记录。
本历史记录不证明 Windows 安装、签名、公证或真实浏览器行为已通过。
