import { createContext } from 'react'

type RequestScope = { invalidate: () => void }

export class PluginPageLifetime {
  visible: boolean
  private readonly scopes = new Map<RequestScope, symbol>()

  constructor(visible: boolean) {
    this.visible = visible
  }

  register(scope: RequestScope) {
    const registration = Symbol()
    this.scopes.set(scope, registration)
    return () => {
      if (!this.visible) return
      queueMicrotask(() => {
        if (this.scopes.get(scope) !== registration) return
        this.scopes.delete(scope)
        scope.invalidate()
      })
    }
  }

  dispose() {
    for (const scope of this.scopes.keys()) scope.invalidate()
    this.scopes.clear()
  }
}

export const PluginPageLifetimeContext = createContext<PluginPageLifetime | null>(null)
