import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createLabelsApi } from './labels'
import type { LabelJob } from '@nexus/plugin-contracts/vinted-helper'

const id = '00000000-0000-4000-8000-000000000001'
const bytes = new TextEncoder().encode('%PDF-label')
const completed: LabelJob = {
  id,
  filename: 'label.pdf',
  inputSize: bytes.length,
  received: bytes.length,
  status: 'completed',
  outputSize: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  pageCount: 1,
  notes: [{ page: 1, mode: 'isolated' }],
  error: null,
}
function transport(replies: Record<string, unknown>) {
  const calls: { method: string; payload: unknown }[] = []
  return {
    calls,
    call: async <T>(
      _id: string,
      _cap: string,
      method: string,
      payload: unknown,
      parse: (value: unknown) => T,
    ) => {
      calls.push({ method, payload })
      return parse(replies[method])
    },
  }
}

describe('label transfer adapter', () => {
  it('uploads bounded chunks and downloads only a complete hash-verified PDF', async () => {
    const mock = transport({
      'vinted.labels.begin': { id, chunkSize: 192 * 1024 },
      'vinted.labels.append': { received: bytes.length },
      'vinted.labels.start': completed,
      'vinted.labels.read': {
        total: bytes.length,
        next: bytes.length,
        done: true,
        data: Buffer.from(bytes).toString('base64'),
      },
    })
    const api = createLabelsApi(mock.call)
    const result = await api.process(
      { name: 'label.pdf', bytes },
      { marginMm: 3, cropMm: null },
      new AbortController().signal,
    )
    expect(result).toEqual(completed)
    expect(await api.download(result, new AbortController().signal)).toEqual(bytes)
    expect(mock.calls.map((call) => call.method)).toEqual([
      'vinted.labels.begin',
      'vinted.labels.append',
      'vinted.labels.start',
      'vinted.labels.read',
    ])
  })
  it('cleans up a session when upload fails or is cancelled after begin', async () => {
    const controller = new AbortController()
    const close = vi.fn()
    const api = createLabelsApi(
      async <T>(
        _id: string,
        _cap: string,
        method: string,
        _payload: unknown,
        parse: (value: unknown) => T,
      ) => {
        if (method === 'vinted.labels.begin') {
          controller.abort()
          return parse({ id, chunkSize: 192 * 1024 })
        }
        if (method === 'vinted.labels.close') {
          close()
          return parse({ closed: true })
        }
        throw new Error('unexpected')
      },
    )
    await expect(
      api.process(
        { name: 'label.pdf', bytes },
        { marginMm: 3, cropMm: null },
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('rejects mismatched job identities and corrupted download chunks', async () => {
    const mock = transport({
      'vinted.labels.read': {
        total: bytes.length,
        next: bytes.length,
        done: true,
        data: Buffer.from('%PDF-wrong').toString('base64'),
      },
    })
    const api = createLabelsApi(mock.call)
    await expect(api.download(completed, new AbortController().signal)).rejects.toThrow(
      '校验',
    )
    mock.call = async <T>(
      _id: string,
      _cap: string,
      method: string,
      _payload: unknown,
      parse: (value: unknown) => T,
    ) =>
      parse(
        method === 'vinted.labels.begin'
          ? { id, chunkSize: 192 * 1024 }
          : method === 'vinted.labels.append'
            ? { received: bytes.length }
            : method === 'vinted.labels.close'
              ? { closed: true }
              : { ...completed, filename: 'another.pdf' },
      )
    await expect(
      createLabelsApi(mock.call).process(
        { name: 'label.pdf', bytes },
        { marginMm: 3, cropMm: null },
        new AbortController().signal,
      ),
    ).rejects.toThrow('不一致')
  })
})
