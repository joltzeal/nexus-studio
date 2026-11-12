import { emailFailureMessage } from './errors'

export interface EmailResourceSnapshot<P, T> {
  params: P
  value: T | null
  loading: boolean
  error: string | null
}

/**
 * A lane owns one physical RPC. Changing scope invalidates its result immediately,
 * then starts only the latest requested scope after the old RPC settles.
 */
export class EmailResource<P, T> {
  private snapshot: EmailResourceSnapshot<P, T>
  private readonly listeners = new Set<() => void>()
  private active = false
  private inFlight = false
  private pending = false
  private revision = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    params: P,
    private readonly load: (params: P) => Promise<T>,
    private readonly failure: string,
  ) {
    this.snapshot = { params, value: null, loading: true, error: null }
  }

  getSnapshot = (): EmailResourceSnapshot<P, T> => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(pollMs?: number): void {
    if (this.active) return
    this.active = true
    this.pending = true
    if (pollMs !== undefined) this.timer = setInterval(() => this.refresh(), pollMs)
    this.drain()
  }

  dispose(): void {
    this.active = false
    this.pending = false
    this.revision += 1
    clearInterval(this.timer)
    this.timer = undefined
  }

  select(params: P): void {
    this.revision += 1
    this.pending = true
    this.publish({ params, value: null, loading: true, error: null })
    this.drain()
  }

  refresh = (): void => {
    if (!this.active || this.inFlight) return
    this.pending = true
    this.drain()
  }

  invalidate(): void {
    this.revision += 1
    this.pending = true
    this.drain()
  }

  private publish(snapshot: EmailResourceSnapshot<P, T>): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  private drain(): void {
    if (!this.active || this.inFlight || !this.pending) return
    this.pending = false
    this.inFlight = true
    const revision = this.revision
    const params = this.snapshot.params
    this.publish({ ...this.snapshot, loading: true })
    void this.read(params, revision)
  }

  private async read(params: P, revision: number): Promise<void> {
    try {
      const value = await this.load(params)
      if (this.active && revision === this.revision) {
        this.publish({ params, value, loading: false, error: null })
      }
    } catch (error) {
      if (this.active && revision === this.revision) {
        this.publish({
          ...this.snapshot,
          loading: false,
          error: emailFailureMessage(error, this.failure),
        })
      }
    } finally {
      this.inFlight = false
      this.drain()
    }
  }
}
