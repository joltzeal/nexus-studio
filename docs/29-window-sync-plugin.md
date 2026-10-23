# 窗口同步传输插件

`plugins/window-sync` 实现 `studio.window-sync` 1.0.0，能力为 `window.sync`。
这是使用 Node.js 24 内置 `net`、`crypto`、`fs` 的真实点对点 TCP 文件传输插件。
传输对象是**主程序已经加密的、不透明归档文件**；插件不导出、解密、解包、导入或合并浏览器资料。
主程序负责生成和导入加密快照，宿主负责插件安装、权限检查及独立进程托管。

## 模块职责

源码、协议入口与测试分工如下：

1. `src/transport.test.ts`：真实 localhost 连接、鉴权、校验、失败与恢复；
   `src/process.test.ts`：两个独立 Node 子进程与退出清理；
   `src/rpc.test.ts`：宿主协议与调用取消。
2. `src/types.ts`、`src/invitation.ts`：方法、状态、邀请与边界输入校验。
3. `src/wire.ts`：有界帧、HMAC 双向鉴权和背压；
   `src/archive.ts`：固定文件描述符、流式散列与写入。
4. `src/transport.ts`：offer、异步接收、进度、有效期、取消和资源释放；
   `src/rpc/server.ts` 与 `src/index.ts`：独立进程 stdio 入口。
5. `nexus.plugin.ts`、`scripts/emit-manifest.mjs`：单一 manifest 来源与构建产物。

插件仅使用 Node.js 内置模块，没有生产依赖。
构建使用工作区的 TypeScript，测试使用工作区的 Vitest。

## Manifest 与宿主集成

清单声明：

```ts
{
  apiVersion: 1,
  id: 'studio.window-sync',
  version: '1.0.0',
  name: '窗口同步',
  minCoreVersion: '0.1.3',
  capabilities: ['window.sync'],
  permissions: {
    networkDomains: [],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
}
```

入口为 `dist/src/index.js`，生成的清单为 `dist/nexus.plugin.json`。
插件版本为 `1.0.0`，最低主程序版本为 `0.1.3`。
Rust 宿主的 `CORE_VERSION` 使用 `env!("CARGO_PKG_VERSION")`，
从 `apps/desktop/src-tauri/Cargo.toml` 的包版本读取当前核心版本，再与
`minCoreVersion` 作 SemVer 比较。当前该包版本为 `0.1.3`；
不再用旧的硬编码 `0.1.0` 误拒绝本插件。

SDK 与 Rust 宿主均声明 `window.sync` 能力。
主程序通过 `profile_sync_offer`、`profile_sync_receive`、`profile_sync_status`、
`profile_sync_cancel` 和 `profile_sync_import` 专用原生命令完成发送、接收与导入。
WebView 的通用 `plugin_call` 拒绝 `window.sync`，归档路径由原生迁移服务管理，
同步状态返回 UI 前会移除插件返回的内部文件路径。

`networkDomains: []` 表示没有固定第三方服务域名，**不表示没有网络访问**：
offer 监听所有本地 IPv4 接口的随机 TCP 端口，receive 连接邀请或调用者指定的地址。
现有精确域名清单无法描述任意用户配对的局域网节点；宿主权限说明需要明确这一边界。
没有通配域名、自动中继或第三方服务，也不能把 manifest 当成网络或文件沙箱。
私有存储声明不提供路径隔离。源文件和目标目录均由受信任的主程序管理，
本插件只访问调用中明确给出的路径，不扫描浏览器目录或其他插件目录。

主程序与插件的调用边界：

- 导出前要求关闭所选窗口，迁移期间阻止这些窗口启动、编辑或删除。
  主程序生成完整、已关闭写入的 AES-GCM 加密归档，并在 offer 完成或取消前保留源文件。
- 生成 32 字节随机配对 secret，以 64 个小写十六进制字符传入。
  邀请包含该 secret；必须按敏感凭据处理，不进入日志、常规持久化或遥测。
- 创建并控制接收文件的父目录；传入尚不存在的绝对文件路径。
  插件不创建父目录，不自动覆盖、解密、解包或导入目标。
