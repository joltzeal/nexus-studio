import { EmailRequestError, emailFailureMessage, readStateFailureMessage } from './errors'
import type {
  MailboxView,
  MailFolder,
  MailMessage,
  MailMessageDetail,
  MailMessagePage,
  MailReadState,
  MessageDetailQuery,
  MessageQuery,
  MessageReadInput,
  MessageReadResult,
} from './types'

export interface EmailResourceSnapshot<P, T> {
  params: P
  value: T | null
  loading: boolean
  error: string | null
}

/**
 * A lane owns one physical RPC. Changing scope invalidates its result immediately,
 * then starts only the latest requested scope after the old RPC settles.
 */
export class EmailResource<P, T> {
  private snapshot: EmailResourceSnapshot<P, T>
  private readonly listeners = new Set<() => void>()
  private active = false
  private inFlight = false
  private pending = false
  private revision = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    params: P,
    private readonly load: (params: P) => Promise<T>,
    private readonly failure: string,
  ) {
    this.snapshot = { params, value: null, loading: true, error: null }
  }

  getSnapshot = (): EmailResourceSnapshot<P, T> => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(pollMs?: number): void {
    if (this.active) return
    this.active = true
    this.pending = true
    if (pollMs !== undefined) this.timer = setInterval(() => this.refresh(), pollMs)
    this.drain()
  }

  dispose(): void {
    this.active = false
    this.pending = false
    this.revision += 1
    clearInterval(this.timer)
    this.timer = undefined
  }

  select(params: P): void {
    this.revision += 1
    this.pending = true
    this.publish({ params, value: null, loading: true, error: null })
    this.drain()
  }

  refresh = (): void => {
    if (!this.active || this.inFlight) return
    this.pending = true
    this.drain()
  }

  invalidate(): void {
    this.revision += 1
    this.pending = true
    this.drain()
  }

  commit(update: (value: T) => T): void {
    if (!this.active || this.snapshot.value === null) return
    // A confirmed mutation supersedes reads that began before it.
    this.revision += 1
    this.pending = false
    this.publish({
      ...this.snapshot,
      value: update(this.snapshot.value),
      loading: false,
    })
  }

  private publish(snapshot: EmailResourceSnapshot<P, T>): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  private drain(): void {
    if (!this.active || this.inFlight || !this.pending) return
    this.pending = false
    this.inFlight = true
    const revision = this.revision
    const params = this.snapshot.params
    this.publish({ ...this.snapshot, loading: true })
    void this.read(params, revision)
  }

  private async read(params: P, revision: number): Promise<void> {
    try {
      const value = await this.load(params)
      if (this.active && revision === this.revision) {
        this.publish({ params, value, loading: false, error: null })
      }
    } catch (error) {
      if (this.active && revision === this.revision) {
        this.publish({
          ...this.snapshot,
          loading: false,
          error: emailFailureMessage(error, this.failure),
        })
      }
    } finally {
      this.inFlight = false
      this.drain()
    }
  }
}

interface ReaderApi {
  list: (input: MessageQuery) => Promise<MailMessagePage>
  get: (input: MessageDetailQuery) => Promise<MailMessageDetail>
  setRead: (input: MessageReadInput) => Promise<MessageReadResult>
}

export interface EmailReaderSnapshot {
  scope: number
  folder: MailFolder
  readState: MailReadState
  page: number
  list: MailMessagePage | null
  listLoading: boolean
  listError: string | null
  selected: MailMessage | null
  selectedIds: string[]
  detail: MailMessageDetail | null
  detailLoading: boolean
  detailError: string | null
  writing: boolean
  writeError: string | null
}

export class EmailReaderStore {
  private snapshot: EmailReaderSnapshot = {
    scope: 0,
    folder: 'inbox',
    readState: 'all',
    page: 1,
    list: null,
    listLoading: true,
    listError: null,
    selected: null,
    selectedIds: [],
    detail: null,
    detailLoading: false,
    detailError: null,
    writing: false,
    writeError: null,
  }
  private readonly listeners = new Set<() => void>()
  private readonly resource: EmailResource<MessageQuery, MailMessagePage>
  private readonly account: Pick<MailboxView, 'id' | 'email'>
  private unsubscribe: (() => void) | undefined
  private active = false
  private scope = 0
  private selectionRevision = 0
  private detailRevision = 0
  private writeRevision = 0
  private mutationRevision = 0
  private autoAttempt = -1
  private cursors: (string | undefined)[] = [undefined]
  private readonly readUpdates = new Map<string, { revision: number; isRead: boolean }>()

