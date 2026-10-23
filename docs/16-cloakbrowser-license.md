# CloakBrowser 授权与内核选择

## 目标与当前边界

用户只通过 Nexus 桌面应用粘贴 CloakBrowser 密钥，不依赖 CLI、终端或 `.env`。
Nexus 调用当前锁定版本 CloakBrowser JS wrapper 的公开 `validateLicense` 与
`ensureBinary` 能力；应用不代用户申请、生成或转售密钥。

CloakBrowser wrapper 公开密钥校验 API。许可证计划决定可用内核和并发席位：免费计划使用最新构建，
且不能固定历史版本；其他有效计划可请求精确版本。多窗口席位最终由 CloakBrowser 服务端裁决，
Nexus 不尝试规避服务端限制。

## SQLite 凭据生命周期

- 设置页提供输入、校验并保存、删除；只显示“已配置”与校验返回的计划/有效期，绝不回显密钥。
- Rust 将授权记录写入 Nexus 应用数据目录中的 `nexus.sqlite`；数据库只由 Rust 打开和修改。
  本期不接系统凭据库，也不迁移窗口或演示数据。
- 数据库不加密，密钥以明文保存在本机文件中，访问控制依赖当前操作系统用户权限。
  设置页必须明确提示这一点。Unix 文件权限限制为当前用户；Windows 依赖应用数据目录 ACL。
  UI、localStorage、Profile JSON、命令行参数及日志中不得出现密钥。
- 校验失败或服务不可达时不覆盖已有密钥。用户明确删除后删除 SQLite 授权记录。
- wrapper 的 `validateLicense()` 优先使用有效期内的本地校验缓存；服务不可达时也可能
  使用同一密钥对应的过期缓存。因此“校验并保存”不保证本次请求实时连通授权服务，
  实际启动时的许可席位仍以官方服务及浏览器内核裁决为准。
- 创建窗口和启动窗口时，由 Rust 从 SQLite 取密钥，仅经子进程环境变量
  `CLOAKBROWSER_LICENSE_KEY` 传入 Node 适配进程；不修改用户 shell 环境。
- CloakBrowser 缓存和校验缓存位于应用数据目录的 `cloakbrowser/`，不使用用户 home 下的 CLI 密钥文件。
- 子进程仅向 CloakBrowser SDK 提供者传递密钥所需的最小环境；错误需脱敏，密钥不得进诊断输出。
- Web 浏览器预览没有 Tauri 能力，不展示可保存/可校验的假交互。

## 内核选择

- 默认选项为“授权可用的最新内核”。准备二进制时用用户已保存的密钥调用官方 `ensureBinary`，
  并将返回的实际二进制路径和版本固定到新窗口 Profile。
- 免费计划不能固定旧版本；界面不为免费授权提供版本输入。
- 已配置的非 free 计划可为新窗口填写精确版本，通过锁定 wrapper 的公开 API
  `ensureBinary(licenseKey, browserVersion)` 准备对应内核；下载和授权仍由 SDK 裁决。
- 已创建 Profile 不自动更换版本；升级需新建 Profile 或单独设计可恢复迁移。
- 设置中的「浏览器内核」页可先将基础或新版内核下载到本地，窗口创建复用同一准备服务和缓存。
  下载进度、错误分类及任务边界见[浏览器内核](27-browser-kernels.md)。

## 并发及错误

Nexus 允许不同 Profile 并行尝试，单 Profile 仍独占。CloakBrowser 许可服务和二进制最终裁决
席位数。启动失败应展示脱敏、可操作的许可拒绝信息，
且清理失败的子进程，不自动降级、换版本或回退直连。

UI 将校验状态和窗口启动状态分开，不把“密钥已存”显示为“浏览器已可用”。网络不可达、
密钥无效/过期、SQLite 读写失败、下载失败、版本不兼容及席位已满应使用稳定错误类别。

## 验收

- macOS 与 Windows SQLite 应用数据目录下的授权读写、覆盖、删除分别验证；不得把一个平台的结果
  推断为另一个平台通过。
- 校验失败时旧凭据保持不变；密钥不会出现在命令参数、Profile 文件、应用 localStorage 或日志。
- 使用 UI 保存密钥后新建 Profile 可准备官方授权的最新内核；启动子进程得到同一凭据。
- 免费密钥创建 Profile 成功但并发超过席位时由 CloakBrowser 拒绝，UI 显示许可错误且已占会话不受影响。
- Pro 版本 pin 只传给明确选择的新 Profile；既有 Profile 的绑定保持不变。
- 网页预览不执行授权写入；桌面应用为唯一实际操作入口。

## 当前实现状态

设置页提供状态读取、密钥校验保存和删除；状态只返回配置标志、计划与有效期。
校验通过后才写库，失败不会覆盖旧密钥。授权、Profile 创建和启动命令均由 Rust 托管。
已完成本机授权数据库读写和常规测试；尚未使用真实用户密钥做在线验证，
也未完成 Windows 实机 SQLite ACL、授权内核下载和发行包检查。

## 官方依据

- [CloakBrowser JS README](https://github.com/CloakHQ/CloakBrowser/blob/main/js/README.md)
- [CloakBrowser JS license implementation](https://github.com/CloakHQ/CloakBrowser/blob/main/js/src/license.ts)
- [CloakBrowser JS CLI login implementation](https://github.com/CloakHQ/CloakBrowser/blob/main/js/src/cli.ts)
