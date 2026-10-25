import {
  orderProfilesNewestFirst,
  type NativeProfile,
  type WindowSettings,
} from '@/lib/platform/native-profiles'
import { randomFingerprintSeed, randomWindowName } from '@/lib/random-name'
import type { WindowProxyRef } from './window-proxy'

export const MAX_BATCH_WINDOWS = 100
const MAX_SEED = 2_147_483_647

export interface BatchAccount {
  id: string
  label: string
}

export interface WindowBatchConfig {
  count: number
  namePrefix: string
  accounts?: readonly BatchAccount[]
  proxy: WindowProxyRef
  settings: WindowSettings
  groupId: string | null
}

export type BatchItemStatus = 'pending' | 'creating' | 'binding' | 'complete' | 'failed'

export interface WindowBatchItem {
  key: string
  name: string
  seed: number
  account: BatchAccount | null
  profile: NativeProfile | null
  status: BatchItemStatus
  error: string | null
  duplicateWindowIds: string[]
  attempted: boolean
}

export interface WindowBatchPorts {
  listProfiles: () => Promise<NativeProfile[]>
  createProfile: (
    name: string,
    proxy: string | null,
    proxyPlugin: string | null,
    proxyEndpoint: number | null,
    settings: WindowSettings,
    groupId: string | null,
  ) => Promise<NativeProfile>
  bindAccount: (
    accountId: string,
    windowId: string,
    confirmDuplicates: boolean,
  ) => Promise<{ bound: boolean; duplicates: string[] }>
}

export function mergeBatchProfiles(
  current: readonly NativeProfile[],
  items: readonly WindowBatchItem[],
): NativeProfile[] {
  const known = new Set(current.map((profile) => profile.id))
  const added = items.flatMap((item) =>
    item.profile && !known.has(item.profile.id) ? [item.profile] : [],
  )
  // Retrying an earlier row must not move previously completed rows above it.
  return orderProfilesNewestFirst([...added.reverse(), ...current])
}

function uniqueName(input: string, used: Set<string>): string {
  const stem = Array.from(input.trim()).slice(0, 40).join('')
  let name = stem
  for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) {
    const tail = `-${suffix}`
    name =
      Array.from(stem)
        .slice(0, 40 - tail.length)
        .join('') + tail
  }
  used.add(name.toLowerCase())
  return name
}

export function planWindowBatch(
  config: WindowBatchConfig,
  existing: readonly NativeProfile[],
  randomSeed = randomFingerprintSeed,
): WindowBatchItem[] {
  if (
    !Number.isInteger(config.count) ||
    config.count < 1 ||
    config.count > MAX_BATCH_WINDOWS
  ) {
    throw new Error(`每批可创建 1–${MAX_BATCH_WINDOWS} 个窗口。`)
  }
  if (
    config.accounts &&
    (config.accounts.length !== config.count ||
      new Set(config.accounts.map((account) => account.id)).size !== config.count)
  ) {
    throw new Error('所选账号与窗口数量不一致，或包含重复账号。')
  }
  const prefix = config.namePrefix.trim()
  if (Array.from(prefix).length > 36) throw new Error('名称前缀最多 36 个字符。')
  const names = new Set(existing.map((profile) => profile.name.trim().toLowerCase()))
  const seeds = new Set(existing.map((profile) => profile.settings.fingerprintSeed))
  return Array.from({ length: config.count }, (_, index) => {
    const account = config.accounts?.[index] ?? null
    const base = prefix
      ? `${prefix}-${String(index + 1).padStart(2, '0')}`
      : account?.label || randomWindowName([...names])
    let seed = randomSeed()
    if (!Number.isInteger(seed) || seed < 1 || seed > MAX_SEED) {
      throw new Error('随机种子生成失败，请重试。')
    }
    // Collision resolution is bounded by the number of occupied seeds, even
    // when the random source repeats. A retry reuses this plan unchanged.
    while (seeds.has(seed)) seed = (seed % MAX_SEED) + 1
    seeds.add(seed)
    return {
      key: String(index),
      name: uniqueName(base, names),
      seed,
      account: account ? { ...account } : null,
      profile: null,
      status: 'pending',
      error: null,
      duplicateWindowIds: [],
      attempted: false,
    }
  })
}

function message(cause: unknown): string {
  return typeof cause === 'string'
    ? cause
    : cause instanceof Error
      ? cause.message
      : '操作失败，请重试。'
}

