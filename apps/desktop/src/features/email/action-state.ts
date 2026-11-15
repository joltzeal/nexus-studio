import { emailFailureMessage } from './errors'

export class EmailAction {
  private snapshot: { busy: boolean; error: string | null } = { busy: false, error: null }
  private readonly listeners = new Set<() => void>()
  private active = false
  private inFlight = false
  private settlement: (() => void) | null = null

  constructor(private readonly failure: string) {}

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    this.active = true
    this.reconcile()
  }

  dispose(): void {
    this.active = false
  }

  async run<T>(write: () => Promise<T>, commit: (value: T) => void): Promise<void> {
    if (!this.active || this.inFlight) return
    this.inFlight = true
    this.publish({ busy: true, error: null })
    try {
      const value = await write()
      this.settlement = () => commit(value)
    } catch (error) {
      const message = emailFailureMessage(error, this.failure)
      this.settlement = () => this.publish({ busy: true, error: message })
    }
    this.reconcile()
  }

  private reconcile(): void {
    if (!this.active || !this.settlement) return
    // Activity pauses effects without canceling the physical mutation or its receipt.
    const settle = this.settlement
    this.settlement = null
    try {
      settle()
    } catch (error) {
      this.publish({ busy: true, error: emailFailureMessage(error, this.failure) })
    } finally {
      this.inFlight = false
      this.publish({ ...this.snapshot, busy: false })
    }
  }

  private publish(snapshot: { busy: boolean; error: string | null }): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
