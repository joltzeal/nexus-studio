import { describe, expect, it } from 'vitest'
import { createSupplyImageReader } from './image-transfer'
import type { SupplyRpc } from './api'

describe('shared supply image transfer', () => {
  it('reads exact chunks and always closes the opened transfer', async () => {
    const calls: string[] = []
    const rpc: SupplyRpc = async (method, payload, parse) => {
      calls.push(`${method}:${JSON.stringify(payload)}`)
      if (method === 'supply.image.open')
        return parse({
          id: '00000000-0000-4000-8000-000000000001',
          size: 4,
          chunkSize: 2,
          mime: 'image/jpeg',
        })
      if (method === 'supply.image.read') {
        const offset = (payload as { offset: number }).offset
        return parse(
          offset === 0 ? { offset: 0, data: 'AQI=' } : { offset: 2, data: 'AwQ=' },
        )
      }
      return parse({ closed: true })
    }
    const blob = await createSupplyImageReader(rpc)(
      'https://product.aliyizhan.com/person/photo.jpg',
      new AbortController().signal,
    )
    expect(blob.type).toBe('image/jpeg')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4])
    expect(calls.at(-1)).toContain('supply.image.close')
  })

  it('rejects a chunk at the wrong offset and still closes the transfer', async () => {
    const methods: string[] = []
    const rpc: SupplyRpc = async (method, _payload, parse) => {
      methods.push(method)
      if (method === 'supply.image.open')
        return parse({
          id: '00000000-0000-4000-8000-000000000001',
          size: 2,
          chunkSize: 2,
          mime: 'image/png',
        })
      if (method === 'supply.image.read') return parse({ offset: 1, data: 'AQI=' })
      return parse({ closed: true })
    }
    await expect(
      createSupplyImageReader(rpc)(
        'https://product.aliyizhan.com/person/photo.png',
        new AbortController().signal,
      ),
    ).rejects.toThrow('传输数据无效')
    expect(methods.at(-1)).toBe('supply.image.close')
  })

  it('closes a transfer when the caller aborts between chunks', async () => {
    const controller = new AbortController()
    const methods: string[] = []
    const rpc: SupplyRpc = async (method, _payload, parse) => {
      methods.push(method)
      if (method === 'supply.image.open') {
        controller.abort()
        return parse({
          id: '00000000-0000-4000-8000-000000000001',
          size: 2,
          chunkSize: 2,
          mime: 'image/png',
        })
      }
      return parse({ closed: true })
    }
    await expect(
      createSupplyImageReader(rpc)(
        'https://product.aliyizhan.com/person/photo.png',
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(methods.at(-1)).toBe('supply.image.close')
  })
})