- 轮询任务，显示真实进度与错误，并在合适时调用 `sync.cancel`。
  仅在接收状态为 `completed` 后，交由独立的主程序归档逻辑验证 AES-GCM 并导入。
- 按[窗口加密迁移](28-window-transfer.md)保留首次同步的源窗口 UUID；
  本机已有同 UUID 时，要求用户明确选择覆盖并关闭对应窗口。
  后续双向更新沿用稳定 UUID，冲突由用户确认完整快照覆盖，不由插件自动合并。

若发送前出现「浏览器数据中包含不可迁移的链接或特殊文件」，错误来自主程序生成快照时
的浏览器目录复制，此时尚未调用插件的 `sync.offer`。根目录中的本机运行痕迹
`Last Browser`、`RunningChromeVersion` 由主程序精确排除，不跟随链接；
其他链接与特殊文件仍拒绝迁移，Cookies、localStorage、IndexedDB、OPFS 仍保留。
上游依据、临时浏览器复现结果与未确认的边界见[窗口加密迁移](28-window-transfer.md)。
该修复共用于文件导出和设备同步准备阶段，不改变 TCP 协议或插件导入职责。

## RPC 方法

四个方法都使用 capability `window.sync`。未声明字段会被拒绝；
错误不包含原始路径、邀请、secret 或系统异常原文。

| 方法           | 输入                                                         | 成功结果                                                          |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `sync.offer`   | `{ filePath: string, secret: string }`                       | `{ offerId, invitation, addresses: string[], expiresAt: number }` |
| `sync.receive` | `{ invitation: string, destination: string, host?: string }` | `{ jobId: string }`                                               |
| `sync.status`  | `{ id: string }`                                             | 下述状态对象                                                      |
| `sync.cancel`  | `{ id: string }`                                             | `{ success: true }`                                               |

`filePath` 必须是绝对路径，目标必须是普通文件；拒绝目录和符号链接。
打开时使用 no-follow / non-blocking 标记，并比较打开前与文件描述符的 inode，
避免路径替换后打开其他文件或阻塞在 FIFO。
不检测归档内部格式，不能据此宣称加密或 AES-GCM 验证已经由插件完成。

offer 在完成初始流式散列和真实监听后才返回，不是后台建任务即返回；
大文件散列可能超过宿主默认 30 秒调用截止时间，主程序应按需提供至多 120 秒的 RPC 截止时间。
调用超时或宿主取消时中止尚未返回的 offer，不留下无法获知 ID 的监听器。

receive 在校验邀请、目标不存在和父目录存在后创建异步任务，**不等待连接或传输**。
不可达节点、鉴权失败、磁盘写入失败或中途断开会体现在后续 `sync.status` 中。
`host` 覆盖邀请中的 host，保留端口和已签名的传输元数据；支持合法主机名、IPv4 或
不带方括号的 IPv6 字面量，不接受 URL、端口、userinfo、空白或 zone ID。
offer 本身只监听 IPv4；接收端输入 IPv6 不代表发送端实现了原生 IPv6 监听。

状态为：

```ts
{
  state: 'waiting' | 'transferring' | 'completed' | 'failed' | 'cancelled',
  bytes: number,
  total: number,
  error?: string,
  path?: string,
}
```

`bytes` 和 `total` 都是密文归档字节数。发送进度表示交给 TCP 的字节，不表示对端已落盘。
任一端 `bytes === total` 都不能代替 `completed`：
此时仍可能在等待发送后源文件校验、完成签名、接收端 fsync 或落盘回执。
接收 `completed` 额外返回绝对 `path`；发送完成不返回路径。
未知 ID 明确报错。取消会等待连接关闭、在途任务结束及部分文件清理后返回；
重复取消有效 ID 是幂等操作，已经完成的状态保持完成，已完成的目标不会被删除。

