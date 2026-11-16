import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VerificationSound } from './verification-sound'

class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  start = vi.fn<(at: number) => void>()
  stop = vi.fn()
  connect = vi.fn()
  disconnect = vi.fn()
}

class FakeContext {
  state = 'running'
  currentTime = 10
  destination = {}
  sources: FakeSource[] = []
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  decodeAudioData = vi.fn(async () => ({ duration: 0.2 }))
  createBufferSource = vi.fn(() => {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  })
}

let sound: VerificationSound
let context: FakeContext
let requested: string[]

beforeEach(() => {
  context = new FakeContext()
  requested = []
  sound = new VerificationSound()
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return context
    }),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(url)
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }
    }),
  )
})
afterEach(() => {
  sound.close()
  vi.unstubAllGlobals()
})

describe('OTP voice playback', () => {
  it('preloads bundled clips and speaks repeated digits separately with 0.5s gaps', async () => {
    expect(await sound.arm()).toBe(true)
    expect(context.sources).toHaveLength(0)
    expect(await sound.play('email', '000001')).toBe(true)
    expect(requested).toHaveLength(12)
    expect(context.sources).toHaveLength(7)
    expect(context.sources[0]?.start).toHaveBeenCalledWith(10.05)
    expect(context.sources[1]?.start).toHaveBeenCalledWith(10.75)
    expect(context.sources[2]?.start).toHaveBeenCalledWith(11.45)
    expect(context.sources.map((source) => source.buffer)).toHaveLength(7)
    expect(context.sources[6]?.start.mock.calls[0]?.[0]).toBeCloseTo(14.25)
  })

  it('uses the SMS introduction and rejects non-numeric codes', async () => {
    await sound.arm()
    expect(await sound.play('sms', '1234')).toBe(true)
    expect(context.sources).toHaveLength(5)
    expect(await sound.play('sms', '12x4')).toBe(false)
    expect(context.sources).toHaveLength(5)
  })

  it('keeps the text notification path when a bundled clip fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    )
    await sound.arm()
    expect(await sound.play('email', '000001')).toBe(false)
    expect(context.sources).toHaveLength(0)
  })

  it('reloads audio after an earlier fetch failure without restarting the app', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockImplementation(async () => ({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1),
        })),
    )
    await sound.arm()
    expect(await sound.play('sms', '1234')).toBe(false)
    expect(await sound.play('sms', '1234')).toBe(true)
    expect(context.sources).toHaveLength(5)
  })
})
