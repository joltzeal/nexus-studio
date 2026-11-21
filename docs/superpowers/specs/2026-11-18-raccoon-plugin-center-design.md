# Raccoon 插件中心设计规范

日期为 2026-11-18。

## 产品范围

插件中心负责发现、安装、更新、授权、查看清单和卸载插件。Rust 插件宿主拥有目录、进程、授权、商店配置和安装状态。前端读取宿主事实并发起明确操作。

插件目录属于整个 Raccoon 应用。切换 Browser Workspace 时，插件中心保留当前页签、搜索和页面位置。插件业务关系继续使用 Raccoon Profile UUID。

安装完成后宿主自动启动插件。启动中、运行中、后台重试和需要激活由宿主返回。当前页面的生命周期控件为安装和卸载，进程启动与重试由宿主管理。

## 页面结构

desktop-v2 使用 ShardBrowser Launcher 页面骨架。

1. `PageHeader` 承载标题、搜索、检查更新、全部更新和商店设置。
2. 内容顶部使用 `SegmentControl` 切换“已安装”和“插件商店”。
3. 页签右侧显示运行中、待激活、可更新和最近检查时间。
4. 主体使用 `DataList` 表格，沿用 `row-line`、键盘导航、行操作和更多菜单。
5. 插件清单与发布信息使用 UI Kit `Modal`。
6. 商店设置与激活使用 `DialogModal`，卸载使用 `AlertModal`。
7. 加载、读取失败、搜索无结果、空目录、商店未配置和商店错误均使用现有状态组件。

## 表格规则

标准行高为 58px。表头和行分隔由 `DataList` 统一绘制。操作在行 hover、键盘焦点和菜单打开时显示。

“已安装”页签列定义如下。

| 列 | 内容 | 建议宽度 |
| --- | --- | --- |
| 插件 | 32px 中性图标块、名称、插件 ID | `minmax(250px, 1.35fr)` |
| 能力 | manifest capability 列表 | `minmax(170px, 1fr)` |
| 版本 | 当前版本和可更新版本 | `minmax(110px, .55fr)` |
| 状态 | 宿主进程状态和授权状态 | `minmax(210px, 1.2fr)` |
| 操作 | 主操作和更多菜单 | DataList 固定操作轨 |

“插件商店”沿用前三列。最后一列显示发布说明和包大小。行主操作根据状态显示安装、更新、激活或“已安装”。

长 ID、能力、方法、域名和错误文字允许换行或截断。详情弹窗提供完整内容。checksum 校验由宿主负责，表格保持摘要信息。

## 密度与间距

- 页面顶栏高度沿用 52px。
- 顶栏控件使用 `xsmall`，行内操作使用 `3xsmall`。
- 页面内容使用 `px-gutter`。
- 页签、统计和列表之间使用 12px 间距。
- 行内图标使用 14px，插件图标块使用 32px。
- 弹窗正文使用 14px 水平内边距和 16px 垂直节奏。
- 列表末端保留页面自身的滚动留白。

旧版页面改造时应直接采用这些组件和尺寸，移除旧版独立的 `.plugins-workspace`、`.plugin-overview`、`.plugin-panel` 和 Table 外壳样式。

## 字体与颜色

页面只使用 ShardX UI Kit 的语义 token。

- 名称使用 `text-ui` 和 `text-text-strong-950`。
- 插件 ID 使用等宽字体、`text-micro` 和 `text-text-soft-400`。
- 次要说明使用 `text-secondary` 和 `text-text-sub-600`。
- 图标块使用 `bg-bg-weak-50` 和 `text-icon-sub-600`。
- 状态使用 `Badge` 的 success、information、warning 和 gray。
- 错误、警告和进度反馈使用 `Alert`。
- 危险操作使用 error 变体。

业务 JSX 统一使用语义 token。插件类型和 capability 使用中性视觉。

## 状态语言

宿主状态映射如下。

