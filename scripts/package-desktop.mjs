import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.toLowerCase().startsWith('npm_')) delete env[key]
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(pnpm, ['run', 'build'])
run(process.execPath, ['scripts/stage-desktop-runtime.mjs'])
run(
  resolve(root, 'apps/desktop/node_modules/.bin/tauri'),
  ['build', '--config', 'src-tauri/tauri.release.conf.json'],
  resolve(root, 'apps/desktop'),
)
