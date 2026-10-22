# Vinted 账号池插件 `studio.vinted-accounts`

本文说明仓库内 Vinted 账号池插件的实际范围。插件规则见
[插件对接开发规范](14-plugin-integration-guide.md)，宿主协议见[插件宿主](17-plugin-host.md)。

## 当前事实

插件包位于 `plugins/vinted-accounts`，实现 `account.pool` 能力的 8 个方法、
私有 JSON 存储与逐行 JSON RPC 服务端。页面位于
`apps/desktop/src/features/accounts`，在主导航里叫「Vinted 账号」。
账号与浏览器窗口的关联也在这里维护，窗口页只负责发起关联。

- 一条账号记录有九个业务字段：登录方式、账号、密码、手机号、邮箱接码地址、
  手机接码地址、状态、主页链接与备注。
- 登录方式与账密是必填项，缺任何一项都不能写入；其余字段留空是合法状态，
  不做“猜一个默认值”的补齐。
- 登录方式只有四种：`email` / `google` / `apple` / `facebook`。
- 状态只有四种：`active`（正常）/ `pending`（待验证）/ `limited`（受限）/
  `blocked`（封禁）。状态是操作者的记录，插件不探测真实账号状态。
- 密码明文存在插件私有目录（文件权限 0600），宿主不加密、不代管。
  页面在表格里不显示密码，只在编辑弹窗里回读，默认隐藏。
- 插件不发起任何网络请求，`networkDomains` 为空、`secrets` 为空、
  `wantsBrowserAccess: false`。

## 包结构

```text
plugins/vinted-accounts/
├── package.json          # ESM、锁定依赖、dist 由构建生成
├── nexus.plugin.ts       # manifest 唯一来源，由 definePluginManifest 校验
├── src/
│   ├── index.ts          # 组装存储、能力与协议；进程入口
│   ├── capabilities/     # account.pool 方法表
│   ├── domain/           # 类型、zod 校验、表格解析、表头映射与错误码
│   ├── rpc/              # 协议、服务端、脱敏日志（与其他插件同源，按包自包含）
│   └── store/            # 私有 JSON 文档（accounts / bindings）
└── dist/                 # 构建产物：dist/src/index.js 与 dist/nexus.plugin.json
```

## 方法表

| 方法                       | 入参                                          | 说明                             |
| -------------------------- | --------------------------------------------- | -------------------------------- |
| `vinted.accounts.list`     | —                                             | 全部账号 + 全部绑定 + 是否持久化 |
| `vinted.accounts.save`     | `AccountInput`（带 `id` 即编辑）              | 新建或更新，重复登录直接拒绝     |
| `vinted.accounts.remove`   | `{ accountId }`                               | 删除账号并清掉它的绑定           |
| `vinted.accounts.import`   | `{ filename, text \| base64 }`                | 解析表格并 upsert，返回逐行报告  |
| `vinted.accounts.template` | `{ format: 'csv' \| 'xlsx' }`                 | 返回文件名、MIME 与 base64 内容  |
| `vinted.accounts.bind`     | `{ accountId, windowId, confirmDuplicates? }` | 关联窗口，重复账号先返回冲突     |
| `vinted.accounts.unbind`   | `{ windowId }`                                | 解除该窗口的关联                 |
| `vinted.accounts.bindings` | —                                             | 绑定列表，附带账号摘要           |

上限：账号 2000 条，导入报告最多回传 50 条错误。单次导入内容不超过 512 KB
（宿主单行消息上限 1 MiB，base64 会放大 1.33 倍）。

## 表格导入

`src/domain/table.ts` 自带 CSV 与 XLSX 读写，不引第三方表格库：
插件随桌面应用打包，为读一行表头多带一个依赖不划算。

- CSV：RFC 4180，支持引号转义、字段内换行、BOM 与 CRLF；分隔符在逗号、分号、
  制表符里按表头自动判定（欧洲区 Excel 常用分号）。
- XLSX：自己实现 zip 读取（stored 与 deflate）与工作表 XML 解析，覆盖共享字符串
  （`t="s"`）、内联字符串（`t="inlineStr"`）与数值；只读第一张工作表。
- 模板写出：单工作表、内联字符串，Excel 与 Numbers 都能直接打开。

`src/domain/import.ts` 负责把单元格变成账号：

- 表头可用中文或英文，大小写与空格、下划线、连字符、括号都忽略；
  列顺序可以调换。识别不出表头时按模板列序读取。
- 首行是否算表头由两条规则决定：至少映射到两列，且整行没有 `@` 或 `http(s)://`
  这类明显的凭据形态。否则把首行当数据，避免丢掉唯一一行。
- 登录方式留空时，账号里带 `@` 视为邮箱登录，其余直接报错——不猜。
- 状态认不出时按 `active` 处理；主页链接缺协议时补 `https://`。
- 同一 `(登录方式, 账号小写)` 视为同一条记录，重复导入是更新，绑定不受影响。

模板只有表头，没有示例行：示例行很容易被连同样例一起导进去。

## 窗口关联

关联关系存在插件的 `bindings` 数组里，键是窗口标识：

```text
bindings: [{ windowId, accountId, boundAt }]
```

- 一个窗口最多一条绑定：写入前先按 `windowId` 删旧记录，再插入新的。
- 一个账号可以出现在多个窗口上。`vinted.accounts.bind` 发现同账号已绑在别的窗口时，
  在没有 `confirmDuplicates: true` 的情况下**不写入**，只返回 `duplicates` 数组；
  页面据此弹出 AlertDialog，写明已经关联了哪些窗口，确认后再调一次。
- 删除账号会连带删掉它的绑定，不会留下指向空记录的窗口。
- 插件只存窗口 UUID，不存窗口名称。名称属于主程序的 Profile 记录，
  插件复制一份只会过期；提示文案里的窗口名由窗口页自己拼。

窗口页（`spaces-page.tsx`）在插件运行中读取 `vinted.accounts.bindings` 与
`vinted.accounts.list`，在表格里加一列显示已关联账号，并在每行 `…` 菜单里提供
“关联账号 / 更换账号 / 解除关联”。插件没就绪时这一列留空、菜单仍可打开，
弹窗里会说明插件尚未就绪。

## 已知边界

- 没有账号登录能力：关联只是记录，不会把密码填进浏览器，也不会校验账号能否登录。
- 没有加密与主密码：能读到用户目录的人就能读到密码明文。
- 没有批量改状态、批量删除与去重合并。
- 没有 `.xls`（旧二进制格式）支持，读取时直接提示另存为 `.xlsx` 或 `.csv`。
- 表格只读第一张工作表，多工作表的文件其余部分被忽略。
- 导出只提供空模板，不提供“把现有账号导成表格”。
