# Raccoon 桌面应用

本目录包含 React / TypeScript / Vite 前端、Tauri 2 桌面入口与 Rust 业务核心。
界面采用纸白与钴蓝，保持紧凑表格、侧栏和 shadcn/ui 控件。

## 页面与数据

四个主页面为窗口管理、分组管理、插件中心和应用设置。
插件二级目录根据宿主目录动态生成；设置包含浏览器接入、内置内核、激活码和应用代理。

窗口页使用三个提供方 Tabs，在现有表格上管理内置浏览器、AdsPower 与比特浏览器。
新建时选择当前接入，已有外部环境可从官方列表接入；创建后不能原地更换绑定。
全局代理占用、账号关系、短信等待与 SIM8 到期提醒覆盖全部接入。
详情不启动浏览器；打开、停止、移出 Raccoon 与删除环境是独立操作。

Rust 是 SQLite 的唯一所有者，窗口与连接字段明文保存，不写 Keychain。
外观与工作区偏好保留在 localStorage，浏览器预览和 Tauri WebView 按来源分别保存。
网页预览不可执行原生窗口命令，不返回模拟成功结果。

## 结构

- `src/lib/platform`：严格校验新窗口、连接、操作恢复与迁移命令。
- `src/features/spaces`：窗口表格、Tabs、编辑、接入已有环境与批量创建。
- `src-tauri/src/core/window_service.rs`：窗口编排、锁、代理、操作意图与恢复。
- `src-tauri/src/core/browser`：提供方 trait、三个适配器、连接与观察存储。
- `src-tauri/src/core/window_store.rs`：严格 schema 2 窗口和不可变绑定。
- `src-tauri/src/core/transfer_service.rs`：内置窗口 manifest 3 加密迁移和同步。

旧 `profile_*` IPC、`NativeProfile` DTO、运行时 schema 1 与旧快照导入已移除。
已有 SQLite 只在启动时执行一次事务升级，正常读写不包含兼容分支。
插件仍使用 Raccoon UUID；厂商 ID 不替代业务关联 ID。

## 开发与检查

从仓库根目录运行 `rtk proxy pnpm run dev` 预览前端。
开发工具链版本和桌面前置条件见[开发规范](../../docs/03-development-standards.md)。
当前不跑本地构建、打包或 Rust 编译/测试/Clippy；直接工具检查和未验证项见
[质量记录](../../docs/09-quality-and-testing.md)。不要以格式检查代替 Rust 编译或厂商 API 实测。
模块入口见[文档索引](../../docs/README.md)。
