# 质量门禁与验证记录

## 2026-10-22 地址生成器插件接入

新增第二个完整插件 `plugins/address-generator`（`studio.address-generator`，能力
`address.generator`）与桌面页面 `apps/desktop/src/features/addresses`，导航增加第六个入口。
插件把 Overpass 公开地址查询、资料生成、CSV 与地图 Key 保存放在自己的进程里；
页面只经 `plugin_call` 调用 `address.*`，不新增宿主侧业务命令。

本轮在本机 macOS 实际执行：

| 检查                               | 命令                                                                   | 结果                                                     |
| ---------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| ESLint                             | `eslint . --max-warnings 0`                                            | 通过，无输出                                             |
| Prettier                           | `prettier --check .`                                                   | 通过                                                     |
| 桌面类型检查                       | `tsc --noEmit -p apps/desktop/tsconfig.json`                           | 通过                                                     |
| 插件类型检查                       | `tsc -p plugins/address-generator/tsconfig.json --noEmit`              | 通过                                                     |
| 前端测试                           | `vitest run`                                                           | 29 文件、315 用例通过（插件 57、地址页面 14）            |
| Rust 测试                          | `cargo test --lib --locked`                                            | 58 通过、1 忽略（真实浏览器冒烟），共 59 用例            |
| Rust 静态检查                      | `cargo clippy --all-targets -- -D warnings` 与 `cargo fmt --check`     | 通过                                                     |
| 前端构建                           | `vite build`                                                           | 通过，主 chunk 625.54 kB，仍有大于 500 kB 的警告         |

新增 Rust 用例 `workspace_address_plugin_installs_enables_and_serves_its_catalog`：
把插件从 `dist` 安装进临时宿主、以 `address.generator` 启用、调用 `address.catalog`
断言 10 个国家，并验证同一插件用 `proxy.provider` 调用会被 `PERMISSION_DENIED` 拒绝。
同一轮里修掉 `core/profile_service.rs::list` 的 `needless_question_mark`（既有代码，
clippy 报错，改为直接返回 `collect` 结果，行为不变，测试仍全过）。

环境限制（不是代码问题）：本机沙箱拦截批量删除，`vite build` 需要先把
`apps/desktop/dist` 移走，`vitest` 启动时需要把 `node_modules/.vitest-cache` 移走，
否则报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。`pnpm install` 在本沙箱会因符号链接
`EEXIST` 失败，故本轮直接用 `node_modules/.bin/*` 调用工具，未重跑 `pnpm` 聚合命令。

未验证：真实 Google Maps Key 下的地图选点与 Geocoding 配额、Overpass 上游地址质量与
限流表现、地址能否真实收件、Windows 行为。

## 2026-10-22 SQLite 授权接入与文档对齐

设置页在桌面端提供密钥校验保存、状态读取和删除；Rust 将校验后的密钥以明文写入
`app_data_dir/nexus.sqlite`，只返回计划与有效期等元数据。创建新窗口时可按授权计划
选择精确内核版本，Rust 从 SQLite 读取密钥并通过子进程环境变量传入 CloakBrowser 适配器。
窗口管理当前直接操作原生 Profile，不再显示旧 localStorage 演示窗口；分组仍未接入原生窗口。

本轮验证：`rtk proxy pnpm run lint` 通过；`rtk proxy pnpm run typecheck` 通过；
`rtk proxy pnpm run test` 为 21 文件、229 用例通过；`rtk proxy pnpm run build` 通过，
但报告一个大于 500 kB 的前端 chunk 警告；`rtk proxy pnpm run rust:check` 通过；
`rtk proxy pnpm run rust:test` 为 51 项通过、1 项真实浏览器用例忽略；
格式化后 `rtk proxy pnpm run rust:lint` 通过。授权相关 Rust 局部测试 8 项通过，
桌面与 browser-runtime 的局部 TypeScript 检查通过。文档及触及的源码文件经 Prettier
检查通过，`git diff --check` 通过。`rtk proxy pnpm run runtime:check` 返回
`status=ok`、`browser=not-connected`，不代表浏览器已启动。上述检查均在本机 macOS 开发环境执行。

全仓 `rtk proxy pnpm run check` 在 Prettier 阶段退出：`.workbuddy-ai/memory/2026-10-22.md`
未符合格式规范；该本地记忆文件未修改，未将聚合命令记为通过。
未使用真实用户密钥验证在线校验、内核下载、许可席位与授权会话；Windows ACL、
正式安装包、无开发工具运行和真实代理出口均未验证。

