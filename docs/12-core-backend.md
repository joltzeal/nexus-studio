# 核心后端：引擎通道、调度与插件边界

## 范围

Rust 核心管理 profile 到内核版本的持久绑定、窗口调度和插件能力声明。
`profile_service` 通过 Node 适配器调用 CloakBrowser JS wrapper，并注册 Tauri 命令。
窗口管理直接使用真实 Profile，历史 localStorage 演示窗口不自动迁移；SQLite 保存窗口配置、
内核绑定与激活码，
插件宿主由 Rust 托管独立 Node 进程。

## 版本取舍

截至 2026-10-22，CloakBrowser 官方 README 将最新构建标为 Chromium 155：
旧的 v146 二进制可无密钥运行；最新构建可通过免费密钥使用一个并发会话，
Pro 计划提供更多会话席位。具体访问条件应以当前许可和账户资格为准。
这不是“145 才能多窗口”的固定技术边界，具体配额由 CloakBrowser 许可证决定。
浏览器窗口、profile 数量、会话席位及标签页数量是不同概念。

允许设备保留两个**官方来源**的不同版本二进制，但每个窗口绑定明确的引擎通道和单独 profile。
这只是并列安装和显式选择，不是让两个版本共享一个 profile 或合并免费会话配额。
创建表单默认基础内核，用户可明确选择最新内核；保存激活码不改变默认选项或已有窗口。
容量不足返回明确错误，不能自动降级旧版、跨通道借席位或尝试规避许可证限制。
已被新内核打开的 profile 不能直接交给旧内核启动；需要独立目录和经过验证的迁移流程。
Nexus 不自行将并发限制为一个会话，尚未接入官方实时席位查询；
独立 Profile 可并行启动尝试，CloakBrowser 启动结果负责最终许可裁决。
超出授权时将返回启动错误，不自动切换内核或绕过许可。纯调度器仍支持有限容量及未知容量
拒绝预留的通用模型，但生产 Profile 通道使用 ProviderEnforced 模式。

官方包装层提供按版本缓存、`CLOAKBROWSER_BINARY_PATH` 本地二进制入口和
`ensureBinary(licenseKey, browserVersion)` 精确版本选择。窗口创建传入明确的
`kernelKind` 与可选完整版本：基础通道不传密钥，新版通道读取 SQLite 激活码。
再用二进制自身 `--version` 确定绑定。基础版本输入对未激活和免费计划均可用；
新版通道只有已配置的非 free 计划可固定版本，免费计划使用该通道最新版本。
Manager 的 `browser_manager.py` 作为生命周期参考：区分 launching/running/stopping、
按 profile 防重入和识别席位拒绝；本项目不依赖 Manager 的 Python 服务。

## 模块契约

- `core::scheduler`：注册通道，要求正整数容量；按通道统计启动中、运行中和停止中预留。
  新 profile 先生成包含通道 ID 与**精确内核版本**的绑定记录；调用方必须先持久化，
  再恢复绑定供调度器使用。未绑定的 profile 不可启动，绑定后的 profile 即使已停止，
  也不能切换通道或内核版本；程序重启后需从可靠存储恢复原绑定，不能依照默认通道重建。
  `ProfileStore` 在应用数据目录中创建独立记录，程序重启时恢复绑定；记录缺失或损坏
  会拒绝加载，不用默认版本补写。每个窗口与 profile 均独占。
  预留返回带代次的不可变快照；
  启动完成、失败、停止完成、进程意外退出必须带相同代次，迟到回调不得影响新尝试。
  启动失败仅在残留进程清理完成后释放，停止完成仅在进程实际退出后释放。
  容量下降不强制关闭现有预留，只阻止后续预留。运行中进程状态仍在内存，
  程序异常退出后的外部进程协调还需完善。
- `core::plugins`：登记带 API 版本和能力的插件描述，供调度器解析代理端口。
  完整插件系统在 `core::plugin_host`：读取 SDK manifest、安装、托管 Node.js 子进程、
  执行能力检查点；插件密码由插件自己管理，见[插件宿主](17-plugin-host.md)。
  `ProxyProviderPort` 是代理插件解析端口，返回不含明文凭据的配置句柄和可选密钥引用。
- `core::Core`：在预留前验证代理插件已登记且具备代理能力，解析失败不占用通道；
  空配置句柄同样拒绝。无代理选择是显式直连，由后续真实业务策略决定是否允许。

所有 API 的错误均可分类：通道不存在、容量未知/已满、窗口/profile 占用、
插件缺失/能力不匹配、代理解析失败、回调代次不匹配。
真实 Profile 的运行状态只在适配进程确认启动后显示；网页预览不提供原生操作。

## 当前可试用的桌面流程

窗口管理页的“创建窗口”直接创建 Profile。创建时由官方包装层准备二进制，
把实际路径和内核版本写入 `nexus.sqlite`；旧版 `profile.json` 在读取时迁移。
浏览器目录为 `app_data_dir/profiles/<id>/user-data`。
启动时再次执行二进制的 `--version`，必须与记录一致；
然后调用 `launchPersistentContext`，使用该 profile 的目录和可选无凭据代理地址。
停止时等待对应适配进程退出。不同 Profile 的启动与停止不会持有全局状态锁等待浏览器，
可同时运行；相同 Profile 在启动、运行或停止期间仍由调度器独占。
运行状态显示已启动的 Profile 数，不代表 CloakBrowser 的许可席位总数。

在仓库根目录运行 `rtk proxy pnpm run desktop:dev` 后即可试创建。
该开发路径依赖本机 Node.js 和 pnpm，首次内核准备需要官方来源可访问及相应授权。
当前尚未将 Node 和依赖打包为 macOS/Windows 免配置发行产物。
前端浏览器预览只展示入口说明，不执行 Tauri 命令。

## 后续适配

当前 Node 子进程调用 MIT 授权的 CloakBrowser JS wrapper；
Rust 持有启动、停止与磁盘绑定记录。后续仍需发行包内置 Node 运行时、
官方席位查询（如未来提供）、更完整的崩溃恢复和代理失败阻断验证。
启动前生成配置快照，授权密钥只由 Rust 注入浏览器适配子进程；插件管理自己的密码，不能直接访问 SQLite 或
浏览器进程。旧前端存储迁移尚未设计；真实窗口 CRUD 已走 Profile 目录。优先采用公开源码的依赖；
CloakBrowser 包装层为 MIT 开源，官方发布的编译二进制仍受独立的专有许可约束。
后端创建真实 profile 时使用 `create_new` 写入唯一绑定记录；若已有目录但缺少或损坏记录，
应拒绝启动，不得以当前默认版本补写。当前未提供 UI 修复流程。
更换内核版本需创建新 profile 或另行设计有备份与验证的显式迁移流程。

公开依据：
[CloakBrowser README](https://github.com/CloakHQ/CloakBrowser/blob/main/README.md)、
[Manager 浏览器管理器](https://github.com/CloakHQ/CloakBrowser-Manager/blob/main/backend/browser_manager.py)、
[二进制许可](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md)。
面向第三方分发或让他人控制浏览器前，必须先确认相应 OEM/SaaS 授权；
内部工作室使用与外部分发的许可边界不同。官方许可明确禁止规避会话限制；
双版本共存不是规避授权的机制，具体以官方当前协议为准。
