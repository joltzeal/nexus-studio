# 桌面发行与应用内更新

## 发行组成

`rtk proxy pnpm run desktop:package` 先构建工作区包，再运行
`scripts/stage-desktop-runtime.mjs`，最后使用 Tauri 发行配置构建。
脚本从 Node.js 官方发行地址获取固定版本 `24.18.0`，用同一官方来源的
`SHASUMS256.txt` 校验后，按当前 Rust target 放入 `src-tauri/binaries`。
浏览器适配器、代理池及地址生成插件通过 pnpm deploy 复制到
`src-tauri/runtime`。发行分阶段使用 hoisted 布局，使 Node 依赖以实际目录
进入 Tauri 资源包；默认 pnpm 软链接不会被当前 Tauri 打包流程保留。
以上两个目录是忽略的生成物，不提交到 Git。
发行版从自身资源目录运行适配器，并从自身可执行目录运行 Node sidecar。

浏览器内核不随 Nexus 安装包分发。用户不需要配置 Node、Rust、Python、
环境变量或 CLI 登录；首次创建窗口由官方 SDK 获取对应内核，需要网络。
最新内核仍受用户自己填入的激活码约束。下载失败不会静默换用系统浏览器。
浏览器二进制的再分发权需要独立确认，本流程不打包它。

## CI 与草稿

`.github/workflows/ci.yml` 在 macOS/Windows 和 Linux 上运行源码检查。
`.github/workflows/release.yml` 仅在 `v*` 标签触发，构建 macOS arm64、
macOS x64 与 Windows x64，使用 GitHub Actions 的
`TAURI_SIGNING_PRIVATE_KEY` 签名更新包，向私有仓库创建草稿 Release。
签名密钥不进入源码。本地备份位于开发机的
`~/Library/Application Support/Nexus Studio Release/updater.key`；丢失密钥后，
现有安装无法无缝接受新签名。发版前同步三处版本：
根 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json`。
未提供 `APPLE_SIGNING_IDENTITY` 时，macOS 工作流使用临时 ad-hoc 签名使
应用包及随附 Node 可执行文件具备有效的本地签名；它不提供开发者身份和公证。
正式发行需要在 macOS runner 导入开发者证书并配置公证凭据。

当前没有 Apple Developer ID 或 Windows 签名证书；草稿构件尚不能
称为无提示安装包。macOS 公证、Windows 代码签名与新机器安装验证
必须分别完成。CI 编译不替代真实平台安装和首次内核下载测试。

## 更新通道

安装包的 updater 公钥固定在 `tauri.release.conf.json`；关于页只在发行版
提供“检查更新”。检测到签名版本后可下载、安装并重启，运行中窗口必须先停止。
更新不会删除本机 SQLite、插件私有数据或浏览器 user-data。

私有 `joltzeal/nexus-studio` Release 对普通安装用户不可匿名访问。
配置中的 `joltzeal/nexus-studio-updates` 是拟议的**公开、仅存发行产物**的更新源；
目前该仓库尚未创建，`latest.json` 和安装文件也未发布。创建公开更新源、
上传经过操作系统签名的安装包以及把草稿转为正式发布，是发行前的最后步骤。
在此之前关于页会如实显示更新服务连接失败，不宣称自动更新已上线。

## 本机验证记录（2026-10-22）

在 macOS arm64 上，Node 24.18.0 官方校验下载与 hoisted 资源分阶段完成；
受管 Node 在打包后的 `.app` 中成功导入浏览器适配器。Tauri 生成
`Nexus.app`、更新用 `.app.tar.gz` 和 `.sig`；ad-hoc 签名后的应用通过
`codesign --verify --deep`。Rust `cargo check --locked` 与库测试通过
（58 通过、1 个真实浏览器冒烟用例忽略）；前端测试 323 个通过。
此记录不涵盖 Windows 安装、干净机器首次内核下载或公开更新服务。
