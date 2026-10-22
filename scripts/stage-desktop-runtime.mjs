import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const tauri = join(root, 'apps/desktop/src-tauri')
const marker = join(tauri, '.staged-runtime')
const runtime = join(tauri, 'runtime')
const binaries = join(tauri, 'binaries')
const target =
  process.env.NEXUS_TARGET_TRIPLE ??
  execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1]
const platforms = {
  'aarch64-apple-darwin': ['darwin-arm64', 'tar.xz'],
  'x86_64-apple-darwin': ['darwin-x64', 'tar.xz'],
  'x86_64-pc-windows-msvc': ['win-x64', 'zip'],
}
const platform = platforms[target]
if (!platform) throw new Error(`Unsupported desktop target: ${target}`)
if (
  (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim() !==
  '24.18.0'
) {
  throw new Error('Review the bundled Node version before changing .node-version')
}
if ((existsSync(runtime) || existsSync(binaries)) && !existsSync(marker)) {
  throw new Error('Refusing to replace runtime files not created by this script')
}

const version = '24.18.0'
const archiveName = `node-v${version}-${platform[0]}.${platform[1]}`
const base = `https://nodejs.org/dist/v${version}`
const [checksums, response] = await Promise.all([
  fetch(`${base}/SHASUMS256.txt`),
  fetch(`${base}/${archiveName}`),
])
if (!checksums.ok || !response.ok)
  throw new Error('Could not download the official Node runtime')
const expected = (await checksums.text())
  .split('\n')
  .find((line) => line.endsWith(`  ${archiveName}`))
  ?.split(/\s+/)[0]
if (!expected) throw new Error(`No official SHA256 checksum for ${archiveName}`)
const bytes = Buffer.from(await response.arrayBuffer())
if (createHash('sha256').update(bytes).digest('hex') !== expected) {
  throw new Error('Node runtime checksum mismatch')
}

const staging = join(tmpdir(), `nexus-stage-${process.pid}`)
await mkdir(staging, { recursive: true })
try {
  const archive = join(staging, archiveName)
  await writeFile(archive, bytes)
  const extraction = spawnSync('tar', ['-xf', archive, '-C', staging], {
    stdio: 'inherit',
  })
  if (extraction.status !== 0) throw new Error('Could not extract the Node runtime')
  const source = join(
    staging,
    `node-v${version}-${platform[0]}`,
    platform[0].startsWith('win-') ? 'node.exe' : 'bin/node',
  )
  if (existsSync(marker)) {
    await rm(runtime, { recursive: true, force: true })
    await rm(binaries, { recursive: true, force: true })
  }
  await mkdir(binaries, { recursive: true })
  const executable = join(
    binaries,
    `node-${target}${platform[0].startsWith('win-') ? '.exe' : ''}`,
  )
  await copyFile(source, executable)
  if (!platform[0].startsWith('win-')) await chmod(executable, 0o755)
  await mkdir(runtime, { recursive: true })
  const deployEnv = { ...process.env }
  for (const key of Object.keys(deployEnv)) {
    if (key.toLowerCase().startsWith('npm_')) delete deployEnv[key]
  }
  for (const [name, destination] of [
    ['@nexus/browser-runtime', join(runtime, 'browser-runtime')],
    ['@nexus/plugin-proxy-pool', join(runtime, 'plugins/proxy-pool')],
    ['@nexus/plugin-address-generator', join(runtime, 'plugins/address-generator')],
    ['@nexus/plugin-shared-supply', join(runtime, 'plugins/shared-supply')],
  ]) {
    await mkdir(resolve(destination, '..'), { recursive: true })
    const result = spawnSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      [
        '--filter',
        name,
        'deploy',
        '--legacy',
        '--prod',
        '--config.node-linker=hoisted',
        destination,
      ],
      { cwd: root, env: deployEnv, stdio: 'inherit' },
    )
    if (result.status !== 0) throw new Error(`Failed to stage ${name}`)
  }
  const browserModule = pathToFileURL(
    join(runtime, 'browser-runtime/dist/profile-runtime.js'),
  ).href
  const smoke = spawnSync(
    executable,
    ['--input-type=module', '-e', `await import(${JSON.stringify(browserModule)})`],
    { cwd: root, stdio: 'inherit' },
  )
  if (smoke.status !== 0) {
    throw new Error('Bundled Node cannot load the browser adapter')
  }
  await writeFile(marker, `${target}\n`)
  console.log(`Staged desktop runtime for ${target}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