  constructor(
    account: Pick<MailboxView, 'id' | 'email'>,
    private readonly api: ReaderApi,
    private onChanged?: () => void,
  ) {
    this.account = { id: account.id, email: account.email }
    this.resource = new EmailResource(
      this.query(),
      api.list,
      '邮件列表读取失败，请检查授权或应用代理后重试。上次读取的邮件已保留。',
    )
  }

  getSnapshot = (): EmailReaderSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setOnChanged(callback?: () => void): void {
    this.onChanged = callback
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.publish({ scope: this.scope, writing: false, detailLoading: false })
    this.unsubscribe = this.resource.subscribe(() => {
      const list = this.resource.getSnapshot()
      this.publish({
        list: list.value,
        listLoading: list.loading,
        listError: list.error,
        selectedIds:
          list.value === null
            ? this.snapshot.selectedIds
            : this.snapshot.selectedIds.filter((id) =>
                list.value!.items.some((item) => item.id === id),
              ),
      })
    })
    this.resource.start(5_000)
    if (this.snapshot.selected) this.refreshDetail()
  }

  dispose(): void {
    this.active = false
    this.scope += 1
    this.detailRevision += 1
    this.writeRevision += 1
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.resource.dispose()
  }

  refreshList = (): void => this.resource.refresh()

  setFolder(folder: MailFolder): void {
    if (folder === this.snapshot.folder) return
    this.cursors = [undefined]
    this.changeScope({ folder, page: 1 })
  }

  setReadState(readState: MailReadState): void {
    if (readState === this.snapshot.readState) return
    this.cursors = [undefined]
    this.changeScope({ readState, page: 1 })
  }

  repeatedCursor(): boolean {
    const next = this.snapshot.list?.nextCursor
    return next != null && this.cursors.slice(0, this.snapshot.page).includes(next)
  }

  nextPage(): void {
    const cursor = this.snapshot.list?.nextCursor
    if (!cursor || this.repeatedCursor()) return
    this.cursors = [...this.cursors.slice(0, this.snapshot.page), cursor]
    this.changeScope({ page: this.snapshot.page + 1 })
  }

  previousPage(): void {
    if (this.snapshot.page > 1) this.changeScope({ page: this.snapshot.page - 1 })
  }

  toggleSelection(id: string, checked: boolean): void {
    if (!this.snapshot.list?.items.some((item) => item.id === id)) return
    const selected = new Set(this.snapshot.selectedIds)
    if (checked) selected.add(id)
    else selected.delete(id)
    this.publish({ selectedIds: [...selected] })
  }

  selectAll(checked: boolean): void {
    this.publish({
      selectedIds: checked
        ? (this.snapshot.list?.items.map((item) => item.id) ?? [])
        : [],
    })
  }

  selectMessage(id: string): void {
    if (!this.active || this.snapshot.selected?.id === id) return
    const message = this.snapshot.list?.items.find((item) => item.id === id)
    if (!message) return
    this.selectionRevision += 1
    this.autoAttempt = -1
    this.publish({
      selected: message,
      detail: null,
      detailLoading: false,
      detailError: null,
    })
    this.refreshDetail()
  }

  clearMessage = (): void => {
    this.selectionRevision += 1
    this.detailRevision += 1
    this.publish({
      selected: null,
      detail: null,
      detailLoading: false,
      detailError: null,
    })
  }

  refreshDetail = (): void => {
    const selected = this.snapshot.selected
    if (!this.active || !selected || this.snapshot.detailLoading) return
    const revision = ++this.detailRevision
    const scope = this.scope
    const mutation = this.mutationRevision
    this.publish({ detailLoading: true })
    void this.loadDetail(
      {
        accountId: this.account.id,
        expectedEmail: this.account.email,
        folder: this.snapshot.folder,
        messageId: selected.id,
      },
      scope,
      revision,
      mutation,
    )
  }

  markRead = (
    messageIds: string[],
    isRead: boolean,
    scope = this.scope,
  ): Promise<void> =>
    scope === this.scope ? this.write(messageIds, isRead, false) : Promise.resolve()

  private query(): MessageQuery {
    const cursor = this.cursors[this.snapshot.page - 1]
    return {
      accountId: this.account.id,
      expectedEmail: this.account.email,
      folder: this.snapshot.folder,
      readState: this.snapshot.readState,
      ...(cursor === undefined ? {} : { cursor }),
    }
  }

  private changeScope(patch: Partial<EmailReaderSnapshot>): void {
    this.scope += 1
    this.selectionRevision += 1
    this.detailRevision += 1
    this.writeRevision += 1
    this.autoAttempt = -1
    this.readUpdates.clear()
    this.publish({
      ...patch,
      scope: this.scope,
      selected: null,
      selectedIds: [],
      detail: null,
      detailLoading: false,
      detailError: null,
      writing: false,
      writeError: null,
    })
    this.resource.select(this.query())
  }

