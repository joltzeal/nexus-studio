import { describe, expect, it } from 'vitest'
import { VintedTools } from './vinted.js'

const origin = 'https://www.vinted.fr'
const page = {
  url: `${origin}/items/new`,
  title: 'Sell an item',
  text: '',
  controls: [
    { index: 0, role: 'textbox', name: 'Title' },
    { index: 1, role: 'textbox', name: 'Description' },
    { index: 2, role: 'textbox', name: 'Price (EUR)' },
  ],
}
const form = { title: 'Blue shirt', description: 'A used blue shirt.', price: '12.50' }
type Request = { operation: string; input: unknown }
function setup(handle: (request: Request) => unknown) {
  const requests: Request[] = []
  const tools = new VintedTools(
    async (request) => {
      requests.push(request)
      return handle(request)
    },
    origin,
    '7',
  )
  return { tools, requests }
}
function current() {
  return {
    url: `${origin}/api/v2/users/current`,
    status: 200,
    text: JSON.stringify({
      user: { id: 7, login: 'fixture', status: 'active' },
    }),
  }
}

describe('explicit account balance observations', () => {
  it('reports unavailable balances without navigating away during identity inspection', async () => {
    const { tools, requests } = setup((request) =>
      request.operation === 'request'
        ? current()
        : {
            ...page,
            text: 'Available balance EUR 200.00',
          },
    )
    expect(await tools.inspectAccount()).toMatchObject({ balanceStatus: 'unavailable' })
    expect(requests).toHaveLength(1)
    expect(await tools.readBalance()).toMatchObject({ balanceStatus: 'unavailable' })
    expect(
      requests.every((request) => ['request', 'snapshot'].includes(request.operation)),
    ).toBe(true)
  })

  it('follows one observed wallet link without guessing a wallet endpoint', async () => {
    let walletOpen = false
    const { tools, requests } = setup((request) => {
      if (request.operation === 'request') return current()
      if (request.operation === 'click') {
        walletOpen = true
        return { completed: true }
      }
      return walletOpen
        ? {
            ...page,
            url: `${origin}/observed-wallet-page`,
            title: 'Portefeuille Vinted',
            text: 'Solde disponible\n12,3456 EUR\nSolde en attente\n3,20 EUR',
            controls: [],
          }
        : {
            ...page,
            url: `${origin}/`,
            title: 'Vinted',
            text: 'Portefeuille',
            controls: [{ index: 0, role: 'link', name: 'Portefeuille' }],
          }
    })
    expect(await tools.readBalance()).toMatchObject({
      balanceStatus: 'observed',
      balanceSource: 'page',
      balance: { currency: 'EUR', available: '12.3456', pending: '3.20' },
    })
    expect(requests.find((request) => request.operation === 'click')?.input).toEqual({
      target: { index: 0 },
    })
    expect(
      requests
        .filter((request) => request.operation === 'request')
        .map((request) => request.input),
    ).toEqual([{ method: 'GET', path: '/api/v2/users/current' }])
  })

  it('does not assume zero when a wallet amount cannot be observed', async () => {
    const { tools } = setup((request) =>
      request.operation === 'request'
        ? current()
        : {
            ...page,
            title: 'Vinted Balance',
            controls: [],
            text: 'Balance temporarily unavailable.',
          },
    )
    const result = await tools.readBalance()
    expect(result.balanceStatus).toBe('unavailable')
    expect(result).not.toHaveProperty('balance')
  })
})

describe('localized form readback', () => {
  it.each([
    ['Titre', 'Description', 'Prix (EUR)'],
    ['Titel', 'Beschreibung', 'Preis (EUR)'],
    ['Título', 'Descripción', 'Precio (EUR)'],
    ['Titolo', 'Descrizione', 'Prezzo (EUR)'],
    ['Tytuł', 'Opis', 'Cena (EUR)'],
    ['Titel', 'Beschrijving', 'Prijs (EUR)'],
  ])(
    'uses bounded observed localized labels %s / %s / %s',
    async (title, description, price) => {
      const { tools } = setup((request) =>
        request.operation === 'snapshot'
          ? {
              ...page,
              controls: [
                { index: 0, role: 'textbox', name: title },
                { index: 1, role: 'textbox', name: description },
                { index: 2, role: 'textbox', name: price },
              ],
            }
          : form,
      )
      expect(await tools.readListingForm()).toEqual({ ...form, currency: 'EUR' })
    },
  )

  it('requires currency evidence rather than deriving currency from the hostname', async () => {
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? {
            ...page,
            controls: page.controls.map((control) =>
              control.index === 2 ? { ...control, name: 'Price' } : control,
            ),
          }
        : form,
    )
    await expect(tools.readListingForm()).rejects.toThrow(/review_required/i)
  })

  it('rejects conflicting observed form currency', async () => {
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? {
            ...page,
            controls: [
              ...page.controls,
              { index: 3, role: 'textbox', name: 'Currency', value: 'GBP' },
            ],
          }
        : { ...form, currency: 'GBP' },
    )
    await expect(tools.readListingForm()).rejects.toThrow(/review_required/i)
  })

  it('rejects an ambiguous currency label even if the value contains one currency', async () => {
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? {
            ...page,
            controls: page.controls.map((control) =>
              control.index === 2 ? { ...control, name: 'Price (EUR GBP)' } : control,
            ),
          }
        : { ...form, price: '12.50 EUR' },
    )
    await expect(tools.readListingForm()).rejects.toThrow(/review_required/i)
  })
})

describe('exact message composer readback', () => {
  it('reads the full untrimmed value from one observed localized inbox textbox', async () => {
    const { tools, requests } = setup((request) =>
      request.operation === 'snapshot'
        ? {
            ...page,
            url: `${origin}/inbox/123`,
            controls: [
              { index: 2, role: 'textbox', name: 'Votre message', type: 'textarea' },
            ],
          }
        : { text: '  Thank you.\n' },
    )
    expect(await tools.readMessageForm('123')).toEqual({ text: '  Thank you.\n' })
    expect(requests[1]?.input).toEqual({ fields: { text: { index: 2 } } })
  })

  it.each([
    {
      ...page,
      url: `${origin}/inbox/124`,
      controls: [{ index: 1, role: 'textbox', name: 'Message' }],
    },
    { ...page, url: `${origin}/inbox/123`, controls: [] },
    {
      ...page,
      url: `${origin}/inbox/123`,
      controls: [
        { index: 1, role: 'textbox', name: 'Message' },
        { index: 2, role: 'textbox', name: 'Message' },
      ],
    },
    {
      ...page,
      url: `${origin}/inbox/123`,
      controls: [{ index: 0, role: 'textbox', name: 'Search', type: 'search' }],
    },
  ])(
    'stops on a wrong conversation, missing composer, or ambiguous textbox',
    async (snapshot) => {
      const { tools, requests } = setup(() => snapshot)
      await expect(tools.readMessageForm('123')).rejects.toThrow(/review_required/i)
      expect(requests).toHaveLength(1)
    },
  )
})
