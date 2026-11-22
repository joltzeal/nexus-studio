# 插件本地开发与对象存储发布

从 2026-11-14 起，插件实现不再由主应用 Git 仓库分发。插件在开发机编译和调试，发布包直接上传对象存储；桌面应用由 GitHub Actions 构建。

## 目录职责

| 目录                                     | 内容                                                      | 是否提交 Git       |
| ---------------------------------------- | --------------------------------------------------------- | ------------------ |
| `plugins/<name>/`                        | 插件实现、提示词、私有存储、RPC 服务、测试与 manifest     | 否，保留本地并忽略 |
| `plugins/<name>/dist/`                   | 本地编译后的插件入口和资源，供开发宿主安装                | 否                 |
| `market/`                                | 插件发布产物的暂存根目录                                  | 否                 |
| `market/plugins/<id>/<version>.nexuspkg` | 可安装的发布包；这里的 `plugins` 是对象路径，不是源码目录 | 否                 |
| `market/catalog.json`                    | 商店索引，包含版本、最低主程序版本、下载路径与 SHA-256    | 否                 |
| `packages/plugin-contracts/`             | 主应用需要的纯数据类型、方法名和校验规则                  | 是                 |
| `packages/plugin-sdk/`                   | 通用插件协议、manifest、能力与生命周期                    | 是                 |
| `apps/desktop/src/features/`             | 随主应用分发的页面与插件调用适配器                        | 是                 |

`market/` 不是运行中的业务数据库，也不是第二份插件源码。插件安装后的私有数据仍在应用数据目录，升级发布包不替换这些数据。

取消跟踪使用 `git rm --cached`，不会删除本机源码。`.gitignore` 不会清除已经发布过的 Git 历史；本次不重写历史或强制推送。

## 开发

工作区允许可选的本地 `plugins/*`。没有该目录的公开检出仍能安装、检查和构建主应用。

Tauri debug 启动会直接扫描 `/plugins/*` 的 `nexus.plugin.ts` 和 `src/index.ts`，使用工作区
`plugin-sdk`、`plugin-contracts` 源码并通过 Node loader 执行 TypeScript。无需先构建、安装或激活
第一方源码插件。插件进程保留宿主 manifest、方法和能力检查，数据写入应用数据目录的
`plugins/data/<id>`；退出开发应用后，由下次启动重新发现源码并自动加载。
代码修改在插件进程重启后生效，当前宿主不提供模块热替换。

VInted helper 源码目录为 `plugins/vinted-helper/`，保留安装 ID `studio.address-generator`。
源码面单 Worker 直接读取已安装依赖中的 PDFium WASM，不要求先生成 `dist` 资源。
文件夹改名后必须完整重启 Tauri debug 以重新扫描路径，不能只重启旧插件进程。
正式安装包仍需携带 Worker 与六段 WASM，详见[VInted helper 启用方式](19-address-generator-plugin.md)。

```sh
rtk proxy pnpm install --frozen-lockfile
rtk proxy pnpm run plugin:dev ai-image
```

`plugin:dev` 仍为独立打包、资源生成和发布前验证入口。普通桌面调试无需使用该监听脚本。
编译文件更新不会替换已经运行的 Node 进程。仅启动网页预览不能执行原生插件进程。

修改 manifest、资源或生成脚本后，重新执行插件构建，不能只依赖 TypeScript 监听：

```sh
rtk proxy pnpm run plugins:build
```

主应用的 `build:packages` 只编译 `packages/*`，不会顺带构建本地插件。独立插件调试和发布允许本地编译、打包；本地应用构建及 Rust 编译、测试和 Clippy 仍遵循当前协作约定，交给 CI。

## 发布

先更新插件本地 manifest 和 package 版本，并设置真实的最低主程序版本。以下以 AI 生图为例：

```sh
rtk proxy pnpm --filter '@nexus/plugin-ai-image...' build
rtk proxy node scripts/pack-plugin.mjs plugins/ai-image
rtk proxy pnpm run market:catalog
rtk proxy pnpm run market:verify market/plugins/studio.ai-image/<version>.nexuspkg
rtk proxy pnpm run market:publish
```

发布前运行插件行为测试，验证最终包的 manifest、版本、摘要、启动握手和实际所需方法。含资源的插件还要从最终安装包读取资源，不能用源码目录代替。

`market:publish` 按本地目录中完整的 `catalog.json` 上传：先包、后索引。发布单个插件时先读取线上索引，仅替换目标条目，保留其他插件；不要用只有一个条目的目录覆盖线上完整商店。包上传后回读 SHA-256，再更新并回读索引。对象存储账户属于开发发布环境，不要求最终用户配置。

签名市场发布使用 `market:publish --catalog catalog-v2.json`。配置、签名及兼容条件见[插件与插件仓库规范](55-plugin-and-marketplace-standard.md)。

加密包是现有分发格式，不能将它描述成不可逆的源码保护：应用运行插件时必须能够解密和执行。这里的源码保密边界是“不提交实现源码到 Git”，不承诺阻止取得应用和插件包的人分析运行代码。

## 主应用 CI

CI 在检出后执行 `public:check`，拒绝跟踪 `plugins/` 和 `market/` 文件。桌面 Release 只等待 macOS arm64、macOS x64 和 Windows x64 的应用构建，不再等待插件构建或上传插件资产。

本地插件专用集成测试保留在本地插件目录。公开仓库的测试使用公开契约和受控协议夹具，不把缺失的本地插件当成已完成真实集成验证。

插件页面目前随主程序编译。新增页面或修改交互仍需发布主应用；只改插件执行逻辑、模型提示词和私有数据处理时，可以独立发布插件。
