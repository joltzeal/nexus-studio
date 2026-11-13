import { describe, expect, it } from 'vitest'
import type { AgentProductSnapshot } from '@nexus/plugin-sdk/agent'
import { VintedTools } from './vinted.js'
import type { BrowserPlan, BrowserSnapshot } from '../services/models.js'

const origin = 'https://www.vinted.fr'
const operationId = '30000000-0000-4000-8000-000000000001'
const product: AgentProductSnapshot = {
  id: operationId,
  revision: 1,
  name: 'Shirt',
  title: 'Blue shirt',
  description: 'A used blue shirt.',
  price: 12.5,
  currency: 'EUR',
  category: '',
  condition: 'Good',
  brand: '',
  size: '',
  tags: [],
  images: [],
}
const listing: BrowserSnapshot = {
  url: `${origin}/items/new`,
  title: 'Sell an item',
  text: '',
  controls: [{ index: 4, role: 'button', name: 'Upload', type: 'submit' }],
}

function setup(snapshot: BrowserSnapshot) {
  const requests: Array<{ operation: string; input: unknown }> = []
  const tools = new VintedTools(
    async (request) => {
      requests.push(request)
      return request.operation === 'snapshot' ? snapshot : { completed: true }
    },
    origin,
    '7',
  )
  return { tools, requests }
}

describe('observed final submit controls', () => {
  it.each([
    'Upload',
    'Publish',
    'Publier',
    'Mettre en ligne',
    'Hochladen',
    'Subir artículo',
    'Pubblica',
    'Artikel plaatsen',
    'Wystaw przedmiot',
  ])('accepts the observed localized listing final action %s', async (name) => {
    const { tools, requests } = setup({
      ...listing,
      controls: [{ index: 4, role: 'button', name, type: 'submit' }],
    })
    await tools.executePlan(
      { action: 'submit', target: { index: 4 } },
      product,
      operationId,
    )
    expect(requests.map((request) => request.operation)).toEqual(['snapshot', 'submit'])
    expect(requests[1]?.input).toEqual({ target: { index: 4 }, operationId })
  })

  it.each([
    'Send',
    'Envoyer',
    'Nachricht senden',
    'Enviar mensaje',
    'Invia',
    'Bericht verzenden',
    'Wyślij wiadomość',
  ])('accepts the observed localized conversation send action %s', async (name) => {
    const { tools, requests } = setup({
      ...listing,
      url: `${origin}/inbox/123`,
      controls: [{ index: 4, role: 'button', name }],
    })
    await tools.executePlan(
      { action: 'submit', target: { index: 4 } },
      undefined,
      operationId,
    )
    expect(requests[1]?.operation).toBe('submit')
  })

  it.each([
    'Delete',
    'Pay',
    'Buy',
    'Confirm',
    'Save draft',
    'Next',
    'Send',
    'Publish and pay',
    'Supprimer',
    'Löschen',
    'Envoyer',
  ])(
    'rejects destructive, unrelated, and non-final listing targets: %s',
    async (name) => {
      const { tools, requests } = setup({
        ...listing,
        controls: [{ index: 4, role: 'button', name, type: 'submit' }],
      })
      await expect(
        tools.executePlan(
          { action: 'submit', target: { index: 4 } },
          product,
          operationId,
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' })
      expect(requests.every((request) => request.operation === 'snapshot')).toBe(true)
    },
  )

  it.each([
    { ...listing, url: `${origin}/items/123/edit` },
    { ...listing, url: `${origin}/settings` },
    { ...listing, url: 'https://other.test/items/new' },
    { ...listing, controls: [{ index: 4, role: 'textbox', name: 'Upload' }] },
    {
      ...listing,
      controls: [{ index: 4, role: 'button', name: 'Upload', type: 'file' }],
    },
    { ...listing, controls: [] },
  ])(
    'rejects a wrong page or target that is not an observed final button',
    async (snapshot) => {
      const { tools, requests } = setup(snapshot)
      await expect(
        tools.executePlan(
          { action: 'submit', target: { index: 4 } },
          product,
          operationId,
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' })
      expect(requests.every((request) => request.operation === 'snapshot')).toBe(true)
    },
  )

  it.each([
    { css: 'button[type=submit]' },
    { testId: 'publish' },
    { label: 'Upload' },
    { index: 99 },
    { role: 'button', name: 'Publish' },
    { index: 4, role: 'link', name: 'Upload' },
  ])(
    'requires the model target to resolve uniquely to observed evidence: %j',
    async (target) => {
      const { tools, requests } = setup(listing)
      const plan: BrowserPlan = { action: 'submit', target }
      await expect(tools.executePlan(plan, product, operationId)).rejects.toThrow()
      expect(requests.every((request) => request.operation === 'snapshot')).toBe(true)
    },
  )

  it('rejects an ambiguous named target without submitting', async () => {
    const { tools, requests } = setup({
      ...listing,
      controls: [
        { index: 4, role: 'button', name: 'Upload' },
        { index: 5, role: 'button', name: 'Upload' },
      ],
    })
    await expect(
      tools.executePlan(
        { action: 'submit', target: { role: 'button', name: 'Upload' } },
        product,
        operationId,
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' })
    expect(requests).toHaveLength(1)
  })

  it('does not allow a publish control to send a conversation or a send control to publish a listing', async () => {
    const { tools, requests } = setup({ ...listing, url: `${origin}/inbox/123` })
    await expect(
      tools.executePlan(
        { action: 'submit', target: { index: 4 } },
        undefined,
        operationId,
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' })
    await expect(
      tools.executePlan({ action: 'submit', target: { index: 4 } }, product, operationId),
    ).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' })
    expect(requests.every((request) => request.operation === 'snapshot')).toBe(true)
  })
})
