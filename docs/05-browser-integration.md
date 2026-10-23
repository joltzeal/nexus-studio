# 浏览器接入契约

## 当前实现

桌面窗口页的“创建窗口”直接创建真实 CloakBrowser Profile；“打开”才启动持久上下文。
Rust 保存绑定和调度，Node.js 适配器
调用官方 JS 包装层。窗口的代理来源可以是手动地址或代理插件；
代理插件由插件宿主解析，失败时阻断启动，见[插件宿主](17-plugin-host.md)。
原有 localStorage 演示窗口不会自动迁移或出现在原生列表。
`packages/browser-runtime` 保留 Node.js 协议基础，目前仅健康与能力描述，不启动窗口。
Manager 只作产品与隔离行为参考，不作为本应用的运行依赖。

## 配置来源与映射

配置选项参考 CloakBrowser 官方 [README 的 Launch、Persistent Context、Fingerprint Management 部分](https://github.com/CloakHQ/CloakBrowser/blob/main/README.md)。
实际接入时必须按选用的 SDK 与二进制版本复核选项。

| 窗口字段           | 官方能力                                                    | 当前处理                               |
| ------------------ | ----------------------------------------------------------- | -------------------------------------- |
| 独立窗口           | `launchPersistentContext({ userDataDir, headless: false })` | 原生 Profile 独立目录，显式打开后启动  |
| HTTP / SOCKS5 代理 | `proxy`                                                     | 手动无凭据地址；插件代理解析失败则阻断 |
| GeoIP              | `geoip` 匹配代理出口时区、语言及 WebRTC IP                  | 有代理时可选；真实出口尚未验证         |
| 时区、语言         | `timezone`、`locale`                                        | 手工覆盖；空值使用包装层默认或 GeoIP   |
| 尺寸               | `viewport`                                                  | 默认或两个常用尺寸                     |
| 指纹种子           | `--fingerprint=<seed>`；持久化 profile 会保留种子           | 可在创建时填写，之后不可修改           |
| 起始地址           | Playwright 页面导航                                         | 仅允许不含凭据的 HTTP(S) 地址          |

底层还支持 GPU、硬件、屏幕、品牌、存储配额、WebRTC 等单项指纹标志。
官方建议保留种子产生的一致参数组合；因此本页不开放任意参数注入。
自定义参数进入插件能力与版本兼容性评估后再设计，避免混合不一致指纹。

## 后续生命周期与安全边界

Rust 核心负责 profile 路径、独占锁、进程生命周期、错误与重试；Node.js 适配器封装官方 SDK。
不同 Profile 的启动和停止可并行；Nexus 不自行猜测或固定 CloakBrowser 并发席位。
官方包装层未公开可信席位数时，超额由 CloakBrowser 启动错误裁决并反馈给用户。
UI 只接受稳定 DTO，不持有进程句柄或调试端口。启动前生成不可变、经过验证的快照；
修改窗口配置不静默改变已运行会话，重启后才应用。
代理必需时，配置无效、不可用或鉴权失败必须阻断启动和敏感流量，
禁止自动回退直连。官网指出部分 Playwright request API 不走浏览器 SOCKS5/认证 HTTP 代理，
适配器必须单独约束这类请求，不能凭页面代理配置声称全部流量已受保护。
日志仅存脱敏摘要，代理密码和许可证不进入 localStorage。

## 版本与分发

CloakBrowser 二进制版本、并发配额及再分发许可由所选版本和授权决定，不能从 profile 数量推断。
在正式打包前核对官方 [binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md)；
macOS、Windows 分别进行启动、隔离、持久化、代理阻断及崩溃恢复验证。
本地表单、协议健康检查、前端构建均不能代替这些运行验证。

# 145 内核启动警告

当前 CloakBrowser SDK `0.6.3` 的默认启动参数包含 `--no-sandbox`；
Playwright 在未显式启用 Chromium 沙箱时也会添加这一参数。
145 内核显示“不受支持的命令行标记”是 Chromium 的启动提醒，
不等同于 Profile 隔离失败，但浏览器进程的沙箱保护确实被关闭。
不能只隐藏提醒后宣称没有安全影响；若要改变启动行为，须先在
145 内核与新版内核、macOS 和 Windows 的临时 Profile 上验证 SDK
是否允许覆盖默认参数及兼容性。
