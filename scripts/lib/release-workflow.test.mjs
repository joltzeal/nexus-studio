import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/release.yml'),
  'utf8',
)

describe('desktop release workflow', () => {
  it('builds the three supported desktop targets with their runtime', () => {
    for (const target of [
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'x86_64-pc-windows-msvc',
    ]) {
      expect(workflow).toContain(`target: ${target}`)
    }
    expect(workflow).toContain('pnpm install --frozen-lockfile')
    expect(workflow).toContain('pnpm runtime:stage')
    expect(workflow).toContain('pnpm rust:test')
    expect(workflow).toContain('pnpm rust:lint')
    expect(workflow).toContain('Verify staged runtime')
    expect(workflow).toContain('Verify signed macOS runtime')
  })

  it('publishes only after all desktop artifacts are packaged', () => {
    const publish = workflow.split('  publish:\n')[1]
    expect(publish).toContain('needs: [package]')
    expect(publish).toContain('gh release edit "$RELEASE_TAG" --draft=false --latest')
    expect(workflow).toContain('releaseDraft: true')
    expect(workflow).toContain('uploadUpdaterJson: true')
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY')
  })

  it('keeps private plugin builds and packages out of GitHub Actions', () => {
    expect(workflow).not.toContain('@nexus/plugin-ai-image')
    expect(workflow).not.toContain('scripts/pack-plugin.mjs')
    expect(workflow).not.toMatch(/^\s+plugins:/m)
    expect(workflow).toContain('插件在本地开发并独立发布至插件商店')
  })
})
