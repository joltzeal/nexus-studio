# 桌面分发与运行时规划

## Raccoon Preview 本地构件

2026-11-18 用户明确授权构建 Preview。macOS arm64 使用 v2、release、macOS
及 `tauri.preview.conf.json` 四份配置，生成 `Raccoon Preview.app`，版本为
`0.2.0-preview.1`，应用标识为 `com.raccoon.preview`。该构件包含全局代理库和
ShardBrowser 原生入口，数据保存到 Preview 独立应用目录。使用 ad-hoc 签名，
未公证。具体构建与资源检查结果见质量记录。

## 当前交付状态

desktop-v2 的 ShardBrowser 原生开发入口使用
`rtk proxy pnpm --filter @raccoon/desktop-v2 run desktop:dev`，通过独立
`tauri.v2.conf.json` 指向 v2 前端，并设置与旧桌面端分开的
`com.raccoon.desktop` 应用标识。其 `v2/raccoon.sqlite` 位于独立应用数据目录，
不打开或迁移旧桌面端数据。开发服务使用 `1422` 端口，与旧版的 `1420` 分开；
Preview 配置继续使用单独标识。该命令会启动 Tauri
并触发 Rust 编译，仍遵循本地禁止应用/Rust 构建的约定，由允许的 CI 或验收环境执行。
现有默认发行脚本保留旧前端入口，v2 原生开发配置尚未作为正式发行验证。

当前桌面开发构件已有 Rust 原生窗口、插件宿主与 SQLite 授权，
分组及外观/工作区偏好仍使用 localStorage；授权密钥在未加密数据库中明文保存。
浏览器预览产物和本机桌面构件用于开发演示，不构成正式发布证据。
目标平台为 macOS 与 Windows，两者分别验证和记录。
主线实际结果统一填入[质量矩阵](09-quality-and-testing.md)。

## 开发者运行环境

仓库基线为 Node.js 24.18.0、pnpm 11.17.0、Rust 1.93.0。
Vite 前端开发使用 Node.js 和 pnpm，Tauri 壳开发另需 Rust 与平台编译前置条件。
这些是开发者要求，不是最终用户安装要求。
当前不使用 Manager 服务、Python、FastAPI 或 Docker。
独立 browser-runtime 协议检查使用开发 Node.js，不证明应用已捆绑运行时。

## 当前构建入口

| 命令                               | 对应产物或行为   | 证据范围               |
| ---------------------------------- | ---------------- | ---------------------- |
| `rtk proxy pnpm run dev`           | Vite 演示服务    | 前端开发运行           |
| `rtk proxy pnpm run build`         | TS 包与前端构建  | JS 构建                |
| `rtk proxy pnpm run desktop:dev`   | Tauri 壳内演示   | 当前平台开发运行       |
| `rtk proxy pnpm run desktop:build` | 当前平台桌面构件 | 本机桌面构建           |
| `rtk proxy pnpm run runtime:check` | 独立健康协议     | 进程协议，不是应用集成 |

构建入口存在不等于执行通过，未执行检查不能填写成功。
Rust 编译成功不代表授权、浏览器启动或 Windows 运行通过。
桌面开发构件使用本机 Node.js；发行配置由 `desktop:package` 生成受管 Node 与
JS 资源。首次新建窗口仍需要从官方来源按需获取浏览器内核。

## 长期安装体验目标

最终签名应用不要求用户安装 Node.js、Rust 或 Python，也不要求配置 PATH。
产品业务不依赖用户复制 `.env` 文件才能启动。
实际 WebView、操作系统版本和平台安装依赖需随发布方式准确说明。
目标不等于当前完成；本轮不宣称已有可公开分发安装包。
不承诺零业务配置：后续引擎或平台可能需要合法许可、账号或明确用户设置。

## 后续受控运行时

发行打包从 Node.js 官方下载固定版本 `24.18.0`，校验官方 SHA256，
按 macOS arm64 / x64 与 Windows x64 生成 Tauri sidecar。发行构件通过明确资源路径
启动适配器和插件；缺少资源时应用拒绝启动，不调用未知系统 Node.js。
运行时版本、协议兼容和完整性需要一起验证，不能使用无约束最新版下载地址。
资源路径、用户数据和临时目录分别管理，不依赖开发工作目录。
嵌套可执行资源需纳入对应平台的签名与发布检查。
只有在原生安装包完成干净环境验证后，才能宣称无需开发工具。

## 后续浏览器获取与授权

浏览器可随签名包固定版本分发，或通过受管流程获取并验证构件。
获取流程需明确版本、来源、架构、完整性、失败恢复与兼容性。
校验失败不能继续使用未知二进制，也不能静默改用系统浏览器。
SDK 和浏览器构件的再分发权限、使用条件与获取方式是发布依赖。
如需一次人工取得许可，应在发布准备中明确完成并记录。
技术上能下载不代表拥有再分发权，本文不提供具体条款的法律判断。

## 两个平台的后续发布检查

