# 插件自主声明导航图标

状态：2026-11-21 已按用户要求实施公共契约、宿主校验、侧栏和 11 个本地插件声明。
实现与验证边界见[实施记录](../plans/2026-11-21-plugin-icons-ecom-agent-v2.md)。

## 问题与方向

当前 `apps/desktop-v2/src/raccoon-preview/sidebar.tsx` 的 `PluginItem` 对所有插件固定渲染
`NavExtensionsIcon`。该组件同时用于原生工作台，并非只影响网页预览。
插件名称不同，但展开侧栏和折叠图标栏都缺少可辨识的形状。

每个插件应在自己的源码中维护图标，manifest 仅携带经过验证的静态描述。
应用负责统一尺寸、描边、颜色、无障碍名称及缺省图标，不维护插件 ID 到图标的映射表。
图标随插件版本更新，不加载插件 React、任意 SVG 文本、远程资源或脚本。

## 推荐契约

扩展现有 `@nexus/plugin-sdk/ui` 的 `PluginUiDeclarationSchema`：

```ts
ui: {
  protocolVersion: 1,
  navigation: {
    icon: {
      viewBox: '0 0 24 24',
      paths: ['M…'],
    },
  },
  // profileTable 按需声明，不再是声明 ui 的前提
}
```

复用已有 `PluginIconSchema`：固定 24 × 24 viewBox、1–8 条 path，路径长度和字符集有界。
不增加独立颜色、strokeWidth、尺寸、HTML、SVG URL 或图片 URL 字段。
插件名称继续使用 manifest.name，避免导航标签与插件目录产生两个来源。
此处为现有 UI 协议的可选能力扩展，不把业务插件的 `apiVersion` 改为 2。

每个插件可采用 `src/ui/icon.ts` 导出 `navigationIcon`，在 `nexus.plugin.ts` 引用。
已有 Vinted `profileTable.icon` 可复用同一个对象；导航与 Profile 入口各自独立声明。
只有导航图标的插件不需要伪造 Profile 表格入口、capability 或 viewId。

## 渲染规则

- 侧栏保留现有 `size-3.5` 图标槽位，SVG 使用 `currentColor`、`fill="none"`、统一描边和圆角端点。
- 普通、悬停、选中、禁用、亮色、暗色及系统对比主题均继承 NavItem 的现有状态。
- SVG 本身 `aria-hidden`，展开侧栏使用文字，折叠侧栏沿用插件名称提示和无障碍名称。
- 未提供或旧宿主未传递图标时使用通用插件图标；不因此隐藏插件导航。
- 无效图标在 manifest 校验时报结构化错误，不把任意内容送进 `innerHTML`。
- 插件卸载、更新或目录重读后使用最新静态描述，不从页面状态缓存另一个图标副本。

## 第一方插件形状建议

| 插件          | 图形语义             |
| ------------- | -------------------- |
| 代理池        | 两端节点与转接路径   |
| SIM8          | SIM 卡轮廓与消息短线 |
| 邮箱管理      | 信封                 |
| Vinted 账号池 | 身份卡与人像         |
| VInted helper | 定位点               |
| AI 生图       | 图片框与编辑笔       |
| 共享货源      | 分层货箱             |
| Vinted 监控   | 雷达扫描             |
| 商品管理      | 吊牌                 |
| Ecom Agent    | 分支流程节点         |
| 窗口同步      | 两个屏幕与双向箭头   |

所有图形使用同一线性风格，依靠轮廓区分，不给插件分配彩色徽章。
图标数据归插件内部，应用增加新插件无需发布新的映射名单。

## 实施范围

1. `packages/plugin-sdk/src/ui.ts` 与测试：添加可选 navigation，让 profileTable 可选，并要求 ui 至少有一个真实入口；保留现有服务校验。
2. `apps/desktop/src-tauri/src/core/plugin_host/manifest.rs` 与测试源码：对应可选结构、图标验证及向目录透传。不得让仅有 navigation 的插件获得 Profile 表格或服务调用授权。
3. `apps/desktop-v2/src/raccoon/plugins/api.ts`、目录类型及 Profile 插件入口：接受导航声明，显式判断 profileTable 存在；不假设所有 ui 都有表格入口。
4. 新增通用 `PluginNavigationIcon` 渲染器；`raccoon-preview/sidebar.tsx` 使用声明；插件中心若展示图标也使用同一组件。
5. 11 个本地插件逐个声明自己的图形，保持业务方法、权限、数据和提示词不变。
6. 更新公开对接文档、源码测试和真实质量记录。

## 检查与发布边界

源码测试覆盖合法路径、恶意 SVG/URL/事件文本、超长数据、仅导航声明、同时含两种入口、
无声明回退，以及图标声明不会赋予额外调用权限。直接运行 SDK/前端测试、无产物类型检查和 lint。

按用户 2026-11-19 最新要求，不执行插件 build、应用 build 或图像验证；
Rust 编译和测试同样不在本地执行。本方案的源码检查不能替代原生宿主与安装包验收。
旧宿主对未知字段可能拒绝 manifest，所以应先更新宿主，再更新声明新图标的插件，
并根据实际发行版本填写插件最低主程序版本，不能把图标契约直接发给尚未支持它的宿主。