发送状态从 `waiting` 进入 `transferring`，只有收到有效落盘回执才进入 `completed`。
鉴权失败不消耗 offer；传输断开或回执丢失后可回到 `waiting`，
由调用者重新发起接收，从字节 0 开始。没有自动重试或断点续传。
源文件变化、到期、取消分别终止 offer；同时只允许一个已认证的传输尝试。
接收失败或到期会先清理部分文件再暴露最终失败状态；
实际清理失败明确报告 `Partial archive cleanup failed`，不伪装已清理。
这种情况下 `sync.cancel` 也返回错误，不返回虚假的取消成功。

## 邀请与实际网络边界

邀请字符串格式：

```text
nexus-sync:<无填充 base64url 编码的 UTF-8 JSON>
```

JSON 字段严格为：

```ts
{
  v: 1,
  host: string,
  port: number,
  secret: string,
  transferId: string,
  sha256: string,
  size: number,
  expiresAt: number,
}
```

`transferId` / `offerId` 是 16 个随机字节的小写 hex。
`sha256` 是归档密文的 SHA-256 小写 hex；
`size` 是非负安全整数；`expiresAt` 是 Unix 毫秒时间戳。
有效期固定为 offer 初始校验后 15 分钟，包含传输时间，到期会关闭监听与现有连接。
接收端拒绝过期邀请、非 v1、无效尺寸/端口/secret，以及超过本机当前时间 15 分钟的邀请；
双方系统时钟需要一致，否则可能拒绝邀请。

发送端从本机非内部 IPv4 接口中优先选择 RFC1918 私网地址作为主 host，
`addresses` 返回去重后的本地 IPv4 候选，供 UI 展示与用户选择。
没有非内部 IPv4 时只返回 `127.0.0.1`，这仅支持本机连接。
多网卡、VPN、路由或网卡顺序可能导致默认地址不可达，可传 `host` 选择其他直达地址。
端口由操作系统分配；没有自动开放防火墙、端口映射、STUN、打洞、发现或中继。

同一 LAN 也可能被访客 Wi-Fi、AP 隔离或防火墙阻断。
跨 NAT 只有用户已经配置的直达路由、VPN 或端口转发可用；
公网转发必须保持邀请中的 TCP 端口，或由调用方显式调整邀请端口。
配对不是持续实时会话合并，不监听窗口变化、不同步 Cookie 增量、不保持浏览器连接。

邀请编码不提供保密性，持有邀请的人具有接收权限。
TCP 元数据（地址、尺寸、散列、有效期、nonce）是明文；
归档内容的加密保护完全依赖主程序已经生成的 AES-GCM 文件。
插件不增加 TLS，不发送 secret 到 TCP 对端，不记录 secret，
也不声称传输层实现了新的内容加密或秘密保管。

## TCP v1 协议

控制帧是以 LF 结束的 UTF-8 JSON，每帧最多 4096 字节，不含 LF。
唯一的原始二进制区段位于 data 帧之后，长度严格等于邀请 size。
读取保留少量有界前瞻数据，不把整个文件或全部流量拼接进 Buffer。

双方各生成 32 个随机字节的 nonce，用 64 个小写 hex 表示。
签名函数为 HMAC-SHA256，key 为 `Buffer.from(secret, 'hex')`，message 为以下数组的
紧凑 `JSON.stringify` UTF-8 字节：

```ts
;[
  'nexus-window-sync',
  1,
  role,
  transferId,
  sha256,
  size,
  expiresAt,
  clientNonce,
  serverNonce,
]
```

角色分别为 `sender`、`receiver`、`finished` 和 `received`；
签名为小写 hex，比较使用 `timingSafeEqual`。
不同角色、不同随机挑战和不同传输元数据的签名不可互换。
host 与 port 允许直达地址选择或用户端口转发，因此不进入签名。

交换顺序：

1. 接收端发送 `{ type: 'request', v: 1, transferId, nonce: clientNonce }`。
2. 发送端确认 ID 和有效期，返回
   `{ type: 'challenge', nonce: serverNonce, proof: HMAC('sender') }`。
3. 接收端验证发送方后返回
   `{ type: 'authenticate', proof: HMAC('receiver') }`。
   发送端验证后才允许读取和发送归档；错误角色或错误 secret 不会获得归档字节。
