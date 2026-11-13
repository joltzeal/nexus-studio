import { existsSync } from 'node:fs'
import { chromium } from '../../../../packages/browser-runtime/node_modules/playwright-core/index.js'
import { expect, it } from 'vitest'
import type { AgentProductSnapshot } from '@nexus/plugin-sdk/agent'
import { AutomationActor } from '../../../../packages/browser-runtime/src/automation.js'
import { VintedTools } from './vinted.js'

const origin = 'https://www.vinted.fr'
const configuredBinary = process.env.NEXUS_TEST_AUTOMATION_BROWSER_BINARY
const binary = configuredBinary ?? chromium.executablePath()
const description = 'A used blue shirt with a mark on the sleeve. '.padEnd(6000, 'x')
const product: AgentProductSnapshot = {
  id: '20000000-0000-4000-8000-000000000001',
  revision: 1,
  name: 'Shirt',
  title: 'Blue shirt',
  description,
  price: 12.5,
  currency: 'EUR',
  category: '',
  condition: 'Good',
  brand: '',
  size: '',
  tags: [],
  images: [],
}
const baseline = {
  url: `${origin}/items/new`,
  listingIds: ['122'],
  observedAt: '2026-11-13T07:59:58.000Z',
  intentStartedAt: '2026-11-13T07:59:59.000Z',
}

it.skipIf(!configuredBinary && !existsSync(binary)).each(['home', 'blank', 'ambiguous'])(
  'reconciles an exact 6000-character owned listing from a controlled %s page',
  async (mode) => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: binary,
      proxy: { server: 'http://127.0.0.1:9' },
    })
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      const page = await context.newPage()
      const observed: Array<{ path: string; method: string }> = []
      await page.route('**/*', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        expect(url.origin).toBe(origin)
        expect(request.method()).toBe('GET')
        observed.push({ path: url.pathname, method: request.method() })
        let body: unknown
        if (url.pathname === '/api/v2/wardrobe/7/items')
          body = {
            items:
              mode === 'ambiguous'
                ? [
                    { id: 123, user_id: 7 },
                    { id: 124, user_id: 7 },
                  ]
                : [
                    { id: 123, user_id: 7 },
                    { id: 122, user_id: 7 },
                  ],
            pagination: { current_page: 1, per_page: 12 },
          }
        else if (/^\/api\/v2\/items\/12[34]$/u.test(url.pathname)) {
          const id = Number(url.pathname.split('/').at(-1))
          body = {
            item: {
              id,
              title: product.title,
              description,
              user: { id: 7 },
              price: { amount: '12.50', currency_code: 'EUR' },
              created_at: '2026-11-13T08:00:00Z',
              url: `${origin}/items/${id}-blue-shirt`,
            },
          }
        }
        if (body)
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(body),
          })
        else
          await route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><title>Fixture wardrobe</title><p>Own wardrobe</p>',
          })
      })
      const actor = new AutomationActor(context)
      try {
        if (mode !== 'blank')
          await actor.execute({
            operation: 'navigate',
            origin,
            input: { url: `${origin}/` },
            timeoutMs: 5000,
          })
        const tools = new VintedTools((request) => actor.execute(request), origin, '7')
        if (mode === 'ambiguous')
          await expect(tools.confirmListing(product, baseline)).rejects.toMatchObject({
            code: 'RESULT_UNKNOWN',
          })
        else
          expect(await tools.confirmListing(product, baseline)).toMatchObject({
            listingId: '123',
            listingUrl: `${origin}/items/123-blue-shirt`,
          })
        expect(observed.filter((entry) => entry.path === '/api/v2/items/122')).toEqual([])
        expect(observed.length).toBeLessThanOrEqual(4)
      } finally {
        await actor.whenIdle()
        await actor.release()
      }
    } finally {
      await browser.close()
    }
  },
)
