import { useEffect, useState } from 'react'
import { Alert, Button, Modal } from '@proxyshard/shardx-ui-kit'
import { emailApi } from '../../../raccoon/plugins/email/api'
import type {
  EmailAuthorizationChallenge,
  EmailAuthorizationResult,
} from '../../../raccoon/plugins/email/model'
import { toast } from '../../../shared/model/toast'
import { startAuthorizationSession } from '../../../raccoon/plugins/email/authorization-session'

export function AuthorizationDialog({
  mailboxId,
  email,
  onAuthorized,
  onClose,
}: {
  mailboxId: string
  email: string
  onAuthorized: () => void
  onClose: () => void
}) {
  const [challenge, setChallenge] = useState<EmailAuthorizationChallenge | null>(null)
  const [state, setState] = useState<EmailAuthorizationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    return startAuthorizationSession(
      emailApi,
      { id: mailboxId, email },
      {
        challenge: setChallenge,
        state: (result) => {
          setState(result)
          setError(null)
          if (result.status === 'authorized') {
            toast.ok('邮箱授权已保存')
            onAuthorized()
          }
        },
        error: setError,
      },
    )
  }, [mailboxId, email])
  return (
    <Modal
      open
      title="Microsoft 设备授权"
      description={`只授权并核对邮箱 ${email}。授权回调由邮箱插件保存凭据。`}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      footer={
        <div className="flex gap-2">
          <Button size="xsmall" mode="stroke" variant="neutral" onClick={onClose}>
            关闭
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        {challenge && (
          <>
            <p className="m-0 text-secondary text-text-sub-600">
              在微软设备登录页面输入此代码，并确认授权的是 {email}
            </p>
            <code className="w-fit rounded-control bg-bg-weak-50 px-3 py-2 text-page-title font-mono text-text-strong-950">
              {challenge.userCode}
            </code>
            <a href={challenge.verificationUri} target="_blank" rel="noreferrer">
              打开 Microsoft 设备登录
            </a>
            <p className="m-0 text-secondary text-text-soft-400">
              有效期至 {new Date(challenge.expiresAt).toLocaleString()}
            </p>
          </>
        )}
        {state?.status === 'pending' && (
          <p className="m-0 text-secondary text-text-sub-600">
            尚未完成授权；约 {state.retryAfterSeconds} 秒后自动检查。
          </p>
        )}
        {state && state.status !== 'pending' && state.status !== 'authorized' && (
          <Alert status="warning" variant="lighter">
            授权状态：
            {state.status === 'account-mismatch'
              ? '授权邮箱不匹配，原凭据未更改'
              : state.status === 'expired'
                ? '授权已过期'
                : '授权已拒绝'}
          </Alert>
        )}
        {state?.status === 'authorized' && (
          <Alert status="success" variant="lighter">
            已授权并确认邮箱地址
          </Alert>
        )}
      </div>
    </Modal>
  )
}
