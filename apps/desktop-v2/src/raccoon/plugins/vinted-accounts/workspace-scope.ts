export type ScopeToken = { connectionId: string | null; generation: number }
export type AccountTransient = {
  selected: string[]
  dialog: 'create' | 'edit' | 'import' | null
}

export class WorkspaceScope {
  private generation = 0
  private state: AccountTransient = { selected: [], dialog: null }
  connectionId: string | null
  constructor(connectionId: string | null) {
    this.connectionId = connectionId
  }
  get transient(): AccountTransient {
    return this.state
  }
  setTransient(value: AccountTransient) {
    this.state = value
  }
  begin(): ScopeToken {
    return { connectionId: this.connectionId, generation: this.generation }
  }
  current(token: ScopeToken) {
    return (
      token.connectionId === this.connectionId && token.generation === this.generation
    )
  }
  switchTo(connectionId: string | null) {
    if (connectionId === this.connectionId) return
    this.connectionId = connectionId
    this.generation++
    this.state = { selected: [], dialog: null }
  }
  invalidate() {
    this.generation++
    this.state = { selected: [], dialog: null }
  }
  async guard<T, R>(
    token: ScopeToken,
    operation: Promise<T>,
    apply: (value: T) => R,
  ): Promise<R | null> {
    const value = await operation
    return this.current(token) ? apply(value) : null
  }
}
