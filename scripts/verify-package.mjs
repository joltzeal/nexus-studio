import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { deriveKey, readPackage } from './lib/market-package.mjs'

/**
 * Smoke test for a packed plugin: extracts it, starts the generated loader with
 * the key the host would derive, and waits for the handshake. Run this after
 * `pnpm market:pack` and before uploading anything.
 */
const file = process.argv[2]
if (file === undefined) {
  console.error(
    '用法：node scripts/verify-package.mjs market/plugins/<id>/<version>.nexuspkg',
  )
  process.exit(1)
}

const bytes = readFileSync(resolve(file))
const { header, files } = readPackage(bytes)
const directory = mkdtempSync(join(tmpdir(), 'nexus-verify-'))
const storage = join(directory, 'storage')
mkdirSync(storage, { recursive: true })
for (const entry of files) {
  const target = join(directory, entry.path)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, entry.data)
}

const key = deriveKey(header.manifest.id, header.manifest.version).toString('hex')
const child = spawn(process.execPath, [join(directory, header.entry)], {
  env: {
    ...process.env,
    NEXUS_PLUGIN_KEY: key,
    NEXUS_PLUGIN_STORAGE_DIR: storage,
    NEXUS_PLUGIN_PACKAGE_DIR: directory,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let settled = false
const finish = (code, message) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  child.kill()
  rmSync(directory, { recursive: true, force: true })
  if (code === 0) console.log(message)
  else console.error(message)
  process.exit(code)
}

const timer = setTimeout(() => finish(1, '插件在 10 秒内没有完成握手'), 10_000)

let buffered = ''
let readyMessage
const report = (message, catalog) =>
  `ok ${header.manifest.id} ${header.manifest.version}\n` +
  `   方法 ${message.methods.length} 个：${message.methods.join(', ')}\n` +
  `   状态 ${JSON.stringify({ ...message.status, ...(catalog ? { bundledCatalog: catalog } : {}) })}`
child.stdout.on('data', (chunk) => {
  buffered += chunk.toString()
  for (const line of buffered.split('\n').slice(0, -1)) {
    if (line.trim() === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.type === 'hello') {
      child.stdin.write(`${JSON.stringify({ type: 'handshake', protocolVersion: 1 })}\n`)
    }
    if (message.type === 'ready') {
      if (header.manifest.id === 'studio.sales-agent') {
        readyMessage = message
        child.stdin.write(
          `${JSON.stringify({
            protocolVersion: 1,
            requestId: 'verify-bundled-catalog',
            capability: 'sales.agent',
            method: 'salesAgent.catalog.search',
            deadlineMs: 5000,
            payload: { market: 'US', limit: 1 },
          })}\n`,
        )
      } else finish(0, report(message))
    }
    if (message.requestId === 'verify-bundled-catalog' && readyMessage) {
      const result = message.result
      if (
        !message.ok ||
        result?.market !== 'US' ||
        !/^[a-f0-9]{64}$/.test(result.catalogRevision ?? '') ||
        !Number.isInteger(result.total) ||
        result.total < 1 ||
        !Array.isArray(result.items) ||
        result.items.length !== 1
      ) {
        finish(1, '最终插件包无法离线读取分类资源')
      } else
        finish(
          0,
          report(readyMessage, { revision: result.catalogRevision, total: result.total }),
        )
    }
  }
  buffered = buffered.slice(buffered.lastIndexOf('\n') + 1)
})

let errors = ''
child.stderr.on('data', (chunk) => {
  errors += chunk.toString()
})
child.on('exit', (code) => {
  finish(1, `插件进程退出（${code}）：${errors.trim() || '没有输出'}`)
})
