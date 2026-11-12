import { ImapFlow } from 'imapflow'
import { invalidRequest } from '../domain/errors.js'
import {
  EmailProviderFactory,
  type EmailProvider,
  type MailTransport,
} from '../domain/types.js'
import { MicrosoftGraph } from './graph.js'
import { MicrosoftHttp } from './http.js'
import { imapProxy, MicrosoftImap, type ImapClientFactory } from './imap.js'
import { MicrosoftTokens } from './oauth.js'
import { OpaqueCursor } from './support.js'

export type { ImapClient, ImapClientFactory } from './imap.js'

export interface MicrosoftEmailOptions {
  fetchImpl?: typeof fetch
  proxy?: string
  imapClientFactory?: ImapClientFactory
}

export class MicrosoftEmailFactory extends EmailProviderFactory {
  readonly id = 'microsoft'
  private readonly cursors = new OpaqueCursor()
  private readonly http: MicrosoftHttp

  constructor(private readonly options: MicrosoftEmailOptions = {}) {
    super()
    this.http = new MicrosoftHttp(options.fetchImpl)
  }

  create(transport: MailTransport): EmailProvider {
    if (transport !== 'graph' && transport !== 'imap') {
      throw invalidRequest('Microsoft mail transport is not supported')
    }
    return {
      tokens: new MicrosoftTokens(transport, this.http),
      mailbox:
        transport === 'graph'
          ? new MicrosoftGraph(this.http, this.cursors)
          : new MicrosoftImap(
              this.options.imapClientFactory ?? ((options) => new ImapFlow(options)),
              imapProxy(this.options.proxy ?? process.env.NEXUS_NETWORK_PROXY),
              this.cursors,
            ),
    }
  }
}
