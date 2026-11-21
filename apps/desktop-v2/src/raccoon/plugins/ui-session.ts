import { PluginUiViewSchema, type PluginUiView } from '@nexus/plugin-sdk/ui'
import type { PluginView } from './types'

export const pluginUiIdentity = (plugin: PluginView) =>
  `${plugin.installation ?? ''}:${plugin.runtimeGeneration ?? ''}`

export type PluginUiTarget = {
  pluginId: string
  viewId: string
  profileId: string
  connectionId: string
  identity: string
}
export type PluginUiRequest = Omit<PluginUiTarget, 'identity'> & {
  operation: 'open' | 'dispatch' | 'close'
  sessionId?: string
  revision?: string
  actionId?: string
  values?: Record<string, string>
}
type Snapshot = {
  target: PluginUiTarget | null
  sessionId: string | null
  view: PluginUiView | null
  busy: boolean
  error: string | null
}

export class PluginUiSession {
  private generation = 0
  private state: Snapshot = {
    target: null,
    sessionId: null,
    view: null,
    busy: false,
    error: null,
  }
  private readonly listeners = new Set<() => void>()
  private readonly rpc: (input: PluginUiRequest) => Promise<unknown>
  private readonly onView: (target: PluginUiTarget, view: PluginUiView) => void
  constructor(
    rpc: (input: PluginUiRequest) => Promise<unknown>,
    onView: (target: PluginUiTarget, view: PluginUiView) => void = () => {},
  ) {
    this.rpc = rpc
    this.onView = onView
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private request(
    target: PluginUiTarget,
    operation: PluginUiRequest['operation'],
    extra: Partial<PluginUiRequest> = {},
  ): PluginUiRequest {
    const { identity: _identity, ...scope } = target
    return { ...scope, operation, ...extra }
  }
  private release(target: PluginUiTarget, sessionId: string) {
    void this.rpc(this.request(target, 'close', { sessionId })).catch(() => {})
  }
  close = () => {
    const { target, sessionId } = this.state
    this.generation++
    if (target && sessionId) this.release(target, sessionId)
    this.publish({ target: null, sessionId: null, view: null, busy: false, error: null })
  }
  async open(target: PluginUiTarget) {
    this.close()
    const generation = this.generation
    this.publish({ target, busy: true })
    let sessionId: string | null = null
    try {
      const raw = await this.rpc(this.request(target, 'open'))
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof (raw as { sessionId?: unknown }).sessionId !== 'string'
      )
        throw new Error('Invalid session')
      sessionId = (raw as { sessionId: string }).sessionId
      if (generation !== this.generation) {
        this.release(target, sessionId)
        return
      }
      const view = PluginUiViewSchema.parse((raw as { view?: unknown }).view)
      this.publish({ sessionId, view, busy: false, error: null })
      this.onView(target, view)
    } catch {
      if (sessionId) this.release(target, sessionId)
      if (generation === this.generation)
        this.publish({ busy: false, error: '插件面板读取失败，请重新打开' })
    }
  }
  async dispatch(actionId: string, values: Record<string, string>): Promise<boolean> {
    const { target, sessionId, view, busy } = this.state
    if (!target || !sessionId || !view || busy) return false
    const generation = this.generation
    this.publish({ busy: true, error: null })
    try {
      const raw = await this.rpc(
        this.request(target, 'dispatch', {
          sessionId,
          revision: view.revision,
          actionId,
          values,
        }),
      )
      if (generation !== this.generation) return false
      if (
        !raw ||
        typeof raw !== 'object' ||
        (raw as { sessionId?: unknown }).sessionId !== sessionId
      )
        throw new Error('Invalid session')
      const next = PluginUiViewSchema.parse((raw as { view?: unknown }).view)
      this.publish({ view: next, busy: false })
      this.onView(target, next)
      return true
    } catch {
      if (generation === this.generation)
        this.publish({
          busy: false,
          error: '插件操作失败，保留了当前输入，可重新读取后重试',
        })
      return false
    }
  }
}
