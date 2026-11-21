# 代理网站 Provider 与分层代理池

日期：2026-11-21。状态：抽象、选择器与 Decodo 手动订阅补充范围已确认，进入实施。本文目标不表示所有实现或真实厂商联调已经完成。

## 1. 用户要求

- 删除现有 Decodo 端口范围拼接功能及其 RPC、表单、schema、调用与测试，重新集成。
- 在代理池插件内部建立代理网站的抽象基类，Provider 表示提供 API 的代理网站，不是浏览器 Provider。
- 通过各网站 API 读取用户订阅与代理，纳入代理池统一库存，供主程序所有代理选择器选择。
- 保留手动添加及 URL 导入；主程序自己的代理库继续与插件代理池共存。
- 代理池中手动代理直接列出，网站以子级入口出现；网站下按订阅/产品/到期时间再分组代理。
- 沿用现有 ShardX UI Kit、主题、密度、分页、搜索和图标按钮，不重写一套选择器外观。
- Decodo 的数据中心、ISP 等 API 不支持的产品允许手动创建订阅：上传 TXT、指定产品类型和到期时间。此为 Decodo 适配器额外声明的能力，与 API 来源订阅分别标记。

## 2. 已核对的源码现状

`plugins/proxy-pool/src/services/import.ts` 的 `decodoInputs` 只按起止端口构造地址，没有调用 Decodo API，也没有读取账户套餐。
旧能力名是 `proxy.strategy.decodo`，desktop-v2 的批量添加弹窗将其作为 URL 导入旁边的一个模式。
插件现有 `proxy.subscriptions.*` 是把本地代理生成 Clash 订阅的导出功能，不是向代理网站购买/查询的远端订阅，不能混用。

现有 Profile 选择器通过 `proxy.list/get` 读取不含密码的库存，最终仍绑定 `studio.proxy-pool` 与本地整数 `endpointId`；Rust 启动时通过私有 `proxy.resolve` 取得连接。
新 Provider 不改变这一绑定边界，不把 API Key、密码或远端订阅 ID 写到 Profile 的代理字段。

## 3. Decodo 官方文档的实际覆盖范围

2026-11-21 读取用户指定认证文档、完整索引、订阅/端点/子用户文档及官方 OpenAPI。

| 接口/范围                                   | 文档实际说明                                                                                           | 对产品的影响                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `GET /v2/subscriptions`                     | 当前住宅代理套餐详情；示例为一个对象，含 `service_type`、`valid_from`、`valid_until`、流量及子用户额度 | 不能称为全部产品和所有订阅的分页清单              |
| `GET /v2/sub-users`                         | 住宅代理的子用户资料；公开响应不含密码                                                                 | API Key 不能据此还原可用的代理认证密码            |
| `GET /v2/endpoints`、`/v2/endpoints/{type}` | 公共住宅网关类型与地域端点，类型为 `random` / `sticky`                                                 | 这是网关目录，不是账户获配的独享 IP 清单          |
| `GET /v2/endpoints-custom/back-connect`     | 根据显式提供的代理用户名、密码、会话参数返回连接串                                                     | 必须先有代理认证资料；不得用 API Key 冒充代理密码 |
| 数据中心、ISP 产品组                        | Public API 认证页明确表示不支持                                                                        | 无法用这份文档实现这些产品的全订阅读取            |
| 移动代理                                    | 仅支持流量、目标统计相关接口                                                                           | 不能伪装成已同步了移动代理库存                    |

认证使用固定 `https://api.decodo.com` 下的官方接口，OpenAPI 声明 `Authorization` 请求头 API Key；不推测其他未文档化的鉴权前缀或私有接口。
只按公开可验证的响应结构接入，遇到未声明的产品/分页结构明确报告，不用静态样例或猜测端口补齐。

用户已确认用手动订阅补齐数据中心、ISP 等产品：API 同步仅处理官方支持的住宅套餐；用户通过 TXT 导入真实代理并填写到期时间，归属 Decodo 接入与订阅，进入同一分层选择器。界面不得将手动上传标为已从 API 自动同步。

住宅产品的 Public API 不提供账户独享 IP 列表：订阅信息通过 `/v2/subscriptions` 读取，配置代理用户名和密码后，通过官方 `endpoints-custom/back-connect` 获取明确数量的住宅入口。入口数量由接入设置控制并标注非固定 IP，不用本地端口拼接伪造。

## 4. 抽象与数据所有权

基类建议命名 `ProxySiteProvider`，由 `ProxySiteProviderRegistry` 注册实现。通用库存、页面和主程序选择器不得写 Decodo/Webshare 的业务分支。

- `providerId`：网站适配器标识，例如 `decodo`。
- `providerAccountId`：插件中配置的一个接入实例；同网站不同 API Key 不混合库存。
- `subscriptionKey`：账号范围内稳定的远端订阅标识。若官方仅提供单个住宅产品且无订阅 ID，可用明确标注的本地产品键，不虚构官方 ID。
- `remoteEndpointKey`：订阅范围内稳定的代理身份；返回内容缺乏身份时，由适配器说明稳定键策略，不能仅凭显示名称匹配。
- `endpointId`：现有代理池本地整数 ID，供 Profile 绑定和原生解析；刷新、改名和密码轮换不能随意更换。

基类负责声明支持的产品/能力与分页契约，提供订阅读取及订阅下代理读取。适配器返回统一 DTO：产品类型、有效期、可用状态、流量等真实元数据，以及标准连接字段。
API Key 和代理密码使用插件现有私有凭据存储，公开 DTO 只包含配置存在标记；不在错误、日志、选择器或导出 URL 中回显密码。

