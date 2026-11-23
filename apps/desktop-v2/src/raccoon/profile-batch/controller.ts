import {
  BrowserWindowSchema,
  CreateBrowserWindowInputSchema,
  type BrowserConnection,
  type BrowserOperation,
  type BrowserWindow,
  type CreateBrowserWindowInput,
} from '@nexus/contracts/browser'

export const MAX_BATCH_PROFILES = 100
const MAX_SEED = 2_147_483_647
const CLOAK_MIN_SEED = 10_000
const CLOAK_MAX_SEED = 99_999
const REJECTED_BEFORE_CREATE = new Set([
  'invalid_config', 'unsupported', 'auth_required', 'permission_denied',
  'not_submitted', 'rate_limited', 'profile_busy', 'profile_missing',
])

export type ProfileBatchTarget = { id: string; name: string }
export type ProfileBatchStatus =
  | 'pending'
  | 'creating'
  | 'binding'
  | 'complete'
  | 'create_failed'
  | 'uncertain'
  | 'binding_failed'

export type ProfileBatchItem = {
  targetId: string
  targetName: string
  name: string
  operationId: string
  profileId: string | null
  profile: BrowserWindow | null
  input: CreateBrowserWindowInput | null
  seed: number | null
  status: ProfileBatchStatus
  error: string | null
}
export type ProfileBatchTemplate = Omit<
  CreateBrowserWindowInput,
  'operationId' | 'connectionId' | 'name'
>
export type ProfileBatchConfig = {
  connection: BrowserConnection
  targets: readonly ProfileBatchTarget[]
  namePrefix: string
  template: ProfileBatchTemplate
}
export type ProfileBatchPorts = {
  checkConnection(connection: BrowserConnection, operationId?: string): Promise<void>
  create(input: CreateBrowserWindowInput): Promise<BrowserWindow>
  operationStatus(operationId: string): Promise<BrowserOperation | null>
  reconcile(operationId: string): Promise<BrowserWindow | null>
  onBind(targetId: string, profileId: string): Promise<void>
}

export function batchError(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : typeof cause === 'string'
      ? cause
      : '操作失败，请重试'
}

function uniqueName(value: string, used: Set<string>): string {
  const stem = Array.from(value.trim() || 'Profile')
    .slice(0, 40)
    .join('')
  let name = stem
  for (let count = 2; used.has(name.toLocaleLowerCase()); count++) {
    const suffix = `-${count}`
    name =
      Array.from(stem)
        .slice(0, 40 - suffix.length)
        .join('') + suffix
  }
  used.add(name.toLocaleLowerCase())
  return name
}

function seedBounds(provider: BrowserConnection['providerId']) {
  return provider === 'cloakbrowser'
    ? { min: CLOAK_MIN_SEED, max: CLOAK_MAX_SEED }
    : { min: 1, max: MAX_SEED }
}

export function batchConnectionProblem(connection: BrowserConnection): string | null {
  if (!connection.enabled) return '此 Workspace 尚未启用'
  if (!connection.scopeConfirmed) return '请先在设置中确认当前厂商账号或 Workspace'
  if (!connection.capabilities.create) return '此 Workspace 不支持创建 Profile'
  return null
}

export function pendingCreateProblem(
  operations: readonly BrowserOperation[],
  connectionId: string,
  ownOperationId?: string,
): string | null {
  if (operations.some((operation) => operation.connectionId !== connectionId))
    return '操作清单不属于当前 Workspace，已阻止创建'
  return operations.some(
    (operation) =>
      operation.kind === 'create' &&
      operation.id !== ownOperationId &&
      !['committed', 'failed', 'cancelled'].includes(operation.phase),
  )
    ? '此 Workspace 有创建结果尚未核对，请先在 Profile 操作中核对后再新建'
    : null
}

export function validBatchKernel(
  provider: BrowserConnection['providerId'],
  engine: string | null,
  version: string | null,
): version is string {
  if (!version) return false
  if (provider === 'aliasmode')
    return engine === 'firefox'
      ? version.length <= 80 && /^aliasmode-runtime-[a-zA-Z0-9.-]+-r\d+$/.test(version)
      : version.length <= 64 && /^\d+(?:\.\d+){3}-aliasmode\.\d+$/.test(version)
  return version.length <= 48 && /^\d+(?:\.\d+){3,4}$/.test(version)
}

/** One explicit batch. The native service owns idempotency and uncertain-write recovery. */
export class ProfileBatchController {
  private readonly config: ProfileBatchConfig
  private rows: ProfileBatchItem[]
  private active: Promise<void> | null = null
  private stopping = false
  private kernelVersion: string | null
  private readonly ports: ProfileBatchPorts

