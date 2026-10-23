import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const tauri = resolve(root, 'apps/desktop/src-tauri')
const target = process.env.TAURI_ENV_TARGET_TRIPLE
if (!target?.endsWith('-apple-darwin')) {
  throw new Error(`Unsupported macOS target: ${target ?? 'missing'}`)
}

const source = resolve(tauri, 'binaries', `node-${target}`)
const destination = resolve(tauri, 'binaries/node-helper')
const entitlements = resolve(tauri, 'NodeEntitlements.plist')
if (!existsSync(source)) throw new Error(`Staged Node is missing: ${source}`)

await copyFile(source, destination)
await chmod(destination, 0o755)

const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || '-'
const args = [
  '--force',
  '--sign',
  identity,
  '--options',
  'runtime',
  '--entitlements',
  entitlements,
]
if (identity !== '-') args.push('--timestamp')
args.push(destination)

const signed = spawnSync('codesign', args, { stdio: 'inherit' })
if (signed.error) throw signed.error
if (signed.status !== 0) throw new Error('Could not sign the bundled Node helper')

const verified = spawnSync('codesign', ['--verify', '--strict', destination], {
  stdio: 'inherit',
})
if (verified.error) throw verified.error
if (verified.status !== 0) throw new Error('Bundled Node helper signature is invalid')
