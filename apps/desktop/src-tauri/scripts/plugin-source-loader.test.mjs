import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const loaderPath = join(scriptDirectory, 'plugin-source-loader.mjs')
const manifestLoaderPath = join(scriptDirectory, 'plugin-source-manifests.mjs')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'raccoon-plugin-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function collectOutput(child) {
  return new Promise((resolveOutput, rejectOutput) => {
    let output = ''
    let errors = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      errors += chunk
    })
    child.once('error', rejectOutput)
    child.once('close', (code) => {
      if (code === 0) resolveOutput(output)
      else rejectOutput(new Error(`Source plugin helper exited ${code}: ${errors}`))
    })
  })
}

function readMessages(child) {
  const messages = []
  let buffer = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      messages.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
    }
  })
  return messages
}

function waitForMessage(child, messages, predicate, label) {
  return new Promise((resolveMessage, rejectMessage) => {
    const finish = (error) => {
      clearTimeout(timer)
      clearInterval(poll)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) rejectMessage(error)
      else resolveMessage()
    }
    const onExit = (code) => finish(new Error(`Plugin exited before ${label} (${code})`))
    const onError = (error) => finish(error)
    const timer = setTimeout(
      () => finish(new Error(`Source plugin did not emit ${label}`)),
      5000,
    )
    const poll = setInterval(() => {
      if (messages.some(predicate)) finish()
    }, 10)
    child.once('exit', onExit)
    child.once('error', onError)
    if (messages.some(predicate)) finish()
  })
}

test('loads a plugin manifest from TypeScript and resolves JavaScript-style source imports', async (t) => {
  const root = await fixture(t)
  const plugin = join(root, 'sample-plugin')
  await mkdir(join(plugin, 'src'), { recursive: true })
  await writeFile(
    join(plugin, 'nexus.plugin.ts'),
    `import { pluginName } from './src/name.js';\nexport default { id: 'sample.plugin', name: pluginName };\n`,
  )
  await writeFile(
    join(plugin, 'src/name.ts'),
    `export const pluginName: string = 'Source Plugin';\n`,
  )

  const child = spawn(
    process.execPath,
    ['--conditions=development', '--import', loaderPath, manifestLoaderPath, root],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const stdout = await collectOutput(child)

  assert.deepEqual(JSON.parse(stdout), {
    plugins: [
      {
        directory: join(root, 'sample-plugin'),
        entry: join(root, 'sample-plugin/src/index.ts'),
        manifest: { id: 'sample.plugin', name: 'Source Plugin' },
      },
    ],
    problems: [],
  })
})

test('loads manifest dependencies from the workspace SDK source', async (t) => {
  const root = await fixture(t)
  const plugin = join(root, 'sdk-plugin')
  await mkdir(join(plugin, 'src'), { recursive: true })
  await writeFile(join(plugin, 'src/index.ts'), 'export {};\n')
  await writeFile(
    join(plugin, 'nexus.plugin.ts'),
    `import { definePluginManifest } from '@nexus/plugin-sdk';\n` +
      `export default definePluginManifest({ apiVersion: 1, id: 'sample.sdk-plugin', ` +
      `version: '1.0.0', name: 'SDK Plugin', minCoreVersion: '0.1.0', ` +
      `capabilities: ['account.pool'], permissions: { networkDomains: [], ` +
      `wantsBrowserAccess: false, storage: 'private', secrets: [] }, ` +
      `ui: { protocolVersion: 1, profileTable: { title: 'Accounts', ` +
      `viewId: 'accounts', capability: 'account.pool', icon: { ` +
      `viewBox: '0 0 24 24', paths: ['M0 0L1 1Z'] } } } });\n`,
  )

  const child = spawn(
    process.execPath,
    ['--conditions=development', '--import', loaderPath, manifestLoaderPath, root],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const stdout = await collectOutput(child)
  const result = JSON.parse(stdout)

  assert.deepEqual(result.problems, [])
  assert.equal(result.plugins[0].manifest.ui.profileTable.viewId, 'accounts')
})

test('runs a TypeScript plugin entry directly and preserves the host handshake', async (t) => {
  const root = await fixture(t)
  const plugin = join(root, 'source-plugin')
  await mkdir(join(plugin, 'src'), { recursive: true })
  await writeFile(join(plugin, 'package.json'), `{"type":"module"}`)
  await writeFile(
    join(plugin, 'src/value.ts'),
    `export const value: string = 'source';\n`,
  )
  await writeFile(
    join(plugin, 'src/index.ts'),
    `import { value } from './value.js';\n` +
      `process.stdout.write(JSON.stringify({ type: 'hello', value }) + '\\n');\n` +
      `process.stdin.on('data', data => { if (data.toString().includes('handshake')) ` +
      `process.stdout.write(JSON.stringify({ type: 'ready', value }) + '\\n'); });\n`,
  )

  const child = spawn(
    process.execPath,
    ['--conditions=development', '--import', loaderPath, resolve(plugin, 'src/index.ts')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  t.after(() => child.kill('SIGTERM'))
  const messages = readMessages(child)

  await waitForMessage(
    child,
    messages,
    (message) => message.type === 'hello' && message.value === 'source',
    'hello',
  )
  child.stdin.write('{"type":"handshake"}\n')
  await waitForMessage(
    child,
    messages,
    (message) => message.type === 'ready' && message.value === 'source',
    'ready',
  )
})
