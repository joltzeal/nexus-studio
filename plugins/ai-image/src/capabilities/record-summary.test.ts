import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

import { createAiImagePlugin } from '../index.js'
import { generationSummary } from '../domain/generation-summary.js'
import { composePrompt, presetLabel } from '../domain/presets.js'
import { composeSceneViewPrompt } from '../domain/scene-plan.js'
import type { GenerationRecord, ScenePlan, ScenePlanResult } from '../domain/types.js'
import { DEFAULT_MAX_LINE_BYTES, type PluginResponse } from '../rpc/protocol.js'
import { createMemoryStore } from '../store/private-store.js'

function maximumRecord(): GenerationRecord {
  const time = '2026-10-25T12:00:00.000Z'
  const requirements = '保'.repeat(12000)
  const result: ScenePlanResult = {
    product: '画'.repeat(500),
    material: '铁'.repeat(500),
    observations: '旧'.repeat(6000),
    uncertainties: '疑'.repeat(2000),
    presetId: 'home-sofa',
    reason: '景'.repeat(2000),
    prompt: '景'.repeat(6000),
    views: Array.from({ length: 4 }, (_, index) => ({
      id: `${index}${'v'.repeat(63)}`,
      label: `${index}${'角'.repeat(119)}`,
      prompt: `${index}${'面'.repeat(3999)}`,
    })),
  }
  const inputs = Array.from({ length: 6 }, () => ({
    id: randomUUID(),
    name: '图'.repeat(120),
    mime: 'image/png',
    bytes: 8 * 1024 * 1024,
  }))
  const outputs = inputs.slice(0, 4).map((file) => ({
    ...file,
    id: randomUUID(),
    unknownImageData: 'RAW-IMAGE-DATA'.repeat(1000),
  }))
  const plan: ScenePlan = {
    id: randomUUID(),
    createdAt: time,
    updatedAt: time,
    status: 'success',
    providerId: randomUUID(),
    providerName: '商'.repeat(60),
    providerKind: 'openai_compatible',
    model: '模'.repeat(120),
    inputFileId: inputs[0]!.id,
    requirements,
    count: 4,
    result,
    error: null,
  }
  const basePrompt = composePrompt(null, requirements)
  const record: GenerationRecord = {
    id: randomUUID(),
    source: {
      pluginId: '插'.repeat(128),
      itemId: '品'.repeat(128),
      title: '名'.repeat(500),
      url: `https://example.test/${'图'.repeat(2027)}`,
    },
    scenePlan: {
      plan,
      prompt: result.prompt,
      views: result.views.map((view, index) => ({
        ...view,
        status: 'success',
        outputFileId: outputs[index]!.id,
        error: null,
        effectivePrompt: composeSceneViewPrompt(
          result,
          null,
          requirements,
          result.prompt,
          view,
        ),
        unknownViewData: 'RAW-VIEW-DATA'.repeat(1000),
      })),
    },
    createdAt: time,
    updatedAt: time,
    status: 'success',
    stage: 'done',
    mode: 'edit',
    prompt: basePrompt,
    basePrompt,
    presetId: null,
    presetLabel: presetLabel(null),
    size: '1024x1536',
    count: 4,
    providerId: plan.providerId,
    providerName: plan.providerName,
    providerKind: plan.providerKind,
    imageModel: '模'.repeat(120),
    textModel: '文'.repeat(120),
    copySupportsVision: true,
    vision: {
      providerId: plan.providerId,
      providerName: plan.providerName,
      providerKind: plan.providerKind,
      model: plan.model,
      inputFileId: plan.inputFileId,
      description: '图'.repeat(6000),
    },
    outputVision: {
      providerId: plan.providerId,
      providerName: plan.providerName,
      providerKind: plan.providerKind,
      model: plan.model,
      outputFileId: outputs[0]!.id,
      status: 'failed',
      description: '图'.repeat(6000),
      error: '错'.repeat(240),
    },
    inputs,
    outputs,
    title: '题'.repeat(120),
    description: '述'.repeat(2000),
    error: null,
    copyError: '错'.repeat(240),
    durationMs: 999999,
  }
  return Object.assign(record, { unknownRawData: 'RAW-RECORD-DATA'.repeat(2000) })
}

function rpc(store: ReturnType<typeof createMemoryStore>) {
  const input = new PassThrough()
  const output = new PassThrough()
  const messages = new Map<string, { response: PluginResponse; bytes: number }>()
  let buffer = ''
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      const response = JSON.parse(line) as PluginResponse
      if (response.requestId !== undefined) {
        messages.set(response.requestId, {
          response,
          bytes: Buffer.byteLength(`${line}\n`, 'utf8'),
        })
      }
    }
  })
  const instance = createAiImagePlugin({
    input,
    output,
    diagnostics: new PassThrough(),
    store,
  })
  instance.server.start()
  input.write('{"type":"handshake","protocolVersion":1}\n')
  const call = async <T>(method: string, payload: unknown, expectedOk = true) => {
    const requestId = randomUUID().padEnd(128, 'r')
    input.write(
      `${JSON.stringify({
        protocolVersion: 1,
        requestId,
        capability: 'image.provider',
        method,
        payload,
        deadlineMs: 5000,
      })}\n`,
    )
    return vi.waitFor(() => {
      const message = messages.get(requestId)
      expect(message).toBeDefined()
      expect(message!.response.ok).toBe(expectedOk)
      return {
        result: message!.response.result as T,
        error: message!.response.error,
        bytes: message!.bytes,
      }
    })
  }
  return { instance, call }
}

