import { describe, expect, it } from 'vitest'
import { VintedTools } from './vinted.js'

const origin = 'https://www.vinted.fr'
const paths = {
  current: '/api/v2/users/current',
  profile: '/api/v2/users/7',
  items: '/api/v2/wardrobe/7/items?page=1&per_page=12&order=newest_first',
  feedback: '/api/v2/user_feedbacks?user_id=7&by=all&page=1&per_page=12',
}
const profile = {
  user: {
    id: 7,
    login: 'fixture',
    about: 'I sell used shirts. api_key=do-not-emit',
    item_count: 17,
    feedback_count: 12,
    positive_feedback_count: 12,
    feedback_reputation: 0.96,
    rating: 4.8,
    verification: { email: { valid: true, address: 'private@example.test' } },
    email: 'private@example.test',
    password: 'do-not-emit',
    access_token: 'do-not-emit',
    session: { cookie: 'do-not-emit' },
  },
}
const items = {
  items: [
    {
      id: 10,
      user_id: 7,
      title: 'Used cotton shirt',
      catalog: { id: 12, title: 'Shirts' },
      brand_title: 'Fixture',
      access_token: 'do-not-emit',
    },
  ],
}
const feedback = {
  user_feedbacks: [
    {
      id: 14,
      receiver_id: 7,
      feedback: 'The shirt was as described.',
      rating: 5,
      reviewer: { email: 'private@example.test' },
    },
  ],
}
type Request = { operation: string; input: unknown }
function setup(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    [paths.current]: { user: { id: 7, login: 'fixture', status: 'active' } },
    [paths.profile]: profile,
    [paths.items]: items,
    [paths.feedback]: feedback,
    ...overrides,
  }
  const requests: Request[] = []
  const tools = new VintedTools(
    async (request) => {
      requests.push(request)
      const path = (request.input as { path: string }).path
      const body = responses[path]
      if (body instanceof Error) throw body
      return { url: `${origin}${path}`, status: 200, text: JSON.stringify(body) }
    },
    origin,
    '7',
  )
  return { tools, requests }
}

describe('bounded observed seller evidence', () => {
  it('collects every evidence source through one exclusive browser actor', async () => {
    const responses: Record<string, unknown> = {
      [paths.current]: { user: { id: 7, login: 'fixture', status: 'active' } },
      [paths.profile]: profile,
      [paths.items]: items,
      [paths.feedback]: feedback,
    }
    let active = false
    const tools = new VintedTools(
      async (request) => {
        if (active) throw new Error('AUTOMATION_BUSY')
        active = true
        try {
          await new Promise<void>((resolve) => setImmediate(resolve))
          const path = (request.input as { path: string }).path
          return {
            url: `${origin}${path}`,
            status: 200,
            text: JSON.stringify(responses[path]),
          }
        } finally {
          active = false
        }
      },
      origin,
      '7',
    )
    const result = await tools.readAccountEvidence()
    expect(result.evidence).toMatchObject({
      rating: 4.8,
      items: [{ id: '10', title: 'Used cotton shirt' }],
      feedback: [{ id: '14', comment: 'The shirt was as described.' }],
      availability: { profile: 'observed', items: 'observed', feedback: 'observed' },
    })
  })

  it('projects observed profile, owned item categories, and feedback without navigating or leaking credentials', async () => {
    const { tools, requests } = setup()
    const result = await tools.readAccountEvidence()
    expect(result).toMatchObject({
      evidenceStatus: 'observed',
      evidence: {
        identity: { id: '7', username: 'fixture' },
        rating: 4.8,
        profile: {
          itemCount: 17,
          feedbackCount: 12,
          emailVerified: true,
          feedbackReputation: 0.96,
        },
        items: [{ id: '10', title: 'Used cotton shirt', category: 'Shirts' }],
        feedback: [{ id: '14', comment: 'The shirt was as described.', rating: 5 }],
        availability: { profile: 'observed', items: 'observed', feedback: 'observed' },
        sample: true,
      },
    })
    expect(requests.every((request) => request.operation === 'request')).toBe(true)
    expect(
      new Set(requests.map((request) => (request.input as { path: string }).path)),
    ).toEqual(new Set(Object.values(paths)))
    expect(JSON.stringify(result)).not.toContain('do-not-emit')
    expect(JSON.stringify(result)).not.toContain('private@example.test')
    expect(JSON.stringify(result)).not.toContain('access_token')
  })

  it('does not convert an unscaled reputation into a star rating or average feedback samples', async () => {
    const { tools } = setup({
      [paths.profile]: { user: { ...profile.user, rating: undefined } },
    })
    const result = await tools.readAccountEvidence()
    expect(result.evidence).not.toHaveProperty('rating')
    expect(result.evidence.profile).toMatchObject({ feedbackReputation: 0.96 })
  })

  it('keeps unavailable evidence explicit without treating read errors as an account block', async () => {
    const { tools } = setup({
      [paths.profile]: new Error('403 api_key=do-not-emit'),
      [paths.items]: new Error('403'),
      [paths.feedback]: new Error('403'),
    })
    const result = await tools.readAccountEvidence()
    expect(result).toMatchObject({
      evidenceStatus: 'unavailable',
      evidence: {
        accountStatus: 'active',
        availability: {
          profile: 'unavailable',
          items: 'unavailable',
          feedback: 'unavailable',
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('do-not-emit')
  })

  it('requires authenticated identity before inspecting public profile evidence', async () => {
    const { tools, requests } = setup({
      [paths.current]: { user: { id: 8, login: 'another' } },
    })
    await expect(tools.readAccountEvidence()).rejects.toMatchObject({
      code: 'REVIEW_REQUIRED',
    })
    expect(requests).toHaveLength(1)
  })

  it.each([
    { [paths.profile]: { user: { ...profile.user, id: 8 } }, field: 'profile' },
    { [paths.items]: { items: [{ ...items.items[0], user_id: 8 }] }, field: 'items' },
    {
      [paths.feedback]: {
        user_feedbacks: [{ ...feedback.user_feedbacks[0], receiver_id: 8 }],
      },
      field: 'feedback',
    },
    {
      [paths.items]: { items: [{ ...items.items[0], user_id: undefined }] },
      field: 'items',
    },
  ])(
    'does not use evidence associated with another or unknown seller: $field',
    async ({ field, ...overrides }) => {
      const { tools } = setup(overrides)
      const result = await tools.readAccountEvidence()
      expect(result.evidence).not.toHaveProperty(field)
      expect(result.evidence.availability).toMatchObject({ [field]: 'unavailable' })
      if (field === 'profile') expect(result.evidence).not.toHaveProperty('rating')
    },
  )

  it('caps item and feedback samples and never exposes unselected fields', async () => {
    const { tools } = setup({
      [paths.items]: {
        items: Array.from({ length: 20 }, (_, i) => ({
          ...items.items[0],
          id: 100 + i,
          title: 'A'.repeat(1000),
        })),
      },
      [paths.feedback]: {
        user_feedbacks: Array.from({ length: 20 }, (_, i) => ({
          ...feedback.user_feedbacks[0],
          id: 200 + i,
          feedback: 'B'.repeat(1000),
        })),
      },
    })
    const result = await tools.readAccountEvidence()
    expect(result.evidence.items).toHaveLength(12)
    expect(result.evidence.feedback).toHaveLength(12)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(20 * 1024)
  })
})
