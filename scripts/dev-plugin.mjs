import { spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const slug = process.argv[2]
if (!slug || !/^[a-z][a-z0-9-]{0,63}$/.test(slug)) {
  console.error('用法：pnpm plugin:dev <插件目录名>，例如 ai-image')
  process.exit(1)
}

let metadata
try {
  metadata = JSON.parse(await readFile(resolve(root, 'plugins', slug, 'package.json')))
} catch {
  console.error(`本地没有插件源码：plugins/${slug}`)
  process.exit(1)
}
if (
  typeof metadata.name !== 'string' ||
  !/^@nexus\/plugin-[a-z][a-z0-9-]*$/.test(metadata.name)
) {
  console.error('插件 package.json 中缺少有效的包名称')
  process.exit(1)
}

// pnpm run supplies its JS entry point, avoiding shell quoting and .cmd on Windows.
const executable = process.env.npm_execpath
const command = executable
  ? process.execPath
  : process.platform === 'win32'
    ? 'pnpm.cmd'
    : 'pnpm'
const prefix = executable ? [executable] : []
const build = spawnSync(
  command,
  [...prefix, '--filter', `${metadata.name}...`, 'build'],
  {
    cwd: root,
    stdio: 'inherit',
  },
)
if (build.error) {
  console.error('无法运行 pnpm，请通过 pnpm plugin:dev 启动')
  process.exit(1)
}
if (build.status !== 0) process.exit(build.status ?? 1)

console.log(`正在监听 ${slug}。在桌面应用插件中心安装本地插件，修改后重启该插件进程。`)
const watcher = spawn(
  command,
  [...prefix, '--filter', metadata.name, 'exec', 'tsc', '-p', 'tsconfig.json', '--watch'],
  { cwd: root, stdio: 'inherit' },
)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => watcher.kill(signal))
watcher.on('error', () => {
  console.error('无法启动插件编译监听')
  process.exitCode = 1
})
watcher.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 130 : 1)
})
