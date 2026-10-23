import type { ProxyProvider, ProxyResolution } from '@nexus/plugin-sdk'

import { buildConnectionUrl, buildRedactedUrl } from '../domain/credentials.js'
import { invalidRequest, notConfigured } from '../domain/errors.js'
import {
  AppendInputSchema,
  CheckInputSchema,
  ConfigureInputSchema,
  DecodoInputSchema,
  ImportInputSchema,
  IdInputSchema,
  ListInputSchema,
  ProxyGroupInputSchema,
  ProxyInputSchema,
  ProbeInputSchema,
  ProxyUrlInputSchema,
  ResolveInputSchema,
  SelectionInputSchema,
  SubscriptionInputSchema,
  SubscriptionTokenInputSchema,
  parseOrThrow,
  type EndpointRecord,
  type Scheme,
  type SubscriptionRecord,
} from '../domain/schemas.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import {
  checkEndpoint,
  chooseScheme,
  describeTarget,
  probeProxy,
  type CheckDependencies,
} from '../services/check.js'
import { createGroup, listGroups, requireGroup } from '../services/groups.js'
import { decodoInputs, parseImportInput } from '../services/import.js'
import {
  createEndpoint,
  deleteEndpoints,
  findEndpoint,
  importEndpoints,
  selectedEndpoints,
  toPublic,
  updateEndpoint,
} from '../services/inventory.js'
import {
  newSubscriptionToken,
  parseBaseConfig,
  renderClash,
  renderBaseConfig,
  resolveRows,
  tokenMatches,
  validateGroupName,
  validateSubscriptionSource,
  writeSubscriptionFile,
} from '../services/subscription.js'
import type { PrivateStore, StoreDocument } from '../store/private-store.js'
import type { SecretVault } from '../store/secret-vault.js'
import { ProxyTransfer, TRANSFER_METHODS } from '../services/transfer.js'

export const PROXY_METHODS = [
  'proxy.list',
  'proxy.get',
  'proxy.create',
  'proxy.update',
  'proxy.delete',
  'proxy.import',
  'proxy.strategy.decodo',
  'proxy.check',
  'proxy.probe',
  'proxy.exportUrls',
  'proxy.resolve',
  'proxy.describe',
  'proxy.groups.list',
  'proxy.groups.create',
  'proxy.config.get',
  'proxy.config.set',
  'proxy.subscriptions.list',
  'proxy.subscriptions.get',
  'proxy.subscriptions.create',
  'proxy.subscriptions.update',
  'proxy.subscriptions.delete',
  'proxy.subscriptions.preview',
  'proxy.subscriptions.export',
  'proxy.subscriptions.download',
  'proxy.subscriptions.link',
  'proxy.subscriptions.resetToken',
  'proxy.subscriptions.append',
  ...TRANSFER_METHODS,
] as const

export interface ProxyPoolDependencies {
  store: PrivateStore
  vault: SecretVault
  logger: Logger
  check: Omit<CheckDependencies, 'vault'>
  now?: () => Date
}

function handleFor(row: EndpointRecord): string {
  // Opaque to the host: no host, port, account or credential is encoded.
  return `nxproxy:v1:endpoint:${row.id}`
}

function referenceFor(row: EndpointRecord): ProxyResolution {
  return {
    configHandle: handleFor(row),
    ...(row.secretRef === null ? {} : { secretRef: row.secretRef }),
  }
}

export class ProxyPool implements ProxyProvider {
  readonly id = 'proxy.provider'
  readonly name = '代理池'
  private readonly store: PrivateStore
  private readonly vault: SecretVault
  private readonly logger: Logger
  private readonly checkDeps: Omit<CheckDependencies, 'vault'>
  private readonly now: () => Date
  private readonly transfer: ProxyTransfer

