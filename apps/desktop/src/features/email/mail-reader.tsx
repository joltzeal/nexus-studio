import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Paperclip,
  RefreshCw,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { getMessage, listMessages, setMessagesRead } from './api'
import { EmailReaderStore, type EmailReaderSnapshot } from './async-state'
import { useEmailAction, useEmailReader } from './hooks'
import { formatMailTime, mailHtmlDocument, type MailboxView } from './types'

interface MailReaderProps {
  account: MailboxView
  onClose: () => void
  onChanged?: () => void
}

export function MailReader(props: MailReaderProps) {
  const { account } = props
  return (
    <ReaderSession
      key={JSON.stringify([
        account.id,
        account.email,
        account.transport,
        account.clientId,
        account.enabled,
      ])}
      {...props}
    />
  )
}

function ReaderSession({ account, onClose, onChanged }: MailReaderProps) {
  const [store] = useState(
    () =>
      new EmailReaderStore(account, {
        list: listMessages,
        get: getMessage,
        setRead: setMessagesRead,
      }),
  )
  const state = useEmailReader(store, onChanged)
  const items = state.list?.items ?? []
  const allSelected = items.length > 0 && state.selectedIds.length === items.length
  const repeatedCursor = store.repeatedCursor()
  const counts = state.list ?? account.reception[state.folder]
  function close() {
    store.dispose()
    onClose()
  }
  function markPage(isRead: boolean) {
    void store.markRead(
      store.getSnapshot().list?.items.map((item) => item.id) ?? [],
      isRead,
      state.scope,
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="flex h-[min(90svh,54rem)] min-w-0 flex-col gap-3 overflow-hidden p-4 sm:max-w-6xl sm:p-5">
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle className="truncate">{account.email}</DialogTitle>
          <DialogDescription>
            {account.transport === 'graph' ? 'Graph' : 'IMAP'} · 收件箱与垃圾箱 ·
            打开正文后同步已读状态
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={state.folder}
            onValueChange={(value) => {
              if (value === 'inbox' || value === 'junkemail') store.setFolder(value)
            }}
          >
            <TabsList aria-label="邮件目录">
              <TabsTrigger value="inbox">收件箱</TabsTrigger>
              <TabsTrigger value="junkemail">垃圾箱</TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            共 {counts?.total ?? '—'} 封 · 未读 {counts?.unread ?? '—'}
          </span>
        </div>
        {state.writeError ? <FieldError>{state.writeError}</FieldError> : null}
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.4fr)]">
          <section
            className={cn(
              'min-h-0 min-w-0 flex-col gap-2',
              state.selected ? 'hidden md:flex' : 'flex',
            )}
            aria-label="邮件列表面板"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Tabs
                value={state.readState}
                onValueChange={(value) => {
                  if (value === 'all' || value === 'unread' || value === 'read')
                    store.setReadState(value)
                }}
              >
                <TabsList aria-label="筛选邮件已读状态">
                  <TabsTrigger value="all">全部</TabsTrigger>
                  <TabsTrigger value="unread">未读</TabsTrigger>
                  <TabsTrigger value="read">已读</TabsTrigger>
                </TabsList>
              </Tabs>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="刷新邮件"
                disabled={state.listLoading}
                onClick={store.refreshList}
              >
                <RefreshCw className={cn(state.listLoading && 'animate-spin')} />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                aria-label="全选当前页邮件"
                checked={
                  allSelected ? true : state.selectedIds.length ? 'indeterminate' : false
                }
                disabled={!items.length || state.writing}
                onCheckedChange={(value) => store.selectAll(value === true)}
              />
              <span>已选 {state.selectedIds.length}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!state.selectedIds.length || state.writing}
                onClick={() => {
                  void store.markRead(store.getSnapshot().selectedIds, true, state.scope)
                }}
              >
                所选标为已读
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!state.selectedIds.length || state.writing}
                onClick={() => {
                  void store.markRead(store.getSnapshot().selectedIds, false, state.scope)
                }}
              >
                所选标为未读
              </Button>
            </div>
            {state.listError ? <FieldError>{state.listError}</FieldError> : null}
            {repeatedCursor ? (
              <FieldError>分页游标重复，请刷新邮件后重试。</FieldError>
            ) : null}
            <div
              className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border"
              aria-label="邮件列表"
              aria-busy={state.listLoading}
            >
              {items.length ? (
                items.map((message, index) => (
                  <div key={message.id}>
                    {index ? <Separator /> : null}
                    <div
                      className={cn(
                        'flex items-start gap-1 px-2 py-1',
                        state.selected?.id === message.id && 'bg-accent',
                      )}
                    >
                      <Checkbox
                        className="mt-3 shrink-0"
                        aria-label={`选择邮件 ${message.subject || '（无主题）'}`}
                        checked={state.selectedIds.includes(message.id)}
                        disabled={state.writing}
                        onCheckedChange={(value) =>
                          store.toggleSelection(message.id, value === true)
                        }
                      />
                      <Button
                        variant="ghost"
                        aria-label={`打开邮件 ${message.subject || '（无主题）'}`}
                        aria-pressed={state.selected?.id === message.id}
                        className="h-auto min-w-0 flex-1 justify-start px-2 py-1.5 text-left whitespace-normal"
                        onClick={() => store.selectMessage(message.id)}
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={cn(
                                'truncate',
                                !message.isRead && 'font-semibold',
                              )}
                            >
                              {message.subject || '（无主题）'}
                            </span>
                            {!message.isRead ? (
                              <Badge variant="secondary">未读</Badge>
                            ) : (
                              <span className="sr-only">已读</span>
                            )}
                            {message.hasAttachments ? (
                              <Paperclip aria-label="含附件" />
                            ) : null}
                          </span>
                          <span className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
                            <span className="truncate">
                              {message.from.name || message.from.address || '未知发件人'}
                            </span>
                            <span className="shrink-0 tabular-nums">
                              {formatMailTime(message.receivedAt)}
                            </span>
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {message.preview}
                          </span>
                        </span>
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <Empty className="p-4">
                  <EmptyHeader>
                    <EmptyTitle>
                      {state.listLoading
                        ? '正在读取邮件…'
                        : state.listError
                          ? '邮件尚未加载'
                          : '没有符合筛选条件的邮件'}
                    </EmptyTitle>
                    <EmptyDescription>
                      {state.listError
                        ? '请点击刷新邮件重试。'
                        : '可切换目录或已读状态筛选。'}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={!items.length || state.writing}
                onClick={() => markPage(true)}
              >
                本页标为已读
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!items.length || state.writing}
                onClick={() => markPage(false)}
              >
                本页标为未读
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">
                第 {state.page} 页
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="上一页邮件"
                disabled={state.page <= 1 || !state.list}
                onClick={() => store.previousPage()}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="下一页邮件"
                disabled={!state.list?.nextCursor || repeatedCursor}
                onClick={() => store.nextPage()}
              >
                <ChevronRight />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              每页最多 20 封 · 列表每 5 秒更新
            </p>
          </section>
          <section
            className={cn(
              'min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border',
              state.selected ? 'flex' : 'hidden md:flex',
            )}
            aria-label="邮件详情"
          >
            {state.selected ? (
              <MessageDetail
                key={JSON.stringify([state.folder, state.selected.id])}
                store={store}
                state={state}
              />
            ) : (
              <Empty className="p-4">
                <EmptyHeader>
                  <EmptyTitle>选择一封邮件</EmptyTitle>
                  <EmptyDescription>查看发件人、收件人和正文。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MessageDetail({
  store,
  state,
}: {
  store: EmailReaderStore
  state: EmailReaderSnapshot
}) {
  const detail = state.detail
  const [view, setView] = useState('html')
  const [copied, setCopied] = useState(false)
  const copy = useEmailAction('复制失败，请选择纯文本正文后手动复制。')
  const html = detail?.html
  const document = useMemo(() => (html ? mailHtmlDocument(html) : null), [html])
  const contentView = document ? view : 'text'
  return (
    <article
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
      aria-busy={state.detailLoading}
    >
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="md:hidden"
          onClick={store.clearMessage}
        >
          <ArrowLeft data-icon="inline-start" />
          返回列表
        </Button>
        <Badge variant="outline">
          {(detail ?? state.selected)?.isRead ? '已读' : '未读'}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!detail || state.writing}
            onClick={() => {
              const current = store.getSnapshot().detail
              if (detail && current?.id === detail.id)
                void store.markRead([current.id], !current.isRead, state.scope)
            }}
          >
            {detail?.isRead ? '标为未读' : '标为已读'}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="刷新邮件详情"
            disabled={state.detailLoading}
            onClick={store.refreshDetail}
          >
            <RefreshCw className={cn(state.detailLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>
      <h2 className="text-sm font-semibold break-words">
        {(detail ?? state.selected)?.subject || '（无主题）'}
      </h2>
      {state.detailError ? <FieldError>{state.detailError}</FieldError> : null}
      {state.detailLoading && !detail ? (
        <p className="text-sm text-muted-foreground" role="status">
          正在读取正文…
        </p>
      ) : null}
      {detail ? (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">发件人</dt>
            <dd className="break-words">
              {[detail.from.name, detail.from.address].filter(Boolean).join(' · ') || '—'}
            </dd>
            <dt className="text-muted-foreground">收件人</dt>
            <dd className="break-words">
              {detail.to
                .map((recipient) =>
                  [recipient.name, recipient.address].filter(Boolean).join(' · '),
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
              正文已截断；纯文本最多 64 KiB，HTML 最多 128 KiB。
            </p>
          ) : null}
          <Separator />
          <Tabs value={contentView} className="min-h-0 flex-1" onValueChange={setView}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TabsList aria-label="正文格式">
                <TabsTrigger value="html" disabled={!document}>
                  格式正文
                </TabsTrigger>
                <TabsTrigger value="text">纯文本</TabsTrigger>
              </TabsList>
              <Button
                variant="ghost"
                size="sm"
                disabled={!detail.body || copy.busy}
                onClick={() => {
                  setCopied(false)
                  void copy.action.run(
                    async () => {
                      if (!(await copyText(detail.body)))
                        throw new Error('Copy unavailable')
                    },
                    () => setCopied(true),
                  )
                }}
              >
                <Copy data-icon="inline-start" />
                {copied ? '已复制' : '复制正文'}
              </Button>
            </div>
            {copy.error ? <FieldError>{copy.error}</FieldError> : null}
            {contentView === 'html' && document ? (
              <TabsContent value="html" className="min-h-64">
                <iframe
                  title="邮件格式正文"
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={document}
                  className="h-full min-h-64 w-full rounded-md bg-background"
                />
              </TabsContent>
            ) : (
              <TabsContent value="text">
                <pre className="font-sans text-sm leading-relaxed break-words whitespace-pre-wrap">
                  {detail.body || '（正文为空）'}
                </pre>
              </TabsContent>
            )}
          </Tabs>
        </>
      ) : null}
    </article>
  )
}