| 宿主值 | 页面文案 | Badge |
| --- | --- | --- |
| `available` | 本地可安装 | gray |
| `starting` | 启动中 | information |
| `running` | 运行中 | success |
| `retrying` | 后台重试 | warning |
| `unlicensed` | 需要激活 | warning |

第一方插件授权映射如下。

| 授权值 | 页面文案 |
| --- | --- |
| `inactive` | 需要激活 |
| `active` | 已激活或已激活至指定日期 |
| `expired` | 授权已过期 |
| `invalid` | 授权无效 |
| `needsConnection` | 需要联网核验或离线可用至指定日期 |

进程状态和授权状态分别展示。安装、进程启动和业务可调用性由宿主继续分别判定。

## 操作流程

### 初次读取

页面并行读取 `plugin_catalog`、`plugin_market_status` 和 `plugin_license_status`。三个结果通过边界校验后一起进入页面状态。返回格式错误使用明确的契约错误。

### 本地安装

开发目录中发现的 `available` 插件显示“安装”。点击后调用 `plugin_install`。成功后重读目录、商店和授权状态。

### 商店安装和更新

商店行调用 `plugin_market_install`。当前版本显示“已安装”。更高版本显示“更新”。全部更新先调用 `plugin_market_refresh`，随后顺序更新已安装、可更新且授权可用的插件。页面保留逐项失败信息。

### 授权

第一方插件显示激活入口。激活码仅保存在当前弹窗状态并提交给 `plugin_license_activate`。
输入框使用 password 类型与 secret 属性。成功后清空输入并重读目录。

### 卸载

卸载使用危险确认弹窗。确认后调用 `plugin_uninstall`。失败时保留错误并允许重试。成功后关闭弹窗并重读目录。

### 后台状态

存在 starting 或 retrying 插件时，每三秒重读一次目录。页面卸载时停止轮询。商店后台检查继续由 Rust 宿主管理。

## 弹窗

插件清单使用大尺寸详情弹窗，字段包含版本、API 版本、最低核心版本、状态、能力、已授权能力、方法、网络域名、浏览器访问、存储和密钥槽。

商店发布信息使用中尺寸详情弹窗，字段包含版本、安装状态、能力、包大小、说明和更新内容。

商店地址使用中尺寸设置弹窗。字段支持商店根地址或完整 `catalog.json` 地址。已配置时提供“清除地址”。

激活使用任务弹窗。标题包含插件名称，副标题包含插件 ID 和当前授权状态。

## 可访问性

- 页签使用 tab 语义和方向键导航。
- 搜索沿用 PageHeader 的 `/` 和 Mod+F 行为。
- DataList 支持上下方向键、Home、End、Page Up、Page Down、Enter 和 Space。
- 图标按钮拥有完整名称。
- 状态文字承载完整含义，颜色提供辅助识别。
- 弹窗具备标题、说明、焦点圈和关闭行为。
- 错误使用 alert，进度和成功反馈使用 status。

## 旧版 plugins 对齐规则

`apps/desktop/src/features/plugins/plugins-page.tsx` 保留业务能力参考。后续视觉对齐按以下顺序进行。

1. 保留旧版 `native-plugins` 调用和授权判断。
2. 将页面外壳替换为 `PageHeader` 和 `PageBody`。
3. 将 shadcn Tabs 替换为 `SegmentControl`。
4. 将 shadcn Table 替换为 `DataList`。
5. 将 Badge、Dialog 和 AlertDialog 替换为 ShardX UI Kit 对应组件。
6. 将概览卡片收敛为页签右侧的行内统计。
7. 将行内操作收敛为一个主操作和更多菜单。
8. 删除页面专属色值、厚重卡片、独立阴影和大面积面板边框。
9. 保持 Rust 命令、授权门禁、顺序更新和失败恢复语义。

## 当前实现边界

desktop-v2 已接入真实 Rust 插件命令和上述页面结构。当前桌面正式包使用 `apps/desktop/src`。后续验证范围包括 desktop-v2 桌面包、插件进程、商店网络和授权。

构建、类型检查、测试、插件安装、商店请求和真实授权的验证状态保持待执行。