4. 发送端确认源文件仍匹配 offer，再发送 `{ type: 'data', size, sha256 }`，
   接着流式发送严格 size 个密文字节。
5. 发送端验证实际发送字节散列、原文件指纹和发送后的全文件散列，
   只有全部匹配才发 `{ type: 'finished', proof: HMAC('finished') }`。
6. 接收端验证尺寸、散列、finished 签名和有效期，fsync 部分文件后发布目标，
   再发送 `{ type: 'received', proof: HMAC('received') }`。
7. 发送端验证落盘回执后消耗 offer，关闭监听并释放源文件描述符。

接收端先完成本地文件，再发送回执。网络若恰在此处断开，接收端可能已经
`completed`，发送端仍然 `waiting`。这是回执丢失的真实边界；
不能因为发送端没收到回执就删除已验证目标，也不能声称双方跨进程原子提交。
需要重试时使用新的、不存在的接收路径，并由主程序避免重复导入。

## 文件与生命周期

offer 持有原始文件描述符，不在传输时按路径重开。
初始、开始发送前、发送结束后都流式计算散列，并比较 dev、ino、size、mtimeNs、
ctimeNs；发送期间另外计算实际输出字节的散列。
文件不会因归档大而整文件读入内存；哈希和输出使用 64 KiB 工作缓冲，
写 TCP 和写文件均等待背压或写入完成。

接收临时文件是目标同目录下的 `.<文件名>.<jobId>.part`，使用 `wx` 和 0600 权限创建。
读取恰好 size 个字节，验证完成帧与散列后 fsync 并关闭。
**发布先用 `link(temp, destination)` 原子创建目标名，再用 `unlink(temp)` 移除临时名，
有意不用普通 `rename`**：Node 的 rename 可以替换在传输期间出现的目标，
而本接口必须保留已有文件。硬链接的目标创建是排他的，目标存在时失败。
两条路径位于同一目录；文件系统不支持硬链接时明确失败，不回退到可能覆盖的复制或重命名。
这里保证文件内容先 fsync，不宣称已经实现父目录 fsync 或断电恢复事务。

默认网络空闲超时 30 秒，连接与双向鉴权阶段另有 15 秒绝对截止，
避免慢速逐字节发送长期占用鉴权连接。每个 offer 最多 8 个候选 TCP 连接，
最多 16 个活动任务，进程内最多保留 256 条任务状态，满后淘汰最早的终态记录。
不把任务、secret 或邀请持久化；进程重启后应创建新 offer。

stdio 沿用 `hello → handshake → ready`，消息上限 1 MiB，调用截止上限 120 秒，
握手上限 15 秒，3 次协议错误停止服务。
`ready.methods` 精确列出四个 `sync.*` 方法；`ready` 只表示插件可接受调用。
并发宿主调用上限 32，每进程保留至多 65536 个已使用调用 ID，
到达上限明确拒绝后续调用，需要宿主回收进程。
宿主控制消息 `cancel` 取消尚未完成的 RPC；
`sync.cancel` 取消已经返回 ID 的 offer 或接收任务，两者不可混淆。

stdin 结束或关闭、SIGTERM、SIGINT、取消与到期均释放相关监听/连接；
接收任务在正常可执行清理时移除部分文件。强制 SIGKILL、进程崩溃或机器断电不能保证
执行清理，可能留下 0600 的密文 `.part`，主程序应管理临时工作目录的恢复与清理。
正常退出和 OS 回收连接也不构成 Windows 或真实跨设备网络验证证据。

## 验证方式

使用固定 Node.js 24.18.0 和工作区依赖：

```bash
rtk proxy env PATH=/Users/ameno/.nvm/versions/node/v24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm_config_verify_deps_before_run=false pnpm --filter @nexus/plugin-window-sync run build
rtk proxy env PATH=/Users/ameno/.nvm/versions/node/v24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm_config_verify_deps_before_run=false /Users/ameno/.nvm/versions/node/v24.18.0/bin/node node_modules/vitest/vitest.mjs run plugins/window-sync/src --maxWorkers=1
rtk proxy env PATH=/Users/ameno/.nvm/versions/node/v24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm_config_verify_deps_before_run=false /Users/ameno/.nvm/versions/node/v24.18.0/bin/node node_modules/typescript/bin/tsc -p plugins/window-sync/tsconfig.tests.json
```

