type AuthorizationFailure = 'AUTH_FAILED' | 'PERMISSION_DENIED'

export function authorizationFailureMessage(code: string | null): string | null {
  if (code === 'AUTH_FAILED') return '邮箱授权已失效或被撤销，请编辑邮箱并更新授权凭据。'
  if (code === 'PERMISSION_DENIED')
    return '缺少所选通道的收信权限，请重新授权，或改用已获授权的通道。'
  return null
}

export class EmailRequestError extends Error {
  constructor(readonly code: AuthorizationFailure) {
    super(authorizationFailureMessage(code)!)
    this.name = 'EmailRequestError'
  }
}

export function emailFailureMessage(error: unknown, fallback: string): string {
  return error instanceof EmailRequestError
    ? (authorizationFailureMessage(error.code) ?? fallback)
    : fallback
}

export function readStateFailureMessage(code: string | null): string {
  if (code === 'PERMISSION_DENIED')
    return '缺少修改已读状态的权限，请重新授予写入权限；邮件仍可阅读，未成功的邮件状态保持不变。'
  return (
    authorizationFailureMessage(code) ??
    '已读状态未更新，请重试。未成功的邮件状态保持不变。'
  )
}
