import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

const VERIFY_MARKER = 'NEXUS_PACKAGED_RUNTIME_OK'
const NODE_JIT_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
]

export function resolvePackagedRuntime({ platform, bundlePath }) {
  if (platform === 'darwin') {
    return {
      appBundle: bundlePath,
      appExecutable: posix.join(bundlePath, 'Contents/MacOS/nexus-desktop'),
      node: posix.join(bundlePath, 'Contents/Helpers/node'),
      networkPreload: posix.join(
        bundlePath,
        'Contents/Resources/runtime/browser-runtime/dist/network-preload.js',
      ),
      browserModule: posix.join(
        bundlePath,
        'Contents/Resources/runtime/browser-runtime/dist/profile-runtime.js',
      ),
    }
  }
  if (platform === 'win32') {
    return {
      node: win32.join(bundlePath, 'node.exe'),
      networkPreload: win32.join(
        bundlePath,
        'runtime/browser-runtime/dist/network-preload.js',
      ),
      browserModule: win32.join(
        bundlePath,
        'runtime/browser-runtime/dist/profile-runtime.js',
      ),
    }
  }
  throw new Error(`Unsupported packaged runtime platform: ${platform}`)
}

function commandOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

function ensureCommandSucceeded(result, message) {
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = commandOutput(result).trim() || `exit ${result.status}`
    throw new Error(`${message}: ${detail}`)
  }
}

function entitlementIsTrue(output, entitlement) {
  const marker = `[Key] ${entitlement}`
  const start = output.indexOf(marker)
  if (start === -1) return false
  const next = output.indexOf('[Key] ', start + marker.length)
  const section = output.slice(start, next === -1 ? undefined : next)
  return /\[Bool\]\s+true\b/.test(section)
}

function verifyMacosSignatures(paths, spawn) {
  const signature = spawn(
    'codesign',
    ['--verify', '--deep', '--strict', paths.appBundle],
    { encoding: 'utf8' },
  )
  ensureCommandSucceeded(signature, 'Packaged application signature failed')

  const nodeEntitlements = spawn('codesign', ['-d', '--entitlements', '-', paths.node], {
    encoding: 'utf8',
  })
  ensureCommandSucceeded(nodeEntitlements, 'Could not inspect packaged Node entitlements')
  const nodeOutput = commandOutput(nodeEntitlements)
  for (const entitlement of NODE_JIT_ENTITLEMENTS) {
    if (!entitlementIsTrue(nodeOutput, entitlement)) {
      throw new Error(`Packaged Node entitlement must be true: ${entitlement}`)
    }
  }

  const applicationEntitlements = spawn(
    'codesign',
    ['-d', '--entitlements', '-', paths.appExecutable],
    { encoding: 'utf8' },
  )
  ensureCommandSucceeded(
    applicationEntitlements,
    'Could not inspect application entitlements',
  )
  const applicationOutput = commandOutput(applicationEntitlements)
  if (
    NODE_JIT_ENTITLEMENTS.some((entitlement) => applicationOutput.includes(entitlement))
  ) {
    throw new Error('Packaged application must not receive Node JIT entitlements')
  }
}

export function verifyPackagedRuntime(
  paths,
  { platform = process.platform, spawn = spawnSync } = {},
) {
  for (const path of Object.values(paths)) {
    if (!existsSync(path)) throw new Error(`Packaged runtime file is missing: ${path}`)
  }
  const preloadUrl = pathToFileURL(paths.networkPreload).href
  const browserUrl = pathToFileURL(paths.browserModule).href
  const result = spawn(
    paths.node,
    [
      '--import',
      preloadUrl,
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(browserUrl)}); console.log(${JSON.stringify(VERIFY_MARKER)})`,
    ],
    { encoding: 'utf8' },
  )
  if (result.error) throw result.error
  if (result.status !== 0 || !result.stdout.includes(VERIFY_MARKER)) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    throw new Error(`Packaged Node runtime failed: ${detail}`)
  }
  if (platform === 'darwin') verifyMacosSignatures(paths, spawn)
}
