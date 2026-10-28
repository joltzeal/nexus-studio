import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestImages, requestScenePlan, requestVision } from './openai.js'

const IMAGE = {
  mime: 'image/png',
  bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
}
const REQUEST = {
  baseUrl: 'https://english.example.test/v1',
  apiKey: 'synthetic-key',
  model: 'selected-vision',
  image: IMAGE,
  timeoutMs: 1000,
}
const VISION = {
  title: 'Used ceramic mug',
  description: 'A blue ceramic mug with visible wear along the rim.',
  prompt: 'A handheld smartphone photo of the same mug beside a living-room window.',
}
const PLAN = {
  ...VISION,
  translatedRequirements: 'Preserve the worn rim.',
  product: 'Mug',
  material: 'Appears to be ceramic.',
  observations: 'Visible wear along the rim.',
  uncertainties: 'The underside is not visible.',
  presetId: 'home-sofa',
  reason: 'An ordinary living room suits this household item.',
  views: [{ id: 'front', label: 'Front view', prompt: 'Show the visible front face.' }],
}

function mockChat(value: unknown) {
  const calls = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
  vi.stubGlobal('fetch', calls)
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('English recognition and smartphone photo instructions', () => {
  it.each(['vision', 'plan'] as const)(
    'sends English instructions and natural phone style for %s',
    async (operation) => {
      const calls = mockChat(operation === 'vision' ? VISION : PLAN)
      const request = { ...REQUEST, requirements: 'Preserve the worn rim.', count: 1 }
      await (operation === 'vision' ? requestVision(request) : requestScenePlan(request))
      const body = JSON.parse(String(calls.mock.calls[0]?.[1]?.body)) as {
        messages: { content: unknown }[]
      }
      const instructions = JSON.stringify(body.messages)
      expect(instructions).toContain('English')
      expect(instructions).toContain('handheld smartphone')
      expect(instructions).toContain('ordinary')
      expect(instructions).toContain('HDR')
      expect(instructions).not.toMatch(/\p{Script=Han}/u)
      expect(instructions).not.toContain('Simplified Chinese')
      expect(calls).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['title', 'description', 'prompt'] as const)(
    'rejects a non-English vision %s without another paid request',
    async (field) => {
      const calls = mockChat({ ...VISION, [field]: '这是中文商品内容' })
      await expect(requestVision(REQUEST)).rejects.toMatchObject({
        detail: expect.stringContaining('英文'),
      })
      expect(calls).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    { title: '旧杯子' },
    { description: 'Une tasse bleue。蓝色杯子' },
    { observations: '边缘磨损' },
    { prompt: '在桌上拍照' },
    { views: [{ ...PLAN.views[0], label: '正面' }] },
    { views: [{ ...PLAN.views[0], prompt: '近距离拍摄' }] },
  ])('rejects non-English scene output: %j', async (patch) => {
    const calls = mockChat({ ...PLAN, ...patch })
    await expect(
      requestScenePlan({ ...REQUEST, requirements: '', count: 1 }),
    ).rejects.toMatchObject({ detail: expect.stringContaining('英文') })
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, '', '保留缺口'])(
    'rejects a missing or untranslated independent requirements rendering: %s',
    async (translatedRequirements) => {
      const calls = mockChat({ ...PLAN, translatedRequirements })
      await expect(
        requestScenePlan({
          ...REQUEST,
          requirements: '保留缺口',
          count: 1,
        }),
      ).rejects.toMatchObject({ detail: expect.stringContaining('英文') })
      expect(calls).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects untranslated image prompts before submitting a paid request', async () => {
    const calls = mockChat({})
    await expect(
      requestImages({
        ...REQUEST,
        prompt: '把商品放在客厅',
        size: 'auto',
        count: 1,
        inputs: [],
      }),
    ).rejects.toThrow('英文')
    expect(calls).not.toHaveBeenCalled()
  })
})
