import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('desktop release configuration', () => {
  it('keeps the v2 app, Rust host, and updater channel on the same release version', () => {
    const appConfig = JSON.parse(
      readFileSync(resolve(root, 'apps/desktop/src-tauri/tauri.v2.conf.json'), 'utf8'),
    )
    const cargoManifest = readFileSync(
      resolve(root, 'apps/desktop/src-tauri/Cargo.toml'),
      'utf8',
    )
    const cargoVersion = cargoManifest.match(/^version = "([^"]+)"$/m)?.[1]

    expect(cargoVersion).toBe(appConfig.version)
  })

  it('keeps installed application and MSI upgrade identities when the display name changes', () => {
    const config = JSON.parse(
      readFileSync(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    )

    expect(config.productName).toBe('Raccoon')
    expect(config.identifier).toBe('com.nexusstudio.desktop')
    expect(config.bundle.windows.wix.upgradeCode).toBe(
      '2e3e2263-4519-5724-8aaa-441e824cdcc7',
    )
  })

  it('allows packaged OTP audio to be fetched from the application origin', () => {
    const config = JSON.parse(
      readFileSync(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    )
    for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
      const connect = policy
        .split(';')
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith('connect-src '))
      expect(connect?.split(/\s+/)).toContain("'self'")
    }
  })

  it('uses the public repository that actually publishes the updater manifest', () => {
    const legacyConfig = JSON.parse(
      readFileSync(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    )
    const v2Config = JSON.parse(
      readFileSync(resolve(root, 'apps/desktop/src-tauri/tauri.v2.conf.json'), 'utf8'),
    )

    expect(legacyConfig.plugins.updater.endpoints).toEqual([
      'https://github.com/joltzeal/nexus-studio/releases/latest/download/latest.json',
    ])
    expect(v2Config.plugins.updater.endpoints).toEqual([
      'https://github.com/joltzeal/nexus-studio/releases/download/raccoon-v2/latest.json',
    ])
  })

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
      'pnpm run runtime:verify-packaged apps/desktop/src-tauri/target/release/bundle/macos/Raccoon.app',
    )
    expect(workflow).not.toContain('pnpm run runtime:verify-packaged -- ')
    expect(workflow).toContain('tauri.release.macos.conf.json')
  })
})