当前没有 Apple Developer ID，也没有 Windows 代码签名证书，因此首次安装会被系统拦截。
具体现象与代价见[插件发布与 CI/CD](18-plugin-release-and-cicd.md)第 12 节（该文档已暂缓，
仅作参考），本文不重复。
结论是：ad-hoc 签名保证 arm64 可执行，但不满足 Gatekeeper；Windows 会触发 SmartScreen。
自动更新的完整性由 minisign 校验保证，与操作系统代码签名无关。

macOS 按实际架构验证安装、启动、资源签名与干净环境运行；公证只在取得证书后才谈。
Windows 执行原生构建、安装、资源定位与子进程退出检查。
两个平台均覆盖空格与非 ASCII 用户路径，不依赖开发机工具或缓存。
签名凭据由受控发布环境提供，不进入源码、演示数据或数据库。
macOS 结果不能代表 Windows，也不能由跨平台框架名称推定通过。
当前尚无上述发布证据，主线仅填写真正执行的检查。

## 后续更新与数据

Tauri updater 使用独立签名密钥；0.2 启动后静默检查并在后台下载，下载完成后才在
侧边栏版本行显示升级按钮，点击并二次确认后安装并重启；
0.1 的关于页检查、下载、安装和重启入口仍保留在旧前端；
发布版始终初始化 updater，因此基础 `tauri.conf.json` 必须包含公钥与更新地址，
不能只放在 release 覆盖配置中；本地打包也必须叠加 release 和对应平台配置，
否则安装包可能缺少插件宿主的 Node helper 与 runtime。未提供签名私钥的本地
打包可仅关闭更新产物生成，应用内更新仍使用相同的公钥和地址。
安装前要求停止所有运行中的窗口。发行工作流当前用 `tauri.v2.conf.json` 与
`tauri.release.v2.conf.json` 构建 0.2，并生成 updater 清单与签名产物。
工作流暂只构建 macOS arm64 与 x64，Windows 矩阵在恢复 Windows 验收前不运行。
旧版 updater 继续读取 GitHub Latest 的 `latest.json`；v2 从 `raccoon-v2` 预发布
Release 读取独立 updater 清单。版本化 v2 Release 显式不设为 GitHub Latest，发布完成后
工作流将其中的 `latest.json` 复制到 `raccoon-v2`，使旧版客户端继续留在 0.1 更新通道。
地址生成器的浏览器 Key 由仓库 Secret `VITE_GOOGLE_MAPS_API_KEY` 注入前端构建；
Secret 未配置时构建仍可完成，但地图选点会提示未配置。
版本化 v2 Release 与 updater 通道均位于公开 GitHub 仓库。
当前发行工作流使用 ad-hoc macOS 签名，尚未完成 Developer ID 签名或公证，
Windows 0.2 安装包尚未进入工作流。
当前授权 SQLite 与未来业务表均遵守[本地数据](07-data-storage.md)的所有权与迁移规则。
演示 localStorage 不自动成为正式业务数据，升级策略需明确设计。
插件依赖和浏览器来源进入可追溯发布清单，诊断信息脱敏。
当前不将本机应用构建等同于完整运行时、授权与双平台分发链闭环。

## 2026-11-18 用户本机 Preview 编译

用户自行执行应用编译。当前 macOS Preview 使用 v2 前端与独立应用标识。
在仓库根目录执行以下命令。

```bash
rtk proxy pnpm --config.verify-deps-before-run=false --filter @raccoon/desktop-v2 run build && \
rtk proxy pnpm --config.verify-deps-before-run=false --filter @nexus/desktop exec tauri build \
  --config src-tauri/tauri.v2.conf.json \
  --config src-tauri/tauri.release.conf.json \
  --config src-tauri/tauri.release.macos.conf.json \
  --config src-tauri/tauri.preview.conf.json \
  --bundles app
```

应用输出为 apps/desktop/src-tauri/target/release/bundle/macos/Raccoon Preview.app。
此命令使用现有已准备的运行时资源，Preview 采用 ad-hoc 签名。

## 2026-11-20 本机 macOS 0.2 构建

按用户要求只构建当前机器架构，使用 `aarch64-apple-darwin`。前端通过
`VITE_GOOGLE_MAPS_API_KEY` 注入已有浏览器 Key；该 Key 同时写入仓库 Secret
供发行工作流使用。临时使用本机生成的 updater 私钥完成签名，因此本次
`Raccoon.app.tar.gz.sig` 与配置中的 CI 公钥不匹配，不代表真实自动更新通过。

构建结果位于
`apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/`：

- `macos/Raccoon.app`，ad-hoc 签名，`codesign --verify --deep --strict` 通过，
  `runtime:verify-packaged` 通过。
- `macos/Raccoon.app.tar.gz` 与 `.sig`，更新签名使用上述临时私钥。
- `dmg/Raccoon_0.2.0_aarch64.dmg`，SHA-256
  `5db2e9199ef746b8f2fe8adc8a34e9a2b8d7fa8074861d83ed4038cfd7803fc6`。

应用可启动并进入真实 SQLite 工作区；未公证，未验证 Gatekeeper 干净环境安装，
未构建 x64 或 Windows。构建时需要至少约 11 GiB 可用磁盘，`target/debug`
可在不影响 release 构件的前提下清理。
