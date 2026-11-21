# Raccoon 插件中心与 Profile 修复实施记录

日期为 2026-11-18。

## 目标

- 保留 ShardBrowser 启动失败的安全分类原因。
- 将 Folder 分配收敛到 WindowStore 的同一 SQLite 事务。
- 使用随机英文单词组合生成新 Profile 默认名称。
- 在 desktop-v2 接入真实插件中心。
- 建立旧版 plugins 向 ShardBrowser 设计语言迁移的规范。

## 已实施

- ShardBrowser Provider 区分代理配置、代理出口检测、Profile 占用、CDP、内核执行和其他启动错误。
- `browser_window_move_group` 通过 WindowStore 校验 Profile、Folder、providerId 和 connectionId 后原子写入。
- 新建 Profile 使用固定词表和浏览器安全随机数生成名称，同一弹窗会话保持不变。
- desktop-v2 新增插件 DTO 校验、Tauri API、授权规则和插件中心页面。
- 插件中心已接入主导航，覆盖目录、商店、搜索、安装、更新、全部更新、授权、详情和卸载。
- 新增插件中心设计规范并同步模块文档。
- 创建、更新和启动操作不再把解析后的代理连接 URL 写入持久化 payload；
  创建重试按保存的代理来源引用重新解析瞬时凭据。
- 旧调用方提交的 inline 手动代理先写入 Rust 代理库并转换为稳定 `proxyId`，
  自动化创建也在写入 action intent 前完成转换，action 与浏览器 operation payload
  均只保存 `proxyId`；同一 action 或 operation 引用在事务内拒绝不同凭据覆盖。
  新的创建、更新、启动、停止与删除操作只保存该引用。
- ShardBrowser 启动分类覆盖 SDK 的 busy、未解决运行标记和损坏锁记录。
- 插件激活弹窗在取消、关闭、Esc 和放弃修改后都会清空激活码状态。

## 验证边界

用户要求停止运行测试。测试、构建、类型检查、lint、Rust 编译、浏览器启动、Folder 写入、插件安装、商店请求和授权操作的验证状态保持待执行。
