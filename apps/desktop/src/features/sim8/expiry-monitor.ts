import { expiryApi } from './expiry-api'
import { message, type ExpiryReminder, type ExpirySnapshot } from './types'

export type ExpiryAvailability = 'hidden' | 'upgrade' | 'ready' | 'unavailable'
export interface ExpiryMonitorState {
  availability: ExpiryAvailability
  snapshot: ExpirySnapshot | null
  checking: boolean
  dismissing: string[]
  error: string | null
}

export const EMPTY_EXPIRY_STATE: ExpiryMonitorState = {
  availability: 'hidden',
  snapshot: null,
  checking: false,
  dismissing: [],
  error: null,
}

export class NumberExpiryMonitor {
  state = EMPTY_EXPIRY_STATE
  private generation = 0
  private revision = 0
  private polling = false
  private identity = ''

  constructor(
    private readonly changed: (state: ExpiryMonitorState) => void,
    private readonly api: typeof expiryApi = expiryApi,
  ) {}

  private patch(patch: Partial<ExpiryMonitorState>) {
    this.state = { ...this.state, ...patch }
    this.changed(this.state)
  }

  setAvailability(availability: ExpiryAvailability, identity: string = availability) {
    if (identity === this.identity && availability === this.state.availability) return
    this.generation += 1
    this.identity = identity
    this.polling = false
    this.patch({ ...EMPTY_EXPIRY_STATE, availability })
    if (availability === 'ready') void this.refresh()
  }

  async refresh(): Promise<void> {
    if (this.state.availability !== 'ready' || this.polling) return
    const generation = this.generation
    const active = () =>
      generation === this.generation && this.state.availability === 'ready'
    this.polling = true
    this.patch({ checking: true })
    const accept = (snapshot: ExpirySnapshot, revision: number) => {
      // A poll begun before a dismissal must never restore that dismissed row.
      if (active() && revision === this.revision && this.state.dismissing.length === 0) {
        this.patch({ snapshot, error: null })
      }
    }
    try {
      let revision = this.revision
      let snapshot = await this.api.list()
      accept(snapshot, revision)
      for (
        let batch = 0;
        active() && snapshot.pendingTels.length > 0 && batch < 250;
        batch += 1
      ) {
        revision = this.revision
        snapshot = await this.api.refresh(snapshot.pendingTels)
        accept(snapshot, revision)
      }
    } catch (error) {
      if (active()) this.patch({ error: message(error) })
    } finally {
      if (active()) {
        this.polling = false
        this.patch({ checking: false })
      }
    }
  }

  async dismiss(item: ExpiryReminder): Promise<void> {
    if (this.state.availability !== 'ready' || this.state.dismissing.length > 0) return
    const generation = this.generation
    this.revision += 1
    this.patch({ dismissing: [item.tel], error: null })
    try {
      const snapshot = await this.api.dismiss(item.tel, item.expiresAt)
      if (generation === this.generation) this.patch({ snapshot })
    } catch (error) {
      if (generation === this.generation) this.patch({ error: message(error) })
    } finally {
      if (generation === this.generation) {
        this.revision += 1
        this.patch({ dismissing: [] })
      }
    }
  }

  stop() {
    this.generation += 1
    this.identity = ''
    this.polling = false
    this.state = EMPTY_EXPIRY_STATE
  }
}
