import type {
  BrowserConnection,
  BrowserConnectionProbe,
  BrowserOperation,
  BrowserWindow,
  CreateBrowserWindowInput,
  UpdateBrowserWindowInput,
} from '@nexus/contracts/browser'
import type { BrowserProviderId } from '@nexus/contracts/browser'
import type { CloakKernelStatus, KernelStatus, NativeFolder } from './api.ts'
import type { FolderMeta } from '../entities/profile/lib/folderMeta'

export type NativeApi = {
  call(command: string, args?: Record<string, unknown>): Promise<unknown>
}
export type ManagedProvider = 'cloakbrowser' | 'shardbrowser'
export type WorkspaceState = {
  connections: BrowserConnection[]
  connectionId: string | null
  profiles: BrowserWindow[]
  folders: NativeFolder[]
  operations: BrowserOperation[]
  probe: BrowserConnectionProbe | null
  kernels: KernelStatus | null
  cloakKernels: CloakKernelStatus | null
  loading: boolean
  error: string | null
  pendingCreateId: string | null
  busy: ReadonlySet<string>
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left instanceof Set && right instanceof Set) {
    if (left.size !== right.size) return false
    for (const value of left) if (!right.has(value)) return false
    return true
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    )
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        sameValue(leftRecord[key], rightRecord[key]),
    )
  )
}

export class NativeWorkspace {
  api: NativeApi
  state: WorkspaceState = {
    connections: [],
    connectionId: null,
    profiles: [],
    folders: [],
    operations: [],
    probe: null,
    kernels: null,
    cloakKernels: null,
    loading: true,
    error: null,
    pendingCreateId: null,
    busy: new Set(),
  }
  private generation = 0
  private initialization: Promise<void> | null = null
  private reads = 0
  private listeners = new Set<() => void>()

