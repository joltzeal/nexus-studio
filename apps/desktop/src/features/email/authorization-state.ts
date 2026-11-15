import { EmailRequestError } from './errors'
import type {
  EmailAuthorizationChallenge,
  EmailAuthorizationResult,
  MailboxView,
} from './types'

interface AuthorizationApi {
  start(accountId: string, expectedEmail: string): Promise<EmailAuthorizationChallenge>
  poll(authorizationId: string, accountId: string): Promise<EmailAuthorizationResult>
  cancel(authorizationId: string): Promise<void>
}
interface AuthorizationSnapshot {
  phase: 'idle' | 'starting' | 'waiting' | 'failed' | 'authorized'
  challenge: EmailAuthorizationChallenge | null
  account: MailboxView | null
  checking: boolean
  error: string | null
}

export class EmailAuthorizationStore {
  private snapshot: AuthorizationSnapshot = {
    phase: 'idle',
    challenge: null,
    account: null,
    checking: false,
    error: null,
  }
  private readonly listeners = new Set<() => void>()
  private active = false
  private closed = false
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private notified = false
  private onAuthorized: ((account: MailboxView) => void) | undefined

  constructor(
    private readonly account: Pick<MailboxView, 'id' | 'email'>,
    private readonly api: AuthorizationApi,
  ) {}

  getSnapshot = (): AuthorizationSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  setOnAuthorized(callback: (account: MailboxView) => void): void {
    this.onAuthorized = callback
  }
  activate(): void {
    if (this.closed || this.active) return
    this.active = true
    this.notify()
    if (this.snapshot.phase === 'waiting' && !this.snapshot.checking)
      this.schedule(this.snapshot.challenge?.intervalSeconds ?? 5)
  }
  pause(): void {
    this.active = false
    clearTimeout(this.timer)
  }
  cancel = (): void => {
    if (this.closed) return
    this.closed = true
    this.revision += 1
    this.pause()
    const challenge = this.snapshot.challenge
    if (challenge) void this.api.cancel(challenge.authorizationId).catch(() => {})
  }

  begin = async (): Promise<void> => {
    if (
      !this.active ||
      this.closed ||
      this.snapshot.phase === 'starting' ||
      this.snapshot.checking
    )
      return
    const revision = ++this.revision
    clearTimeout(this.timer)
    this.publish({ phase: 'starting', challenge: null, error: null })
    try {
      const challenge = await this.api.start(this.account.id, this.account.email)
      if (this.closed || revision !== this.revision) {
        void this.api.cancel(challenge.authorizationId).catch(() => {})
        return
      }
      this.publish({ phase: 'waiting', challenge })
      this.schedule(challenge.intervalSeconds)
    } catch (error) {
      if (this.closed || revision !== this.revision) return
      this.publish({
        phase: 'failed',
        error:
          error instanceof EmailRequestError
            ? '微软未允许此 Client ID 请求写权限。请按下方步骤检查应用与租户设置，或联系应用所有者。'
            : '无法启动微软授权。请确认邮箱插件至少为 1.2.0，并检查公共客户端配置和应用代理。',
      })
    }
  }

  retry = async (): Promise<void> => {
    if (!this.active || this.closed || this.snapshot.checking || !this.snapshot.challenge)
      return
    clearTimeout(this.timer)
    const revision = this.revision
    const id = this.snapshot.challenge.authorizationId
    this.publish({ checking: true, error: null })
    try {
      const result = await this.api.poll(id, this.account.id)
      if (this.closed || revision !== this.revision) return
      if (result.status === 'authorized') {
        this.publish({ phase: 'authorized', account: result.account })
        this.notify()
      } else if (result.status === 'pending') {
        this.publish({ phase: 'waiting' })
        this.schedule(result.retryAfterSeconds)
      } else {
        const messages = {
          denied:
            '微软未授予所需写权限，原凭据保持不变。请检查下方应用/租户设置，或联系应用所有者。',
          expired: '授权码已过期，原凭据保持不变。请重新开始授权。',
          'account-mismatch':
            '登录的微软邮箱与当前邮箱不一致，未替换凭据。请使用当前邮箱的主地址登录；别名无法核对时请联系应用所有者。',
        }
        this.publish({ phase: 'failed', error: messages[result.status] })
      }
    } catch {
      if (this.closed || revision !== this.revision) return
      this.publish({
        error:
          '授权检查或凭据保存失败，原凭据仍保留。可重试检查，不必重复登录；已取得的新凭据会先重试保存。',
      })
    } finally {
      if (!this.closed && revision === this.revision) this.publish({ checking: false })
    }
  }

  private schedule(seconds: number): void {
    clearTimeout(this.timer)
    if (!this.active || this.closed) return
    this.timer = setTimeout(() => void this.retry(), seconds * 1000)
  }
  private notify(): void {
    if (this.active && !this.notified && this.snapshot.account) {
      this.notified = true
      this.onAuthorized?.(this.snapshot.account)
    }
  }
  private publish(patch: Partial<AuthorizationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}
