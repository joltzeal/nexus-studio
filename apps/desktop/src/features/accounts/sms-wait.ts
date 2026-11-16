export interface SmsWaitTarget {
  accountId: string
  accountName: string
  windowId: string
  windowName: string
  phone: string
  smsOtpUrl: string
}

export interface EmailWaitTarget {
  accountId: string
  accountName: string
  windowId: string
  windowName: string
  mailboxId: string
  mailboxEmail: string
  startedAt: number
}

export interface SmsWaitState {
  accountId: string
  expiresAt: number
  lastError: string | null
}

export type SmsWaitRead = { code: string | null } | { stopped: string }

interface SmsWaitOptions<T extends SmsWaitTarget | EmailWaitTarget> {
  read: (target: T, signal: AbortSignal) => Promise<SmsWaitRead>
  received: (target: T, code: string) => void
  expired: (target: T, lastError: string | null) => void
  invalidated: (target: T, reason: string) => void
}

interface Task<T extends SmsWaitTarget | EmailWaitTarget> {
  target: T
  state: SmsWaitState
  abort: AbortController
  pollTimer: ReturnType<typeof setInterval>
  deadlineTimer: ReturnType<typeof setTimeout>
}

export class SmsWaitManager<T extends SmsWaitTarget | EmailWaitTarget = SmsWaitTarget> {
  private readonly tasks = new Map<string, Task<T>>()
  private readonly reading = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly SmsWaitState[] = []

  constructor(private readonly options: SmsWaitOptions<T>) {}

  getSnapshot = (): readonly SmsWaitState[] => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(target: T): boolean {
    const contact =
      'mailboxId' in target
        ? [target.mailboxId, target.mailboxEmail]
        : [target.phone, target.smsOtpUrl]
    if (![target.accountId, target.windowId, ...contact].every((value) => value.trim())) {
      throw new Error(
        'mailboxId' in target
          ? '请先为账号关联邮箱。'
          : '请先关联账号，并保存手机号和短信接码链接。',
      )
    }
    const existing = this.tasks.get(target.accountId)
    if (existing && this.current(existing)) return false
    const task: Task<T> = {
      target: { ...target },
      state: {
        accountId: target.accountId,
        expiresAt: Date.now() + 300000,
        lastError: null,
      },
      abort: new AbortController(),
      deadlineTimer: setTimeout(() => this.expire(task), 300000),
      pollTimer: setInterval(() => void this.poll(task), 5000),
    }
    this.tasks.set(target.accountId, task)
    this.emit()
    void this.poll(task)
    return true
  }

  stop(accountId: string): void {
    const task = this.tasks.get(accountId)
    if (!task) return
    clearInterval(task.pollTimer)
    clearTimeout(task.deadlineTimer)
    task.abort.abort()
    this.tasks.delete(accountId)
    this.emit()
  }

  stopAll(): void {
    for (const accountId of this.tasks.keys()) this.stop(accountId)
  }

  stopWindow(windowId: string): void {
    for (const [accountId, task] of this.tasks) {
      if (task.target.windowId === windowId) this.stop(accountId)
    }
  }

  private emit() {
    this.snapshot = Array.from(this.tasks.values(), (task) => ({ ...task.state }))
    for (const listener of this.listeners) listener()
  }

  private expire(task: Task<T>) {
    if (this.tasks.get(task.target.accountId) !== task) return
    this.stop(task.target.accountId)
    this.options.expired(task.target, task.state.lastError)
  }

  private current(task: Task<T>): boolean {
    if (this.tasks.get(task.target.accountId) !== task) return false
    if (Date.now() >= task.state.expiresAt) {
      this.expire(task)
      return false
    }
    return true
  }

  private async poll(task: Task<T>) {
    const id = task.target.accountId
    if (!this.current(task) || this.reading.has(id)) return
    // A cancelled RPC may still be settling; restarting must not overlap it.
    this.reading.add(id)
    try {
      const result = await this.options.read(task.target, task.abort.signal)
      if (!this.current(task)) return
      if ('stopped' in result) {
        this.stop(id)
        this.options.invalidated(task.target, result.stopped)
        return
      }
      if (result.code !== null) {
        if (
          !('mailboxId' in task.target ? /^\d{6}$/ : /^(?:\d{4}|\d{6})$/).test(
            result.code,
          )
        ) {
          throw new Error('没有返回有效的验证码。')
        }
        this.stop(id)
        this.options.received(task.target, result.code)
      } else if (task.state.lastError !== null) {
        task.state.lastError = null
        this.emit()
      }
    } catch (cause) {
      if (!this.current(task)) return
      task.state.lastError =
        cause instanceof Error
          ? cause.message
          : typeof cause === 'string'
            ? cause
            : '读取验证码失败，下次自动重试。'
      this.emit()
    } finally {
      this.reading.delete(id)
    }
  }
}
