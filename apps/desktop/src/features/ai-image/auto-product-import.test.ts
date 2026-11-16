import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoProductImport } from './auto-product-import'

const storage = new Map<string, string>()
const getRecord = vi.fn()
const importProduct = vi.fn()

beforeEach(() => {
  storage.clear()
  getRecord.mockReset()
  importProduct.mockReset()
})

function create() {
  return new AutoProductImport({
    getRecord,
    importProduct,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    notify: vi.fn(),
  })
}

describe('automatic product import', () => {
  it('keeps pending generation across instances and imports only after success', async () => {
    const first = create()
    first.track('record-1')
    getRecord.mockResolvedValueOnce({ record: { status: 'running' } })
    await first.check()
    const resumed = create()
    getRecord.mockResolvedValueOnce({ record: { status: 'success' } })
    importProduct.mockResolvedValueOnce({ alreadyImported: false })
    await resumed.check()
    expect(importProduct).toHaveBeenCalledExactlyOnceWith('record-1')
    expect(resumed.pending()).toEqual([])
  })

  it('retains failed imports for explicit retry without another generation', async () => {
    const notify = vi.fn()
    const runtime = new AutoProductImport({
      getRecord,
      importProduct,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      notify,
    })
    runtime.track('record-2')
    getRecord.mockResolvedValue({ record: { status: 'success' } })
    importProduct.mockRejectedValueOnce(new Error('商品插件不可用'))
    await runtime.check()
    expect(runtime.pending()).toEqual(['record-2'])
    importProduct.mockResolvedValueOnce({ alreadyImported: true })
    const retry = notify.mock.calls[0]?.[1] as (() => void) | undefined
    retry?.()
    await vi.waitFor(() => expect(runtime.pending()).toEqual([]))
    await runtime.check()
    expect(runtime.pending()).toEqual([])
    expect(importProduct).toHaveBeenCalledTimes(2)
  })

  it('drops failed generations without importing', async () => {
    const runtime = create()
    runtime.track('record-3')
    getRecord.mockResolvedValue({ record: { status: 'failed' } })
    await runtime.check()
    expect(runtime.pending()).toEqual([])
    expect(importProduct).not.toHaveBeenCalled()
  })

  it('does not claim a pending task was registered if storage rejects the write', () => {
    const runtime = new AutoProductImport({
      getRecord,
      importProduct,
      notify: vi.fn(),
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('disk full')
        },
      },
    })
    expect(() => runtime.track('record-4')).toThrow('disk full')
    expect(runtime.pending()).toEqual([])
  })

  it('does not announce a saved import when removing its pending receipt fails', async () => {
    const notify = vi.fn()
    let writes = 0
    const runtime = new AutoProductImport({
      getRecord,
      importProduct,
      notify,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          if (++writes > 1) throw new Error('disk full')
          storage.set(key, value)
        },
      },
    })
    runtime.track('record-5')
    getRecord.mockResolvedValue({ record: { status: 'success' } })
    importProduct.mockResolvedValue({ alreadyImported: false })
    await runtime.check()
    expect(notify).not.toHaveBeenCalledWith('图片已生成并加入商品库。')
    expect(runtime.pending()).toEqual(['record-5'])
  })
})
