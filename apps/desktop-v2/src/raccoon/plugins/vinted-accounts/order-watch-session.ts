export type CurrentOrderWatchTask = () => boolean

export class OrderWatchSession {
  private readonly identity: () => string | null
  private generation = 0
  private active = false
  private pending: object | null = null

  constructor(identity: () => string | null) {
    this.identity = identity
  }

  start() {
    this.generation++
    this.active = true
    this.pending = null
  }

  stop() {
    this.generation++
    this.active = false
    this.pending = null
  }

  async run(
    operation: (current: CurrentOrderWatchTask) => Promise<void>,
  ): Promise<boolean> {
    const identity = this.identity()
    if (!this.active || !identity || this.pending) return false
    const generation = this.generation
    const token = {}
    this.pending = token
    const current = () =>
      this.active &&
      this.pending === token &&
      generation === this.generation &&
      identity === this.identity()
    try {
      await operation(current)
      return true
    } finally {
      if (this.pending === token) this.pending = null
    }
  }
}

export function orderWatchHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
