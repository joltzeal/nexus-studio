import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePackagedRuntime, verifyPackagedRuntime } from './packaged-runtime.mjs'

describe('packaged runtime paths', () => {
  it('resolves the separately signed Node helper and runtime resources inside a macOS app bundle', () => {
    expect(
      resolvePackagedRuntime({
        platform: 'darwin',
        bundlePath: '/Applications/Nexus.app',
      }),
    ).toEqual({
      appBundle: '/Applications/Nexus.app',
      appExecutable: '/Applications/Nexus.app/Contents/MacOS/nexus-desktop',
      node: '/Applications/Nexus.app/Contents/Helpers/node',
      networkPreload:
        '/Applications/Nexus.app/Contents/Resources/runtime/browser-runtime/dist/network-preload.js',
      browserModule:
        '/Applications/Nexus.app/Contents/Resources/runtime/browser-runtime/dist/profile-runtime.js',
    })
  })

  it('resolves the sidecar and runtime resources from a Windows install directory', () => {
    expect(
      resolvePackagedRuntime({
        platform: 'win32',
        bundlePath: String.raw`C:\Program Files\Nexus`,
      }),
    ).toEqual({
      node: String.raw`C:\Program Files\Nexus\node.exe`,
      networkPreload: String.raw`C:\Program Files\Nexus\runtime\browser-runtime\dist\network-preload.js`,
      browserModule: String.raw`C:\Program Files\Nexus\runtime\browser-runtime\dist\profile-runtime.js`,
    })
  })
})

describe('packaged runtime dependencies', () => {
  it.each([true, false])(
    'executes the dependency guard before accepting the packaged runtime (peers present=%s)',
    (available) => {
      const temporary = mkdtempSync(join(tmpdir(), 'nexus-runtime-dependencies-'))
      const paths = {
        node: process.execPath,
        networkPreload: join(temporary, 'network-preload.mjs'),
        browserModule: join(temporary, 'profile-runtime.mjs'),
      }
      writeFileSync(paths.networkPreload, '')
      writeFileSync(
        paths.browserModule,
        `export async function verifySdkDependencies() {
          ${available ? '' : 'throw new Error("BROWSER_RUNTIME_DEPENDENCY_MISSING")'}
        }`,
      )
      try {
        const verify = () => verifyPackagedRuntime(paths, { platform: 'win32' })
        if (available) expect(verify).not.toThrow()
        else expect(verify).toThrow('BROWSER_RUNTIME_DEPENDENCY_MISSING')
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
    },
  )
})

describe('packaged macOS signatures', () => {
  it('rejects a bundle when the application process receives Node JIT entitlements', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'nexus-runtime-test-'))
    const paths = {
      appBundle: temporary,
      appExecutable: join(temporary, 'nexus-desktop'),
      node: process.execPath,
      networkPreload: join(temporary, 'network-preload.js'),
      browserModule: join(temporary, 'profile-runtime.js'),
    }
    for (const path of [paths.appExecutable, paths.networkPreload, paths.browserModule]) {
      writeFileSync(path, '')
    }
    const spawn = (command, args) => {
      if (command === paths.node) {
        return {
          status: 0,
          stdout: 'NEXUS_PACKAGED_RUNTIME_OK\n',
          stderr: '',
        }
      }
      if (args.includes('--entitlements')) {
        return {
          status: 0,
          stdout: '',
          stderr:
            args.at(-1) === paths.node
              ? '[Key] com.apple.security.cs.allow-jit\n[Value]\n[Bool] true\n[Key] com.apple.security.cs.allow-unsigned-executable-memory\n[Value]\n[Bool] true'
              : '[Key] com.apple.security.cs.allow-jit\n[Value]\n[Bool] true',
        }
      }
      return { status: 0, stdout: '', stderr: '' }
    }

    try {
      expect(() =>
        verifyPackagedRuntime(paths, {
          platform: 'darwin',
          spawn,
        }),
      ).toThrow('application must not receive Node JIT entitlements')
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('rejects a Node JIT entitlement whose value is false', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'nexus-runtime-test-'))
    const paths = {
      appBundle: temporary,
      appExecutable: join(temporary, 'nexus-desktop'),
      node: process.execPath,
      networkPreload: join(temporary, 'network-preload.js'),
      browserModule: join(temporary, 'profile-runtime.js'),
    }
    for (const path of [paths.appExecutable, paths.networkPreload, paths.browserModule]) {
      writeFileSync(path, '')
    }
    const spawn = (command, args) => {
      if (command === paths.node) {
        return {
          status: 0,
          stdout: 'NEXUS_PACKAGED_RUNTIME_OK\n',
          stderr: '',
        }
      }
      if (args.includes('--entitlements')) {
        return {
          status: 0,
          stdout: '',
          stderr:
            args.at(-1) === paths.node
              ? '[Key] com.apple.security.cs.allow-jit\n[Value]\n[Bool] false\n[Key] com.apple.security.cs.allow-unsigned-executable-memory\n[Value]\n[Bool] true'
              : '',
        }
      }
      return { status: 0, stdout: '', stderr: '' }
    }

    try {
      expect(() =>
        verifyPackagedRuntime(paths, {
          platform: 'darwin',
          spawn,
        }),
      ).toThrow('Packaged Node entitlement must be true: com.apple.security.cs.allow-jit')
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})
