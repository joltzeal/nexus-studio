# 插件导航图标与 Ecom Agent desktop-v2 迁移

范围：11 个本地插件自主声明图标、宿主验证及透传、v2 侧栏和完整 Ecom Agent 工作台。
直接按用户授权实施，保留现有未提交修改；不建立 v1 兼容页面或通用旧 IPC 别名。
UI 按 unslop 的保留产品功能原则适配现有 ShardX UI Kit，不另建主题。

## 实施清单

- [x] 扩展 `PluginUiDeclarationSchema`，将 navigation 和 Profile 面板分别建模。
- [x] Rust 对应校验，拒绝空声明、不安全路径、仅导航插件声明服务。
- [x] 侧栏、折叠栏和插件中心复用 `PluginNavigationIcon`，11 个插件图形互异。
- [x] 迁移商品选择、批量编辑、拖拽和按钮分配、运行前检查及确定创建请求。
- [x] 迁移草稿模板的修订、保存未确认和恢复核对。
- [x] 迁移模型、测试、并发、速率、重试、费用预算、通知及保留设置。
- [x] 迁移任务、Profile 作业、事件、冻结素材、人工审查和用量明细。
- [x] 迁移批次及单作业暂停、继续、取消、隔离接管、核对和补登记流程。
- [x] 迁移清理预览、二次确认、保护规则和失败反馈。
- [x] 当前 Workspace 限定候选 Profile；创建和预检命令显式传入 connectionId，由 Rust 校验。
- [x] 商品、账号和 Profile 详情可跳转关联运行记录；Agent 可打开相关业务记录。
- [x] 恢复任务只读深链 `nexus://agent/<UUID>`，不能从链接执行任务控制。
- [x] 完成定向自动化回归、静态检查和质量记录。

## 功能保留核对

| 模块 | v2 路径（`src/pages/plugins/sales-agent/` 下） |
| --- | --- |
| 主界面与原生契约 | `index.tsx`、`api.ts`、`completion-api.ts`、`native-boundary.ts` |
| 商品与 Profile 分配 | `batch-composer.tsx`、`assignment.ts`、`product-picker.tsx`、`product-editor.tsx` |
| 商品与冻结素材 | `product-cover.tsx`、`artifact-cover.tsx`、`product-picker-metadata.ts` |
| 草稿模板与运行前检查 | `workspace-library.tsx`、`workspace-state.ts`、`preflight-panel.tsx` |
| 任务与恢复 | `batch-runs.tsx`、`batch-detail.tsx`、`run-controls.tsx`、`state.ts`、`retry-countdown.tsx` |
| 事件、审查、用量 | `agent-events.tsx`、`job-items.tsx`、`review-workbench.tsx`、`usage-panel.tsx` |
| 设置和清理 | `settings-dialog.tsx`、`execution-settings.tsx`、`retention-dialog.tsx` |
| 公共呈现和异步读取 | `presentation.ts`、`agent-pagination.tsx`、`use-query.ts` |
| 新 UI 组件适配及依赖 | `controls.tsx`、`icons.tsx`、`dependencies.ts`、`scope.tsx` |

Agent 页面通过 connectionId 和插件安装身份隔离的 React Activity 保留，跳转商品、账号或同连接的
Profile 后返回仍保留草稿、批次编辑、分配、分页和原创建请求标识。
Activity 隐藏时暂停查询、计时器和 portal；原有在途写入由外层页面生命周期管理，
不能因为隐藏触发 effect 清理就丢弃提交回执或永远停在 busy。
切换 Workspace、卸载或替换插件时清理原页面请求作用域。

只读审查发现并修复首次挂载商品详情被写入门禁拦截、未注册 Profile get 命令、
失败导航意图反复重放、管理入口被待消费深链拉回，以及跨页卸载 Agent 草稿的问题。
对应回归涵盖未加载列表时读取详情、已删除 Profile、旧导航失败、隐藏与返回、
生命周期销毁和 StrictMode 再次 setup。

Node 插件已有 LangGraph、平台工具、提示词、美国分类资源和设置存储均保留；本轮不改写它们。
Rust 继续拥有任务、冻结快照、操作标识、占用和持久化恢复，不在 React 中模拟任务执行。

## 验证边界

按用户要求不执行插件 build、应用 build、打包、发布或图像验证；不执行 Rust 编译、测试或 Clippy。
允许定向 Vitest、Node 测试、无产物 TS 检查、ESLint、Prettier 和 rustfmt。
源码和受控回归不能代表真实模型、Bark、Vinted 写入、系统深链注册或双平台安装验收。
图标属于 manifest 元数据，现有已安装包需在后续由用户授权的构建、安装流程更新；
不能声称未重建的插件包已经包含新图标，也不能把修改后的同版本源码视为已发行宿主支持。
