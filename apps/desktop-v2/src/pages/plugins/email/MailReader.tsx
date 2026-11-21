import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, EmptyState, Modal, Select } from '@proxyshard/shardx-ui-kit'
import { emailApi } from '../../../raccoon/plugins/email/api'
import {
  graphReadMarks,
  graphUnreadCount,
  markGraphMessages,
  reconcileGraphMarks,
} from '../../../raccoon/plugins/email/graph-read-state'
import {
  formatMailTime,
  type MailFolder,
  type MailFolderCounts,
  type MailMessage,
  type MailMessageDetail,
  type MailReadState,
  type MailboxView,
} from '../../../raccoon/plugins/email/model'
import { clip } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'
import { usePluginTask } from '../usePluginTask'
import { PluginFilterRow } from '../PluginFilterRow'
import { MailBody } from './MailBody'

const GRAPH_FILTER_SCAN_PAGES = 3

export function MailReader({
  mailbox,
  onClose,
}: {
  mailbox: MailboxView
  onClose: () => void
}) {
  const [folder, setFolder] = useState<MailFolder>('inbox')
  const [readState, setReadState] = useState<MailReadState>('all')
  const [page, setPage] = useState<MailMessage[]>([])
  const graph = mailbox.transport === 'graph'
  const [localMarks, setLocalMarks] = useState(() => new Map<string, boolean>())
  const visiblePage = graph
    ? page
        .map((item) => ({ ...item, isRead: localMarks.get(item.id) ?? item.isRead }))
        .filter((item) => readState === 'all' || item.isRead === (readState === 'read'))
    : page
  const [counts, setCounts] = useState<Partial<Record<MailFolder, MailFolderCounts>>>({})
  const folderCounts = counts[folder] ?? mailbox.reception[folder]
  function unreadCount(target: MailFolder) {
    const current = counts[target] ?? mailbox.reception[target]
    if (!graph) return current?.unread
    const marks =
      target === folder && counts[target] ? localMarks : graphReadMarks(mailbox, target)
    return graphUnreadCount(current, marks)
  }
  const [cursor, setCursor] = useState<string | undefined>()
  const [next, setNext] = useState<string | null>(null)
  const [selection, setSelection] = useState<string[]>([])
  const [detail, setDetail] = useState<MailMessageDetail | null>(null)
  const [plainText, setPlainText] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const task = usePluginTask()
  const generation = useRef(0)
  const [history, setHistory] = useState<(string | undefined)[]>([undefined])
  const [pageNumber, setPageNumber] = useState(0)
  const load = useCallback(
    async (nextCursor?: string) => {
      const request = ++generation.current
      const token = task.begin()
      setBusy(true)
      setError(null)
      try {
        let sourceCursor = nextCursor
        for (let scanned = 0; scanned < GRAPH_FILTER_SCAN_PAGES; scanned++) {
          const result = await emailApi.listMessages({
            accountId: mailbox.id,
            expectedEmail: mailbox.email,
            folder,
            readState: graph || readState === 'all' ? undefined : readState,
            ...(sourceCursor ? { cursor: sourceCursor } : {}),
          })
          if (!task.current(token) || generation.current !== request) return
          const continuation =
            result.nextCursor === sourceCursor ? null : result.nextCursor
          if (graph) {
            const marks = reconcileGraphMarks(
              mailbox,
              folder,
              graphReadMarks(mailbox, folder),
              result.items,
              sourceCursor === undefined &&
                result.nextCursor === null &&
                result.items.length === result.total,
            )
            if (
              readState !== 'all' &&
              continuation &&
              scanned + 1 < GRAPH_FILTER_SCAN_PAGES &&
              !result.items.some(
                (item) => (marks.get(item.id) ?? item.isRead) === (readState === 'read'),
              )
            ) {
              sourceCursor = continuation
              continue
            }
            setLocalMarks(marks)
          }
          setPage(result.items)
          setCounts((current) => ({
            ...current,
            [folder]: { total: result.total, unread: result.unread },
          }))
          setNext(continuation)
          setCursor(nextCursor)
          setSelection([])
          return
        }
      } catch (cause) {
        if (task.current(token) && generation.current === request)
          setError(cause instanceof Error ? cause.message : '邮件列表读取失败')
      } finally {
        if (task.current(token) && generation.current === request) setBusy(false)
      }
    },
    [folder, graph, mailbox.email, mailbox.id, readState],
  )
  useEffect(() => {
    setDetail(null)
    setCursor(undefined)
    setHistory([undefined])
    setPageNumber(0)
    setPage([])
    setSelection([])
    void load()
    return () => {
      generation.current++
    }
  }, [folder, readState, load])
  function adjustUnread(delta: number) {
    if (!delta) return
    setCounts((current) => {
      const previous = current[folder]
      if (!previous) return current
      const unread = Math.max(0, Math.min(previous.total, previous.unread + delta))
      return { ...current, [folder]: { ...previous, unread } }
    })
  }
  function applyRead(updatedIds: string[], isRead: boolean) {
    const updated = new Set(updatedIds)
    const changed = page.filter(
      (item) => updated.has(item.id) && item.isRead !== isRead,
    ).length
    adjustUnread(isRead ? -changed : changed)
    setPage((items) =>
      items
        .map((item) => (updated.has(item.id) ? { ...item, isRead } : item))
        .filter((item) => readState === 'all' || item.isRead === (readState === 'read')),
    )
    if (readState !== 'all' && isRead !== (readState === 'read'))
      setSelection((ids) => ids.filter((id) => !updated.has(id)))
    setDetail((value) => (value && updated.has(value.id) ? { ...value, isRead } : value))
  }
  async function openMessage(message: MailMessage) {
    if (!task.acquire()) return
    const token = task.begin()
    const request = ++generation.current
    const isCurrent = () => task.current(token) && request === generation.current
    setDetail(null)
    setBusy(true)
    setError(null)
    try {
      const result = await emailApi.getMessage({
        accountId: mailbox.id,
        expectedEmail: mailbox.email,
        folder,
        messageId: message.id,
      })
      if (!isCurrent()) return
      setDetail(result)
      setPlainText(false)
      if (graph) {
        const listed = page.find((item) => item.id === result.id)
        if (listed && listed.isRead !== result.isRead)
          adjustUnread(result.isRead ? -1 : 1)
        setPage((items) =>
          items.map((item) =>
            item.id === result.id ? { ...item, isRead: result.isRead } : item,
          ),
        )
        try {
          setLocalMarks(markGraphMessages(mailbox, folder, [result], true))
          setDetail({ ...result, isRead: true })
          if (readState === 'unread')
            setSelection((ids) => ids.filter((id) => id !== result.id))
        } catch {
          toast.err('未能保存本机已读状态')
        }
        return
      }
      if (result.isRead) {
        applyRead([message.id], true)
        return
      }
      try {
        const written = await emailApi.setMessagesRead({
          accountId: mailbox.id,
          expectedEmail: mailbox.email,
          folder,
          messageIds: [message.id],
          isRead: true,
        })
        if (!isCurrent()) return
        if (written.updatedIds.includes(message.id)) {
          applyRead([message.id], true)
        } else {
          applyRead([message.id], false)
          setError('未能标记已读。可检查邮箱授权或稍后重试。')
        }
      } catch (cause) {
        if (!isCurrent()) return
        applyRead([message.id], false)
        setError(
          `未能标记已读。${cause instanceof Error ? cause.message : '请稍后重试。'}`,
        )
      }
    } catch (cause) {
      if (isCurrent())
        setError(cause instanceof Error ? cause.message : '邮件详情读取失败')
    } finally {
      task.release()
      if (isCurrent()) setBusy(false)
    }
  }
  async function mark(isRead: boolean) {
    if (!selection.length || !task.acquire()) return
    const token = task.begin()
    const request = ++generation.current
    setBusy(true)
    setError(null)
    try {
      if (graph) {
        const selected = page.filter((item) => selection.includes(item.id))
        try {
          setLocalMarks(markGraphMessages(mailbox, folder, selected, isRead))
        } catch {
          toast.err('未能保存本机已读状态')
          return
        }
        setDetail((current) =>
          current && selection.includes(current.id) ? { ...current, isRead } : current,
        )
        setSelection([])
        toast.ok(isRead ? '已在本机标记为已读' : '已在本机标记为未读')
        return
      }
      const result = await emailApi.setMessagesRead({
        accountId: mailbox.id,
        expectedEmail: mailbox.email,
        folder,
        messageIds: selection,
        isRead,
      })
      if (!task.current(token) || request !== generation.current) return
      applyRead(result.updatedIds, isRead)
      const failed = result.failures.length
      if (failed) {
        setSelection(result.failures.map((item) => item.messageId))
        setError(`${result.updatedIds.length} 封已更新，${failed} 封未更新。`)
      } else {
        setSelection([])
        toast.ok(isRead ? '邮件已标记为已读' : '邮件已标记为未读')
      }
    } catch (cause) {
      if (task.current(token) && request === generation.current)
        setError(cause instanceof Error ? cause.message : '已读状态更新失败')
    } finally {
      task.release()
      if (task.current(token) && request === generation.current) setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={`读取邮件 · ${mailbox.email}`}
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <div className="flex min-h-[min(72vh,620px)] flex-col gap-3">
        <PluginFilterRow label="邮件筛选">
          <Select
            className="min-w-[144px] flex-1"
            label="邮件目录"
            size="xsmall"
            value={folder}
            disabled={busy}
            onChange={(value) => setFolder(value as MailFolder)}
            options={[
              {
                value: 'inbox',
                label: `收件箱 · ${unreadCount('inbox') ?? '—'}`,
              },
              {
                value: 'junkemail',
                label: `垃圾箱 · ${unreadCount('junkemail') ?? '—'}`,
              },
            ]}
          />
          <Select
            className="w-[144px]!"
            label="已读状态"
            size="xsmall"
            value={readState}
            disabled={busy}
            onChange={(value) => setReadState(value as MailReadState)}
            options={[
              { value: 'all', label: '全部' },
              { value: 'unread', label: '未读' },
              { value: 'read', label: '已读' },
            ]}
          />
        </PluginFilterRow>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-secondary tabular-nums text-text-soft-400">
            {folderCounts?.total ?? '—'} 封 · 未读 {unreadCount(folder) ?? '—'}
            {graph ? '（本机）' : ''}
          </span>
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={!selection.length || busy}
            onClick={() => void mark(true)}
          >
            标记已读
          </Button>
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={!selection.length || busy}
            onClick={() => void mark(false)}
          >
            标记未读
          </Button>
        </div>
        {error && (
          <Alert status="warning" variant="lighter">
            {error}
          </Alert>
        )}
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(230px,.85fr)_minmax(0,1.4fr)]">
          <div className="min-h-0 overflow-y-auto rounded-control bg-bg-weak-50 p-2">
            {visiblePage.length ? (
              visiblePage.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2 border-b border-stroke-soft-200 py-2"
                >
                  <Button
                    size="3xsmall"
                    mode={selection.includes(item.id) ? 'stroke' : 'ghost'}
                    variant="neutral"
                    aria-label={`选择邮件 ${item.subject}`}
                    onClick={() =>
                      setSelection((current) =>
                        current.includes(item.id)
                          ? current.filter((id) => id !== item.id)
                          : [...current, item.id],
                      )
                    }
                  >
                    {selection.includes(item.id) ? '已选' : '选择'}
                  </Button>
                  <Button
                    type="button"
                    className="h-auto min-w-0 flex-1 justify-start whitespace-normal px-1 text-left"
                    mode="ghost"
                    variant="neutral"
                    disabled={busy}
                    onClick={() => void openMessage(item)}
                  >
                    <span className="flex min-w-0 flex-col items-start">
                      <strong
                        className={`block max-w-full truncate ${item.isRead ? 'font-normal text-text-sub-600' : 'font-medium text-text-strong-950'}`}
                      >
                        {item.subject || '（无主题）'}
                      </strong>
                      <span className="block max-w-full truncate text-micro text-text-soft-400">
                        {item.from.name || item.from.address}
                      </span>
                      <span className="text-micro text-text-soft-400">
                        {formatMailTime(item.receivedAt)}
                      </span>
                    </span>
                  </Button>
                </div>
              ))
            ) : (
              <EmptyState
                title={
                  busy
                    ? '读取邮件…'
                    : readState === 'all'
                      ? '当前目录没有邮件'
                      : '本页没有符合筛选的邮件'
                }
              />
            )}
          </div>
          <article className="min-h-0 min-w-0 overflow-y-auto rounded-control bg-bg-raised p-3">
            {detail ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="m-0 text-panel-title text-text-strong-950">
                      {detail.subject || '（无主题）'}
                    </h2>
                    <p className="mb-0 mt-1 text-secondary text-text-sub-600">
                      {detail.from.name} &lt;{detail.from.address}&gt; ·{' '}
                      {formatMailTime(detail.receivedAt)}
                    </p>
                    <p className="m-0 text-secondary text-text-soft-400">
                      收件人：{detail.to.map((item) => item.address).join(', ') || '—'}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="3xsmall"
                      mode="ghost"
                      variant="neutral"
                      onClick={() =>
                        void clip
                          .write(detail.body)
                          .then(() => toast.ok('邮件正文已复制'))
                      }
                    >
                      复制正文
                    </Button>
                    {!!detail.html?.trim() && (
                      <Button
                        size="3xsmall"
                        mode="ghost"
                        variant="neutral"
                        onClick={() => setPlainText((value) => !value)}
                      >
                        {plainText ? '查看格式化内容' : '查看纯文本'}
                      </Button>
                    )}
                  </div>
                </div>
                <MailBody html={detail.html} body={detail.body} plainText={plainText} />
                {detail.truncated && (
                  <p className="text-secondary text-text-soft-400">正文已截断</p>
                )}
              </>
            ) : (
              <EmptyState
                title="选择一封邮件"
                hint="邮件正文仅在打开后读取，不会缓存到账号资料。"
              />
            )}
          </article>
        </div>
        <div className="flex items-center justify-end gap-2">
          <span className="text-secondary text-text-soft-400">
            第 {pageNumber + 1} 页{cursor ? ' · 后续邮件' : ''}
          </span>
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={busy || pageNumber === 0}
            onClick={() => {
              setDetail(null)
              setPageNumber(pageNumber - 1)
              void load(history[pageNumber - 1])
            }}
          >
            上一页
          </Button>
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={busy || !next}
            onClick={() => {
              if (!next) return
              setDetail(null)
              setHistory([...history.slice(0, pageNumber + 1), next])
              setPageNumber(pageNumber + 1)
              void load(next)
            }}
          >
            下一页
          </Button>
        </div>
      </div>
    </Modal>
  )
}
