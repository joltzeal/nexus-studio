import { describe, expect, it } from 'vitest'
import { VintedTools } from './vinted.js'
import { AgentFailure } from '../errors.js'

const origin = 'https://www.vinted.fr'
const wardrobe = '/api/v2/wardrobe/7/items?page=1&per_page=12&order=newest_first'

describe('retryable platform reads', () => {
  it.each([429, 503])(
    'preserves retryability and HTTP status from current-user reads: %s',
    async (status) => {
      const tools = new VintedTools(
        async () => ({
          url: `${origin}/api/v2/users/current`,
          status,
          text: '',
        }),
        origin,
        '7',
      )
      await expect(tools.inspectAccount()).rejects.toMatchObject({
        code: 'PLATFORM_HTTP',
        retryable: true,
        status,
      })
    },
  )

  it('preserves a host transient read failure without forwarding transport secrets', async () => {
    const tools = new VintedTools(
      async () => {
        throw new AgentFailure('TIMEOUT', 'secret=must-not-escape', true)
      },
      origin,
      '7',
    )
    const error: unknown = await tools.inspectAccount().catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'PLATFORM_NETWORK', retryable: true })
    expect(String(error)).not.toContain('must-not-escape')
  })

  it('does not swallow platform cooldown inside optional account evidence reads', async () => {
    const tools = new VintedTools(
      async ({ input }) => {
        const { path } = input as { path: string }
        return {
          url: `${origin}${path}`,
          status: path === wardrobe ? 429 : 200,
          text: JSON.stringify({ user: { id: 7, login: 'fixture', status: 'active' } }),
        }
      },
      origin,
      '7',
    )
    await expect(tools.readAccountEvidence()).rejects.toMatchObject({
      code: 'PLATFORM_HTTP',
      retryable: true,
      status: 429,
    })
  })
})