  private publish(patch: Partial<EmailReaderSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private async loadDetail(
    input: MessageDetailQuery,
    scope: number,
    revision: number,
    mutation: number,
  ): Promise<void> {
    try {
      let detail = await this.api.get(input)
      if (!this.active || scope !== this.scope || revision !== this.detailRevision) return
      const update = this.readUpdates.get(detail.id)
      if (update && update.revision > mutation)
        detail = { ...detail, isRead: update.isRead }
      this.publish({
        detail,
        selected: detail,
        detailLoading: false,
        detailError: null,
      })
      this.tryAutoRead()
    } catch (error) {
      if (!this.active || scope !== this.scope || revision !== this.detailRevision) return
      this.publish({
        detailLoading: false,
        detailError: emailFailureMessage(
          error,
          '邮件详情读取失败，请检查授权或应用代理后重试。',
        ),
      })
    }
  }

  private tryAutoRead(): void {
    const detail = this.snapshot.detail
    if (
      !this.active ||
      !detail ||
      detail.isRead ||
      this.snapshot.detailLoading ||
      this.snapshot.writing ||
      this.autoAttempt === this.selectionRevision
    )
      return
    this.autoAttempt = this.selectionRevision
    void this.write([detail.id], true, true)
  }

  private async write(
    messageIds: string[],
    isRead: boolean,
    automatic: boolean,
  ): Promise<void> {
    if (!this.active || this.snapshot.writing || !messageIds.length) return
    if (
      !automatic &&
      this.snapshot.selected &&
      messageIds.includes(this.snapshot.selected.id)
    )
      this.autoAttempt = this.selectionRevision
    const scope = this.scope
    const revision = ++this.writeRevision
    const input: MessageReadInput = {
      accountId: this.account.id,
      expectedEmail: this.account.email,
      folder: this.snapshot.folder,
      messageIds: [...messageIds],
      isRead,
    }
    this.publish({ writing: true, writeError: null })
    try {
      const result = await this.api.setRead(input)
      if (!this.active || scope !== this.scope || revision !== this.writeRevision) return
      const updated = new Set(result.updatedIds)
      const mutation = ++this.mutationRevision
      const visibleIds = new Set([
        ...(this.snapshot.list?.items.map((item) => item.id) ?? []),
        ...(this.snapshot.selected ? [this.snapshot.selected.id] : []),
      ])
      for (const id of this.readUpdates.keys())
        if (!visibleIds.has(id)) this.readUpdates.delete(id)
      for (const id of updated) this.readUpdates.set(id, { revision: mutation, isRead })
      let unreadDelta = 0
      for (const id of updated) {
        const previous =
          this.snapshot.list?.items.find((item) => item.id === id) ??
          (this.snapshot.selected?.id === id ? this.snapshot.selected : null)
        if (previous && previous.isRead !== isRead) unreadDelta += isRead ? -1 : 1
      }
      this.publish({
        selected:
          this.snapshot.selected && updated.has(this.snapshot.selected.id)
            ? { ...this.snapshot.selected, isRead }
            : this.snapshot.selected,
        detail:
          this.snapshot.detail && updated.has(this.snapshot.detail.id)
            ? { ...this.snapshot.detail, isRead }
            : this.snapshot.detail,
        selectedIds: this.snapshot.selectedIds.filter((id) => !updated.has(id)),
        writeError: result.failures.length
          ? `已更新 ${updated.size} 封，${result.failures.length} 封未更新。${readStateFailureMessage(
              result.failures.some((item) => item.code === 'PERMISSION_DENIED')
                ? 'PERMISSION_DENIED'
                : result.failures[0]!.code,
            )}`
          : null,
      })
      if (updated.size) {
        this.resource.commit((list) => ({
          ...list,
          unread: Math.min(list.total, Math.max(0, list.unread + unreadDelta)),
          items: list.items
            .map((item) => (updated.has(item.id) ? { ...item, isRead } : item))
            .filter(
              (item) =>
                this.snapshot.readState === 'all' ||
                (this.snapshot.readState === 'read' ? item.isRead : !item.isRead),
            ),
        }))
        this.onChanged?.()
      }
    } catch (error) {
      if (!this.active || scope !== this.scope || revision !== this.writeRevision) return
      this.publish({
        writeError: readStateFailureMessage(
          error instanceof EmailRequestError ? error.code : null,
        ),
      })
    } finally {
      if (this.active && scope === this.scope && revision === this.writeRevision) {
        this.publish({ writing: false })
        this.tryAutoRead()
      }
    }
  }
}