  constructor(dependencies: ProxyPoolDependencies) {
    this.store = dependencies.store
    this.vault = dependencies.vault
    this.logger = dependencies.logger
    this.checkDeps = dependencies.check
    this.now = dependencies.now ?? (() => new Date())
    this.transfer = new ProxyTransfer(this.store, this.vault)
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  /** ProxyProvider contract: the selected endpoint, never a silent direct connection. */
  async resolve(): Promise<ProxyResolution | null> {
    const row = await this.resolveEndpoint(null)
    return row === null ? null : referenceFor(row)
  }

  /**
   * `endpointId` pins one row of the pool to a window. Without it the window
   * follows the plugin's default endpoint, which is what an older window
   * record implies.
   */
  private async resolveEndpoint(
    endpointId: number | null,
  ): Promise<EndpointRecord | null> {
    const document = await this.store.read()
    const id = endpointId ?? document.config.defaultEndpointId
    if (id === null) return null
    const row = document.endpoints.find((entry) => entry.id === id && !entry.deleted)
    if (row === undefined) {
      throw notConfigured(
        endpointId === null
          ? '默认代理已被删除，请在插件配置中重新选择'
          : '窗口指定的代理已被删除，请重新选择',
      )
    }
    if (!row.enabled) {
      throw notConfigured(
        endpointId === null
          ? '默认代理已停用，窗口启动被阻断'
          : '窗口指定的代理已停用，窗口启动被阻断',
      )
    }
    return row
  }

  status(): Record<string, unknown> {
    return {
      storage: {
        kind: this.store.kind,
        durable: this.store.durable,
        canExportFiles: this.store.exportDirectory !== null,
      },
      vault: { kind: this.vault.kind, durable: this.vault.durable },
    }
  }

  async call(context: DispatchContext): Promise<unknown> {
    const { method, payload } = context
    switch (method) {
      case 'transfer.export':
      case 'transfer.import':
      case 'transfer.rollback':
      case 'transfer.commit':
        return this.transfer.call(context)
      case 'proxy.list':
        return this.list(payload)
      case 'proxy.get':
        return this.get(payload)
      case 'proxy.create':
        return this.create(payload)
      case 'proxy.update':
        return this.update(payload)
      case 'proxy.delete':
        return this.remove(payload)
      case 'proxy.import':
        return this.import(payload)
      case 'proxy.strategy.decodo':
        return this.decodo(payload)
      case 'proxy.check':
        return this.check(payload, context)
      case 'proxy.probe':
        return this.probe(payload)
      case 'proxy.exportUrls':
        return this.exportUrls(payload)
      case 'proxy.resolve': {
        // A window may pin one endpoint; otherwise the default applies.
        const { endpointId } = parseOrThrow(
          ResolveInputSchema,
          payload ?? {},
          '代理解析参数',
        )
        const row = await this.resolveEndpoint(endpointId)
        if (row === null) {
          return { configured: false, configHandle: null, secretRef: null }
        }
        // Materialize from the same row snapshot as the opaque reference.
        // Missing credentials must fail rather than produce an anonymous URL.
        const password =
          row.secretRef === null ? '' : await this.vault.resolve(row.secretRef)
        return {
          configured: true,
          ...referenceFor(row),
          connectionUrl: buildConnectionUrl(
            chooseScheme(row, null),
            row.host,
            row.port,
            row.username,
            password,
          ),
        }
      }
      case 'proxy.describe':
        return this.describe(payload)
      case 'proxy.groups.list':
        return { items: listGroups(await this.store.read()) }
      case 'proxy.groups.create':
        return this.createGroup(payload)
      case 'proxy.config.get':
        return this.configView(await this.store.read())
      case 'proxy.config.set':
        return this.configure(payload)
      case 'proxy.subscriptions.list':
        return this.listSubscriptions()
      case 'proxy.subscriptions.get':
        return this.getSubscription(payload)
      case 'proxy.subscriptions.create':
        return this.createSubscription(payload)
      case 'proxy.subscriptions.update':
        return this.updateSubscription(payload)
      case 'proxy.subscriptions.delete':
        return this.deleteSubscription(payload)
      case 'proxy.subscriptions.preview':
        return this.previewSubscription(payload)
      case 'proxy.subscriptions.export':
        return this.exportById(payload)
      case 'proxy.subscriptions.download':
        return this.downloadSubscription(payload)
      case 'proxy.subscriptions.link':
        return this.subscriptionLink(payload)
      case 'proxy.subscriptions.resetToken':
        return this.resetToken(payload)
      case 'proxy.subscriptions.append':
        return this.appendProxies(payload)
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }

  private async list(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(ListInputSchema, payload, '列表参数')
    if (
      input.riskMin !== null &&
      input.riskMax !== null &&
      input.riskMin > input.riskMax
    ) {
      throw invalidRequest('风险分数范围无效')
    }
    const document = await this.store.read()
    const keyword = input.keyword.toLowerCase()
    const scheme: Scheme | null = input.scheme
    let rows = document.endpoints.filter((row) => !row.deleted)
    if (keyword !== '') {
      rows = rows.filter(
        (row) => row.name.toLowerCase().includes(keyword) || row.host.includes(keyword),
      )
    }
    if (scheme !== null) rows = rows.filter((row) => row.schemes.includes(scheme))
    if (input.enabled !== null) {
      rows = rows.filter((row) => row.enabled === input.enabled)
    }
    if (input.ungrouped) rows = rows.filter((row) => row.groupId === null)
    else if (input.groupId !== null) {
      rows = rows.filter((row) => row.groupId === input.groupId)
    }
    if (input.isProxy !== null) rows = rows.filter((row) => row.isProxy === input.isProxy)
    if (input.isVpn !== null) rows = rows.filter((row) => row.isVpn === input.isVpn)
    if (input.isHosting !== null) {
      rows = rows.filter((row) => row.isHosting === input.isHosting)
    }
    const riskMin = input.riskMin
    const riskMax = input.riskMax
    if (riskMin !== null) {
      rows = rows.filter((row) => row.riskScore !== null && row.riskScore >= riskMin)
    }
    if (riskMax !== null) {
      rows = rows.filter((row) => row.riskScore !== null && row.riskScore <= riskMax)
    }
    rows.sort((left, right) => right.id - left.id)
    return {
      total: rows.length,
      offset: input.offset,
      limit: input.limit,
      items: rows.slice(input.offset, input.offset + input.limit).map(toPublic),
    }
  }

  private async get(payload: unknown): Promise<unknown> {
    const { id } = parseOrThrow(IdInputSchema, payload, '代理标识')
    const document = await this.store.read()
    const row = findEndpoint(document, id)
    const group = document.groups.find((entry) => entry.id === row.groupId)
    return { ...toPublic(row), groupName: group?.name ?? null }
  }

  private async create(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(ProxyInputSchema, payload, '代理参数')
    const row = await this.store.mutate(async (document) => {
      requireGroup(document, input.groupId)
      return createEndpoint(document, input, {
        vault: this.vault,
        now: () => this.timestamp(),
      })
    })
    this.logger.info('已创建代理', { id: row.id })
    return toPublic(row)
  }

  private async update(payload: unknown): Promise<unknown> {
    const { id, rest } = withoutId(payload)
    const input = parseOrThrow(ProxyInputSchema, rest, '代理参数')
    const row = await this.store.mutate(async (document) => {
      requireGroup(document, input.groupId)
      const existing = findEndpoint(document, id)
      return updateEndpoint(document, input, {
        vault: this.vault,
        now: () => this.timestamp(),
        existing,
      })
    })
    this.logger.info('已更新代理', { id: row.id })
    return toPublic(row)
  }

  private async remove(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(SelectionInputSchema, payload, '选中参数')
    const deleted = await this.store.mutate((document) =>
      deleteEndpoints(document, input.ids, {
        vault: this.vault,
        now: () => this.timestamp(),
      }),
    )
    this.logger.info('已删除代理', { count: deleted })
    return { deleted }
  }

  private async import(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(ImportInputSchema, payload, '导入参数')
    const rows = parseImportInput(input)
    const result = await this.store.mutate(async (document) => {
      requireGroup(document, input.groupId)
      return importEndpoints(document, rows, {
        vault: this.vault,
        now: () => this.timestamp(),
      })
    })
    this.logger.info('已导入代理', { ...result })
    return result
  }

  private async decodo(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(DecodoInputSchema, payload, 'Decodo 策略参数')
    const rows = decodoInputs(input)
    const result = await this.store.mutate(async (document) => {
      requireGroup(document, input.groupId)
      return importEndpoints(document, rows, {
        vault: this.vault,
        now: () => this.timestamp(),
      })
    })
    this.logger.info('已生成 Decodo 代理', { ...result })
    return result
  }

  private async check(payload: unknown, context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(CheckInputSchema, payload, '检测参数')
    return checkEndpoint(
      this.store,
      input.id,
      input,
      { ...this.checkDeps, vault: this.vault },
      { assertAlive: context.assertAlive },
    )
  }

  /** Same measurement as `proxy.check`, for a URL that is not in the pool. */
  private async probe(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(ProbeInputSchema, payload, '代理地址')
    return probeProxy(input.url, { ...this.checkDeps, now: this.now })
  }

  private async exportUrls(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(ProxyUrlInputSchema, payload, '导出参数')
    const document = await this.store.read()
    const rows = selectedEndpoints(document, input.ids)
    const urls = rows.map((row) => {
      const scheme =
        row.schemes.length === 1
          ? (row.schemes[0] ?? chooseScheme(row, input.preferredScheme))
          : chooseScheme(row, input.preferredScheme)
      return buildRedactedUrl(scheme, row.host, row.port, row.username)
    })
    // Display exports omit passwords; only proxy.resolve materializes credentials.
    return {
      urls,
      count: urls.length,
      requiresSecret: rows.some((row) => row.secretRef !== null),
    }
  }

  private async describe(payload: unknown): Promise<unknown> {
    const body = (payload ?? {}) as { id?: unknown }
    const document = await this.store.read()
    const id = typeof body.id === 'number' ? body.id : document.config.defaultEndpointId
    if (id === null) throw notConfigured('尚未选择默认代理')
    const row = findEndpoint(document, id)
    const scheme = chooseScheme(row, null)
    return {
      handle: handleFor(row),
      scheme,
      host: row.host,
      port: row.port,
      username: row.username,
      udp: row.udp,
      hasCredentials: row.secretRef !== null,
      ...describeTarget(row, scheme),
    }
  }

  private async createGroup(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(ProxyGroupInputSchema, payload, '分组参数')
    return this.store.mutate((document) =>
      createGroup(document, input.name, this.timestamp()),
    )
  }

  private configView(document: StoreDocument): Record<string, unknown> {
    return {
      defaultEndpointId:
        document.config.defaultEndpointId === null
          ? null
          : String(document.config.defaultEndpointId),
      risk: {
        enabled: document.config.risk.enabled,
        cacheSeconds: document.config.risk.cacheSeconds,
        hasApiKey: document.config.risk.apiKeyRef !== null,
      },
    }
  }

  private async configure(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(ConfigureInputSchema, payload, '插件配置')
    return this.store.mutate(async (document) => {
      if (input.defaultEndpointId !== null) {
        const row = document.endpoints.find(
          (entry) => entry.id === input.defaultEndpointId && !entry.deleted,
        )
        if (row === undefined) throw invalidRequest('默认代理不存在或已删除')
      }
      document.config.defaultEndpointId = input.defaultEndpointId
      document.config.risk.enabled = input.riskEnabled
      document.config.risk.cacheSeconds = input.riskCacheSeconds
      if (typeof input.riskApiKey === 'string') {
        const previous = document.config.risk.apiKeyRef
        if (input.riskApiKey === '') {
          document.config.risk.apiKeyRef = null
          if (previous !== null) await this.vault.drop(previous)
        } else {
          const stored = await this.vault.put('proxycheck-api-key', input.riskApiKey)
          document.config.risk.apiKeyRef = stored.ref
          if (previous !== null) await this.vault.drop(previous)
        }
      }
      return this.configView(document)
    })
  }

  private async listSubscriptions(): Promise<unknown> {
    const document = await this.store.read()
    return {
      items: document.subscriptions
        .filter((row) => !row.deleted)
        .sort((left, right) => right.id - left.id)
        .map((row) => this.subscriptionSummary(row)),
    }
  }

  private subscriptionSummary(row: SubscriptionRecord): Record<string, unknown> {
    return {
      id: String(row.id),
      name: row.name,
      enabled: row.enabled,
      sourceMode: row.sourceMode,
      groupName: row.groupName,
      includeDirect: row.includeDirect,
      preferredScheme: row.preferredScheme,
      memberCount:
        row.sourceMode === 'selected' ? row.proxyIds.length : row.groupIds.length,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  private findSubscription(document: StoreDocument, id: number): SubscriptionRecord {
    const row = document.subscriptions.find((entry) => entry.id === id && !entry.deleted)
    if (row === undefined) throw invalidRequest('订阅不存在或已删除')
    return row
  }

  private async getSubscription(payload: unknown): Promise<unknown> {
    const { id } = parseOrThrow(IdInputSchema, payload, '订阅标识')
    const document = await this.store.read()
    const row = this.findSubscription(document, id)
    const resolved = resolveRows(
      document,
      row.sourceMode,
      row.proxyIds,
      row.groupIds,
      row.preferredScheme,
    )
    return {
      ...this.subscriptionSummary(row),
      proxyIds: row.proxyIds.map(String),
      groupIds: row.groupIds.map(String),
      baseYaml: renderBaseConfig(row.baseConfig),
      availableCount: resolved.rows.length,
      excludedCount: resolved.excluded,
    }
  }

  private async createSubscription(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(SubscriptionInputSchema, payload, '订阅参数')
    validateGroupName(input.groupName)
    const config = parseBaseConfig(input.baseYaml, input.groupName)
    const token = newSubscriptionToken()
    const row = await this.store.mutate(async (document) => {
      validateSubscriptionSource(document, input)
      const stored = await this.vault.put('subscription-token', token.token)
      const timestamp = this.timestamp()
      const record: SubscriptionRecord = {
        id: document.nextId++,
        name: input.name,
        enabled: input.enabled,
        sourceMode: input.sourceMode,
        proxyIds: input.sourceMode === 'selected' ? [...new Set(input.proxyIds)] : [],
        groupIds: input.sourceMode === 'groups' ? [...new Set(input.groupIds)] : [],
        groupName: input.groupName,
        includeDirect: input.includeDirect,
        preferredScheme: input.preferredScheme,
        baseConfig: config,
        tokenHash: token.hash,
        tokenRef: stored.ref,
        createdAt: timestamp,
        updatedAt: timestamp,
        deleted: false,
        deletedAt: null,
      }
      document.subscriptions.push(record)
      return record
    })
    this.logger.info('已创建订阅', { id: row.id })
    return { ...this.subscriptionSummary(row), tokenRef: row.tokenRef }
  }

  private async updateSubscription(payload: unknown): Promise<unknown> {
    const { id, rest } = withoutId(payload)
    const input = parseOrThrow(SubscriptionInputSchema, rest, '订阅参数')
    validateGroupName(input.groupName)
    const config = parseBaseConfig(input.baseYaml, input.groupName)
    const row = await this.store.mutate((document) => {
      validateSubscriptionSource(document, input)
      const record = this.findSubscription(document, id)
      record.name = input.name
      record.enabled = input.enabled
      record.sourceMode = input.sourceMode
      record.proxyIds =
        input.sourceMode === 'selected' ? [...new Set(input.proxyIds)] : []
      record.groupIds = input.sourceMode === 'groups' ? [...new Set(input.groupIds)] : []
      record.groupName = input.groupName
      record.includeDirect = input.includeDirect
      record.preferredScheme = input.preferredScheme
      record.baseConfig = config
      record.updatedAt = this.timestamp()
      return record
    })
    return this.subscriptionSummary(row)
  }

  private async deleteSubscription(payload: unknown): Promise<unknown> {
    const { id } = parseOrThrow(IdInputSchema, payload, '订阅标识')
    await this.store.mutate(async (document) => {
      const record = this.findSubscription(document, id)
      record.deleted = true
      record.deletedAt = this.timestamp()
      record.enabled = false
      record.tokenHash = ''
      if (record.tokenRef !== '') {
        await this.vault.drop(record.tokenRef)
        record.tokenRef = ''
      }
      return record
    })
    return { deleted: 1 }
  }

  private renderFor(
    document: StoreDocument,
    row: SubscriptionRecord,
    redact: boolean,
  ): Promise<{ yaml: string; nodeCount: number; excluded: number }> {
    const resolved = resolveRows(
      document,
      row.sourceMode,
      row.proxyIds,
      row.groupIds,
      row.preferredScheme,
    )
    return (async () => {
      const passwords = new Map<number, string>()
      if (!redact) {
        for (const endpoint of resolved.rows) {
          const ref = endpoint.secretRef
          if (ref !== null) {
            passwords.set(endpoint.id, await this.vault.resolve(ref))
          }
        }
      }
      const yaml = renderClash({
        rows: resolved.rows,
        config: row.baseConfig,
        groupName: row.groupName,
        includeDirect: row.includeDirect,
        preferredScheme: row.preferredScheme,
        passwordFor: (endpoint) => passwords.get(endpoint.id) ?? '',
        redactSecrets: redact,
      })
      return { yaml, nodeCount: resolved.rows.length, excluded: resolved.excluded }
    })()
  }

  private async previewSubscription(payload: unknown): Promise<unknown> {
    const { id } = parseOrThrow(IdInputSchema, payload, '订阅标识')
    const document = await this.store.read()
    const row = this.findSubscription(document, id)
    const rendered = await this.renderFor(document, row, true)
    // Preview is redacted on purpose: it is display data, not a credential export.
    return {
      yaml: rendered.yaml,
      nodeCount: rendered.nodeCount,
      excludedCount: rendered.excluded,
      redacted: true,
    }
  }

  private async exportById(payload: unknown): Promise<unknown> {
    const { id } = parseOrThrow(IdInputSchema, payload, '订阅标识')
    return this.exportSubscription(id, null)
  }

  private async exportSubscription(id: number, token: string | null): Promise<unknown> {
    const document = await this.store.read()
    const row = this.findSubscription(document, id)
    if (!row.enabled) throw invalidRequest('订阅已停用')
    if (token !== null && !tokenMatches(token, row.tokenHash)) {
      throw invalidRequest('订阅令牌无效')
    }
    const directory = this.store.exportDirectory
    if (directory === null) {
      throw notConfigured('当前存储不支持生成订阅文件，需要宿主提供私有存储目录')
    }
    const rendered = await this.renderFor(document, row, false)
    const file = await writeSubscriptionFile(directory, row.id, rendered.yaml)
    return {
      ...file,
      nodeCount: rendered.nodeCount,
      excludedCount: rendered.excluded,
      filename: `${row.name}.yaml`,
    }
  }

  private async downloadSubscription(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(SubscriptionTokenInputSchema, payload, '订阅下载参数')
    return this.exportSubscription(input.id, input.token)
  }

  private async subscriptionLink(payload: unknown): Promise<unknown> {
    const { id } = parseOrThrow(IdInputSchema, payload, '订阅标识')
    const document = await this.store.read()
    const row = this.findSubscription(document, id)
    // The token value stays in the vault; the host resolves it when composing the URL.
    return {
      id: String(row.id),
      filename: `${row.name}.yaml`,
      tokenRef: row.tokenRef,
      path: `/subscriptions/clash/${row.id}/${encodeURIComponent(row.name)}.yaml`,
    }
  }

  private async resetToken(payload: unknown): Promise<unknown> {
    const { id } = parseOrThrow(IdInputSchema, payload, '订阅标识')
    const token = newSubscriptionToken()
    const row = await this.store.mutate(async (document) => {
      const record = this.findSubscription(document, id)
      const stored = await this.vault.put('subscription-token', token.token)
      if (record.tokenRef !== '') await this.vault.drop(record.tokenRef)
      record.tokenRef = stored.ref
      record.tokenHash = token.hash
      record.updatedAt = this.timestamp()
      return record
    })
    return { id: String(row.id), tokenRef: row.tokenRef }
  }

  private async appendProxies(payload: unknown): Promise<unknown> {
    const input = parseOrThrow(AppendInputSchema, payload, '追加参数')
    const row = await this.store.mutate((document) => {
      const record = this.findSubscription(document, input.id)
      if (record.sourceMode !== 'selected') {
        throw invalidRequest('只有手动选择代理的订阅可以追加代理')
      }
      const requested = [...new Set(input.ids)]
      const known = new Set(
        document.endpoints.filter((entry) => !entry.deleted).map((entry) => entry.id),
      )
      if (requested.some((id) => !known.has(id))) {
        throw invalidRequest('部分代理不存在或已删除')
      }
      const existing = new Set(record.proxyIds)
      const added = requested.filter((id) => !existing.has(id))
      if (existing.size + added.length > 1000) {
        throw invalidRequest('单个订阅最多包含 1000 个代理')
      }
      record.proxyIds = [...existing, ...added].sort((left, right) => left - right)
      if (added.length > 0) record.updatedAt = this.timestamp()
      return {
        subscriptionId: String(record.id),
        addedCount: added.length,
        duplicateCount: requested.length - added.length,
        memberCount: record.proxyIds.length,
      }
    })
    return row
  }
}

/** Splits a payload that carries an id from the fields the schema validates. */
function withoutId(payload: unknown): { id: number; rest: Record<string, unknown> } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw invalidRequest('请求缺少 id')
  }
  const { id, ...rest } = payload as Record<string, unknown>
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
    throw invalidRequest('请求缺少 id')
  }
  return { id, rest }
}
