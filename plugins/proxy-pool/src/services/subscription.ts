import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument, stringify } from 'yaml'

import { invalidRequest, unavailable } from '../domain/errors.js'
import type {
  EndpointRecord,
  Scheme,
  SubscriptionInput,
  SubscriptionRecord,
} from '../domain/schemas.js'
import type { StoreDocument } from '../store/private-store.js'
import { chooseScheme } from './check.js'
import { nodeNames } from './node-names.js'

const BUILTIN_TARGETS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'])
const BUILTIN_GROUP_NAMES = new Set([
  'DIRECT',
  'REJECT',
  'GLOBAL',
  'REJECT-DROP',
  'PASS',
  'COMPATIBLE',
])
const PORT_KEYS = ['mixed-port', 'port', 'socks-port', 'redir-port', 'tproxy-port']
const LOG_LEVELS = new Set(['info', 'warning', 'error', 'debug', 'silent'])
const DEFAULT_BASE = {
  'mixed-port': 7890,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'info',
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Rejects values that cannot round-trip through JSON without loss. */
function assertJsonSafe(value: unknown, seen = new Set<unknown>()): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number')
    return
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) throw new Error('circular reference')
    seen.add(value)
    const children = Array.isArray(value) ? value : Object.values(value)
    for (const child of children) assertJsonSafe(child, seen)
    seen.delete(value)
    return
  }
  throw new Error('unsupported value')
}

/**
 * Validates the user-provided Clash base configuration. The plugin owns one
 * strategy group, so rules may only target it or Clash built-ins.
 */
export function parseBaseConfig(
  baseYaml: string,
  groupName: string,
): Record<string, unknown> {
  let config: unknown
  try {
    const document = parseDocument(baseYaml)
    if (document.errors.length > 0) throw new Error('invalid yaml')
    // maxAliasCount: 0 rejects anchors/aliases, keeping snapshots bounded.
    config = document.toJS({ maxAliasCount: 0 })
  } catch {
    throw invalidRequest('基础 YAML 配置无效，请检查缩进、锚点与字段类型')
  }
  if (config === null || config === undefined) config = {}
  if (
    !isPlainObject(config) ||
    Object.keys(config).some((key) => typeof key !== 'string')
  ) {
    throw invalidRequest('基础 YAML 配置必须是键值映射')
  }
  if ('proxies' in config || 'proxy-groups' in config) {
    throw invalidRequest('基础 YAML 不能包含 proxies 或 proxy-groups，节点由代理池生成')
  }
  try {
    assertJsonSafe(config)
  } catch {
    throw invalidRequest('基础 YAML 配置包含无法保存的值')
  }
  const mode = config.mode ?? 'rule'
  if (mode !== 'rule' && mode !== 'global' && mode !== 'direct') {
    throw invalidRequest('基础 YAML 的 mode 只能是 rule、global 或 direct')
  }
  for (const key of PORT_KEYS) {
    const value = config[key]
    if (value === undefined) continue
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 65535
    ) {
      throw invalidRequest(`基础 YAML 的 ${key} 必须是 0 到 65535 的整数`)
    }
  }
  if ('allow-lan' in config && typeof config['allow-lan'] !== 'boolean') {
    throw invalidRequest('基础 YAML 的 allow-lan 必须是布尔值')
  }
  const logLevel = config['log-level'] ?? 'info'
  if (typeof logLevel !== 'string' || !LOG_LEVELS.has(logLevel)) {
    throw invalidRequest('基础 YAML 的 log-level 取值无效')
  }
  const rules = config.rules
  if (rules !== undefined) {
    if (!Array.isArray(rules) || rules.length === 0) {
      throw invalidRequest('基础 YAML 的 rules 必须是非空列表')
    }
    const targets = new Set([groupName, ...BUILTIN_TARGETS])
    for (const rule of rules) {
      if (typeof rule !== 'string') {
        throw invalidRequest('基础 YAML 的每条 rule 必须是字符串')
      }
      const parts = rule.split(',').map((part) => part.trim())
      if (parts[parts.length - 1]?.toLowerCase() === 'no-resolve') parts.pop()
      const target = parts[parts.length - 1]
      if (parts.length < 2 || target === undefined || !targets.has(target)) {
        throw invalidRequest(`基础 YAML 的规则只能指向 ${groupName} 或 Clash 内置策略`)
      }
    }
  }
  return config
}

/** Round-trips a stored base configuration back to editable YAML. */
export function renderBaseConfig(config: Record<string, unknown>): string {
  return stringify(config, { lineWidth: 0 })
}

