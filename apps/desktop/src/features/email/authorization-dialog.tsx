import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field'
import { copyText } from '@/lib/clipboard'
import { openExternalUrl } from '@/lib/platform/external-url'
import {
  cancelEmailAuthorization,
  pollEmailAuthorization,
  startEmailAuthorization,
} from './api'
import { EmailAuthorizationStore } from './authorization-state'
import { useEmailAction } from './hooks'
import { formatMailTime, type MailboxView } from './types'

export function EmailAuthorizationDialog({
  account,
  onClose,
  onAuthorized,
}: {
  account: MailboxView
  onClose: () => void
  onAuthorized: (account: MailboxView) => void
}) {
  const [store] = useState(
    () =>
      new EmailAuthorizationStore(account, {
        start: startEmailAuthorization,
        poll: pollEmailAuthorization,
        cancel: cancelEmailAuthorization,
      }),
  )
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  const { action, error: actionError } = useEmailAction(
    '未能打开微软页面或复制授权码，请手动操作。',
  )
  useEffect(() => {
    store.setOnAuthorized((saved) => {
      store.cancel()
      onAuthorized(saved)
    })
  }, [store, onAuthorized])
  useEffect(() => {
    store.activate()
    return () => store.pause()
  }, [store])
  function close() {
    store.cancel()
    action.dispose()
    onClose()
  }
  const waiting = state.phase === 'waiting'
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>授予 Graph 读写权限</DialogTitle>
          <DialogDescription>
            登录 {account.email}，在微软页面同意 Mail.ReadWrite、User.Read 和离线访问。
            User.Read 用于核对登录邮箱。成功保存后使用 Graph 通道。
          </DialogDescription>
        </DialogHeader>
        <p className="break-all text-xs text-muted-foreground">
          当前已保存的 Client ID：{account.clientId}
        </p>
        {state.challenge && waiting ? (
          <div className="flex flex-col gap-3 text-sm" role="status">
            <p>在微软登录页面输入授权码，并使用当前邮箱登录：</p>
            <p className="font-mono text-xl font-semibold tracking-widest">
              {state.challenge.userCode}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  void action.run(
                    () => openExternalUrl(state.challenge!.verificationUri),
                    () => {},
                  )
                }}
              >
                打开微软授权页面
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void action.run(
                    async () => {
                      if (!(await copyText(state.challenge!.userCode)))
                        throw new Error('Copy failed')
                    },
                    () => {},
                  )
                }}
              >
                复制授权码
              </Button>
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {state.challenge.verificationUri} · 到期{' '}
              {formatMailTime(state.challenge.expiresAt)}
            </p>
            <p className="text-xs text-muted-foreground">
              {state.checking
                ? '正在核对授权并保存凭据…'
                : '等待微软授权，按服务器要求检查结果。'}
              成功前保留原凭据；不会自动重试之前失败的邮件写入。
            </p>
          </div>
        ) : null}
        {state.error || actionError ? (
          <FieldError>{state.error ?? actionError}</FieldError>
        ) : null}
        <details
          className="text-xs text-muted-foreground"
          open={state.phase === 'failed'}
        >
          <summary className="cursor-pointer font-medium">
            无法获得写入同意时如何处理
          </summary>
          <ol className="mt-2 list-decimal space-y-2 pl-4">
            <li>
              若你拥有此应用，在 Microsoft Entra 的“应用注册 → 身份验证 →
              高级设置”允许公共客户端流，并确认支持设备代码流程及当前账号类型。
            </li>
            <li>
              检查“API 权限 → Microsoft Graph → 委托权限”的 Mail.ReadWrite 与
              User.Read。租户禁止用户同意或设备代码登录时，需要管理员批准或调整策略；重复刷新
              token 无法绕过。
            </li>
            <li>
              第三方 Client ID 无法自行修改时，联系应用所有者提供支持上述流程的 Client
              ID，或取得与该 ID 配对且已同意写权限的 refresh
              token，再编辑邮箱。不要替换为无关应用的 token。
            </li>
            <li>
              仅当原应用已获 IMAP.AccessAsUser.All 且邮箱允许 IMAP
              时，可取消此授权并编辑为 IMAP；否则继续只读。
            </li>
          </ol>
        </details>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          {state.error && waiting ? (
            <Button disabled={state.checking} onClick={() => void store.retry()}>
              重试检查
            </Button>
          ) : null}
          {!waiting ? (
            <Button
              disabled={state.phase === 'starting'}
              onClick={() => void store.begin()}
            >
              {state.phase === 'starting'
                ? '正在请求授权码…'
                : state.phase === 'failed'
                  ? '重新开始授权'
                  : '开始微软授权'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
