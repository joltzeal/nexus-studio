import { invalidRequest } from '../domain/errors.js'
import type {
  EmailProvider,
  EmailProviderFactory,
  MailTransport,
} from '../domain/types.js'

export class EmailProviders {
  private readonly registered = new Map<string, EmailProviderFactory>()

  constructor(factories: readonly EmailProviderFactory[]) {
    for (const factory of factories) {
      if (!factory.id || this.registered.has(factory.id)) {
        throw invalidRequest('Email provider registration is invalid or duplicated')
      }
      this.registered.set(factory.id, factory)
    }
  }

  get(provider: string, transport: MailTransport): EmailProvider {
    const factory = this.registered.get(provider)
    if (!factory || (transport !== 'graph' && transport !== 'imap')) {
      throw invalidRequest('Email provider or transport is not supported')
    }
    return factory.create(transport)
  }
}
