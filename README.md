# Raccoon

面向 macOS / Windows 的电商浏览器工作台，使用 Tauri 2、Rust、React 与 ShardX UI Kit。
每个 Workspace 对应一个已配置的浏览器接入实例，管理其 Profile 和 Folder。
账号、代理、号码、采集、AI 生图、商品库与Ecom Agent 通过插件扩展。

## 窗口与浏览器

- Rust `WindowService` 统一管理创建、接入、编辑、打开、停止、移除与删除。
- `BrowserProvider` 隔离内置 Node 运行时与外部本机 API；不依赖 CloakBrowser Manager。
- 内置窗口在创建时固定完整内核包、数据目录和随机种子；设置页管理激活码与内核下载。
- AdsPower、比特浏览器由用户安装并登录官方应用，在设置中连接本机 API、选择厂商分组并确认账户。
  Raccoon 不代替官方登录或套餐权限。未能安全实现的配置由能力声明禁用。
- “移出 Raccoon”只解除关联；“删除浏览器环境”在确认已停止后删除真实环境。
- 写操作保存意图与结果；超时进入重新检查，避免重复创建或启动。
  接口断线保留窗口与插件关系，显示状态未知。

Profile、Folder、接入、激活码和应用代理由 Rust 存入本地 SQLite。凭据以明文保存。
外观与工作区偏好使用 localStorage；网页预览不能调用原生浏览器命令。
0.2 使用 `com.raccoon.desktop` 下独立的 `v2/raccoon.sqlite`。0.1 的数据目录可留作后续显式迁移。

## 插件

插件中心根据已安装、已启用的插件动态生成二级导航。
现有专用页面包括代理池、地址生成器、共享货源、AI 生图、Vinted 账号、Vinted 监控、
SIM8 接码、邮箱、商品管理与Ecom Agent。
发布应用从插件商店安装 `.nexuspkg`；受信任的 Node 子进程不是安全沙箱。
业务关联始终使用 Raccoon 窗口 UUID，切换浏览器 Tab 不改变账号与号码关系。

Ecom Agent 从商品库选择资料，明确分配到账号窗口，以 Playwright 操作现有环境。
Rust 持久化批次、独占资源、LangGraph 检查点和外部动作回执；
账号确认封禁即停止，发布或发信结果不明时只核对，不自动重发。
商品发布事实通过幂等 outbox 同步；架构、插件方法和验证范围见
[Ecom Agent 执行规范](docs/44-sales-agent-architecture.md)，
草稿、审查、接管、通知与清理见[操作说明](docs/46-sales-agent-operations.md)。

## 开发

工具链基线为 Node.js 24.18.0、pnpm 11.17.0、Rust 1.93.0。
使用 pnpm 工作区与唯一根锁文件。所有 shell 命令带 `rtk` 前缀：

```sh
rtk proxy pnpm install --frozen-lockfile
rtk proxy pnpm run dev
```

Vite 默认地址为 `http://127.0.0.1:1422`，原生开发入口为 `rtk proxy pnpm run desktop:dev`。
真实窗口操作使用桌面应用。构建工具链仅供开发者使用，最终用户无需配置 Node、Rust 或 `.env`。
外部指纹浏览器仍需其官方应用处于登录且开放本机 API 的状态。

| 路径                        | 职责                                     |
| --------------------------- | ---------------------------------------- |
| `apps/desktop-v2`           | React 工作台、ShardX UI Kit 与原生适配层 |
| `apps/desktop/src-tauri`    | Tauri 配置、Rust 业务核心与插件宿主      |
| `packages/contracts`        | 共享严格 DTO 与校验                      |
| `packages/plugin-sdk`       | 插件 manifest、协议与生命周期            |
| `packages/browser-runtime`  | 内置浏览器运行时、内核与便携站点状态     |
| `packages/plugin-contracts` | 主应用使用的公开插件数据契约             |
| `plugins`                   | 本地插件实现，不提交 Git                 |
| `market`                    | 本地插件发布包和商店索引，不提交 Git     |
| `docs`                      | 分模块设计、开发规范与验证证据           |

按当前协作要求，本地不执行应用构建、Rust 编译/测试或 Clippy。
插件单独在本地编译、调试和打包后直接发布对象存储，主应用 CI 不包含插件源码；
目录与操作步骤见[插件本地开发](docs/50-local-plugin-development.md)。
可直接运行 Vitest、ESLint、Prettier、`tsc --noEmit` 与 rustfmt；根检查脚本可能构建依赖，不能替代直接检查。
具体结果与 CI、厂商集成、Windows 安装的未验证边界见[质量记录](docs/09-quality-and-testing.md)。

先读[文档索引](docs/README.md)、[开发规范](docs/03-development-standards.md)、
[0.2 浏览器接入设计](docs/superpowers/specs/2026-11-17-raccoon-02-provider-architecture-design.md)
与[桌面发行和更新](docs/20-desktop-release-and-updates.md)。