下方是按实施时间保留的历史阶段记录；其中“尚未接入”仅描述该阶段，
不代表当前代码状态。当前能力边界以本节和各模块文档为准。

## 2026-10-22 移除系统钥匙串，密码改由插件明文保存

代理密码与 proxycheck 密钥不再经过宿主：删除 `core/plugin_host/credentials.rs`、
`secret`/`secret-result` 控制消息、`plugin_secret_set`/`plugin_secret_clear` 两个命令，
以及插件侧的 `secret-bridge`。插件把密码明文写入私有目录的 `secrets.json`（权限 0600），
与 `proxy-pool.json` 同级；宿主既不接收也不托管，界面不再展示凭据库或系统钥匙串。

代理池页面删除默认代理 / 窗口启动 / 凭据库状态面板，未选择默认代理时改为库存页一行说明；
配置页新增 proxycheck 密钥输入，由插件自己保存。插件入口改用 realpath 比较，
修掉安装目录位于 `/var`、`/tmp` 等符号链接路径时进程静默退出、握手超时的问题。

本轮 `cargo test --lib --locked` 为 50 项通过、1 项忽略；前端 19 文件 228 用例；
`cargo clippy --all-targets -- -D warnings`、`cargo fmt`、`typecheck`、`lint` 通过。
新增用例：`install_keeps_a_manifest_that_lives_in_dist`、
`workspace_plugin_installs_from_its_built_dist_and_runs`（真实包安装后启用并调用）、
插件侧 `secret-vault.test.ts`（明文落盘、0600、重启后仍可解析）。

尚未验证：密码文件的加密与访问控制只依赖文件权限，不做额外保护；Windows 未验证。

## 2026-10-22 插件宿主与代理池页面

新增 `core::plugin_host`：manifest 严格校验、发现、安装与卸载、`registry.json` 原子写入、
受管 Node.js 子进程与逐行 JSON 协议、能力检查点，
并把 `proxy_plugin` 接到窗口启动前的代理解析，解析失败时槽位不被占用。
插件中心改为按真实状态显示，新增代理池页面调用 `proxy.*` 方法。

本轮 `cargo test --lib --locked` 为 49 项通过、1 项真实浏览器用例忽略，
其中 13 项为宿主用例，包含对 `plugins/proxy-pool` 的真实握手与 `proxy.list`、
`proxy.get` 调用；`cargo clippy --all-targets -- -D warnings` 与 `cargo fmt` 通过。
前端 `typecheck`、`test`（20 文件 229 用例）、`lint --max-warnings 0` 与构建通过。

尚未验证：真实代理出口流量、Windows 下的进程回收、插件代码被篡改后的启动行为、
操作系统级隔离。宿主对出站网络不做拦截，声明的域名无法在运行时强制。
细节与限制见[插件宿主](17-plugin-host.md)。

## 2026-10-22 原生 Profile 接入

新增 Rust 磁盘绑定记录、Tauri 创建/列表/启动/停止命令及 CloakBrowser JS 适配进程。
独立于既有 localStorage 演示窗口。本机通过 `profile-runner.js prepare` 取得已缓存
内核版本 `145.0.7632.109`，以临时目录执行真实 `launchPersistentContext`，
启动信号与正常关闭均通过；Rust 的忽略式端到端测试也完成了创建、启动、停止、
重新实例化读取版本的流程。临时 Profile 未写入用户正式列表。
根 `check` 已通过：前端 7 文件 112 用例、Rust 19 项常规用例、Clippy、
类型检查和构建；真实内核用例在根检查之外单独执行通过。

尚未验证 Windows、发行包内置 Node、账号许可配额、代理真实流量与异常退出清理。
初次启动 `desktop:dev` 时发现已有 Vite 服务占用 1420 端口；加入复用已有
Nexus 服务的开发入口后，再次启动桌面命令通过，Tauri 进程运行中。
浏览器预览已检查新区域明确要求桌面应用使用。

## 2026-10-22 profile 版本绑定修正

在纯内存调度器增加 profile 到通道 ID 与精确版本的绑定检查。
未登记的 profile 拒绝启动；停止后尝试切换通道或重启后加载不同版本的内核均被拒绝。
新增三个 Rust 用例。绑定记录的实际写盘与浏览器 profile 目录创建尚未实现，
不能把内存测试当作跨进程持久性证据。

## 2026-10-22 Rust 核心调度

新增纯内存的引擎通道和容量预留、窗口/profile 独占、启动与停止的代次回调检查，
以及插件能力登记和代理引用解析端口。已按 CloakBrowser 官方 README 与
二进制许可核对双版本使用边界；此处没有下载安装或启动浏览器。

