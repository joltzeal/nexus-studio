import {
  PluginUiProfileStatusSchema,
  type PluginUiProfileStatus,
} from '@nexus/plugin-sdk/ui'
import { uiClock, type UiClock } from './ui-clock.ts'
import { pluginUiIdentity } from './ui-session.ts'
import type { PluginView } from './types.ts'

export type PluginUiProfileTarget = {
  pluginId: string
  viewId: string
  connectionId: string
  identity: string
}
export type PluginUiProfilesRequest = PluginUiProfileTarget & { profileIds: string[] }
type ProfileStatus = PluginUiProfileStatus['items'][number]
type Group = {
  key: string
  target: PluginUiProfileTarget
  profiles: Map<string, number>
  statuses: Map<string, ProfileStatus>
  eligible: boolean
  inFlight: boolean
  generation: number
  timer?: ReturnType<typeof setTimeout>
}
type ProfileStatusOptions = {
  rpc: (input: PluginUiProfilesRequest) => Promise<unknown>
  clock?: UiClock
}
const scopeKey = (target: PluginUiProfileTarget) =>
  JSON.stringify([target.pluginId, target.viewId, target.connectionId, target.identity])

/** Shared polling for mounted, visible Profile entry points. */
export class PluginUiProfileStatusController {
  private readonly groups = new Map<string, Group>()
  private readonly listeners = new Set<() => void>()
  private readonly clock: UiClock
  private catalog = new Map<string, string>()
  private readonly options: ProfileStatusOptions

  constructor(options: ProfileStatusOptions) {
    this.options = options
    this.clock = options.clock ?? uiClock
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot = (target: PluginUiProfileTarget, profileId: string) =>
    this.groups.get(scopeKey(target))?.statuses.get(profileId) ?? null

  private publish() {
    for (const listener of this.listeners) listener()
  }

  private eligible(target: PluginUiProfileTarget) {
    return (
      this.catalog.get(target.pluginId) ===
      JSON.stringify([target.identity, target.viewId])
    )
  }

  setCatalog(plugins: readonly PluginView[], valid = true) {
    this.catalog = new Map(
      (valid ? plugins : []).flatMap((plugin) => {
        const entry = plugin.ui?.profileTable
        if (
          !plugin.enabled ||
          plugin.state !== 'running' ||
          !entry ||
          !plugin.granted.includes(entry.capability) ||
          !plugin.methods.includes('ui.profile.status')
        )
          return []
        return [[plugin.id, JSON.stringify([pluginUiIdentity(plugin), entry.viewId])]]
      }),
    )
    for (const group of this.groups.values()) {
      const eligible = this.eligible(group.target)
      if (group.eligible === eligible) continue
      group.eligible = eligible
      group.generation++
      if (group.timer !== undefined) this.clock.clearTimeout(group.timer)
      group.timer = undefined
      group.statuses.clear()
      if (eligible) this.schedule(group, 0)
    }
    this.publish()
  }

  watch(target: PluginUiProfileTarget, profileId: string) {
    const key = scopeKey(target)
    let group = this.groups.get(key)
    if (!group) {
      group = {
        key,
        target: {
          pluginId: target.pluginId,
          viewId: target.viewId,
          connectionId: target.connectionId,
          identity: target.identity,
        },
        profiles: new Map(),
        statuses: new Map(),
        eligible: this.eligible(target),
        inFlight: false,
        generation: 0,
      }
      this.groups.set(key, group)
    }
    const current = group
    const count = current.profiles.get(profileId) ?? 0
    current.profiles.set(profileId, count + 1)
    if (!count) {
      current.generation++
      if (!current.inFlight) this.schedule(current, 0)
    }
    let watching = true
    return () => {
      if (!watching) return
      watching = false
      const count = current.profiles.get(profileId) ?? 0
      if (count > 1) current.profiles.set(profileId, count - 1)
      else {
        current.profiles.delete(profileId)
        current.statuses.delete(profileId)
        current.generation++
      }
      if (!current.profiles.size) {
        if (current.timer !== undefined) this.clock.clearTimeout(current.timer)
        current.timer = undefined
        // Preserve the request lock across rapid row/header remounts.
        if (!current.inFlight && this.groups.get(key) === current) this.groups.delete(key)
      }
      this.publish()
    }
  }

  private live(group: Group) {
    return (
      this.groups.get(group.key) === group && group.eligible && group.profiles.size > 0
    )
  }

  private schedule(group: Group, delay: number) {
    if (!this.live(group)) return
    if (group.timer !== undefined) this.clock.clearTimeout(group.timer)
    group.timer = this.clock.setTimeout(() => {
      group.timer = undefined
      void this.poll(group)
    }, delay)
  }

  private async poll(group: Group) {
    if (!this.live(group) || group.inFlight) return
    group.inFlight = true
    const generation = group.generation
    const profileIds = [...group.profiles.keys()]
    try {
      const statuses: ProfileStatus[] = []
      for (let offset = 0; offset < profileIds.length; offset += 200) {
        if (!this.live(group) || generation !== group.generation) return
        const batch = profileIds.slice(offset, offset + 200)
        const response = PluginUiProfileStatusSchema.parse(
          await this.options.rpc({ ...group.target, profileIds: batch }),
        )
        const requested = new Set(batch)
        if (response.items.some((item) => !requested.has(item.profileId)))
          throw new Error('Invalid Profile scope')
        statuses.push(...response.items)
      }
      if (!this.live(group) || generation !== group.generation) return
      group.statuses = new Map(statuses.map((item) => [item.profileId, item]))
      this.publish()
    } catch {
      if (!this.live(group) || generation !== group.generation) return
      group.statuses.clear()
      this.publish()
    } finally {
      group.inFlight = false
      if (this.live(group))
        this.schedule(group, generation === group.generation ? 5000 : 0)
      else if (!group.profiles.size && this.groups.get(group.key) === group)
        this.groups.delete(group.key)
    }
  }

  dispose() {
    for (const group of this.groups.values()) {
      if (group.timer !== undefined) this.clock.clearTimeout(group.timer)
    }
    this.groups.clear()
    this.publish()
  }
}