  constructor(
    config: ProfileBatchConfig,
    existing: readonly BrowserWindow[],
    ports: ProfileBatchPorts,
    randomSeed?: () => number,
  ) {
    this.ports = ports
    if (!config.targets.length || config.targets.length > MAX_BATCH_PROFILES)
      throw new Error(`每批请选择 1–${MAX_BATCH_PROFILES} 个目标`)
    if (
      config.targets.some((target) => !target.id) ||
      new Set(config.targets.map((target) => target.id)).size !== config.targets.length
    )
      throw new Error('批量目标包含无效或重复标识')
    const problem = batchConnectionProblem(config.connection)
    if (problem) throw new Error(problem)
    if (Array.from(config.namePrefix.trim()).length > 36)
      throw new Error('名称前缀最多 36 个字符')
    if (existing.some((profile) => profile.connectionId !== config.connection.id))
      throw new Error('Profile 清单不属于所选 Workspace')
    this.config = structuredClone(config)
    this.kernelVersion = config.template.kernelVersion
    const names = new Set(
      existing.map((profile) => profile.name.trim().toLocaleLowerCase()),
    )
    const bounds = seedBounds(config.connection.providerId)
    const seedRange = bounds.max - bounds.min + 1
    const seeds = new Set(existing.flatMap((profile) => {
      const seed = profile.settings.fingerprintSeed
      return seed !== null && seed >= bounds.min && seed <= bounds.max ? [seed] : []
    }))
    const managed = ['shardbrowser', 'cloakbrowser', 'aliasmode'].includes(
      config.connection.providerId,
    )
    const generateSeed =
      randomSeed ??
      (() => bounds.min + (crypto.getRandomValues(new Uint32Array(1))[0] % seedRange))
    this.rows = config.targets.map((target, index) => {
      let seed: number | null = null
      if (managed && config.connection.capabilities.fingerprintSeed) {
        if (seeds.size >= seedRange) throw new Error('此 Workspace 的指纹种子已用完')
        seed = generateSeed()
        if (!Number.isInteger(seed) || seed < bounds.min || seed > bounds.max)
          throw new Error('指纹种子生成失败')
        while (seeds.has(seed))
          seed = seed >= bounds.max ? bounds.min : seed + 1
        seeds.add(seed)
      }
      const base = config.namePrefix.trim()
        ? `${config.namePrefix.trim()}-${String(index + 1).padStart(2, '0')}`
        : target.name
      return {
        targetId: target.id,
        targetName: target.name,
        name: uniqueName(base, names),
        operationId: crypto.randomUUID(),
        profileId: null,
        profile: null,
        input: null,
        seed,
        status: 'pending',
        error: null,
      }
    })
  }

  get items(): readonly ProfileBatchItem[] {
    return this.rows
  }
  get running(): boolean {
    return this.active !== null
  }
  stopAfterCurrent(): void {
    this.stopping = true
  }

  run(
    onChange: (items: readonly ProfileBatchItem[]) => void,
    selected?: ReadonlySet<string>,
  ): Promise<void> {
    if (this.active) return this.active
    this.stopping = false
    const ids = selected ? new Set(selected) : null
    this.active = Promise.resolve()
      .then(() => this.execute(onChange, ids))
      .finally(() => {
        this.active = null
      })
    return this.active
  }

  private patch(
    targetId: string,
    patch: Partial<ProfileBatchItem>,
    onChange: (items: readonly ProfileBatchItem[]) => void,
  ) {
    this.rows = this.rows.map((row) =>
      row.targetId === targetId ? { ...row, ...patch } : row,
    )
    onChange(this.rows)
    return this.rows.find((row) => row.targetId === targetId)!
  }

  private checkedProfile(value: BrowserWindow): BrowserWindow {
    const profile = BrowserWindowSchema.parse(value)
    if (
      profile.connectionId !== this.config.connection.id ||
      profile.providerId !== this.config.connection.providerId
    )
      throw new Error('创建结果不属于本批 Workspace，已阻止自动关联')
    return profile
  }

  private kernelMatches(profile: BrowserWindow): boolean {
    return (
      validBatchKernel(
        this.config.connection.providerId,
        this.config.template.settings.aliasEngine,
        profile.kernelVersion,
      ) &&
      (this.kernelVersion === null || this.kernelVersion === profile.kernelVersion)
    )
  }

  private async recoverCreate(operationId: string, cause: unknown) {
    const operation = await this.ports.operationStatus(operationId).catch(() => undefined)
    const code = cause instanceof Error && 'code' in cause ? String(cause.code) : ''
    if (code === 'operation_conflict') return null
    if (operation === null && REJECTED_BEFORE_CREATE.has(code)) throw cause
    if (operation && (
      operation.id !== operationId ||
      operation.connectionId !== this.config.connection.id ||
      operation.kind !== 'create'
    )) return null
    if (operation?.phase === 'failed' || operation?.phase === 'cancelled')
      throw new Error(operation.message ?? batchError(cause))
    return this.ports.reconcile(operationId).catch(() => null)
  }