  constructor(api: NativeApi) {
    this.api = api
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.state
  private publish(patch: Partial<WorkspaceState>) {
    const changed = Object.entries(patch).some(
      ([key, value]) => !sameValue(this.state[key as keyof WorkspaceState], value),
    )
    if (!changed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  initialize(preferred?: string | null): Promise<void> {
    if (this.initialization) return this.initialization
    this.initialization = this.initializeWorkspace(preferred).finally(() => {
      this.initialization = null
    })
    return this.initialization
  }

  private async initializeWorkspace(preferred?: string | null) {
    try {
      const connections = (await this.api.call(
        'browser_connection_list',
      )) as BrowserConnection[]
      this.publish({ connections })
      const selected =
        connections.find((row) => row.enabled && row.id === preferred) ??
        connections.find((row) => row.enabled && row.providerId === 'bitbrowser') ??
        connections.find((row) => row.enabled && row.providerId === 'shardbrowser') ??
        connections.find((row) => row.enabled && row.providerId === 'cloakbrowser') ??
        connections.find((row) => row.enabled)
      await this.select(selected?.id ?? null)
    } catch (error) {
      this.publish({ loading: false, error: String(error) })
      throw error
    }
  }

  async select(connectionId: string | null) {
    this.generation++
    this.publish({
      connectionId,
      profiles: [],
      folders: [],
      operations: [],
      probe: null,
      loading: !!connectionId,
      error: null,
      pendingCreateId: null,
    })
    if (connectionId) await this.refresh()
  }

  async refresh() {
    const { connectionId } = this.state
    if (!connectionId) {
      this.publish({ loading: false })
      return
    }
    const generation = this.generation
    const read = ++this.reads
    try {
      const [profiles, folders, operations, probe] = await Promise.all([
        this.api.call('browser_window_list', { connectionId }),
        this.api.call('browser_folder_list', { connectionId }),
        this.api.call('browser_operation_list', { connectionId }),
        this.api.call('browser_connection_probe', { id: connectionId }),
      ])
      if (generation !== this.generation || read !== this.reads) return
      const rows = profiles as BrowserWindow[]
      if (rows.some((row) => row.connectionId !== connectionId))
        throw new Error('Profile 返回了其他 Workspace 的数据')
      const scopedFolders = folders as NativeFolder[]
      if (scopedFolders.some((row) => row.connectionId !== connectionId))
        throw new Error('Folder 返回了其他 Workspace 的数据')
      const scopedOperations = operations as BrowserOperation[]
      const pendingCreateId =
        this.state.pendingCreateId &&
        scopedOperations.some(
          (operation) =>
            operation.id === this.state.pendingCreateId &&
            ['committed', 'cancelled', 'failed'].includes(operation.phase),
        )
          ? null
          : this.state.pendingCreateId
      this.publish({
        profiles: rows,
        folders: scopedFolders,
        operations: scopedOperations,
        probe: probe as BrowserConnectionProbe,
        loading: false,
        error: null,
        pendingCreateId,
      })
    } catch (error) {
      if (generation === this.generation && read === this.reads)
        this.publish({
          loading: false,
          error: String(error),
          probe: null,
          profiles: this.state.profiles.map((row) => ({ ...row, state: 'unknown' })),
        })
      throw error
    }
  }

  private provider(id = this.state.connectionId): BrowserProviderId | null {
    return this.state.connections.find((row) => row.id === id)?.providerId ?? null
  }

  async loadKernels(
    provider: ManagedProvider | null = this.provider() as ManagedProvider | null,
  ) {
    if (provider === 'cloakbrowser') {
      const cloakKernels = (await this.api.call('kernel_status', {
        refresh: false,
      })) as CloakKernelStatus
      this.publish({ cloakKernels })
      return
    }
    const kernels = (await this.api.call('shardbrowser_kernel_status')) as KernelStatus
    this.publish({ kernels })
  }

  createBlockReason() {
    const connection = this.state.connections.find(
      (row) => row.id === this.state.connectionId,
    )
    if (!connection) return '请先选择 Workspace'
    if (!connection.enabled) return `请在实验室启用 ${connection.name}`
    if (!['shardbrowser', 'cloakbrowser', 'bitbrowser'].includes(connection.providerId))
      return '此接入尚未接入当前工作台'
    if (this.state.loading) return '正在检查浏览器接入'
    if (!this.state.probe?.connected)
      return (
        this.state.probe?.message ??
        (connection.providerId === 'bitbrowser'
          ? '请先启动比特浏览器'
          : '请检查浏览器接入状态')
      )
    if (!this.state.probe.capabilities.create) return '此接入不支持创建 Profile'
    if (this.state.pendingCreateId) return '上次创建结果待核对，请先核对操作'
    if (
      this.state.operations.some(
        (operation) =>
          operation.kind === 'create' &&
          !['committed', 'cancelled', 'failed'].includes(operation.phase),
      )
    )
      return '上次创建结果待核对，请先核对操作'
    if (connection.providerId === 'shardbrowser' && !this.state.kernels?.installed.length)
      return '请先在实验室下载 ShardBrowser 内核'
    return null
  }

  async create(input: CreateBrowserWindowInput) {
    const blocked = this.createBlockReason()
    if (blocked) throw new Error(blocked)
    if (input.connectionId !== this.state.connectionId)
      throw new Error('Workspace 已切换，请重新打开创建弹窗')
    const generation = this.generation
    this.reads++
    this.publish({ pendingCreateId: input.operationId })
    try {
      const profile = (await this.api.call('browser_window_create', {
        input,
      })) as BrowserWindow
      if (generation === this.generation) {
        this.publish({
          pendingCreateId: null,
          profiles: [
            ...this.state.profiles.filter((row) => row.id !== profile.id),
            profile,
          ],
        })
        await this.refresh().catch(() => {})
      }
      return profile
    } catch (error) {
      if (generation === this.generation) await this.refresh().catch(() => {})
      const operation = (await this.api
        .call('browser_operation_get', { operationId: input.operationId })
        .catch(() => undefined)) as BrowserOperation | null | undefined
      if (operation?.phase === 'committed') {
        const profile = this.state.profiles.find(
          (row) =>
            row.id === operation.windowId && row.connectionId === input.connectionId,
        )
        if (generation === this.generation && profile) {
          this.publish({ pendingCreateId: null })
          return profile
        }
      }
      if (
        generation === this.generation &&
        (operation === null ||
          (operation && ['failed', 'cancelled'].includes(operation.phase)))
      )
        this.publish({ pendingCreateId: null })
      const code =
        error && typeof error === 'object' && 'code' in error ? error.code : null
      if (
        generation === this.generation &&
        [
          'invalid_config',
          'unsupported',
          'scope_mismatch',
          'connection_missing',
          'scope_unconfirmed',
        ].includes(String(code))
      )
        this.publish({ pendingCreateId: null })
      throw error
    }
  }

  private profile(id: string) {
    const profile = this.state.profiles.find(
      (row) => row.id === id && row.connectionId === this.state.connectionId,
    )
    if (!profile) throw new Error('Profile 不属于当前 Workspace')
    return profile
  }

  private async mutation(id: string, command: string, args: Record<string, unknown>) {
    if (this.state.busy.has(id)) throw new Error('Profile 操作正在进行')
    this.reads++
    this.publish({ busy: new Set([...this.state.busy, id]) })
    try {
      await this.api.call(command, args)
    } finally {
      this.publish({ busy: new Set([...this.state.busy].filter((key) => key !== id)) })
      await this.refresh().catch(() => {})
    }
  }

  async start(id: string) {
    if (this.profile(id).state !== 'stopped') throw new Error('请先核对 Profile 状态')
    await this.mutation(id, 'browser_window_start', { id })
  }
  async stop(id: string) {
    if (this.profile(id).state !== 'running') throw new Error('请先核对 Profile 状态')
    await this.mutation(id, 'browser_window_stop', { id })
  }
  async cleanupCloakSession(id: string) {
    const profile = this.profile(id)
    if (
      profile.providerId !== 'cloakbrowser' ||
      !['unknown', 'stopping'].includes(profile.state)
    )
      throw new Error('当前 Profile 无需核对残留会话')
    await this.mutation(id, 'browser_cloakbrowser_cleanup', { id })
  }
  async remove(id: string) {
    if (this.profile(id).state !== 'stopped') throw new Error('请先确认 Profile 已停止')
    await this.mutation(id, 'browser_window_delete', { id, deleteEnvironment: true })
  }
  async update(input: UpdateBrowserWindowInput) {
    if (this.profile(input.id).state !== 'stopped')
      throw new Error('请先确认 Profile 已停止')
    await this.mutation(input.id, 'browser_window_update', { input })
  }
  async move(ids: string[], groupId: string | null) {
    for (const id of ids) this.profile(id)
    await this.api.call('browser_window_move_group', {
      input: { connectionId: this.state.connectionId, ids, groupId },
    })
    await this.refresh()
  }
  async saveFolder(name: string, id?: string, meta?: FolderMeta) {
    const connectionId = this.state.connectionId
    const generation = this.generation
    if (!connectionId) throw new Error('请先选择 Workspace')
    const previous = id ? this.state.folders.find((row) => row.id === id) : undefined
    if (id && !previous) throw new Error('Folder 不存在')
    this.reads++
    const appearance = meta ?? {
      color: previous?.color ?? null,
      icon: previous?.icon ?? 'folder',
    }
    const result = await this.api.call(
      id ? 'browser_folder_update' : 'browser_folder_create',
      {
        connectionId,
        ...(id ? { id } : {}),
        name,
        note: previous?.note ?? '',
        ...appearance,
      },
    )
    const folder: NativeFolder = {
      ...(previous ?? (result as NativeFolder)),
      name,
      ...appearance,
    }
    if (this.state.connectionId !== connectionId || this.generation !== generation)
      throw new Error('Folder 已保存，Workspace 已切换')
    this.reads++
    this.publish({
      folders: [...this.state.folders.filter((row) => row.id !== folder.id), folder],
    })
    await this.refresh().catch(() => {})
    return folder
  }
  async deleteFolder(id: string) {
    await this.api.call('browser_folder_delete', {
      connectionId: this.state.connectionId,
      id,
    })
    await this.refresh()
  }
  async reconcile(operationId: string) {
    await this.api.call('browser_operation_reconcile', { operationId })
    const operation = (await this.api.call('browser_operation_get', {
      operationId,
    })) as BrowserOperation | null
    if (
      operation &&
      ['committed', 'cancelled', 'failed'].includes(operation.phase) &&
      this.state.pendingCreateId === operationId
    )
      this.publish({ pendingCreateId: null })
    await this.refresh()
  }
  async endOperation(id: string) {
    await this.api.call('browser_operation_resolve', {
      input: { action: 'abandon', id, confirmed: true },
    })
    await this.refresh()
  }
  async enable(provider: ManagedProvider, enabled: boolean) {
    const connection =
      provider === 'cloakbrowser'
        ? ((await this.api.call('browser_managed_cloakbrowser_set', {
            enabled,
          })) as BrowserConnection)
        : ((await this.api.call('browser_managed_shardbrowser_set', {
            enabled,
          })) as BrowserConnection)
    await this.initialize(enabled ? connection.id : null)
  }
}
