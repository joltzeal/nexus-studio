import { z } from 'zod'
import { invalidRequest, protocolError } from '../domain/errors.js'
import type {
  MailCredentials,
  MailTransport,
  TokenRefresher,
  TokenSet,
} from '../domain/types.js'
import { MicrosoftHttp } from './http.js'
import { hasControlCharacters } from './support.js'

const credential = z
  .string()
  .min(1)
  .max(16 * 1024)
  .refine((value) => !/\s/u.test(value) && !hasControlCharacters(value))
const credentialsSchema = z.object({
  email: z.email().max(254),
  clientId: z.uuid(),
  refreshToken: credential,
})
const tokenSchema = z.object({
  access_token: credential,
  expires_in: z.number().int().positive().max(31_536_000),
  refresh_token: credential.optional(),
  token_type: z.literal('Bearer').optional(),
})

export class MicrosoftTokens implements TokenRefresher {
  constructor(
    private readonly transport: MailTransport,
    private readonly http: MicrosoftHttp,
  ) {}

  async refresh(credentials: MailCredentials, signal: AbortSignal): Promise<TokenSet> {
    const valid = credentialsSchema.safeParse(credentials)
    if (!valid.success) throw invalidRequest('Microsoft credentials are invalid')
    const body = await this.http.json(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: valid.data.clientId,
          refresh_token: valid.data.refreshToken,
          grant_type: 'refresh_token',
          scope:
            this.transport === 'graph'
              ? 'https://graph.microsoft.com/.default'
              : 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
        }).toString(),
      },
      signal,
      'token',
    )
    const token = tokenSchema.safeParse(body)
    if (!token.success) throw protocolError('Microsoft token response is invalid')
    return {
      accessToken: token.data.access_token,
      expiresIn: token.data.expires_in,
      ...(token.data.refresh_token !== undefined
        ? { refreshToken: token.data.refresh_token }
        : {}),
    }
  }
}
