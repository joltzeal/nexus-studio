import type { DependencyList, EffectCallback, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductSchema, type ProductImage } from '@nexus/plugin-products/contracts'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import {
  discardProductImages,
  getProduct,
  listProductPublications,
  saveProduct,
  uploadProductImage,
} from './api'
import { ProductEditor, type ProductEditorProps } from './product-editor'
import {
  ProductPublicationDialog,
  ProductPublicationHistory,
  ProductPublicationOverview,
} from './product-publication-history'
import { publication } from './publication.test-data'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useRef: (initial: unknown) =>
      state.hooks
        ? state.hooks.state(() => ({ current: initial }))[0]
        : react.useRef(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('./api', () => ({
  getProduct: vi.fn(),
  listProductPublications: vi.fn(),
  saveProduct: vi.fn(),
  uploadProductImage: vi.fn(),
  discardProductImages: vi.fn(),
  productImageUrl: vi.fn(),
}))

const image: ProductImage = {
  id: '93321469-1d55-407c-90da-9c683823258c',
  name: 'existing.png',
  mime: 'image/png',
  bytes: 1,
  sha256: '0'.repeat(64),
}
const uploaded = { ...image, id: '7789c134-f3fe-4b63-bb41-dd259979ea21', name: 'new.png' }
const product = ProductSchema.parse({
  id: '741204de-e426-4a97-9d1a-a8b420e6eac4',
  revision: 3,
  sequence: 1,
  name: 'Existing draft',
  images: [image],
  publicationCount: 370,
  latestPublication: publication,
  source: { kind: 'manual' },
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
})
let hooks: KernelHookHarness
let props: ProductEditorProps
const render = (): ReactNode => hooks.render(() => ProductEditor(props))
async function settle() {
  render()
  hooks.flushEffects()
  await flushPromises()
}
function input(id: string) {
  return components(render(), Input).find((node) => node.props.id === id)!
}
function change(id: string, value: string) {
  input(id).props.onChange?.({ target: { value } } as React.ChangeEvent<HTMLInputElement>)
}
async function submit() {
  const form = elements(render()).find((node) => node.type === 'form')!
  ;(form.props.onSubmit as (event: React.FormEvent<HTMLFormElement>) => void)({
    preventDefault: vi.fn(),
  } as unknown as React.FormEvent<HTMLFormElement>)
  await flushPromises()
}
function click(label: string) {
  const button = components(render(), Button).find(
    (node) => node.props['aria-label'] === label || text(node.props.children) === label,
  )!
  button.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
  props = { productId: null, onClose: vi.fn(), onSaved: vi.fn() }
  vi.mocked(getProduct).mockResolvedValue(product)
  vi.mocked(discardProductImages).mockResolvedValue()
})
afterEach(async () => {
  hooks.dispose()
  await flushPromises()
})

