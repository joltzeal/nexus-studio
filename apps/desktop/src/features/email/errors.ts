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
    return '缺少修改已读状态的权限，请编辑授权或选择已获授权的通道；邮件仍可阅读，未成功的邮件状态保持不变。'
  return (
    authorizationFailureMessage(code) ??
    '已读状态未更新，请重试。未成功的邮件状态保持不变。'
  )
}
import type { MailTransport } from './types'

export function mailTransportPermissionMessage(transport: MailTransport): string {
  return transport === 'graph'
    ? 'Graph 修改已读/未读需要此 Client ID 已获 Mail.ReadWrite 委托权限；仅有 Mail.Read 可以阅读，刷新 token 或重新导入不能增加授权。'
    : 'OAuth IMAP 读写需要此 Client ID 已获 https://outlook.office.com/IMAP.AccessAsUser.All 委托权限，且邮箱允许 IMAP；四段导入不能补授权限。'
}

export function readStateRecoveryMessage(transport: MailTransport): string {
  return (
    mailTransportPermissionMessage(transport) +
    (transport === 'graph'
      ? ' 如果原应用已获 IMAP.AccessAsUser.All，可编辑邮箱选择 IMAP 并保存，再重新读取邮件。'
      : ' 也可编辑为已获 Mail.ReadWrite 授权的 Graph 通道。') +
    ' 如果使用第三方 Client ID 且无法完成同意，请向应用所有者取得对应通道已授权、与 Client ID 配对的 refresh token；本应用不能代为授予权限。也可继续只读。'
  )
}
