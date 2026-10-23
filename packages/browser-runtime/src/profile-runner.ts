import type { NativeProfile } from './profile-runtime.js'
import { validatePortableStateFiles } from './portable-state.js'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { inspectKernelCache } from './kernel-cache.js'
import {
  kernelFailure,
  kernelProgressFromLog,
  type KernelProgress,
} from './kernel-install.js'

const reportProgress = (progress: KernelProgress): void => {
  process.stderr.write(`NEXUS_KERNEL_PROGRESS ${JSON.stringify(progress)}\n`)
}

async function prepare(): Promise<void> {
  const { prepareBinary } = await import('./profile-runtime.js')
  // The SDK reports observed bytes and stages on stderr, rather than a progress API.
  const log = console.error
  console.error = (...args: unknown[]) => {
    log(...args)
    for (const line of format(...args).split('\n')) {
      const progress = kernelProgressFromLog(line)
      if (progress !== null) reportProgress(progress)
    }
  }
  try {
    const binary = await prepareBinary(
      process.env.CLOAKBROWSER_LICENSE_KEY,
      process.env.CLOAKBROWSER_VERSION,
      reportProgress,
    )
    process.stdout.write(`${JSON.stringify(binary)}\n`)
  } finally {
    console.error = log
  }
}

async function main(): Promise<void> {
  const [action, userDataDir] = process.argv.slice(2)
  if (action === 'validate-state') {
    await validatePortableStateFiles(process.argv.slice(3))
    process.stdout.write('{"valid":true}\n')
  } else if (action === 'prepare') {
    await prepare()
  } else if (action === 'version' && userDataDir) {
    const { binaryVersion } = await import('./profile-runtime.js')
    process.stdout.write(
      `${JSON.stringify({
        version: await binaryVersion(userDataDir),
        binary_path: userDataDir,
      })}\n`,
    )
  } else if (action === 'inventory') {
    process.stdout.write(
      `${JSON.stringify(
        await inspectKernelCache(
          process.env.CLOAKBROWSER_CACHE_DIR ?? join(homedir(), '.cloakbrowser'),
          process.platform,
          process.arch,
        ),
      )}\n`,
    )
  } else if (action === 'validate-license') {
    const { validateBrowserLicense } = await import('./profile-runtime.js')
    const key = process.env.CLOAKBROWSER_LICENSE_KEY
    if (!key) throw new Error('License key is required')
    process.stdout.write(`${JSON.stringify(await validateBrowserLicense(key))}\n`)
  } else if ((action === 'launch' || action === 'snapshot') && userDataDir) {
    const input = createInterface({ input: process.stdin })
    try {
      const commands = input[Symbol.asyncIterator]()
      const first = await commands.next()
      if (first.done) throw new Error('Profile configuration missing')
      const record = JSON.parse(first.value) as NativeProfile
      const { snapshotProfile, openProfile } = await import('./profile-runtime.js')
      if (action === 'snapshot') {
        const state = await snapshotProfile(userDataDir, record)
        process.stdout.write(`${JSON.stringify(state)}\n`)
      } else {
        await openProfile(userDataDir, record, commands)
      }
    } finally {
      input.close()
    }
  } else {
    throw new Error('Unknown profile action')
  }
}

void main().catch((error: unknown) => {
  if (process.argv[2] === 'prepare') {
    process.stderr.write(`NEXUS_KERNEL_ERROR ${JSON.stringify(kernelFailure(error))}\n`)
  } else {
    console.error(error instanceof Error ? error.message : 'Profile runtime failed')
  }
  process.exitCode = 1
})