  private async execute(
    onChange: (items: readonly ProfileBatchItem[]) => void,
    selected: ReadonlySet<string> | null,
  ) {
    const managed = ['shardbrowser', 'cloakbrowser', 'aliasmode'].includes(
      this.config.connection.providerId,
    )
    const unresolvedKernel =
      managed && this.rows.find((row) => row.profile && !this.kernelMatches(row.profile))
    if (unresolvedKernel && selected && !selected.has(unresolvedKernel.targetId)) return
    for (const original of this.rows) {
      if (this.stopping) break
      if (
        original.status === 'complete' ||
        (selected && !selected.has(original.targetId))
      )
        continue
      let item = original
      try {
        if (!item.profile) {
          await this.ports.checkConnection(
            structuredClone(this.config.connection),
            item.operationId,
          )
          item = this.patch(item.targetId, { status: 'creating', error: null }, onChange)
          const input =
            item.input ??
            CreateBrowserWindowInputSchema.parse({
              ...structuredClone(this.config.template),
              operationId: item.operationId,
              connectionId: this.config.connection.id,
              name: item.name,
              settings: { ...this.config.template.settings, fingerprintSeed: item.seed },
              kernelVersion: ['shardbrowser', 'cloakbrowser', 'aliasmode'].includes(
                this.config.connection.providerId,
              )
                ? this.kernelVersion
                : this.config.template.kernelVersion,
            })
          item = this.patch(item.targetId, { input }, onChange)
          let created: BrowserWindow
          try {
            // Retries use exactly the same persisted intent. Native code decides
            // whether it may submit or must reconcile a previous write.
            created = await this.ports.create(structuredClone(input))
          } catch (cause) {
            const recovered = await this.recoverCreate(item.operationId, cause)
            if (!recovered) {
              this.patch(
                item.targetId,
                {
                  status: 'uncertain',
                  error: `创建结果待核对，重试将使用同一操作标识。${batchError(cause)}`,
                },
                onChange,
              )
              continue
            }
            created = recovered
          }
          const profile = this.checkedProfile(created)
          if (
            this.rows.some(
              (row) => row.targetId !== item.targetId && row.profileId === profile.id,
            )
          )
            throw new Error(
              '创建结果重复使用了本批其他目标的 Profile，已阻止自动关联，请核对原生操作',
            )
          item = this.patch(item.targetId, { profile, profileId: profile.id }, onChange)
        }
        if (managed && item.profile && !this.kernelMatches(item.profile)) {
          const recovered = original.profileId
            ? await this.ports.reconcile(item.operationId).catch(() => null)
            : null
          if (recovered) {
            const profile = this.checkedProfile(recovered)
            if (profile.id !== item.profileId)
              throw new Error('协调结果的 Profile 标识与已创建记录不一致')
            item = this.patch(item.targetId, { profile }, onChange)
          }
          if (!item.profile || !this.kernelMatches(item.profile)) {
            this.patch(
              item.targetId,
              {
                status: 'uncertain',
                error:
                  'Profile 已创建，但完整内核版本尚未确认。本批已停止，请核对后重试。',
              },
              onChange,
            )
            this.stopping = true
            break
          }
        }
        if (managed && this.kernelVersion === null && item.profile)
          this.kernelVersion = item.profile.kernelVersion
        if (!item.profileId) throw new Error('Profile 创建结果缺失')
        item = this.patch(item.targetId, { status: 'binding', error: null }, onChange)
        await this.ports.onBind(item.targetId, item.profileId!)
        this.patch(item.targetId, { status: 'complete', error: null }, onChange)
      } catch (cause) {
        if (managed && item.profile && !this.kernelMatches(item.profile)) {
          this.stopping = true
          this.patch(
            item.targetId,
            {
              status: 'uncertain',
              error: `Profile 已创建，内核信息尚未确认，本批已停止。${batchError(cause)}`,
            },
            onChange,
          )
          break
        }
        this.patch(
          item.targetId,
          {
            status: item.profileId ? 'binding_failed' : 'create_failed',
            error: item.profileId
              ? `Profile 已创建，关联尚未完成。${batchError(cause)}`
              : batchError(cause),
          },
          onChange,
        )
      }
    }
  }
}

export async function prepareProfileBatch(
  config: ProfileBatchConfig,
  ports: ProfileBatchPorts,
  readProfiles: () => Promise<BrowserWindow[]>,
  current: () => boolean,
): Promise<ProfileBatchController | null> {
  if (!current()) return null
  const snapshot = structuredClone(config)
  await ports.checkConnection(structuredClone(snapshot.connection))
  if (!current()) return null
  const profiles = await readProfiles()
  if (!current()) return null
  return new ProfileBatchController(snapshot, profiles, ports)
}
