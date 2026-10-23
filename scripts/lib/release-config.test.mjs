import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('desktop release configuration', () => {
  it('does not grant Node JIT entitlements to the macOS application process', () => {
    const releaseConfig = JSON.parse(
      readFileSync(
        resolve(root, 'apps/desktop/src-tauri/tauri.release.conf.json'),
        'utf8',
      ),
    )

    expect(releaseConfig.bundle.macOS?.entitlements).toBeUndefined()
  })

  it('packages the separately signed Node binary as a macOS helper', () => {
    const macConfig = JSON.parse(
      readFileSync(
        resolve(root, 'apps/desktop/src-tauri/tauri.release.macos.conf.json'),
        'utf8',
      ),
    )

    expect(macConfig.bundle.externalBin).toEqual([])
    expect(macConfig.bundle.macOS.files).toEqual({
      'Helpers/node': 'binaries/node-helper',
    })
    expect(macConfig.build.beforeBundleCommand).toBe(
      'node ../../scripts/prepare-macos-node.mjs',
    )
  })

  it('passes the bundle path to pnpm without forwarding a separator as data', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')

    expect(workflow).toContain(
      'pnpm run runtime:verify-packaged apps/desktop/src-tauri/target/release/bundle/macos/Nexus.app',
    )
    expect(workflow).not.toContain('pnpm run runtime:verify-packaged -- ')
    expect(workflow).toContain('tauri.release.macos.conf.json')
  })
})
