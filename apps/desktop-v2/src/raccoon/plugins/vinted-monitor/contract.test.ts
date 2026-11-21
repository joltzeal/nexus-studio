import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VINTED_CAPABILITY,
  VINTED_METHODS,
  VINTED_PLUGIN_ID,
  supportsVintedMonitor,
  supportsVintedImages,
} from './page-contract.ts'
import { parseItemPage, parseUrlInspection } from './parse.ts'
import { EMPTY_FILTERS, itemFilterParams, itemHandoff } from './model.ts'
import { createVintedImageLoader, type ImageCall } from './image-transfer.ts'

test('monitor support requires each base method and a running capability grant', () => {
  const plugin = {
    id: VINTED_PLUGIN_ID,
    enabled: true,
    state: 'running',
    capabilities: [VINTED_CAPABILITY],
    granted: [VINTED_CAPABILITY],
    methods: [...VINTED_METHODS.base],
  }
  assert.equal(supportsVintedMonitor(plugin), true)
  assert.equal(supportsVintedImages(plugin), false)
  assert.equal(supportsVintedMonitor({ ...plugin, granted: [] }), false)
  assert.equal(supportsVintedMonitor({ ...plugin, id: 'unrelated' }), false)
  for (const missing of VINTED_METHODS.base) {
    assert.equal(
      supportsVintedMonitor({
        ...plugin,
        methods: plugin.methods.filter((method) => method !== missing),
      }),
      false,
    )
  }
  for (const missing of VINTED_METHODS.images) {
    assert.equal(
      supportsVintedImages({
        ...plugin,
        methods: [
          ...plugin.methods,
          ...VINTED_METHODS.images.filter((method) => method !== missing),
        ],
      }),
      false,
    )
  }
  assert.equal(
    supportsVintedImages({
      ...plugin,
      methods: [...plugin.methods, ...VINTED_METHODS.images],
    }),
    true,
  )
})

test('archive pages validate pagination and reject mismatched item identity', () => {
  const empty = { items: [], page: 0, pageSize: 20, total: 0, totalPages: 0 }
  assert.deepEqual(parseItemPage(empty), empty)
  assert.deepEqual(
    parseItemPage({ ...empty, page: 3, total: 1, totalPages: 1 }).items,
    [],
  )
  assert.throws(() => parseItemPage({ ...empty, totalPages: 1 }), /数据格式/)
  assert.throws(() => parseItemPage({ ...empty, pageSize: 101 }), /数据格式/)
  const item = {
    id: 'vinted.fr:9',
    externalId: '42',
    domain: 'vinted.fr',
    monitorId: 'monitor',
    monitorIds: [],
    title: 'Top',
    price: '',
    currency: '',
    brand: '',
    size: '',
    condition: '',
    url: '',
    imageUrl: '',
    seller: '',
    userId: null,
    sellerProfile: null,
    favouriteCount: 0,
    viewCount: null,
    starred: false,
    availabilityStatus: 'unknown',
    missingSince: null,
    missingMonitorId: null,
    statusCheckedAt: null,
    statusNote: null,
    collectedAt: '2026-11-19T08:00:00Z',
    listedAt: null,
    firstSeenAt: '2026-11-19T08:00:00Z',
    lastSeenAt: '2026-11-19T08:00:00Z',
  }
  const page = { ...empty, total: 1, totalPages: 1, items: [item] }
  assert.throws(() => parseItemPage(page), /数据格式/)
  assert.equal(
    parseItemPage({ ...page, items: [{ ...item, id: 'vinted.fr:42' }] }).items[0]?.id,
    'vinted.fr:42',
  )
})

test('URL inspection validates the canonical host, path and member identity', () => {
  const member = {
    kind: 'member',
    host: 'vinted.fr',
    userId: '42',
    url: 'https://vinted.fr/member/42',
  }
  assert.deepEqual(parseUrlInspection(member), member)
  assert.throws(() => parseUrlInspection({ ...member, userId: '43' }), /数据格式/)
  assert.throws(
    () => parseUrlInspection({ ...member, url: 'https://other.example/member/42' }),
    /数据格式/,
  )
  assert.throws(
    () =>
      parseUrlInspection({
        ...member,
        url: 'https://username:password@vinted.fr/member/42',
      }),
    /数据格式/,
  )
})

test('archive filters preserve false/zero and only send valid numeric ranges', () => {
  assert.deepEqual(
    itemFilterParams({
      ...EMPTY_FILTERS,
      starred: 'false',
      favouriteCountOp: 'between',
      favouriteCount: '0',
    }),
    {
      starred: false,
      favouriteCountOp: 'between',
      favouriteCountStart: 0,
    },
  )
  assert.throws(
    () =>
      itemFilterParams({
        ...EMPTY_FILTERS,
        favouriteCountOp: 'between',
        favouriteCount: '5',
        favouriteCountEnd: '2',
      }),
    /下限/,
  )
  assert.throws(
    () => itemFilterParams({ ...EMPTY_FILTERS, externalId: 'invalid' }),
    /数字/,
  )
})

test('AI handoff keeps image selection order and only public prompt fields', () => {
  const item = {
    id: 'vinted.fr:42',
    title: 'Coat',
    url: 'https://vinted.fr/items/42-coat',
    brand: '',
    size: 'M',
    condition: '',
    detail: { description: 'Warm', internal: 'private' },
  }
  const imageUrls = [
    'https://images.vinted.net/second.jpg',
    'https://images.vinted.net/first.jpg',
  ]
  const handoff = itemHandoff(item, imageUrls)
  assert.deepEqual(handoff.images, imageUrls)
  assert.equal(handoff.source?.itemId, item.id)
  assert.equal(handoff.source?.pluginId, VINTED_PLUGIN_ID)
  assert.equal(handoff.initialPrompt, '标题：Coat\n尺码：M\n描述：Warm')
})

test('image cancellation after opening closes the exact transfer without reading', async () => {
  const calls: string[] = []
  const controller = new AbortController()
  const id = 'f7a8ea2e-1a55-4be6-b12c-cda82eb5d23a'
  const call: ImageCall = async (method, payload, parse) => {
    calls.push(method)
    if (method === 'vinted.image.open') {
      controller.abort()
      return parse({ id, mime: 'image/jpeg', chunkSize: 262144, size: 1 })
    }
    assert.deepEqual(payload, { id })
    return parse({ closed: true })
  }
  const load = createVintedImageLoader(call)
  await assert.rejects(
    load('vinted.fr:42', 'https://images.vinted.net/first.jpg', controller.signal),
    { name: 'AbortError' },
  )
  assert.deepEqual(calls, ['vinted.image.open', 'vinted.image.close'])
})

test('image loader rejects noncanonical data and closes after failed reads', async () => {
  const calls: string[] = []
  const call: ImageCall = async (method, _payload, parse) => {
    calls.push(method)
    if (method === 'vinted.image.open') {
      return parse({
        id: 'f7a8ea2e-1a55-4be6-b12c-cda82eb5d23a',
        mime: 'image/jpeg',
        chunkSize: 262144,
        size: 1,
      })
    }
    return method === 'vinted.image.read'
      ? parse({ offset: 0, data: '/x==' })
      : parse({ closed: true })
  }
  await assert.rejects(
    createVintedImageLoader(call)(
      'vinted.fr:42',
      'https://images.vinted.net/first.jpg',
      new AbortController().signal,
    ),
    /图片传输数据/,
  )
  assert.deepEqual(calls, [
    'vinted.image.open',
    'vinted.image.read',
    'vinted.image.close',
  ])
})
