# 插件商店与在线更新

应用不再内置任何插件：安装包只带 Node 运行时和浏览器适配器，插件列表来自用户填写的商店地址。
插件以加密的 `.nexuspkg` 发布，本机下载后校验、解密、安装并立即启动，之后由定时扫描发现新版本。

## 1. 当前事实

| 项目             | 现状                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| 默认插件列表     | 空。发布构建不再扫描安装包内的插件目录                                     |
| 开发构建         | 仍列出 `plugins/*` 工作区插件，方便宿主开发；`NEXUS_PLUGIN_DEV_ROOTS` 可加 |
| 商店地址         | 手动填写，存于 `<应用数据>/plugins/store.json`（0600，临时文件 + rename）  |
| 检查时机         | 保存地址后立即检查；启动约 40 秒后首次扫描，之后每 30 分钟一次             |
| 安装来源         | `catalog.json` 里的 `package.url`，相对路径按商店根地址解析                |
| 完整性           | 下载后比对 catalog 中的 SHA-256，再逐文件校验包内摘要                      |
| 版本比较         | SemVer。高于已装版本才升级，同版本重装覆盖，低于已装版本直接拒绝           |
| 插件代码形态     | 单文件 ESM 打包 → AES-256-GCM 加密 → `payload.bin`，包内只有密文           |
| 进程入口         | 包内生成的 `bootstrap.cjs`，运行时解密到内存再加载                         |
| 发布构建的插件源 | 只有商店。安装包内不再随附明文插件                                         |

## 2. 商店目录结构

商店就是一个静态目录（Cloudflare R2、S3、任意静态托管均可）：

```
catalog.json
plugins/studio.vinted-accounts/1.0.0.nexuspkg
plugins/studio.vinted-monitor/1.0.0.nexuspkg
```

`catalog.json`：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-22T09:00:00.000Z",
  "plugins": [
    {
      "manifest": {
        "apiVersion": 1,
        "id": "studio.vinted-accounts",
        "version": "1.0.0",
        "name": "Vinted 账号池",
        "minCoreVersion": "0.1.0",
        "capabilities": ["account.pool"],
        "permissions": {
          "networkDomains": [],
          "wantsBrowserAccess": false,
          "storage": "private",
          "secrets": []
        }
      },
      "description": "账号池与窗口关联",
      "changelog": "首个版本",
      "package": {
        "url": "plugins/studio.vinted-accounts/1.0.0.nexuspkg",
        "size": 94835,
        "sha256": "…64 位小写十六进制…"
      }
    }
  ]
}
```

宿主对 catalog 的容错规则：

- `schemaVersion` 必须是 `1`，`plugins` 最多 256 条。
- 单条解析失败或 manifest 校验失败时**跳过该条**，其余照常显示，不会整份清单作废。
- `package.sha256` 必须是 64 位十六进制，否则该条被丢弃。
- 同一 `id` 出现多次时只保留第一条。

`package.url` 可以是相对路径（按 `catalog.json` 所在目录解析），也可以是完整的 `http(s)://` / `file://` 地址。

## 3. `.nexuspkg` 容器

宿主只做切片和校验，不做解密，因此 Rust 侧不需要任何加密实现。

```
偏移 0   "NXP1"                     4 字节 magic
偏移 4   header 长度                 u32 大端
偏移 8   header                      UTF-8 JSON
其后     files[] 依次拼接的原始字节
```

header：

```json
{
  "schemaVersion": 1,
  "manifest": { …插件清单… },
  "entry": "bootstrap.cjs",
  "description": "…",
  "changelog": "…",
  "createdAt": "2026-10-22T09:00:00.000Z",
  "files": [
    { "path": "nexus.plugin.json", "size": 308, "sha256": "…" },
    { "path": "bootstrap.cjs", "size": 2219, "sha256": "…" },
    { "path": "package.json", "size": 88, "sha256": "…" },
    { "path": "payload.bin", "size": 91293, "sha256": "…" }
  ]
}
```

宿主安装时的约束（`core/plugin_host/package.rs`）：

- 包体上限 32 MiB，header 上限 128 KiB，文件数上限 64。
- 文件路径必须是纯相对路径：不接受 `..`、绝对路径、反斜杠、空段，只允许 `A-Z a-z 0-9 . - _`。
- 每个文件按 header 的 `size` 切片并比对 `sha256`，任何一个不符即整包拒绝。
- `entry` 必须出现在文件表里。