afterEach(() => vi.unstubAllGlobals())

it('keeps 100 maximum Chinese smart summaries below the RPC byte limit and get/storage exact', async () => {
  const store = createMemoryStore()
  const original = maximumRecord()
  await store.mutate((document) => {
    document.records = Array.from({ length: 100 }, (_, index) => ({
      ...original,
      id: `record-${index}`,
    }))
  })
  const fetch = vi.fn(() => {
    throw new Error('Reading records must never call a model')
  })
  vi.stubGlobal('fetch', fetch)
  const { instance, call } = rpc(store)
  try {
    const page = await call<{
      items: Record<string, unknown>[]
      total: number
      pageSize: number
    }>('image.records.list', {
      page: 0,
      size: 100,
      sourcePluginId: original.source!.pluginId,
      sourceItemId: original.source!.itemId,
    })
    expect(page.result.total).toBe(100)
    expect(page.result.pageSize).toBe(100)
    expect(page.result.items).toHaveLength(100)
    expect(page.bytes).toBeLessThan(DEFAULT_MAX_LINE_BYTES)
    for (const item of page.result.items) {
      expect(item).not.toHaveProperty('basePrompt')
      expect(item).not.toHaveProperty('vision')
      expect(item).not.toHaveProperty('unknownRawData')
      expect(item.scenePlan).not.toHaveProperty('plan')
      expect(item.scenePlan).not.toHaveProperty('prompt')
      expect(item.outputVision).toEqual({ status: 'failed' })
      expect(item.source).toEqual({
        pluginId: original.source!.pluginId,
        itemId: original.source!.itemId,
        title: '名'.repeat(40),
        url: original.source!.url,
      })
      expect(item.outputs).toEqual(original.outputs.map(({ id, mime }) => ({ id, mime })))
      expect(item.scenePlan).toEqual({
        views: original.scenePlan!.views.map(({ status, outputFileId }) => ({
          status,
          outputFileId,
        })),
      })
      expect(item.prompt).toBe('保'.repeat(166))
      for (const omitted of [
        'inputs',
        'description',
        'error',
        'copyError',
        'textModel',
        'copySupportsVision',
      ]) {
        expect(item).not.toHaveProperty(omitted)
      }
      expect(JSON.stringify(item)).not.toContain('RAW-')
    }
    const detail = await call<{ record: GenerationRecord }>('image.records.get', {
      id: 'record-0',
    })
    expect(detail.result.record).toEqual({ ...original, id: 'record-0' })
    expect((await store.read()).records[0]).toEqual(detail.result.record)
    expect(
      detail.result.record.scenePlan!.views[0]!.effectivePrompt.length,
    ).toBeGreaterThan(30000)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    instance.server.stop()
  }
})

it('bounds escaped UTF-8 previews without splitting Unicode or inventing legacy metadata', () => {
  const original = maximumRecord()
  original.prompt = '家🏡\n\u0000'.repeat(2000)
  original.source!.title = '画🖼️\n\u0000'.repeat(50)
  const before = structuredClone(original)
  const summary = generationSummary(original)
  for (const [value, full, limit] of [
    [summary.prompt, original.prompt, 500],
    [summary.source!.title, original.source!.title, 120],
  ] as const) {
    expect(Buffer.byteLength(JSON.stringify(value), 'utf8') - 2).toBeLessThanOrEqual(
      limit,
    )
    expect(full.startsWith(value)).toBe(true)
    expect(Buffer.from(value).toString('utf8')).toBe(value)
  }
  expect(original).toEqual(before)
  delete original.source
  delete original.scenePlan
  delete original.vision
  delete original.outputVision
  const legacy = generationSummary(original)
  for (const field of ['source', 'scenePlan', 'vision', 'outputVision']) {
    expect(legacy).not.toHaveProperty(field)
  }
  original.outputVision = null
  expect(generationSummary(original).outputVision).toBeNull()
})

it('returns a bounded explicit error for oversized legacy metadata without dropping rows or altering detail', async () => {
  const store = createMemoryStore()
  const original = maximumRecord()
  original.providerName = '旧'.repeat(10000)
  await store.mutate((document) => {
    document.records = Array.from({ length: 100 }, (_, index) => ({
      ...original,
      id: `record-${index}`,
    }))
  })
  const { instance, call } = rpc(store)
  try {
    const oversized = await call('image.records.list', { page: 0, size: 100 }, false)
    expect(oversized.bytes).toBeLessThan(DEFAULT_MAX_LINE_BYTES)
    expect(oversized.error?.code).toBe('INVALID_REQUEST')
    expect(oversized.error?.message).toContain('减小每页数量')
    const smaller = await call<{
      items: { id: string }[]
      total: number
      pageSize: number
    }>('image.records.list', { page: 1, size: 10 })
    expect(smaller.result.total).toBe(100)
    expect(smaller.result.pageSize).toBe(10)
    expect(smaller.result.items.map((record) => record.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `record-${index + 10}`),
    )
    expect(smaller.bytes).toBeLessThan(DEFAULT_MAX_LINE_BYTES)
    const detail = await call<{ record: GenerationRecord }>('image.records.get', {
      id: 'record-0',
    })
    expect(detail.result.record).toEqual({ ...original, id: 'record-0' })
    expect((await store.read()).records).toHaveLength(100)
  } finally {
    instance.server.stop()
  }
})
