import { createContext, use, useEffect, useState } from 'react'
import { PluginPageLifetimeContext } from '../../../raccoon/plugins/page-lifetime'
import { RequestScope } from './state'

export const AgentConnection = createContext<string | null>(null)
export function useAgentConnection() {
  const connectionId = use(AgentConnection)
  if (!connectionId) throw new Error('请先选择 Workspace。')
  return connectionId
}

export function useAgentRequestScope() {
  const lifetime = use(PluginPageLifetimeContext)
  const [scope] = useState(() => new RequestScope())
  useEffect(
    () => (lifetime ? lifetime.register(scope) : () => scope.invalidate()),
    [lifetime, scope],
  )
  return scope
}