远端 HTTP 请求必须支持取消、截止、分页及响应大小上限，校验来源，禁止带凭据跟随到任意第三方地址。
提供可注入的 HTTP 端口供测试使用；没有用户受控测试账号时只使用合成响应，不请求真实套餐或变更厂商资料。

## 5. 选择器层次

```text
主程序代理 A
主程序代理 B
代理池 ›
  socks5://手动代理:1080
  http://手动代理:8080
  Decodo ›
    住宅代理 · 到期日期/额度 ›
      http://实际网关:端口
  Webshare ›
    实际订阅 ›
      socks5://实际代理:端口
```

上图 Webshare 是同一抽象扩展的例子；未实现或未配置的网站不显示为可用入口。
主程序代理仍全部位于顶级，不增加“直连”条目。
代理池第一级仅列手动/URL 导入的代理与已配置 Provider；Provider 代理不再重复平铺在手动列表。
子级可再按产品和订阅展示，到期日期与服务商状态来自真实响应；缺少字段显示未知，不编造日期。

每一级保留自己的搜索与滚动位置，提供返回入口和键盘返回；代理行延续协议、用户名、风险、延迟与可用状态。
风险检测的网络供应商字段只是检测标签，不能据此推断该端点属于某个网站账号。
最终选择仍只返回原本的本地代理引用，Profile 创建/编辑、快捷换绑、批量分配和批量创建继续共用同一个组件。

建议新增通用的分层读取接口供选择器使用，节点严格区分 Provider 账号、订阅与端点，按父节点分页；返回值不携带可执行的任意 URL 或文件路径。
无论选中哪一级，只能选择真实、已就绪的代理端点，不能把 Provider/订阅分组本身当作可启动代理。

## 6. 刷新、持久化与失败

- 只有全部页读取与校验完成，才原子更新该 Provider 账号的库存视图；后续页失败不能把已有代理误判为已移除。
- 使用账号、订阅及端点稳定身份更新本地行，保留 Profile 已引用的整数 ID；认证变化时更新凭据并重置旧检测结论。
- 手动代理和其他 Provider 的库存不受当前同步影响，同地址但来源不同的行不能被普通去重逻辑错误合并所有权。
- 已确认下架、禁用、到期的端点标为不可用；保留绑定与历史，不静默换用其他代理或回退直连。
- 网络失败、限流、暂时缺少授权或 API 不支持，不等于账号没有订阅。保留上次成功快照并显示错误/过期程度，不返回空列表覆盖。
- 同账号重叠刷新、刷新时修改凭据、删除接入及迟到响应要隔离；提交前核对接入修订，避免旧任务覆盖新设置。
- 凭据与库存写入需使用现有 staged secrets 模式，提交失败保留旧凭据和数据；删除账号需明确展示受影响 Profile，不偷偷删除用户手动代理。
- 默认只读厂商 API；不创建、修改或删除子用户，不购买代理，不代用户增加白名单。

## 7. UI 与旧实现清理

代理池页面新增独立的服务商接入管理入口，配置 API Key 与官方要求的代理认证资料，展示订阅、最近刷新和错误；批量添加只保留通用 URL 导入。
旧 `DecodoInputSchema`、`decodoInputs`、`proxy.strategy.decodo`、前端旧表单/适配器/必需方法列表和开发 mock 分支一并删除，不保留运行时兼容别名。
既有普通库存数据保留；不能仅凭 `dc.decodo.com` 或名称猜测来源并删除用户代理。
遵守不执行 build 的限制，已安装包或旧 dist 不作为新源码已发布的证据。

## 8. 验收与实施前问题

需要覆盖多账号隔离、订阅/端点分页、未支持产品、无代理密码、401/429/超时、部分页失败、重复刷新、凭据修订竞态、ID 稳定及到期启动阻断。
选择器需要覆盖各级搜索/返回、多选及批量入口、手动与 Provider 来源不混合、缺失端点保留绑定、无明文密码。
配置导入导出需纳入新的 Provider 接入设置，业务库存仍由单独副本协议管理，不读取其他插件私有目录。

Decodo 手动订阅的约定：TXT 支持标准代理 URL 及显式协议选择后的 `host:port:user:password` / `host:port`，UTF-8、最多 500000 字节与 1000 行代理。逐行校验，任一行错误整批不写；不在错误中回显凭据。已有订阅允许更新名称、产品、到期时间或用新 TXT 替换成员，保留稳定端点 ID；撤回成员标为不可用，不删除 Profile 关联。到期瞬间按服务端时间阻断解析，不能只依赖 UI 禁选。

## 9. 官方依据

- [Public API Key Authentication](https://help.decodo.com/api-reference/public-api-key-authentication)
- [Get subscriptions](https://help.decodo.com/api-reference/subscriptions/get-subscriptions)
- [Get sub users](https://help.decodo.com/api-reference/sub-users/get-sub-users)
- [Get endpoints](https://help.decodo.com/api-reference/endpoints/get-endpoints)
- [Get endpoints by type](https://help.decodo.com/api-reference/endpoints/get-endpoints-by-type)
- [Generate custom back connect endpoints](https://help.decodo.com/api-reference/endpoints/generate-custom-back-connect-endpoints)
- [Official OpenAPI](https://help.decodo.com/api-reference/jero_public_api.yaml)