describe('product edit failure recovery', () => {
  it('uses a bounded publication overview and only offers history on demand', async () => {
    props.productId = product.id
    await settle()
    const overview = components(render(), ProductPublicationOverview)[0]
    expect(overview).toBeDefined()
    const tree = ProductPublicationOverview(overview!.props)
    expect(text(tree)).toContain('共 370 次发布')
    expect(text(tree)).toContain(publication.windowName)
    expect(components(render(), ProductPublicationHistory)).toHaveLength(0)
    expect(components(render(), ProductPublicationDialog)).toHaveLength(0)
    expect(listProductPublications).not.toHaveBeenCalled()
    expect(
      components(tree, Button).some(
        (node) => text(node.props.children) === '查看发布历史',
      ),
    ).toBe(true)
    change('product-name', 'Retained while viewing history')
    overview!.props.onViewHistory()
    const dialog = components(render(), ProductPublicationDialog)[0]!
    expect(dialog.props).toMatchObject({
      productId: product.id,
      productName: product.name,
    })
    dialog.props.onClose()
    expect(components(render(), ProductPublicationDialog)).toHaveLength(0)
    expect(input('product-name').props.value).toBe('Retained while viewing history')
  })

  it('excludes publication facts from the edited form and accepts bounded save replies', async () => {
    props.productId = product.id
    await settle()
    expect(product).not.toHaveProperty('publications')
    change('product-name', 'Renamed published product')
    vi.mocked(saveProduct).mockResolvedValue({
      ...product,
      revision: 4,
      name: 'Renamed published product',
    })
    await submit()

    const input = vi.mocked(saveProduct).mock.calls[0]![0]
    expect(input.expectedRevision).toBe(3)
    expect(input.data).toMatchObject({
      name: 'Renamed published product',
      status: 'draft',
    })
    expect(input.data).not.toHaveProperty('publications')
    expect(input.data).not.toHaveProperty('publicationCount')
    expect(input.data).not.toHaveProperty('latestPublication')
    expect(props.onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ publicationCount: 370, latestPublication: publication }),
    )
  })

  it('retains a conflicting edit, its revision and its inputs without closing', async () => {
    props.productId = product.id
    await settle()
    change('product-name', 'Retained edit')
    const save = deferred<typeof product>()
    vi.mocked(saveProduct).mockReturnValueOnce(save.promise)
    await submit()

    expect(input('product-name').props.disabled).toBe(true)
    components(render(), Dialog)[0]!.props.onOpenChange?.(false)
    expect(props.onClose).not.toHaveBeenCalled()
    save.reject(new Error('修订冲突，请刷新核对'))
    await flushPromises()

    expect(text(render())).toContain('修订冲突')
    expect(input('product-name').props.value).toBe('Retained edit')
    expect(input('product-category').props.required).not.toBe(true)
    expect(saveProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        id: product.id,
        expectedRevision: 3,
        data: expect.objectContaining({ name: 'Retained edit', category: '' }),
      }),
    )
    expect(props.onSaved).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('keeps a stable creation key when a failed draft save is retried', async () => {
    await settle()
    change('product-name', 'New draft')
    vi.mocked(saveProduct)
      .mockRejectedValueOnce(new Error('写入失败'))
      .mockResolvedValueOnce(product)
    await submit()
    expect(input('product-name').props.value).toBe('New draft')
    await submit()

    const [first, second] = vi.mocked(saveProduct).mock.calls
    expect(first![0].createKey).toBe(second![0].createKey)
    expect(first![0].data.price).toBeNull()
    expect(first![0].data.title).toBe('')
    expect(props.onSaved).toHaveBeenCalledWith(product)
  })
})

describe('temporary image ownership', () => {
  it('cancels only newly uploaded unused images, even after removing an existing image', async () => {
    props.productId = product.id
    await settle()
    click('移除图片 1')
    vi.mocked(uploadProductImage).mockResolvedValueOnce(uploaded)
    input('product-images').props.onChange?.({
      target: {
        files: [new File(['x'], 'new.png', { type: 'image/png' })],
        value: 'file',
      },
    } as unknown as React.ChangeEvent<HTMLInputElement>)
    await flushPromises()
    click('取消')
    await flushPromises()

    expect(discardProductImages).toHaveBeenCalledExactlyOnceWith([uploaded.id])
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(saveProduct).not.toHaveBeenCalled()
  })

  it('waits for an in-flight upload before cancelling its returned image', async () => {
    await settle()
    const upload = deferred<ProductImage>()
    vi.mocked(uploadProductImage).mockReturnValueOnce(upload.promise)
    input('product-images').props.onChange?.({
      target: {
        files: [new File(['x'], 'new.png', { type: 'image/png' })],
        value: 'file',
      },
    } as unknown as React.ChangeEvent<HTMLInputElement>)
    click('取消')
    expect(vi.mocked(uploadProductImage).mock.calls[0]![1]!.aborted).toBe(true)
    expect(props.onClose).not.toHaveBeenCalled()

    upload.resolve(uploaded)
    await flushPromises()
    expect(discardProductImages).toHaveBeenCalledExactlyOnceWith([uploaded.id])
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('discards an unused upload after committing without discarding the saved main image', async () => {
    await settle()
    change('product-name', 'With new images')
    const kept = { ...uploaded, id: '8377f2f4-0128-47c9-99a5-b655b742eaa6' }
    vi.mocked(uploadProductImage)
      .mockResolvedValueOnce(uploaded)
      .mockResolvedValueOnce(kept)
    input('product-images').props.onChange?.({
      target: {
        files: [
          new File(['x'], 'unused.png', { type: 'image/png' }),
          new File(['y'], 'kept.png', { type: 'image/png' }),
        ],
        value: 'files',
      },
    } as unknown as React.ChangeEvent<HTMLInputElement>)
    await flushPromises()
    click('移除图片 1')
    const saved = { ...product, images: [kept] }
    vi.mocked(saveProduct).mockResolvedValueOnce(saved)
    await submit()
    hooks.dispose()

    expect(vi.mocked(saveProduct).mock.calls[0]![0].data.imageIds).toEqual([kept.id])
    expect(discardProductImages).toHaveBeenCalledExactlyOnceWith([uploaded.id])
    expect(props.onSaved).toHaveBeenCalledWith(saved)
  })
})