本轮 `rtk proxy pnpm run check` 完整通过：ESLint、Prettier、TypeScript、
前端 6 文件 109 用例、前端构建、Rust check、Rust 12 用例与 Clippy。
初次运行格式门禁发现两份文档格式不符，格式化后重新运行完整门禁通过。
Rust 测试只验证内存中的调度和插件契约；未接入真实二进制、授权席位、
受管 sidecar、SQLite 或 Tauri 业务 command，也未在 Windows 执行。

## 2026-10-22 多窗口并行启动

移除 Nexus 对真实 Profile 的单会话硬限制；调度器按 Profile 独占，生产引擎通道
将席位裁决交给 CloakBrowser。浏览器启动和停止等待在 Rust 状态锁外进行，窗口页按窗口
隔离操作状态并显示运行数量。新增调度回归测试，确认两个独立 Profile 可同时预留，
重复使用同一个 Profile 仍会被拒绝。CloakBrowser 许可拒绝的原生端到端验证尚未执行。

本轮 `rust:test` 为 23 项通过、1 项真实浏览器用例忽略；`rust:check`、`rust:lint`、
ESLint、Vitest 17 文件 213 项、构建及本次触及的 Prettier 文件检查通过。
全仓 `typecheck` 仍被 `plugins/proxy-pool` 两项既有测试类型错误阻断；全仓格式检查
仍发现 3 个未修改文件不符合格式。未执行 CloakBrowser 授权席位实测或 Windows 验证。

## 2026-10-22 窗口管理更新

本轮将页面术语统一为“窗口”，加入代理、地域、尺寸、指纹种子和起始地址等配置，
并提供本地增删改查。窗口详情显示“未连接”，未验证 CloakBrowser 实际启动或代理生效。
默认状态不再创建样例记录；旧版数据读取时补充配置并清理旧的样例措辞。

本轮 `typecheck`、`lint`、`test`、`build`、`format:check` 已通过；
Vitest 为 6 文件、109 用例。`lint` 初次发现测试夹具的未使用变量，修正后通过。
浏览器预览已检查代理凭据输入被拒绝、有效配置创建及刷新恢复、详情配置、
删除确认的取消分支和 390 × 844 创建表单；删除提交分支由仓库测试覆盖。
此前的页面检查数据记录在下方，为上轮结果，不应当作本轮重复验证。

## 本轮验收对象

本轮交付前端演示页面、独立模块文档和 Tauri 桌面壳。
下面记录本次 macOS 本地初始化工作区的实际结果；当前尚无 Git 提交。
Rust 业务、SQLite、真实浏览器、代理和插件执行均后续接入，不在本轮验收范围。
CI 配置已建立，但未在远程运行，不将配置存在写成双平台通过。

## 工程检查

| 项目               | 入口                               | 本次结果                                            |
| ------------------ | ---------------------------------- | --------------------------------------------------- |
| TypeScript         | `rtk proxy pnpm run typecheck`     | 通过：共享包、桌面前端和测试配置                    |
| ESLint             | `rtk proxy pnpm run lint`          | 通过，无警告                                        |
| Prettier           | `rtk proxy pnpm run format:check`  | 通过                                                |
| Vitest             | `rtk proxy pnpm run test`          | 6 文件、123 用例通过                                |
| JS 构建            | `rtk proxy pnpm run build`         | 通过，设置页按需加载，无 chunk 大小警告             |
| 独立健康协议       | `rtk proxy pnpm run runtime:check` | 返回 status=ok，browser=not-connected               |
| macOS Rust 壳编译  | `rtk proxy pnpm run rust:check`    | 通过，使用锁文件                                    |
| Rust 测试          | `rtk proxy pnpm run rust:test`     | 命令通过，实际 0 用例；仅保留壳，没有 Rust 业务测试 |
| Rust 格式与 Clippy | `rtk proxy pnpm run rust:lint`     | 通过，Clippy 按警告失败                             |
| 聚合检查           | `rtk proxy pnpm run check`         | 通过，覆盖表中 JS 与 Rust 检查；协议单独执行        |
| Tauri 演示启动     | `rtk proxy pnpm run desktop:dev`   | 本次未运行原生窗口；不能用壳编译代替启动证明        |

Vitest 覆盖偏好校验与顺序写入、演示数据持久化、损坏数据保留、拒写、分组引用、插件 manifest、JSON-lines 分帧与协议错误。
前端演示新增 33 项仓库及数据边界用例；不为间距和简单样式增加镜像测试。
检查原始日志保存在本机 `/tmp/nexus-foundation-qa/check.log`，不进入产品源代码。
该临时路径仅用于本次核对，不是发行产物，也不保证长期保留。

