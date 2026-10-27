import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VerificationSound } from './verification-sound'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

class FakeGain {
  gain = {
    setValueAtTime: vi.fn<(value: number, time: number) => void>(),
    linearRampToValueAtTime: vi.fn<(value: number, time: number) => void>(),
  }
  connect = vi.fn<(destination: object) => void>()
  disconnect = vi.fn<() => void>()
}

class FakeOscillator {
  type: OscillatorType = 'sine'
  frequency = { setValueAtTime: vi.fn<(value: number, time: number) => void>() }
  onended: (() => void) | null = null
  connect = vi.fn<(gain: FakeGain) => void>()
  disconnect = vi.fn<() => void>()
  start = vi.fn<(time?: number) => void>()
  stop = vi.fn<(time?: number) => void>(() => {
    if (this.start.mock.calls.length === 0) {
      throw new DOMException('Not started', 'InvalidStateError')
    }
  })
}

class FakeAudioContext extends EventTarget {
  state: AudioContextState = 'suspended'
  currentTime = 12
  destination = {}
  resume = vi.fn(async () => {
    if (this.state === 'closed') {
      throw new DOMException('Context closed', 'InvalidStateError')
    }
    this.state = 'running'
  })
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  oscillators: FakeOscillator[] = []
  gains: FakeGain[] = []
  createOscillator = vi.fn(() => {
    const oscillator = new FakeOscillator()
    this.oscillators.push(oscillator)
    return oscillator
  })
  createGain = vi.fn(() => {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  })
}

let sound: VerificationSound
let context: FakeAudioContext
let createContext: ReturnType<typeof vi.fn<() => FakeAudioContext>>

beforeEach(() => {
  vi.useFakeTimers()
  sound = new VerificationSound()
  context = new FakeAudioContext()
  createContext = vi.fn(function () {
    return context
  })
  vi.stubGlobal('AudioContext', createContext)
})

