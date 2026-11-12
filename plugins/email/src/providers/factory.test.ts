import { describe, expect, it } from 'vitest'
import {
  EmailProviderFactory,
  type EmailProvider,
  type MailTransport,
} from '../domain/types.js'
import { EmailProviders } from './factory.js'
import { MicrosoftEmailFactory } from './microsoft.js'

describe('EmailProviders', () => {
  it('selects a registered factory and its explicit transport', () => {
    const selected: MailTransport[] = []
    class Factory extends EmailProviderFactory {
      readonly id = 'example'
      create(transport: MailTransport): EmailProvider {
        selected.push(transport)
        return new MicrosoftEmailFactory().create(transport)
      }
    }
    const providers = new EmailProviders([new Factory()])
    expect(providers.get('example', 'imap').mailbox).toBeDefined()
    expect(selected).toEqual(['imap'])
  })

  it('rejects duplicate factories instead of replacing authentication clients', () => {
    expect(
      () =>
        new EmailProviders([new MicrosoftEmailFactory(), new MicrosoftEmailFactory()]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })

  it('rejects unknown providers and unsupported transports', () => {
    const providers = new EmailProviders([new MicrosoftEmailFactory()])
    expect(() => providers.get('unknown', 'graph')).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    )
    expect(() => providers.get('microsoft', 'password' as MailTransport)).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    )
  })
})