/** A single in-dialog batch. Native writes are never timed out or raced. */
export class WindowBatchJob {
  private readonly config: WindowBatchConfig
  private rows: WindowBatchItem[]
  private active: Promise<void> | null = null
  private stopRequested = false

  constructor(
    config: WindowBatchConfig,
    existing: readonly NativeProfile[],
    private readonly ports: WindowBatchPorts,
    randomSeed = randomFingerprintSeed,
  ) {
    this.config = {
      ...config,
      proxy: { ...config.proxy },
      settings: { ...config.settings },
      ...(config.accounts
        ? { accounts: config.accounts.map((account) => ({ ...account })) }
        : {}),
    }
    this.rows = planWindowBatch(this.config, existing, randomSeed)
  }

  get items(): readonly WindowBatchItem[] {
    return this.rows
  }

  stopAfterCurrent(): void {
    this.stopRequested = true
  }

  run(
    onChange: (items: readonly WindowBatchItem[]) => void,
    confirmedAccounts: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (this.active) return this.active
    this.stopRequested = false
    const confirmed = new Set(confirmedAccounts)
    // Install the guard before executing any callback or invoking native code.
    this.active = Promise.resolve()
      .then(() => this.execute(onChange, confirmed))
      .finally(() => {
        this.active = null
      })
    return this.active
  }

  private patch(
    key: string,
    patch: Partial<WindowBatchItem>,
    onChange: (items: readonly WindowBatchItem[]) => void,
  ): WindowBatchItem {
    const next = this.rows.map((row) => (row.key === key ? { ...row, ...patch } : row))
    this.rows = next
    onChange(next)
    return next.find((row) => row.key === key)!
  }

  private async findCreated(item: WindowBatchItem): Promise<NativeProfile | null> {
    const profiles = await this.ports.listProfiles()
    const matches = profiles.filter(
      (profile) =>
        profile.name === item.name && profile.settings.fingerprintSeed === item.seed,
    )
    if (matches.length > 1) {
      throw new Error('存在多个相同名称和种子的窗口，请先在窗口管理中核对。')
    }
    return matches[0] ?? null
  }

  private async execute(
    onChange: (items: readonly WindowBatchItem[]) => void,
    confirmed: ReadonlySet<string>,
  ): Promise<void> {
    for (const original of this.rows) {
      if (this.stopRequested) break
      if (original.status === 'complete') continue
      let item = this.patch(
        original.key,
        {
          status: original.profile ? 'binding' : 'creating',
          error: null,
          duplicateWindowIds: [],
        },
        onChange,
      )
      try {
        if (!item.profile && item.attempted) {
          // A backend write can succeed before its response fails. Reconcile
          // first; if listing fails, do not issue another create.
          item = this.patch(item.key, { profile: await this.findCreated(item) }, onChange)
        }
        if (!item.profile) {
          item = this.patch(item.key, { attempted: true }, onChange)
          let profile: NativeProfile
          try {
            const { proxy, settings, groupId } = this.config
            profile = await this.ports.createProfile(
              item.name,
              proxy.proxy,
              proxy.proxyPlugin,
              proxy.proxyEndpoint,
              { ...settings, fingerprintSeed: item.seed },
              groupId,
            )
          } catch (cause) {
            let recovered: NativeProfile | null
            try {
              recovered = await this.findCreated(item)
            } catch {
              throw new Error(`创建结果尚未确认；重试会先核对窗口列表。${message(cause)}`)
            }
            if (!recovered) throw cause
            profile = recovered
          }
          item = this.patch(item.key, { profile }, onChange)
        }
        const profile = item.profile
        if (!profile) throw new Error('窗口创建结果缺失，请重试核对。')
        const account = item.account
        if (account) {
          item = this.patch(item.key, { status: 'binding' }, onChange)
          const result = await this.ports.bindAccount(
            account.id,
            profile.id,
            confirmed.has(account.id),
          )
          if (!result.bound) {
            this.patch(
              item.key,
              {
                status: 'failed',
                duplicateWindowIds: result.duplicates,
                error: '窗口已创建；该账号已有其他关联，请确认后重试关联。',
              },
              onChange,
            )
            continue
          }
        }
        this.patch(item.key, { status: 'complete', error: null }, onChange)
      } catch (cause) {
        this.patch(
          item.key,
          {
            status: 'failed',
            error: item.profile
              ? `窗口已创建，账号关联失败：${message(cause)}`
              : message(cause),
          },
          onChange,
        )
      }
    }
  }
}
