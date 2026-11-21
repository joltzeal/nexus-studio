import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/release.yml'),
  'utf8',
)
const ciWorkflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/ci.yml'),
  'utf8',
)

describe('desktop release workflow', () => {
  it('builds the v2 macOS targets with their runtime', () => {
    expect(workflow).toContain('target: aarch64-apple-darwin')
    expect(workflow).toContain('target: x86_64-apple-darwin')
    expect(workflow).toContain('pnpm build:v2')
    expect(workflow).toContain('--config src-tauri/tauri.v2.conf.json')
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
    expect(publish).toContain(
      'gh release edit "$RELEASE_TAG" --draft=false --latest=false',
    )
    expect(publish).toContain('gh release create raccoon-v2')
    expect(publish).toContain('gh release upload raccoon-v2')
    expect(workflow).toContain('releaseDraft: true')
    expect(workflow).toContain('includeUpdaterJson: true')
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY')
  })

  it('keeps private plugin builds and packages out of GitHub Actions', () => {
    expect(workflow).not.toContain('@nexus/plugin-ai-image')
    expect(workflow).not.toContain('scripts/pack-plugin.mjs')
    expect(workflow).not.toMatch(/^\s+plugins:/m)
    expect(workflow).toContain('插件包独立发布至 R2')
  })

  it('keeps release tags out of the legacy desktop CI build', () => {
    expect(ciWorkflow).toContain("branches: ['**']")
  })
})
