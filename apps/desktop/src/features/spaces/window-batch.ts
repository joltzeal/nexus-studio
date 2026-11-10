import type {
  BrowserConnection,
  CreateBrowserWindowInput,
  ProxyMode,
} from '@nexus/contracts/browser'
import {
  orderBrowserWindows,
  type BrowserWindow,
  type WindowSettings,
} from '@/lib/platform/windows'
import { randomFingerprintSeed, randomWindowName } from '@/lib/random-name'
import { isKernelVersion } from '@/lib/platform/native-kernels'
import type { WindowProxyRef } from './window-proxy'

export const MAX_BATCH_WINDOWS = 100
const MAX_SEED = 2_147_483_647

export interface BatchAccount {
  id: string
  label: string
}

export interface WindowBatchConfig {
  connection: BrowserConnection
  count: number
  namePrefix: string
  accounts?: readonly BatchAccount[]
  proxy: WindowProxyRef & { proxyMode: ProxyMode }
  settings: WindowSettings
  groupId: string | null
  kernelVersion: string | null
}

export type BatchItemStatus = 'pending' | 'creating' | 'binding' | 'complete' | 'failed'

export interface WindowBatchItem {
  key: string
  name: string
  seed: number | null
  operationId: string
  input: CreateBrowserWindowInput | null
  account: BatchAccount | null
  window: BrowserWindow | null
  status: BatchItemStatus
  error: string | null
  duplicateWindowIds: string[]
}

export interface WindowBatchPorts {
  createWindow: (input: CreateBrowserWindowInput) => Promise<BrowserWindow>
  reconcileOperation: (operationId: string) => Promise<BrowserWindow | null>
  bindAccount: (
    accountId: string,
    windowId: string,
    confirmDuplicates: boolean,
  ) => Promise<{ bound: boolean; duplicates: string[] }>
}

export function mergeBatchWindows(
  current: readonly BrowserWindow[],
  items: readonly WindowBatchItem[],
): BrowserWindow[] {
  const known = new Set(current.map((profile) => profile.id))
  const added = items.flatMap((item) =>
    item.window && !known.has(item.window.id) ? [item.window] : [],
  )
  // Retrying an earlier row must not move previously completed rows above it.
  return orderBrowserWindows([...added.reverse(), ...current])
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
  existing: readonly BrowserWindow[],
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
  if (config.kernelVersion != null && !isKernelVersion(config.kernelVersion)) {
    throw new Error('请选择有效的完整内核包版本。')
  }
  const names = new Set(existing.map((profile) => profile.name.trim().toLowerCase()))
  const seeds = new Set(existing.map((profile) => profile.settings.fingerprintSeed))
  return Array.from({ length: config.count }, (_, index) => {
    const account = config.accounts?.[index] ?? null
    const base = prefix
      ? `${prefix}-${String(index + 1).padStart(2, '0')}`
      : account?.label || randomWindowName([...names])
    let seed: number | null = null
    if (
      config.connection.providerId === 'cloakbrowser' &&
      config.connection.capabilities.fingerprintSeed
    ) {
      seed = randomSeed()
      if (!Number.isInteger(seed) || seed < 1 || seed > MAX_SEED)
        throw new Error('随机种子生成失败，请重试。')
      while (seeds.has(seed)) seed = (seed % MAX_SEED) + 1
      seeds.add(seed)
    }
    return {
      key: String(index),
      name: uniqueName(base, names),
      seed,
      operationId: crypto.randomUUID(),
      input: null,
      account: account ? { ...account } : null,
      window: null,
      status: 'pending',
      error: null,
      duplicateWindowIds: [],
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
  private resolvedKernelVersion: string | null

  constructor(
    config: WindowBatchConfig,
    existing: readonly BrowserWindow[],
    private readonly ports: WindowBatchPorts,
    randomSeed = randomFingerprintSeed,
  ) {
    this.config = {
      ...config,
      connection: {
        ...config.connection,
        capabilities: { ...config.connection.capabilities },
      },
      proxy: { ...config.proxy },
      settings: { ...config.settings },
      ...(config.accounts
        ? { accounts: config.accounts.map((account) => ({ ...account })) }
        : {}),
    }
    this.rows = planWindowBatch(this.config, existing, randomSeed)
    this.resolvedKernelVersion = this.config.kernelVersion ?? null
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

  private async recover(item: WindowBatchItem): Promise<BrowserWindow> {
    const recovered = await this.ports.reconcileOperation(item.operationId)
    if (recovered) return recovered
    throw new Error('创建结果尚未确认，请先核对持久化操作；不会重复创建环境。')
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
          status: original.window ? 'binding' : 'creating',
          error: null,
          duplicateWindowIds: [],
        },
        onChange,
      )
      try {
        if (!item.window) {
          // Every manual retry sends the frozen UUID and payload to the idempotent
          // backend. Only the backend decides whether to reconcile or submit.
          const input: CreateBrowserWindowInput = item.input ?? {
            operationId: item.operationId,
            connectionId: this.config.connection.id,
            name: item.name,
            proxyMode: this.config.proxy.proxyMode,
            proxy: this.config.proxy.proxy,
            proxyPlugin: this.config.proxy.proxyPlugin,
            proxyEndpoint: this.config.proxy.proxyEndpoint,
            settings: { ...this.config.settings, fingerprintSeed: item.seed },
            groupId: this.config.groupId,
            kernelVersion:
              this.config.connection.providerId === 'cloakbrowser'
                ? this.resolvedKernelVersion
                : null,
          }
          item = this.patch(item.key, { input }, onChange)
          let created: BrowserWindow
          try {
            created = await this.ports.createWindow(input)
          } catch (cause) {
            try {
              created = await this.recover(item)
            } catch {
              throw new Error(`创建结果待核对：${message(cause)}`)
            }
          }
          item = this.patch(item.key, { window: created }, onChange)
        }
        const profile = item.window
        if (!profile) throw new Error('窗口创建结果缺失，请重试核对。')
        // Freeze only the package version reported by the bound profile. Chrome's
        // display version can omit a revision and must never be used for pinning.
        if (
          this.config.connection.providerId === 'cloakbrowser' &&
          this.resolvedKernelVersion === null &&
          isKernelVersion(profile.kernelVersion)
        ) {
          this.resolvedKernelVersion = profile.kernelVersion
        }
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
            error: item.window
              ? `窗口已创建，账号关联失败：${message(cause)}`
              : message(cause),
          },
          onChange,
        )
      }
    }
  }
}