安装写入 `installed/<id>/<version>/`，先写暂存目录再整体 rename，失败不会留下半个版本。

## 4. 加密与密钥

`payload.bin` 的布局：

```
"NXPAY1\n"   7 字节
nonce       12 字节
密文        AES-256-GCM
tag         16 字节
```

密钥不在包里。宿主按插件 id 与版本推导后通过 `NEXUS_PLUGIN_KEY` 传给插件进程：

```
key = SHA-256(salt + "\n" + pluginId + "\n" + version)
```

- `salt` 存在 `apps/desktop/src-tauri/src/core/plugin_host/market.salt`，用 `include_str!` 编进应用二进制，打包脚本读同一个文件。
- 两侧各有一次已知向量测试（Rust 的 `package_key_matches_the_packer`、Node 的 `derives the same key the desktop host uses`），任何一边改动都会立刻失败。

包内生成的 `bootstrap.cjs` 做的事：读 `payload.bin` → 用 `NEXUS_PLUGIN_KEY` 解密 → 把明文写进系统临时目录的 0600 文件 → 把 `process.argv[1]` 指向它 → `import()` → 进程退出时删除。写临时文件是因为插件靠「`argv[1]` 与 `import.meta.url` 相同」判断自己是不是进程入口，加密包不能破坏这个约定。

**边界要说清楚**：这是「源码不可直接阅读与复制」级别的保护，不是密码学意义上的机密性。salt 编在应用里，拿到应用二进制的人可以逆出密钥；明文在进程运行期间短暂落在临时目录。它挡住的是「打开 R2 桶把 JS 拷走」这类复制，不挡有针对性逆向。

## 5. 应用侧行为

- 商店地址：`https://`、`http://`、`file://` 三种。省略协议时补 `https://`；末尾不是 `.json` 时补 `/catalog.json`；查询串和 fragment 会被丢弃。
- 拉取在 Rust 侧完成（`reqwest`，25 秒超时），**不经过 WebView，因此商店不需要配置 CORS**。
- 失败只记录在 `store.json` 的 `lastError` 上，后台扫描失败不会弹窗；页面把错误显示在商店面板里。
- 安装失败（校验不符、manifest 不合法、包损坏）不改动已安装版本。
- 升级流程：停旧进程 → 写新版本目录 → 换登记表记录 → 删除旧版本目录 → 启动新进程。插件私有数据目录 `data/<id>` 不随版本变化，升级后数据仍在。
- 已安装但没有商店时，插件照常运行；商店只是安装与升级的来源。

## 6. 本地执行方案

### 6.1 打包一个插件

```bash
pnpm build:packages                 # 编译 packages/* 与 plugins/*
pnpm market:pack                    # 产物写到 market/plugins/<id>/<version>.nexuspkg
pnpm market:catalog                 # 汇总成 market/catalog.json
```

只打一个插件：

```bash
node scripts/pack-plugin.mjs plugins/vinted-accounts
node scripts/build-market.mjs
```

`market:pack` 会打印包大小与打包后的源码大小；`catalog.json` 每个插件只保留最高版本。

### 6.2 上线前自检

```bash
pnpm market:verify market/plugins/studio.vinted-accounts/1.0.0.nexuspkg
```

它用宿主同样的密钥解开包、真正启动 `bootstrap.cjs`，等到 `ready` 才退出：

```
ok studio.vinted-accounts 1.0.0
   方法 8 个：vinted.accounts.list, …
   状态 {"storage":"file","storageDurable":true,"pid":16093}
```

这一步能抓住打包后才会暴露的问题：密钥派生不一致、loader 语法错误、依赖没打进 bundle、入口没有自动启动。

### 6.3 不联网自测整个商店

`file://` 商店不需要起服务：

```bash
node -e "console.log('file://' + require('node:path').resolve('market'))"
```

把打印出来的地址填进「插件中心 → 商店设置」。宿主的 `file://` 分支直接读磁盘，走的是和 HTTPS 完全相同的 catalog 解析、校验与安装路径。

想验证 HTTP 分支：

```bash
cd market && python3 -m http.server 8787
```

地址填 `http://127.0.0.1:8787`。

### 6.4 上传 Cloudflare R2

一次性准备：

```bash
npx wrangler login                          # 浏览器授权
npx wrangler r2 bucket create nexus-studio-market
npx wrangler r2 bucket list                 # 确认桶在远端存在
```

日常上传用仓库脚本，它按 catalog 只传最新包，先传包再传 catalog，缓存头也写好了：

