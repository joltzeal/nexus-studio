import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_REFERENCE_BYTES, prepareReference } from './prepare-reference'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9])
const webp = () => new File(['downloaded-webp'], 'product.webp', { type: 'image/webp' })

function canvasEnvironment(width = 2400, height = 1600) {
  const source = { width, height, close: vi.fn() }
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn((): typeof context | null => context),
    toBlob: vi.fn<HTMLCanvasElement['toBlob']>((callback) =>
      callback(new Blob([JPEG], { type: 'image/jpeg' })),
    ),
  }
  const decode = vi.fn(async () => source)
  vi.stubGlobal('createImageBitmap', decode)
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
  return { source, context, canvas, decode }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('local reference conversion', () => {
  it('decodes WebP, preserves proportions, fills transparency and produces actual JPEG bytes', async () => {
    const { source, context, canvas, decode } = canvasEnvironment()
    const file = webp()
    const result = await prepareReference(file)
    expect(decode).toHaveBeenCalledExactlyOnceWith(file, {
      imageOrientation: 'from-image',
    })
    expect(context.fillStyle).toBe('#ffffff')
    expect(context.fillRect).toHaveBeenCalledExactlyOnceWith(0, 0, 1536, 1024)
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(source, 0, 0, 1536, 1024)
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.86)
    expect(result).toEqual({
      base64: btoa(String.fromCharCode(...JPEG)),
      mime: 'image/jpeg',
      name: 'product.jpg',
      width: 1536,
      height: 1024,
      bytes: JPEG.byteLength,
    })
    expect(source.close).toHaveBeenCalledOnce()
    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })

  it('keeps small image dimensions and supports the WebView Image decoder fallback', async () => {
    const { context, canvas } = canvasEnvironment()
    vi.stubGlobal('createImageBitmap', undefined)
    const image = {
      width: 640,
      height: 480,
      src: '',
      decode: vi.fn(async () => undefined),
    }
    vi.stubGlobal(
      'Image',
      class {
        constructor() {
          return image
        }
      },
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reference-test')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const result = await prepareReference(webp())
    expect(result).toMatchObject({ width: 640, height: 480 })
    expect(image.src).toBe('blob:reference-test')
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(image, 0, 0, 640, 480)
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:reference-test')
    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })

  it('rejects invalid input before decoding', async () => {
    const { decode } = canvasEnvironment()
    await expect(
      prepareReference(new File([], 'empty.webp', { type: 'image/webp' })),
    ).rejects.toThrow('内容为空')
    await expect(
      prepareReference(new File(['html'], 'page.html', { type: 'text/html' })),
    ).rejects.toThrow('只支持')
    await expect(
      prepareReference(
        new File([new Uint8Array(MAX_REFERENCE_BYTES + 1)], 'large.webp', {
          type: 'image/webp',
        }),
      ),
    ).rejects.toThrow('8 MB')
    expect(decode).not.toHaveBeenCalled()
  })

  it.each([
    null,
    new Blob([], { type: 'image/jpeg' }),
    new Blob(['png'], { type: 'image/png' }),
  ])(
    'does not relabel an empty or unsupported encoding result as JPEG',
    async (result) => {
      const { source, canvas } = canvasEnvironment()
      canvas.toBlob.mockImplementation((callback) => callback(result))
      await expect(prepareReference(webp())).rejects.toThrow('转为 JPEG 失败')
      expect(source.close).toHaveBeenCalledOnce()
      expect([canvas.width, canvas.height]).toEqual([0, 0])
    },
  )

  it('rejects oversized encoded output after trying the quality levels', async () => {
    const { canvas, source } = canvasEnvironment()
    const result = new Blob([new Uint8Array(MAX_REFERENCE_BYTES + 1)], {
      type: 'image/jpeg',
    })
    canvas.toBlob.mockImplementation((callback) => callback(result))
    await expect(prepareReference(webp())).rejects.toThrow('转换后的图片超过 8 MB')
    expect(canvas.toBlob).toHaveBeenCalledTimes(3)
    expect(source.close).toHaveBeenCalledOnce()
  })

  it('releases decoded pixels after an unavailable canvas or failed draw', async () => {
    const { context, source, canvas } = canvasEnvironment()
    canvas.getContext.mockReturnValueOnce(null)
    await expect(prepareReference(webp())).rejects.toThrow('无法处理图片')
    context.drawImage.mockImplementation(() => {
      throw new Error('draw failed')
    })
    await expect(prepareReference(webp())).rejects.toThrow('draw failed')
    expect(source.close).toHaveBeenCalledTimes(2)
    expect(canvas.toBlob).not.toHaveBeenCalled()
    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })

  it('rejects an invalid decoded size without attempting canvas allocation', async () => {
    const { canvas, source } = canvasEnvironment(0, 200)
    await expect(prepareReference(webp())).rejects.toThrow('无法读取图片尺寸')
    expect(canvas.getContext).not.toHaveBeenCalled()
    expect(source.close).toHaveBeenCalledOnce()
  })

  it('reports undecodable images and never encodes fabricated data', async () => {
    const { canvas, decode } = canvasEnvironment()
    decode.mockRejectedValue(new Error('The source image could not be decoded.'))
    await expect(prepareReference(webp())).rejects.toThrow('无法解码参考图片')
    expect(canvas.toBlob).not.toHaveBeenCalled()
  })

  it('honors cancellation before decode and after an asynchronous encode', async () => {
    const { canvas, source, decode } = canvasEnvironment()
    const first = new AbortController()
    first.abort()
    await expect(prepareReference(webp(), first.signal)).rejects.toThrow()
    expect(decode).not.toHaveBeenCalled()

    const second = new AbortController()
    canvas.toBlob.mockImplementation((callback) => {
      second.abort()
      callback(new Blob([JPEG], { type: 'image/jpeg' }))
    })
    await expect(prepareReference(webp(), second.signal)).rejects.toThrow()
    expect(source.close).toHaveBeenCalledOnce()
    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })
})