## 浏览器交互检查

使用 Codex 内置浏览器访问 `http://localhost:1420/`，保留原有开发服务。
页面身份、实际内容、框架覆盖层和控制台均已检查。
开发中移除旧 ThemePreview 文件曾产生一条历史 HMR 错误；最终刷新后无新增应用错误或警告。

| 页面或行为 | 实际操作与结果                                                     |
| ---------- | ------------------------------------------------------------------ |
| 窗口创建   | 空名称被拒绝；填写名称、备注、分组后新增列表行；刷新恢复           |
| 窗口编辑   | 修改备注保存后列表同步，并保持本地资料                             |
| 搜索与筛选 | 名称搜索命中、无结果 Empty、按分组仅显示所属空间                   |
| 窗口详情   | 仅显示本地说明与未接入状态，关闭后焦点回到原操作按钮               |
| 分组       | 重命名后显示更新；关联数量与窗口列表一致，刷新后可读回             |
| 插件       | 示例开关切换并在刷新后恢复；详情明确没有执行宿主                   |
| 外观       | 浅色/深色与标准/紧凑实际改变根状态，紧凑控件为 28px                |
| 工作区     | 空名称校验、合法保存反馈、侧栏同步；测试后恢复原名称               |
| 关于       | 版本 0.1.0、前端演示与浏览器未连接说明正确                         |
| 键盘       | 侧栏上下键切换、Escape 关闭表单、受控 Dialog 焦点恢复              |
| 存储错误   | 拒写、损坏数据、错误版本由单元测试覆盖；未在浏览器 UI 注入存储故障 |

跟随系统主题和系统减少动态效果已实现，尚未通过修改操作系统设置进行人工回归。
外观恢复确认入口存在，未通过本轮浏览器操作执行重置。
分组新建、无分组和空分组分支由实现提供，本轮人工重点验证重命名和关联关系，未逐项穷举。

## 密度与响应式

当前采用现代、克制的后台风格，统一以 shadcn Nova 紧凑尺度为基准。
实际桌面测量：顶栏 52px，主按钮 32px，列表数据行约 50px。
卡片 padding/gap 为 16px，表格单元格上下 8px、左右 12px，Dialog p-4/gap-4。

| 视口           | 实际结果                                                   |
| -------------- | ---------------------------------------------------------- |
| 1536 × 1024    | 桌面侧栏、工具栏与列表无整页横向溢出；设置分类水平排列     |
| 960 × 700      | 插件页在桌面最小窗口宽度下无整页横向溢出                   |
| 390 × 844      | 顶部导航、窗口页、设置页无整页横向溢出；表格在容器内部滚动 |
| 390 × 844 弹窗 | 创建表单宽 358px、高约 570px；可见控件和关闭操作正常       |

修复了嵌套 Tabs 继承外层方向样式导致设置分类竖排的问题，方向样式现在由最近的 Tabs 提供。
修复了多个行操作共用受控 Dialog 时，关闭后焦点落到 body 的问题。
截图保存在本机 `/tmp/nexus-foundation-qa/`，最终交付使用实际渲染截图，概念图不作为通过证据。
临时视口覆盖在完成检查后恢复，不改变用户长期窗口偏好。

## 尚未验证与后续门禁

| 后续事项             | 当前状态                                       |
| -------------------- | ---------------------------------------------- |
| Rust SQLite 业务     | 未实现；后续验证命令、事务、迁移与错误恢复     |
| 真实 CloakBrowser    | 未接入；不提供本地启动、锁或崩溃恢复证明       |
| 必需代理失败阻断     | 已实现并有 Rust 用例；未在真实浏览器启动中验证 |
| 真实插件执行         | 已实现受管子进程与真实握手用例；不是安全沙箱   |
| 凭据保护             | 不适用；插件密码是私有目录内的明文文件         |
| Windows 构建与安装   | 未在 Windows 执行；已有 CI 检查配置            |
| macOS/Windows 安装包 | 本轮未构建、安装、签名或公证                   |
| 无开发工具运行       | 尚无完整产品证据，待运行时和浏览器打包后验证   |

用户已在 Manager 验证隔离和持久化，保留这一外部参考，不作为本项目已接入的证明。
SDK 与 Manager 的代理责任待接入时核实，见[浏览器接入](05-browser-integration.md)。
当前开发演示通过不等于正式可分发，发布门禁见[应用分发](08-distribution.md)。