```bash
pnpm market:publish                      # 默认桶 nexus-studio-market
pnpm market:publish -- --dry-run         # 只打印命令，不真的上传
pnpm market:publish -- --bucket 其他桶名
```

> **必须带 `--remote`。** Wrangler 4 把 `r2 object put/get/delete` 默认指向本地模拟器，
> 不带 `--remote` 时命令会「成功」，但文件只写进仓库下的 `.wrangler/state/v3/r2/`，
> 真实桶里什么都没有。脚本已经内置 `--remote`；手敲命令时别漏。

不想用脚本时，手动等价命令是（`catalog.json` 必须短缓存，插件包可以长缓存）：

```bash
for file in $(find market -name '*.nexuspkg'); do
  npx wrangler r2 object put "nexus-studio-market/${file#market/}" \
    --file "$file" --content-type application/octet-stream \
    --cache-control "public, max-age=31536000, immutable" --remote
done
npx wrangler r2 object put nexus-studio-market/catalog.json \
  --file market/catalog.json --content-type application/json \
  --cache-control "public, max-age=60" --remote
```

顺序很重要：先传包，最后传 catalog。中途失败时线上 catalog 仍然只指向已经存在的包。

传完可以验证一次，确认东西真在远端：

```bash
npx wrangler r2 object get nexus-studio-market/catalog.json --remote --file /tmp/catalog.json
```

Wrangler 4 没有 `r2 object list`（只剩 `get` / `put` / `delete`），所以「桶里到底有什么」只能靠逐个 `get` 来确认。想连内容一起核对，就把 catalog 里每个包的 sha256 跟下载回来的文件对一遍：

```bash
node -e "for (const p of require('./market/catalog.json').plugins) console.log(p.package.url, p.package.sha256)" |
while read -r key want; do
  npx wrangler r2 object get "nexus-studio-market/$key" --remote --file "/tmp/$(echo "$key" | tr '/' '_')"
  shasum -a 256 "/tmp/$(echo "$key" | tr '/' '_')" | grep -q "$want" && echo "OK   $key" || echo "DIFF $key"
done
```

本地模拟器留下的 `.wrangler/` 可以直接删掉，它不影响任何东西，并且已经在 `.gitignore` 里。

> **`npx` 报 `EBADDEVENGINES`**：`package.json` 的 `devEngines.packageManager` 声明了 pnpm，
> 而 npm 只认识 `onFail` 的 `warn` / `error` / `ignore` 三个值。历史上这里写的是 pnpm 专用的
> `download`，npm 会把它当成非法配置直接报错，导致仓库内任何 `npx` 都跑不起来。
> 现已改为 `warn`：版本不匹配时 pnpm 只提示而不自动下载，npm 也能正常执行 `npx`。
> 如果你的分支还是旧值，改成 `warn` 即可，或改用 `pnpm dlx wrangler@4 …`。

开放读取（二选一）：

- 桶设置里开启 **Public Development URL**，得到 `https://pub-xxxxxxxx.r2.dev`。
- 绑定自定义域名，例如 `https://market.example.com`。

应用里填桶根地址即可，`/catalog.json` 由宿主补上：

```
https://pub-xxxxxxxx.r2.dev
https://market.example.com
```

不需要配置 CORS —— 请求由 Rust 发起，没有浏览器同源限制。

### 6.5 发一个新版本

1. 改 `plugins/<name>/nexus.plugin.ts` 的 `version`。
2. `pnpm build:packages && pnpm market:build`。
3. `pnpm market:verify market/plugins/<id>/<新版本>.nexuspkg`。
4. `pnpm market:publish`。
5. 应用侧最迟 30 分钟看到更新；点「检查更新」立即生效。

旧版本的 `.nexuspkg` 留在桶里没有害处：catalog 只引用最新版，旧包可以在需要时手工回滚。

## 7. 已知边界

- 没有签名验证。完整性靠 catalog 里的 SHA-256，可信度等于商店地址本身；商店被接管就能推任意插件（但密钥仍由应用侧推导，攻击者只能发布自己打包的插件，无法读出你的源码）。
- 没有增量下载，每次升级下载完整包（当前单包 100 KB 量级）。
- 不支持多商店，也不支持私有商店鉴权头。需要时再加。
- 降级只能手工：把 catalog 的版本改低后应用会拒绝安装，必须先卸载。
- 明文在进程运行期间短暂存在临时目录，见第 4 节的边界说明。
