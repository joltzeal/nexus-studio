import { describe, expect, it } from 'vitest'
import { PluginManifestSchema } from '@nexus/plugin-sdk'
import manifest from '../nexus.plugin.js'
import packageInfo from '../package.json' with { type: 'json' }
import { EMAIL_METHODS } from './capabilities/email.js'

describe('email plugin declaration', () => {
  it('declares mailbox access without browser or account pool capabilities', () => {
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.id).toBe('studio.email')
    expect(manifest.version).toBe(packageInfo.version)
    expect(manifest.capabilities).toEqual(['email.provider'])
    expect(manifest.permissions).toEqual({
      networkDomains: [
        'login.microsoftonline.com',
        'graph.microsoft.com',
        'outlook.office365.com',
      ],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    })
  })
  it('advertises only implemented email and configuration methods', () => {
    expect(EMAIL_METHODS).toContain('email.refresh.queue')
    expect(EMAIL_METHODS).toContain('email.messages.get')
    expect(EMAIL_METHODS).toContain('configuration.import')
    expect(EMAIL_METHODS).not.toContain('window.detach')
    expect(EMAIL_METHODS).not.toContain('transfer.export')
  })
})
