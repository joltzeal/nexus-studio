import type { EmailAuthorizationChallenge, EmailAuthorizationResult } from './model.ts'

type AuthorizationApi = {
  startAuthorization: (id: string, email: string) => Promise<EmailAuthorizationChallenge>
  pollAuthorization: (
    authorizationId: string,
    accountId: string,
  ) => Promise<EmailAuthorizationResult>
  cancelAuthorization: (id: string) => Promise<unknown>
}
type Schedule = (run: () => void, delay: number) => () => void

export function startAuthorizationSession(
  api: AuthorizationApi,
  mailbox: { id: string; email: string },
  events: {
    challenge: (challenge: EmailAuthorizationChallenge) => void
    state: (state: EmailAuthorizationResult) => void
    error: (message: string) => void
  },
  schedule: Schedule = (run, delay) => {
    const timer = setTimeout(run, delay)
    return () => clearTimeout(timer)
  },
) {
  let active = true
  let challenge: EmailAuthorizationChallenge | null = null
  let cancelTimer: (() => void) | null = null
  let terminal = false
  const cancel = (id: string) => {
    void api.cancelAuthorization(id).catch(() => {})
  }
  async function poll() {
    if (!active || !challenge || terminal) return
    if (Date.now() >= Date.parse(challenge.expiresAt)) {
      terminal = true
      events.state({ status: 'expired' })
      cancel(challenge.authorizationId)
      return
    }
    try {
      const state = await api.pollAuthorization(challenge.authorizationId, mailbox.id)
      if (!active) return
      events.state(state)
      if (state.status === 'pending')
        cancelTimer = schedule(() => void poll(), state.retryAfterSeconds * 1000)
      else terminal = true
    } catch {
      if (active) {
        events.error('授权状态检查失败，稍后自动重试；可关闭后重新授权。')
        cancelTimer = schedule(
          () => void poll(),
          Math.max(challenge.intervalSeconds, 5) * 1000,
        )
      }
    }
  }
  void api.startAuthorization(mailbox.id, mailbox.email).then(
    (value) => {
      challenge = value
      if (!active) {
        cancel(value.authorizationId)
        return
      }
      events.challenge(value)
      cancelTimer = schedule(() => void poll(), value.intervalSeconds * 1000)
    },
    () => {
      if (active) events.error('授权启动失败，请关闭后重新尝试。')
    },
  )
  return () => {
    active = false
    cancelTimer?.()
    if (challenge && !terminal) cancel(challenge.authorizationId)
  }
}