export interface RenderOptions {
  rows: EndpointRecord[]
  config: Record<string, unknown>
  groupName: string
  includeDirect: boolean
  preferredScheme: Scheme | null
  /** Resolved plaintext for one render pass; never persisted. */
  passwordFor: (row: EndpointRecord) => string
  redactSecrets?: boolean
}

export function renderClash(options: RenderOptions): string {
  const { rows, config, groupName } = options
  if (rows.length === 0) {
    throw invalidRequest('没有可用代理节点，请先添加并启用代理')
  }
  const names = nodeNames(rows, groupName)
  const nodes = rows.map((row, index) => {
    const scheme =
      row.schemes.length === 1
        ? (row.schemes[0] ?? chooseScheme(row, options.preferredScheme))
        : chooseScheme(row, options.preferredScheme)
    const node: Record<string, unknown> = {
      name: names[index],
      type: scheme.startsWith('socks5') ? 'socks5' : 'http',
      server: row.host,
      port: row.port,
    }
    const password = options.passwordFor(row)
    // Presence is decided by the stored reference, not by the resolved value.
    if (row.username !== '' || row.secretRef !== null) {
      node.username = row.username
      node.password = options.redactSecrets === true ? '***' : password
    }
    if (scheme === 'https') node.tls = true
    if (scheme.startsWith('socks5')) node.udp = row.udp
    return node
  })

  const output: Record<string, unknown> = { ...DEFAULT_BASE, ...config }
  output.proxies = nodes
  output['proxy-groups'] = [
    {
      name: groupName,
      type: 'select',
      proxies: [
        ...nodes.map((node) => node.name),
        ...(options.includeDirect ? ['DIRECT'] : []),
      ],
    },
  ]
  if (output.rules === undefined) output.rules = [`MATCH,${groupName}`]
  return stringify(output, { lineWidth: 0, aliasDuplicateObjects: false })
}

export interface ResolvedRows {
  rows: EndpointRecord[]
  excluded: number
}

export function resolveRows(
  document: StoreDocument,
  sourceMode: SubscriptionRecord['sourceMode'],
  proxyIds: number[],
  groupIds: number[],
  preferred: Scheme | null,
): ResolvedRows {
  const candidates = document.endpoints.filter((row) => {
    if (row.deleted) return false
    if (sourceMode === 'selected') return proxyIds.includes(row.id)
    return row.groupId !== null && groupIds.includes(row.groupId)
  })
  const rows = candidates
    .filter(
      (row) =>
        row.enabled &&
        (row.schemes.length === 1 ||
          preferred === null ||
          row.schemes.includes(preferred)),
    )
    .sort((left, right) => left.id - right.id)
  return { rows, excluded: candidates.length - rows.length }
}

export function validateSubscriptionSource(
  document: StoreDocument,
  input: SubscriptionInput,
): void {
  const proxyIds = [...new Set(input.proxyIds)]
  const groupIds = [...new Set(input.groupIds)]
  if (input.sourceMode === 'groups') {
    if (groupIds.length === 0) {
      throw invalidRequest('按分组生成订阅时至少选择一个分组')
    }
    const known = new Set(document.groups.map((group) => group.id))
    if (groupIds.some((id) => !known.has(id))) {
      throw invalidRequest('部分分组不存在或已删除')
    }
  } else {
    if (proxyIds.length === 0) {
      throw invalidRequest('按代理生成订阅时至少选择一个代理')
    }
    // Soft-deleted references from a saved subscription stay editable.
    const known = new Set(document.endpoints.map((row) => row.id))
    if (proxyIds.some((id) => !known.has(id))) {
      throw invalidRequest('部分代理不存在或已删除')
    }
  }
}

export function validateGroupName(groupName: string): void {
  if (/[,\r\n]/.test(groupName) || BUILTIN_GROUP_NAMES.has(groupName.toUpperCase())) {
    throw invalidRequest('订阅分组名不能包含逗号或换行，也不能与 Clash 内置策略同名')
  }
}

export function newSubscriptionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time comparison against the stored hash. */
export function tokenMatches(token: string, expectedHash: string): boolean {
  if (token.length !== 43) return false
  const actual = Buffer.from(hashToken(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/**
 * The rendered subscription contains proxy passwords, so it is written to the
 * plugin's private storage and handed over as a file handle. Plaintext never
 * travels through an RPC message.
 */
export async function writeSubscriptionFile(
  directory: string,
  id: number,
  content: string,
): Promise<{ handle: string; bytes: number }> {
  const name = `${id}-${randomBytes(8).toString('hex')}.yaml`
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, name), content, { mode: 0o600 })
  } catch (error) {
    throw unavailable('订阅文件写入失败，未生成导出文件', error)
  }
  return { handle: `exports/${name}`, bytes: Buffer.byteLength(content, 'utf8') }
}