afterEach(() => {
  sound.close()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('verification sound arming', () => {
  it('returns false without Web Audio support, including play before arming', async () => {
    vi.stubGlobal('AudioContext', undefined)

    await expect(sound.play()).resolves.toBe(false)
    await expect(sound.arm()).resolves.toBe(false)
    expect(() => sound.close()).not.toThrow()
  })

  it('constructs and resumes in the click stack without playing a sound', async () => {
    const resume = deferred<void>()
    context.resume.mockReturnValueOnce(resume.promise)

    const arming = sound.arm()

    expect(createContext).toHaveBeenCalledTimes(1)
    expect(context.resume).toHaveBeenCalledTimes(1)
    expect(context.createOscillator).not.toHaveBeenCalled()
    context.state = 'running'
    resume.resolve()
    await expect(arming).resolves.toBe(true)
    expect(context.createOscillator).not.toHaveBeenCalled()
    expect(context.createGain).not.toHaveBeenCalled()
  })

  it('reuses a running context across clicks without resuming or playing again', async () => {
    context.state = 'running'

    await expect(sound.arm()).resolves.toBe(true)
    await expect(sound.arm()).resolves.toBe(true)

    expect(createContext).toHaveBeenCalledTimes(1)
    expect(context.resume).not.toHaveBeenCalled()
    expect(context.createOscillator).not.toHaveBeenCalled()
  })

  it('returns false on a blocked constructor and allows a later click to retry', async () => {
    createContext.mockImplementationOnce(function () {
      throw new DOMException('Blocked', 'NotAllowedError')
    })

    await expect(sound.arm()).resolves.toBe(false)
    await expect(sound.arm()).resolves.toBe(true)
    expect(createContext).toHaveBeenCalledTimes(2)
  })

  it.each(['throw', 'reject', 'still suspended'] as const)(
    'reports an unsuccessful resume as false: %s',
    async (failure) => {
      context.resume.mockImplementationOnce(() => {
        if (failure === 'throw') throw new DOMException('Blocked', 'NotAllowedError')
        if (failure === 'reject') {
          return Promise.reject(new DOMException('Blocked', 'NotAllowedError'))
        }
        return Promise.resolve()
      })

      await expect(sound.arm()).resolves.toBe(false)
      expect(context.createOscillator).not.toHaveBeenCalled()
      await expect(sound.arm()).resolves.toBe(true)
      expect(createContext).toHaveBeenCalledTimes(1)
    },
  )
})

describe('verification sound playback', () => {
  it('requires arming and never creates a context from a background play call', async () => {
    await expect(sound.play()).resolves.toBe(false)
    expect(createContext).not.toHaveBeenCalled()
  })

  it('schedules one short, softly enveloped two-tone notification', async () => {
    await sound.arm()

    await expect(sound.play()).resolves.toBe(true)

    expect(context.oscillators).toHaveLength(2)
    expect(context.gains).toHaveLength(2)
    const frequencies: number[] = []
    const starts: number[] = []
    for (const [index, oscillator] of context.oscillators.entries()) {
      const gain = context.gains[index]!
      expect(oscillator.type).toBe('sine')
      expect(oscillator.connect).toHaveBeenCalledExactlyOnceWith(gain)
      expect(gain.connect).toHaveBeenCalledExactlyOnceWith(context.destination)
      expect(oscillator.start).toHaveBeenCalledTimes(1)
      expect(oscillator.stop).toHaveBeenCalledTimes(1)
      const start = oscillator.start.mock.calls[0]![0]!
      const stop = oscillator.stop.mock.calls[0]![0]!
      starts.push(start)
      expect(start).toBeGreaterThanOrEqual(12)
      expect(stop).toBeGreaterThan(start)
      expect(stop).toBeLessThan(13)
      expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledTimes(1)
      const [frequency, frequencyTime] =
        oscillator.frequency.setValueAtTime.mock.calls[0]!
      frequencies.push(frequency)
      expect(frequency).toBeGreaterThan(100)
      expect(frequency).toBeLessThan(2000)
      expect(frequencyTime).toBe(start)
      expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, start)
      const ramps = gain.gain.linearRampToValueAtTime.mock.calls
      const [peak, attackTime] = ramps[0]!
      expect(peak).toBeGreaterThan(0)
      expect(peak).toBeLessThanOrEqual(0.2)
      expect(attackTime).toBeGreaterThan(start)
      expect(attackTime).toBeLessThan(stop)
      expect(ramps[ramps.length - 1]).toEqual([0, stop])
      expect(oscillator.disconnect).not.toHaveBeenCalled()
      expect(gain.disconnect).not.toHaveBeenCalled()
    }
    expect(new Set(frequencies).size).toBe(2)
    expect(starts[1]).toBeGreaterThan(starts[0]!)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(context.createOscillator).toHaveBeenCalledTimes(2)
  })

  it('disconnects ended tones and keeps the context available for another notification', async () => {
    await sound.arm()
    await sound.play()
    expect(context.oscillators).toHaveLength(2)
    for (const oscillator of context.oscillators) {
      expect(oscillator.onended).toEqual(expect.any(Function))
      oscillator.onended?.()
      expect(oscillator.onended).toBeNull()
      expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
    }
    for (const gain of context.gains) {
      expect(gain.disconnect).toHaveBeenCalledTimes(1)
    }
    expect(context.close).not.toHaveBeenCalled()

    await expect(sound.play()).resolves.toBe(true)
    expect(createContext).toHaveBeenCalledTimes(1)
    expect(context.oscillators).toHaveLength(4)
    sound.close()
    for (const oscillator of context.oscillators) {
      expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
    }
  })

  it('waits for a suspended context and schedules against its resumed audio clock', async () => {
    await sound.arm()
    context.state = 'suspended'
    const resume = deferred<void>()
    context.resume.mockReturnValueOnce(resume.promise)

    const playing = sound.play()

    expect(context.resume).toHaveBeenCalledTimes(2)
    expect(context.createOscillator).not.toHaveBeenCalled()
    context.state = 'running'
    context.currentTime = 37
    resume.resolve()
    await expect(playing).resolves.toBe(true)
    expect(context.oscillators).toHaveLength(2)
    for (const oscillator of context.oscillators) {
      expect(oscillator.start.mock.calls[0]![0]).toBeGreaterThanOrEqual(37)
      expect(oscillator.stop.mock.calls[0]![0]).toBeLessThan(38)
    }
  })

  it('reports blocked playback without scheduling nodes and permits a later click', async () => {
    await sound.arm()
    context.state = 'suspended'
    context.resume.mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'))

    await expect(sound.play()).resolves.toBe(false)
    expect(context.createOscillator).not.toHaveBeenCalled()
    await expect(sound.arm()).resolves.toBe(true)
    await expect(sound.play()).resolves.toBe(true)
  })

  it('stops and disconnects a partial notification when the second gain cannot be allocated', async () => {
    await sound.arm()
    context.createGain
      .mockImplementationOnce(context.createGain.getMockImplementation()!)
      .mockImplementationOnce(() => {
        throw new DOMException('Audio device unavailable', 'InvalidStateError')
      })

    await expect(sound.play()).resolves.toBe(false)

    expect(context.oscillators).toHaveLength(2)
    for (const oscillator of context.oscillators) {
      expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
      expect(oscillator.onended).toBeNull()
    }
    expect(context.oscillators[0]!.stop).toHaveBeenLastCalledWith()
    expect(context.gains[0]!.disconnect).toHaveBeenCalledTimes(1)
    await expect(sound.play()).resolves.toBe(true)
  })

  it('cancels scheduled tones on close, including an already queued ended callback', async () => {
    await sound.arm()
    await sound.play()
    expect(context.oscillators).toHaveLength(2)
    const ended = context.oscillators.map((oscillator) => oscillator.onended)

    sound.close()
    sound.close()
    ended.forEach((callback) => callback?.())

    expect(context.close).toHaveBeenCalledTimes(1)
    for (const oscillator of context.oscillators) {
      expect(oscillator.stop).toHaveBeenLastCalledWith()
      expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
      expect(oscillator.onended).toBeNull()
    }
    for (const gain of context.gains) {
      expect(gain.disconnect).toHaveBeenCalledTimes(1)
    }
    await expect(sound.play()).resolves.toBe(false)
    const nextContext = new FakeAudioContext()
    createContext.mockImplementationOnce(function () {
      return nextContext
    })
    await expect(sound.arm()).resolves.toBe(true)
    await expect(sound.play()).resolves.toBe(true)
    expect(nextContext.oscillators).toHaveLength(2)
  })
})

describe('verification sound lifecycle races', () => {
  it.each(['arm', 'play'] as const)(
    'bounds a stalled %s resume and consumes its eventual rejection',
    async (operation) => {
      if (operation === 'play') await sound.arm()
      context.state = 'suspended'
      const resume = deferred<void>()
      context.resume.mockReturnValueOnce(resume.promise)
      const results: boolean[] = []

      void sound[operation]().then((result) => results.push(result))
      await vi.advanceTimersByTimeAsync(2000)

      expect(results).toEqual([false])
      expect(vi.getTimerCount()).toBe(0)
      expect(context.createOscillator).not.toHaveBeenCalled()
      resume.reject(new DOMException('Late denial', 'NotAllowedError'))
      await vi.advanceTimersByTimeAsync(0)
      await expect(sound.arm()).resolves.toBe(true)
      await expect(sound.play()).resolves.toBe(true)
      expect(createContext).toHaveBeenCalledTimes(1)
    },
  )

  it('does not play a timed-out notification if resume eventually succeeds', async () => {
    await sound.arm()
    context.state = 'suspended'
    const resume = deferred<void>()
    context.resume.mockReturnValueOnce(resume.promise)
    const results: boolean[] = []

    void sound.play().then((result) => results.push(result))
    await vi.advanceTimersByTimeAsync(2000)

    expect(results).toEqual([false])
    context.state = 'running'
    resume.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(context.createOscillator).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resolve', 'reject'] as const)(
    'close cancels pending arm/play immediately and isolates a later context: %s',
    async (outcome) => {
      const resume = deferred<void>()
      const closing = deferred<void>()
      context.resume.mockImplementation(() => resume.promise)
      context.close.mockReturnValueOnce(closing.promise)
      const results: boolean[][] = []
      void Promise.all([sound.arm(), sound.play()]).then((result) => results.push(result))

      sound.close()
      sound.close()
      await vi.advanceTimersByTimeAsync(0)

      expect(results).toEqual([[false, false]])
      expect(vi.getTimerCount()).toBe(0)
      expect(context.close).toHaveBeenCalledTimes(1)
      const nextContext = new FakeAudioContext()
      createContext.mockImplementationOnce(function () {
        return nextContext
      })
      await expect(sound.arm()).resolves.toBe(true)
      await expect(sound.play()).resolves.toBe(true)
      if (outcome === 'resolve') {
        context.state = 'running'
        resume.resolve()
        closing.resolve()
      } else {
        resume.reject(new Error('Old resume failed'))
        closing.reject(new Error('Old close failed'))
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(context.createOscillator).not.toHaveBeenCalled()
      expect(nextContext.oscillators).toHaveLength(2)
      expect(nextContext.close).not.toHaveBeenCalled()
      expect(results).toEqual([[false, false]])
    },
  )

  it.each(['arm', 'play'] as const)(
    'does not report success if closed before a running-context %s settles',
    async (operation) => {
      await sound.arm()

      const pending = sound[operation]()
      sound.close()

      await expect(pending).resolves.toBe(false)
      expect(context.createOscillator).not.toHaveBeenCalled()
    },
  )

  it('retries resume synchronously on a new click even while a prior click is pending', async () => {
    const resume = deferred<void>()
    context.resume.mockReturnValueOnce(resume.promise)
    const firstClick = sound.arm()

    const secondClick = sound.arm()

    expect(context.resume).toHaveBeenCalledTimes(2)
    await expect(secondClick).resolves.toBe(true)
    resume.resolve()
    await expect(firstClick).resolves.toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(context.createOscillator).not.toHaveBeenCalled()
  })

  it.each(['suspended', 'closed'] as const)(
    'releases scheduled nodes when the browser changes the context to %s',
    async (state) => {
      await sound.arm()
      await sound.play()
      expect(context.oscillators).toHaveLength(2)

      context.state = state
      context.dispatchEvent(new Event('statechange'))

      for (const oscillator of context.oscillators) {
        expect(oscillator.stop).toHaveBeenLastCalledWith()
        expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
        expect(oscillator.onended).toBeNull()
      }
      for (const gain of context.gains) {
        expect(gain.disconnect).toHaveBeenCalledTimes(1)
      }
      expect(context.close).not.toHaveBeenCalled()
      expect(createContext).toHaveBeenCalledTimes(1)
    },
  )

  it('replaces an externally closed context only on a later click, even before statechange fires', async () => {
    await sound.arm()
    await sound.play()
    context.state = 'closed'

    await expect(sound.play()).resolves.toBe(false)
    expect(createContext).toHaveBeenCalledTimes(1)
    const nextContext = new FakeAudioContext()
    createContext.mockImplementationOnce(function () {
      return nextContext
    })
    await expect(sound.arm()).resolves.toBe(true)
    expect(context.close).not.toHaveBeenCalled()
    for (const oscillator of context.oscillators) {
      expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
    }
    await expect(sound.play()).resolves.toBe(true)
    context.dispatchEvent(new Event('statechange'))
    for (const oscillator of nextContext.oscillators) {
      expect(oscillator.disconnect).not.toHaveBeenCalled()
    }
  })

  it.each(['throw', 'reject'] as const)(
    'finishes cleanup and permits re-arming despite a context close failure: %s',
    async (failure) => {
      await sound.arm()
      await sound.play()
      context.close.mockImplementationOnce(() => {
        if (failure === 'throw') throw new Error('Device removed')
        return Promise.reject(new Error('Device removed'))
      })
      const first = context.oscillators[0]!
      first.stop.mockImplementationOnce(() => {
        throw new DOMException('Already stopped', 'InvalidStateError')
      })
      first.disconnect.mockImplementationOnce(() => {
        throw new DOMException('Already disconnected', 'InvalidStateError')
      })

      expect(() => sound.close()).not.toThrow()
      sound.close()
      await vi.advanceTimersByTimeAsync(0)

      expect(context.close).toHaveBeenCalledTimes(1)
      expect(context.oscillators[1]!.disconnect).toHaveBeenCalledTimes(1)
      for (const gain of context.gains) {
        expect(gain.disconnect).toHaveBeenCalledTimes(1)
      }
      const nextContext = new FakeAudioContext()
      createContext.mockImplementationOnce(function () {
        return nextContext
      })
      await expect(sound.arm()).resolves.toBe(true)
    },
  )
})
