# Raccoon 原生宿主

`src-tauri/` 包含 Raccoon 0.2 的 Tauri 入口、Rust 业务核心和插件宿主。
`src-tauri/tauri.conf.json` 指向 [desktop-v2 前端](../desktop-v2/README.md)，
使用 `com.raccoon.desktop` 应用标识和独立的 `v2/raccoon.sqlite`。

从仓库根运行 `rtk proxy pnpm run desktop:dev` 可启动原生开发入口。
该命令会编译 Rust，请在允许构建的环境执行。发行配置和在线更新通道见
[桌面发行与应用内更新](../../docs/20-desktop-release-and-updates.md)。
