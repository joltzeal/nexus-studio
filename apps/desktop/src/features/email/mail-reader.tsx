import { useState } from 'react'
import { ChevronLeft, ChevronRight, Paperclip, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { FieldError } from '@/components/ui/field'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { getMessage, listMessages } from './api'
import { EmailResource } from './async-state'
import { useEmailResource } from './hooks'
import {
  formatMailTime,
  type MailboxView,
  type MailFolder,
  type MessageQuery,
} from './types'

export function MailReader({
  account,
  onClose,
}: {
  account: MailboxView
  onClose: () => void
}) {
  const [folder, setFolder] = useState<MailFolder>('inbox')
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="h-[min(84svh,50rem)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden sm:max-w-5xl">
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle className="truncate">{account.email}</DialogTitle>
          <DialogDescription>
            只读邮件 · {account.transport === 'graph' ? 'Graph' : 'IMAP'} ·
            正文以纯文本展示
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={folder}
          onValueChange={(value) => {
            if (value === 'inbox' || value === 'junkemail') setFolder(value)
          }}
        >
          <TabsList aria-label="邮件目录">
            <TabsTrigger value="inbox">收件箱</TabsTrigger>
            <TabsTrigger value="junkemail">垃圾箱</TabsTrigger>
          </TabsList>
        </Tabs>
        <FolderReader
          key={JSON.stringify([account.id, folder])}
          accountId={account.id}
          folder={folder}
        />
      </DialogContent>
    </Dialog>
  )
}

function FolderReader({ accountId, folder }: { accountId: string; folder: MailFolder }) {
  const [resource] = useState(
    () =>
      new EmailResource<MessageQuery, Awaited<ReturnType<typeof listMessages>>>(
        { accountId, folder },
        listMessages,
        '邮件列表读取失败，请检查授权或应用代理后重试。',
      ),
  )
  const state = useEmailResource(resource)
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const page = cursors.indexOf(state.params.cursor)
  const selected = state.value?.items.find((message) => message.id === selectedId)
  const nextCursor = state.value?.nextCursor
  const repeatedCursor =
    nextCursor != null && cursors.slice(0, page + 1).includes(nextCursor)
  const detailScope = JSON.stringify([
    accountId,
    folder,
    state.params.cursor ?? null,
    selected?.id ?? null,
  ])

  function go(cursor: string | undefined) {
    if (resource.getSnapshot().loading) return
    setSelectedId(null)
    resource.select({ accountId, folder, ...(cursor === undefined ? {} : { cursor }) })
  }

  return (
    <div className="grid min-h-0 min-w-0 grid-rows-[minmax(10rem,1fr)_minmax(10rem,1fr)] gap-4 md:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.2fr)] md:grid-rows-1">
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            第 {page + 1} 页 · 每页最多 20 封
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={state.loading}
            onClick={resource.refresh}
          >
            <RefreshCw
              data-icon="inline-start"
              className={cn(state.loading && 'animate-spin')}
            />
            刷新邮件
          </Button>
        </div>
        {state.error ? <FieldError>{state.error}</FieldError> : null}
        {repeatedCursor ? (
          <FieldError>分页游标重复，请刷新邮件后重试。</FieldError>
        ) : null}
        <div
          className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border"
          aria-busy={state.loading}
          aria-label="邮件列表"
        >
          {state.value?.items.length ? (
            state.value.items.map((message, index) => (
              <div key={message.id}>
                {index ? <Separator /> : null}
                <Button
                  variant="ghost"
                  aria-pressed={selectedId === message.id}
                  className="h-auto w-full justify-start rounded-none px-3 py-2 text-left whitespace-normal aria-pressed:bg-accent"
                  onClick={() => setSelectedId(message.id)}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 items-center gap-1">
                      <span
                        className={cn('truncate', !message.isRead && 'font-semibold')}
                      >
                        {message.subject || '（无主题）'}
                      </span>
                      {message.hasAttachments ? <Paperclip aria-label="含附件" /> : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {message.from.name || message.from.address || '未知发件人'}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {message.preview}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatMailTime(message.receivedAt)}
                    </span>
                  </span>
                </Button>
              </div>
            ))
          ) : (
            <Empty className="p-4">
              <EmptyHeader>
                <EmptyTitle>
                  {state.loading
                    ? '正在读取邮件…'
                    : state.error
                      ? '邮件尚未加载'
                      : '此目录暂无邮件'}
                </EmptyTitle>
                {state.error ? (
                  <EmptyDescription>请点击刷新邮件重试。</EmptyDescription>
                ) : null}
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="上一页邮件"
            disabled={state.loading || page <= 0}
            onClick={() => go(cursors[page - 1])}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="下一页邮件"
            disabled={state.loading || !nextCursor || repeatedCursor}
            onClick={() => {
              if (!nextCursor || repeatedCursor || resource.getSnapshot().loading) return
              setCursors((current) => [...current.slice(0, page + 1), nextCursor])
              go(nextCursor)
            }}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div
        className="min-h-0 min-w-0 overflow-y-auto rounded-lg border p-3"
        aria-label="邮件详情"
      >
        {selected ? (
          <MessageDetail
            key={detailScope}
            accountId={accountId}
            folder={folder}
            messageId={selected.id}
          />
        ) : (
          <Empty className="p-4">
            <EmptyHeader>
              <EmptyTitle>选择一封邮件</EmptyTitle>
              <EmptyDescription>查看发件人、收件人和纯文本正文。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  )
}

function MessageDetail({
  accountId,
  folder,
  messageId,
}: {
  accountId: string
  folder: MailFolder
  messageId: string
}) {
  const [resource] = useState(
    () =>
      new EmailResource(
        { accountId, folder, messageId },
        getMessage,
        '邮件详情读取失败，请检查授权或应用代理后重试。',
      ),
  )
  const state = useEmailResource(resource)
  const detail = state.value
  return (
    <article className="flex min-w-0 flex-col gap-3" aria-busy={state.loading}>
      <div className="flex items-start justify-between gap-2">
        <h2 className="min-w-0 text-sm font-semibold break-words">
          {detail?.subject || (detail ? '（无主题）' : '邮件详情')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新邮件详情"
          disabled={state.loading}
          onClick={resource.refresh}
        >
          <RefreshCw className={cn(state.loading && 'animate-spin')} />
        </Button>
      </div>
      {state.error ? <FieldError>{state.error}</FieldError> : null}
      {state.loading && !detail ? (
        <p className="text-sm text-muted-foreground" role="status">
          正在读取正文…
        </p>
      ) : null}
      {detail ? (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">发件人</dt>
            <dd className="break-words">
              {detail.from.name} {detail.from.address}
            </dd>
            <dt className="text-muted-foreground">收件人</dt>
            <dd className="break-words">
              {detail.to
                .map((recipient) =>
                  [recipient.name, recipient.address].filter(Boolean).join(' '),
                )
                .join('；') || '—'}
            </dd>
            <dt className="text-muted-foreground">时间</dt>
            <dd>{formatMailTime(detail.receivedAt)}</dd>
          </dl>
          {detail.hasAttachments ? (
            <Badge variant="outline">含附件（暂不提供下载）</Badge>
          ) : null}
          {detail.truncated ? (
            <p className="text-xs text-muted-foreground" role="status">
              正文过长，仅展示前 64 KiB。
            </p>
          ) : null}
          <Separator />
          <pre className="font-sans text-sm leading-relaxed break-words whitespace-pre-wrap">
            {detail.body || '（正文为空）'}
          </pre>
        </>
      ) : null}
    </article>
  )
}
