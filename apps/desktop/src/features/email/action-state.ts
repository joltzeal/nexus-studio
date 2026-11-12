import { emailFailureMessage } from './errors'

export class EmailAction {
  private snapshot: { busy: boolean; error: string | null } = { busy: false, error: null }
  private readonly listeners = new Set<() => void>()
  private active = false
  private inFlight = false
  private revision = 0

  constructor(private readonly failure: string) {}

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    this.active = true
  }

  dispose(): void {
    this.active = false
    this.revision += 1
  }

  async run<T>(write: () => Promise<T>, commit: (value: T) => void): Promise<void> {
    if (!this.active || this.inFlight) return
    this.inFlight = true
    const revision = this.revision
    this.publish({ busy: true, error: null })
    try {
      const value = await write()
      if (this.active && revision === this.revision) commit(value)
    } catch (error) {
      if (this.active && revision === this.revision) {
        this.publish({ busy: true, error: emailFailureMessage(error, this.failure) })
      }
    } finally {
      this.inFlight = false
      if (this.active && revision === this.revision) {
        this.publish({ ...this.snapshot, busy: false })
      }
    }
  }

  private publish(snapshot: { busy: boolean; error: string | null }): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
