function safelyRelease(release: () => void): void {
  try {
    release()
  } catch {
    // Cleanup must continue if an audio device or node has already been released.
  }
}

export class VerificationSound {
  private context: AudioContext | null = null
  private readonly activeNodes = new Set<() => void>()
  private readonly pendingResumes = new Set<() => void>()
  private readonly onStateChange = () => {
    if (this.context?.state === 'closed') {
      this.close()
    } else if (this.context?.state !== 'running') {
      for (const release of this.activeNodes) release()
    }
  }

  /** Call directly in the user gesture, before awaiting network work. Never plays audio. */
  async arm(): Promise<boolean> {
    try {
      if (!this.context || this.context.state === 'closed') {
        this.close()
        if (typeof AudioContext !== 'function') return false
        this.context = new AudioContext()
        this.context.addEventListener('statechange', this.onStateChange)
      }
      const context = this.context
      const resumed = await this.resume(context)
      return resumed && this.context === context && context.state === 'running'
    } catch {
      return false
    }
  }

  /** True means one notification was scheduled, not that the output device was audible. */
  async play(): Promise<boolean> {
    const scheduled: Array<() => void> = []
    try {
      const context = this.context
      if (!context || context.state === 'closed') return false
      if (
        !(await this.resume(context)) ||
        this.context !== context ||
        context.state !== 'running'
      ) {
        return false
      }

      const now = context.currentTime + 0.01
      for (const [offset, frequency] of [
        [0, 660],
        [0.18, 880],
      ] as const) {
        const oscillator = context.createOscillator()
        let gain: GainNode | null = null
        let released = false
        const release = (stop = true) => {
          if (released) return
          released = true
          this.activeNodes.delete(release)
          oscillator.onended = null
          if (stop) safelyRelease(() => oscillator.stop())
          safelyRelease(() => oscillator.disconnect())
          safelyRelease(() => gain?.disconnect())
        }
        scheduled.push(release)
        this.activeNodes.add(release)
        gain = context.createGain()

        const start = now + offset
        const end = start + 0.16
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(frequency, start)
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(0.08, start + 0.012)
        gain.gain.linearRampToValueAtTime(0, end)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.onended = () => release(false)
        oscillator.start(start)
        oscillator.stop(end)
      }
      return true
    } catch {
      scheduled.forEach((release) => release())
      return false
    }
  }

  close(): void {
    const context = this.context
    this.context = null
    context?.removeEventListener('statechange', this.onStateChange)
    for (const cancel of this.pendingResumes) cancel()
    for (const release of this.activeNodes) release()
    if (context && context.state !== 'closed') {
      safelyRelease(() => {
        void context.close().catch(() => undefined)
      })
    }
  }

  private resume(context: AudioContext): Promise<boolean> {
    if (context.state === 'running') return Promise.resolve(true)
    if (context.state === 'closed') return Promise.resolve(false)

    return new Promise((resolve) => {
      let settled = false
      const finish = (resumed: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.pendingResumes.delete(cancel)
        resolve(resumed)
      }
      const cancel = () => finish(false)
      // Autoplay policy can leave resume() pending until another user gesture.
      const timeout = setTimeout(cancel, 1000)
      this.pendingResumes.add(cancel)
      try {
        void context.resume().then(() => finish(context.state === 'running'), cancel)
      } catch {
        cancel()
      }
    })
  }
}
