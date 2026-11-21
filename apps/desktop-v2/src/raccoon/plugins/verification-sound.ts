type OtpChannel = 'sms' | 'email'

const clips = [
  'tts_sms_otp',
  'tts_email_otp',
  ...Array.from({ length: 10 }, (_, digit) => `tts_${digit}`),
]

export class VerificationSound {
  private context: AudioContext | null = null
  private buffers: Promise<Map<string, AudioBuffer>> | null = null
  private abort: AbortController | null = null
  private sources = new Set<AudioBufferSourceNode>()

  /** Run in the click handler to unlock audio before the network polling begins. */
  async arm(): Promise<boolean> {
    try {
      if (!this.context || this.context.state === 'closed') {
        this.close()
        if (typeof AudioContext !== 'function') return false
        this.context = new AudioContext()
      }
      const context = this.context
      if (!this.buffers) {
        const controller = new AbortController()
        this.abort = controller
        this.buffers = this.load(context, controller.signal).catch(() => {
          if (this.abort === controller) {
            this.abort = null
            this.buffers = null
          }
          return new Map()
        })
      }
      if (context.state !== 'running') {
        const ready = await new Promise<boolean>((resolve) => {
          let settled = false
          const finish = (value: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve(value)
          }
          const timeout = setTimeout(() => finish(false), 1000)
          void context.resume().then(
            () => finish(context.state === 'running'),
            () => finish(false),
          )
        })
        if (!ready) return false
      }
      return this.context === context && context.state === 'running'
    } catch {
      return false
    }
  }

  /** Schedule the intro followed by each digit; silence between digits is 0.5 s. */
  async play(channel: OtpChannel, code: string): Promise<boolean> {
    if (!/^(?:\d{4}|\d{6})$/.test(code)) return false
    const context = this.context
    if (!context || !(await this.arm()) || this.context !== context) return false
    const scheduled: AudioBufferSourceNode[] = []
    try {
      const buffers = await this.buffers
      if (!buffers || this.context !== context || context.state !== 'running')
        return false
      const names = [
        `tts_${channel}_otp`,
        ...code.split('').map((digit) => `tts_${digit}`),
      ]
      let start = context.currentTime + 0.05
      for (const [index, name] of names.entries()) {
        const buffer = buffers.get(name)
        if (!buffer) throw new Error('语音资源未能加载')
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        source.onended = () => {
          this.sources.delete(source)
          source.disconnect()
        }
        scheduled.push(source)
        this.sources.add(source)
        source.start(start)
        start += buffer.duration + (index < names.length - 1 ? 0.5 : 0)
      }
      return true
    } catch {
      for (const source of scheduled) {
        try {
          source.stop()
        } catch {
          // The source may not have started yet.
        }
        source.disconnect()
        this.sources.delete(source)
      }
      return false
    }
  }

  close(): void {
    this.abort?.abort()
    this.abort = null
    this.buffers = null
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // The device may already be closed.
      }
      source.disconnect()
    }
    this.sources.clear()
    const context = this.context
    this.context = null
    if (context && context.state !== 'closed') void context.close().catch(() => undefined)
  }

  private async load(
    context: AudioContext,
    signal: AbortSignal,
  ): Promise<Map<string, AudioBuffer>> {
    const entries = await Promise.all(
      clips.map(async (name) => {
        const response = await fetch(`${import.meta.env.BASE_URL}audio/otp/${name}.mp3`, {
          signal,
        })
        if (!response.ok) throw new Error(`音频加载失败：${name}`)
        const buffer = await context.decodeAudioData(await response.arrayBuffer())
        return [name, buffer] as const
      }),
    )
    return new Map(entries)
  }
}
