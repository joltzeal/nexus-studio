import { useEffect, useState } from 'react'
import {
  Alert,
  AlertModal,
  Button,
  Checkbox,
  DialogModal,
  Input,
  Select,
  Textarea,
} from '@proxyshard/shardx-ui-kit'
import {
  LOGIN_METHODS,
  LOGIN_LABELS,
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_LABELS,
  DEFAULT_ACCOUNT_STATUS,
  type AccountStatus,
  type LoginMethod,
  type MailboxImportInput,
} from '../../../raccoon/plugins/vinted-accounts/model'
import { accountsApi } from '../../../raccoon/plugins/vinted-accounts/api'

export function ImportDialog({
  busy,
  error,
  mailboxTargets,
  existingAccounts,
  onImportMailboxes,
  onFileImport,
  onClose,
}: {
  busy: boolean
  error: string | null
  mailboxTargets: { id: string; email: string }[] | null
  existingAccounts: { id: string; account: string; loginMethod: LoginMethod }[]
  onImportMailboxes: (input: MailboxImportInput) => void
  onFileImport: (
    filename: string,
    content: { text: string } | { base64: string },
  ) => Promise<void>
  onClose: () => void
}) {
  const [tab, setTab] = useState<'mailboxes' | 'file'>(
    mailboxTargets ? 'mailboxes' : 'file',
  )
  const [selected, setSelected] = useState<string[]>(
    () => mailboxTargets?.map((item) => item.id) ?? [],
  )
  const mailboxIds = JSON.stringify(mailboxTargets?.map((item) => item.id) ?? [])
  useEffect(() => {
    setSelected(JSON.parse(mailboxIds) as string[])
  }, [mailboxIds])
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('email')
  const [status, setStatus] = useState<AccountStatus>(DEFAULT_ACCOUNT_STATUS)
  const [phone, setPhone] = useState('')
  const [emailOtpUrl, setEmailOtpUrl] = useState('')
  const [smsOtpUrl, setSmsOtpUrl] = useState('')
  const [homepageUrl, setHomepageUrl] = useState('')
  const [note, setNote] = useState('')
  const [filename, setFilename] = useState('accounts.csv')
  const [content, setContent] = useState('')
  const [fileContent, setFileContent] = useState<{ base64: string } | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    filename: string
    content: { text: string } | { base64: string }
  } | null>(null)
  async function chooseFile(file: File | undefined) {
    if (!file) return
    setFileContent(null)
    setContent('')
    setFilename(file.name)
    setLocalError(null)
    const csv = /\.(csv|txt)$/i.test(file.name)
    if (
      !/\.(csv|txt|xlsx)$/i.test(file.name) ||
      file.size < 1 ||
      file.size > (csv ? 512 : 384) * 1024
    ) {
      setLocalError('CSV/TXT 文件上限 512 KiB，XLSX 文件上限 384 KiB')
      return
    }
    setReading(true)
    try {
      if (csv) {
        setContent(await file.text())
        setFilename(file.name)
        return
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      setFilename(file.name)
      setContent('')
      setFileContent({ base64: btoa(binary) })
    } catch {
      setLocalError('文件读取失败，请重新选择')
    } finally {
      setReading(false)
    }
  }
  async function template(format: 'csv' | 'xlsx') {
    setLocalError(null)
    setReading(true)
    try {
      const file = await accountsApi.template(format)
      const binary = atob(file.base64)
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.filename
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : '模板读取失败')
    } finally {
      setReading(false)
    }
  }
  function submit() {
    if (busy || reading || confirmation) return
    if (tab === 'file') {
      const target = { filename, content: fileContent ?? { text: content } }
      if (existingAccounts.length) setConfirmation(target)
      else void onFileImport(target.filename, target.content)
      return
    }
    const mailboxes = (mailboxTargets ?? [])
      .filter((item) => selected.includes(item.id))
      .map(({ id, email }) => ({ mailboxId: id, email }))
    onImportMailboxes({
      mailboxes,
      loginMethod,
      phone,
      emailOtpUrl,
      smsOtpUrl,
      status,
      homepageUrl,
      note,
      expectedDuplicateIds: [],
    })
  }
  const canSubmit =
    tab === 'file'
      ? (fileContent !== null || content.trim().length > 0) && filename.trim().length > 0
      : selected.length > 0
  return (
    <>
      <DialogModal
        open
        title="导入 Vinted 账号"
        subtitle="邮箱导入会跳过已存在账号。文件导入按登录方式和账号匹配并更新。"
        size="lg"
        isLoading={busy || reading}
        isDisabled={!canSubmit || reading || confirmation !== null}
        confirmLabel={tab === 'file' ? '导入文件' : `导入 ${selected.length} 个邮箱`}
        onConfirm={submit}
        onCancel={() => {
          if (!busy && !reading && !confirmation) onClose()
        }}
        onOpenChange={(open) => {
          if (!open && !busy && !reading && !confirmation) onClose()
        }}
      >
        <fieldset
          disabled={busy || reading || confirmation !== null}
          className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0 py-inset"
        >
          <div className="flex gap-2">
            <Button
              size="xsmall"
              mode={tab === 'mailboxes' ? 'stroke' : 'ghost'}
              variant="neutral"
              onClick={() => setTab('mailboxes')}
            >
              从邮箱管理导入
            </Button>
            <Button
              size="xsmall"
              mode={tab === 'file' ? 'stroke' : 'ghost'}
              variant="neutral"
              onClick={() => setTab('file')}
            >
              CSV / XLSX 文件
            </Button>
          </div>
          {(error || localError) && (
            <Alert status="error" variant="lighter">
              {localError ?? error}
            </Alert>
          )}
          {tab === 'mailboxes' ? (
            <>
              {!mailboxTargets ? (
                <p className="m-0 text-secondary text-text-sub-600">
                  邮箱管理不可用或正在读取；你仍可使用文件导入。
                </p>
              ) : mailboxTargets.length === 0 ? (
                <p className="m-0 text-secondary text-text-sub-600">没有可导入的邮箱。</p>
              ) : (
                <div className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-control bg-bg-weak-50 p-2">
                  {mailboxTargets.map((item) => (
                    <Checkbox
                      key={item.id}
                      checked={selected.includes(item.id)}
                      label={item.email}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, item.id]
                            : current.filter((id) => id !== item.id),
                        )
                      }
                    />
                  ))}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label="登录方式"
                  size="xsmall"
                  value={loginMethod}
                  onChange={(value) => setLoginMethod(value as LoginMethod)}
                  options={LOGIN_METHODS.map((value) => ({
                    value,
                    label: LOGIN_LABELS[value],
                  }))}
                />
                <Select
                  label="账号状态"
                  size="xsmall"
                  value={status}
                  onChange={(value) => setStatus(value as AccountStatus)}
                  options={ACCOUNT_STATUSES.map((value) => ({
                    value,
                    label: ACCOUNT_STATUS_LABELS[value],
                  }))}
                />
                <Input
                  inputSize="xsmall"
                  label="手机号"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
                <Input
                  inputSize="xsmall"
                  label="主页链接"
                  value={homepageUrl}
                  onChange={(event) => setHomepageUrl(event.target.value)}
                />
                <Input
                  inputSize="xsmall"
                  label="邮箱验证码链接"
                  value={emailOtpUrl}
                  onChange={(event) => setEmailOtpUrl(event.target.value)}
                />
                <Input
                  inputSize="xsmall"
                  label="短信验证码链接"
                  value={smsOtpUrl}
                  onChange={(event) => setSmsOtpUrl(event.target.value)}
                />
                <Input
                  inputSize="xsmall"
                  wrapperClassName="sm:col-span-2"
                  label="备注"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <Input
                inputSize="xsmall"
                label="选择文件"
                type="file"
                accept=".csv,.txt,.xlsx"
                disabled={busy || reading}
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
              <div className="flex gap-2">
                <Button
                  size="xsmall"
                  mode="stroke"
                  variant="neutral"
                  disabled={busy || reading}
                  onClick={() => void template('csv')}
                >
                  下载 CSV 模板
                </Button>
                <Button
                  size="xsmall"
                  mode="stroke"
                  variant="neutral"
                  disabled={busy || reading}
                  onClick={() => void template('xlsx')}
                >
                  下载 XLSX 模板
                </Button>
              </div>
              <Input
                inputSize="xsmall"
                label="文件名"
                value={filename}
                onChange={(event) => setFilename(event.target.value)}
              />
              <Textarea
                label={
                  fileContent ? `已选择 ${filename}，可粘贴 CSV 替换` : '或粘贴 CSV 文本'
                }
                rows={12}
                value={content}
                onChange={(event) => {
                  setContent(event.target.value)
                  setFileContent(null)
                  setFilename('accounts.csv')
                }}
                hint="最大 512 KiB。密码等资料会写入账号池插件私有存储。"
              />
            </>
          )}
        </fieldset>
      </DialogModal>
      <AlertModal
        open={confirmation !== null}
        status="warning"
        title="确认导入并更新账号"
        description={
          <span className="flex flex-col gap-3">
            <span>
              导入「{confirmation?.filename}
              」时，相同登录方式和账号的记录将被更新。当前已有 {
                existingAccounts.length
              }{' '}
              个账号，实际更新范围由文件内容决定。
            </span>
            <span className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-control bg-bg-weak-50 p-2 text-left">
              {existingAccounts.map((account) => (
                <span key={account.id} className="break-all">
                  {account.account} · {LOGIN_LABELS[account.loginMethod]}
                </span>
              ))}
            </span>
            {error && (
              <span className="text-error-text" role="alert">
                {error}
              </span>
            )}
          </span>
        }
        isLoading={busy}
        confirmLabel="确认导入"
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null)
        }}
        onConfirm={() => {
          if (confirmation && !busy)
            void onFileImport(confirmation.filename, confirmation.content)
        }}
      />
    </>
  )
}
