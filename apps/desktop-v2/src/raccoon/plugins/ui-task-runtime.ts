import {
  PluginUiTaskResultSchema,
  type PluginUiNotice,
  type PluginUiTask,
  type PluginUiView,
} from '@nexus/plugin-sdk/ui'
import { pluginUiIdentity, type PluginUiTarget } from './ui-session.ts'
import { uiClock, type UiClock } from './ui-clock.ts'
import type { PluginView } from './types.ts'

export type PluginUiTaskRequest = PluginUiTarget & {
  taskId: string
  operation: 'poll' | 'cancel'
}

type RunningTask = {
  key: string
  target: PluginUiTarget
  task: PluginUiTask
  startedAt: number
  inFlight: boolean
  failed: boolean
  pollTimer?: ReturnType<typeof setTimeout>
  deadlineTimer?: ReturnType<typeof setTimeout>
}
type TaskControllerOptions = {
  rpc: (input: PluginUiTaskRequest) => Promise<unknown>
  notice: (target: PluginUiTarget, notice: PluginUiNotice) => void
  error?: (message: string) => void
  clock?: UiClock
  maxTasks?: number
}

const targetKey = (target: PluginUiTarget) =>
  JSON.stringify([
    target.pluginId,
    target.identity,
    target.connectionId,
    target.profileId,
    target.viewId,
  ])
const cancellationKey = (target: PluginUiTarget, taskId: string) =>
  JSON.stringify([target.pluginId, target.identity, taskId])

/** Owns app-lifetime tasks. Closing a view does not release its work. */
export class PluginUiTaskController {
  private readonly clock: UiClock
  private readonly tasks = new Map<string, RunningTask>()
  private readonly registered = new Set<string>()
  private readonly cancelled = new Set<string>()
  private readonly notices = new Set<string>()
  private catalog: Map<string, string> | null = null
  private active = true
  private readonly options: TaskControllerOptions

  constructor(options: TaskControllerOptions) {
    this.options = options
    this.clock = options.clock ?? uiClock
  }

  setCatalog(plugins: readonly PluginView[]) {
    this.catalog = new Map(
      plugins
        .filter((plugin) => plugin.enabled && plugin.state === 'running')
        .map((plugin) => [plugin.id, pluginUiIdentity(plugin)]),
    )
    for (const record of this.tasks.values()) {
      if (!this.current(record.target)) this.finish(record, true)
    }
  }

  observe = (target: PluginUiTarget, view: PluginUiView) => {
    if (!this.current(target)) return
    this.cancel(target, view.cancelledTasks)
    for (const notice of view.notices) this.notify(target, notice)
    for (const task of view.tasks) {
      if (this.cancelled.has(cancellationKey(target, task.id))) continue
      const key = `${targetKey(target)}:${task.id}`
      const registrationKey = cancellationKey(target, task.id)
      if (this.registered.has(registrationKey)) continue
      this.registered.add(registrationKey)
      if (this.tasks.size >= (this.options.maxTasks ?? 64)) {
        this.sendCancel(target, task.id)
        this.options.error?.('插件后台任务数量已达上限，请稍后重试')
        continue
      }
      const record: RunningTask = {
        key,
        target: { ...target },
        task,
        startedAt: this.clock.now(),
        inFlight: false,
        failed: false,
      }
      this.tasks.set(key, record)
      if (this.clock.now() >= task.deadlineAt) {
        this.timeout(record)
        continue
      }
      record.deadlineTimer = this.clock.setTimeout(
        () => this.timeout(record),
        task.deadlineAt - this.clock.now(),
      )
      void this.poll(record)
    }
  }

  cancel = (target: PluginUiTarget, ids: readonly string[]) => {
    if (!this.current(target) || !ids.length) return
    const taskIds = new Set(ids)
    for (const id of taskIds) this.cancelled.add(cancellationKey(target, id))
    for (const record of this.tasks.values()) {
      if (
        record.target.pluginId === target.pluginId &&
        record.target.identity === target.identity &&
        taskIds.has(record.task.id)
      )
        this.finish(record, true)
    }
  }

  private current(target: PluginUiTarget) {
    return (
      this.active &&
      (!this.catalog || this.catalog.get(target.pluginId) === target.identity)
    )
  }

  private live(record: RunningTask) {
    return this.tasks.get(record.key) === record && this.current(record.target)
  }

  private notify(target: PluginUiTarget, notice: PluginUiNotice) {
    if (!this.current(target)) return
    const key = JSON.stringify([target.pluginId, target.identity, notice.id])
    if (this.notices.has(key)) return
    this.notices.add(key)
    this.options.notice(target, notice)
  }

  private sendCancel(target: PluginUiTarget, taskId: string) {
    void this.options.rpc({ ...target, taskId, operation: 'cancel' }).catch(() => {})
  }

  private finish(record: RunningTask, cancel: boolean) {
    if (this.tasks.get(record.key) !== record) return
    this.tasks.delete(record.key)
    if (record.pollTimer !== undefined) this.clock.clearTimeout(record.pollTimer)
    if (record.deadlineTimer !== undefined) this.clock.clearTimeout(record.deadlineTimer)
    if (cancel) this.sendCancel(record.target, record.task.id)
  }

  private timeout(record: RunningTask) {
    if (!this.live(record)) return
    this.finish(record, true)
    this.notify(record.target, record.task.timeoutNotice)
  }

  private schedule(record: RunningTask) {
    if (!this.live(record)) return
    const now = this.clock.now()
    const elapsed = Math.max(0, now - record.startedAt)
    const next =
      record.startedAt +
      (Math.floor(elapsed / record.task.pollIntervalMs) + 1) * record.task.pollIntervalMs
    record.pollTimer = this.clock.setTimeout(
      () => {
        record.pollTimer = undefined
        if (this.clock.now() >= record.task.deadlineAt) this.timeout(record)
        else void this.poll(record)
      },
      Math.max(0, next - now),
    )
  }

  private async poll(record: RunningTask) {
    if (!this.live(record) || record.inFlight) return
    if (this.clock.now() >= record.task.deadlineAt) {
      this.timeout(record)
      return
    }
    record.inFlight = true
    // The next tick belongs to the start-time cadence, even during a slow RPC.
    this.schedule(record)
    try {
      const raw = await this.options.rpc({
        ...record.target,
        taskId: record.task.id,
        operation: 'poll',
      })
      if (!this.live(record)) return
      if (this.clock.now() >= record.task.deadlineAt) {
        this.timeout(record)
        return
      }
      const result = PluginUiTaskResultSchema.parse(raw)
      if (result.state === 'done') this.finish(record, false)
      for (const notice of result.notices) this.notify(record.target, notice)
    } catch {
      if (!this.live(record)) return
      if (this.clock.now() >= record.task.deadlineAt) this.timeout(record)
      else if (!record.failed) {
        record.failed = true
        this.options.error?.('插件任务暂时无法读取，将继续等待至截止时间')
      }
    } finally {
      record.inFlight = false
      // A cadence tick skipped while busy schedules the following tick.
      if (this.live(record) && record.pollTimer === undefined) this.schedule(record)
    }
  }

  dispose() {
    this.active = false
    for (const record of this.tasks.values()) this.finish(record, true)
    this.registered.clear()
    this.cancelled.clear()
    this.notices.clear()
  }
}