先构建再测试；根 `pnpm run test` 会先运行 `build:packages`。
进程用例使用已构建入口，启动两个真实 Node 进程，通过 stdio 完成握手并在 localhost
传输文件。测试过程中不重复启动 TypeScript 编译器，也不改写共享 `dist`。
大文件用例传输 8 MiB + 17 字节的稀疏文件，在第一个二进制写入处 cork 真实 TCP socket，
确认写入回调未释放时发送进度不前进，待写数据及其底层 Buffer 均不超过 64 KiB。
释放后检查双方完成状态及完整输出散列。
背压和缓冲上限通过实际写入阻塞及底层 Buffer 大小断言，
不依赖整进程 external-memory 采样或 GC 回收时机。
另覆盖错误 secret、角色反射、签名元数据变化、错误 transferId、源文件修改、
损坏/中断/超长数据、超长帧、空闲超时、目的地竞争、取消、到期和退出。

独立进程用例用真实 TCP 转发器只扣留最终 `received` 回执，确定性验证：
接收端已经完成时，发送端仍为 `transferring`；只有释放回执并独立轮询发送端后，
才能断言发送端完成。stdio 响应使用事件唤醒；
独立进程的任务轮询以 Vitest 用例的取消信号为边界。
背压回归验证确认：跳过写入等待或使用整文件大小的发送 Buffer，都会使断言失败。

## 验证记录与边界

以下保留同步插件实现阶段的分项检查；包含后续代理、迁移恢复与内核绑定修复的
最终聚合结果，以[质量与验证](09-quality-and-testing.md)顶部本轮记录为准。

2026-10-23 在 macOS、固定 Node.js 24.18.0 上的验证记录：
上述定向 Vitest 检查 3 个文件、36 个用例通过；
生产源码与测试源码的严格 TypeScript 检查通过，插件 pnpm 构建及 manifest 输出通过。
真实目录权限用例还验证部分文件删除失败时，状态和 `sync.cancel` 均明确报告错误。
已构建工作区的根 Vitest 验证命令：

```bash
rtk proxy env PATH=/Users/ameno/.nvm/versions/node/v24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm_config_verify_deps_before_run=false /Users/ameno/.nvm/versions/node/v24.18.0/bin/node node_modules/vitest/vitest.mjs run
rtk proxy env PATH=/Users/ameno/.nvm/versions/node/v24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm_config_verify_deps_before_run=false /Users/ameno/.nvm/versions/node/v24.18.0/bin/node node_modules/vitest/vitest.mjs run --maxWorkers=2
```

默认并发运行实际为 80 文件通过、2 文件跳过，776 用例通过、5 用例跳过；
两 worker 运行实际为 80 文件通过、2 文件跳过，776 用例通过、5 用例跳过。
历史 128 MiB 用例的超时在上述日期的检查中未再次触发；
可重复验证的失败是旧发送完成断言在扣留真实回执时读到 `transferring`。
该记录不将未复现的历史超时归因为已证实的生产死锁。

同日早期原生 Rust 全量测试 **115 项通过**，覆盖 AES-GCM 加密归档导出与导入、
两个 Rust 宿主通过真实同步插件完成 localhost **A → B → A**，
以及迁移附件的插件收据处理。
首次同步导入保留源窗口 UUID，两端拥有独立的本机资料；
回传时同 UUID 的普通副本导入被拒绝，显式选择替换后才更新原窗口。
这提供了原生归档、受管插件进程与双向同步链路的集成证据。

尚未覆盖真实 LAN 双机、防火墙、多网卡选择、跨 NAT/VPN 可达路径、
Windows 文件系统及进程退出、桌面 UI 完整交互和发行包运行时验收。
localhost 与原生测试证据不能替代这些检查；
完整工程验证记录见[质量与验证](09-quality-and-testing.md)。
