import { endpointFingerprint } from '../domain/credentials.js'
import { invalidRequest } from '../domain/errors.js'
import type {
  BatchResult,
  EndpointRecord,
  ProxyInput,
  ProxyPublic,
} from '../domain/schemas.js'
import type { StoreDocument } from '../store/private-store.js'
import type { SecretVault } from '../store/secret-vault.js'

export function toPublic(row: EndpointRecord): ProxyPublic {
  return {
    id: String(row.id),
    name: row.name,
    groupId: row.groupId === null ? null : String(row.groupId),
    schemes: [...row.schemes],
    host: row.host,
    port: row.port,
    username: row.username,
    enabled: row.enabled,
    udp: row.udp,
    hasPassword: row.secretRef !== null,
    checkStatus: row.checkStatus,
    checkedScheme: row.checkedScheme,
    checkedAt: row.checkedAt,
    exitIp: row.exitIp,
    exitIpCheckedAt: row.exitIpCheckedAt,
    previousExitIp: row.previousExitIp,
    previousExitIpCheckedAt: row.previousExitIpCheckedAt,
    exitIpChanged: row.previousExitIp !== null && row.exitIp !== row.previousExitIp,
    geo: row.geo,
    reputation: row.reputation,
    latencyMs: row.latencyMs,
    checkError: row.checkError,
  }
}

/** A changed address, protocol list or credential invalidates old observations. */
export function resetObservation(row: EndpointRecord): void {
  row.checkStatus = 'unknown'
  row.checkedScheme = null
  row.checkedAt = null
  row.exitIp = null
  row.exitIpCheckedAt = null
  row.previousExitIp = null
  row.previousExitIpCheckedAt = null
  row.geo = null
  row.reputation = null
  row.riskScore = null
  row.isProxy = null
  row.isVpn = null
  row.isHosting = null
  row.latencyMs = null
  row.checkError = null
}

export type UpsertStatus = 'created' | 'updated' | 'duplicate' | 'merged'

export interface UpsertOutcome {
  status: UpsertStatus
  row: EndpointRecord
}

interface UpsertOptions {
  vault: SecretVault
  now: () => string
  /** Present when editing; absent when creating. */
  existing?: EndpointRecord
}

/**
 * Creates or edits an endpoint. The password only passes through the vault:
 * the stored row keeps a reference plus the vault digest.
 */
export async function upsertEndpoint(
  document: StoreDocument,
  input: ProxyInput,
  options: UpsertOptions,
): Promise<UpsertOutcome> {
  const { vault, existing } = options
  let secretRef = existing?.secretRef ?? null
  let credentialFingerprint = existing?.credentialFingerprint ?? ''
  let createdSecretRef: string | null = null

  if (typeof input.password === 'string') {
    if (input.password === '') {
      secretRef = null
      credentialFingerprint = ''
    } else {
      const stored = await vault.put('proxy-password', input.password)
      secretRef = stored.ref
      credentialFingerprint = stored.fingerprint
      createdSecretRef = stored.ref
    }
  }

  const fingerprint = endpointFingerprint(
    input.host,
    input.port,
    input.username,
    credentialFingerprint,
  )
  const duplicate = document.endpoints.find(
    (row) => !row.deleted && row.fingerprint === fingerprint && row.id !== existing?.id,
  )

  if (duplicate !== undefined) {
    if (createdSecretRef !== null) await vault.drop(createdSecretRef)
    const merged = [...new Set([...duplicate.schemes, ...input.schemes])].sort()
    if (
      merged.length === duplicate.schemes.length &&
      merged.every((scheme, index) => scheme === duplicate.schemes[index])
    ) {
      return { status: 'duplicate', row: duplicate }
    }
    duplicate.schemes = merged
    duplicate.updatedAt = options.now()
    resetObservation(duplicate)
    return { status: 'merged', row: duplicate }
  }

  const previousSecretRef = existing?.secretRef ?? null
  if (
    existing !== undefined &&
    previousSecretRef !== null &&
    previousSecretRef !== secretRef
  ) {
    await vault.drop(previousSecretRef)
  }

  const timestamp = options.now()
  if (existing === undefined) {
    const row: EndpointRecord = {
      id: document.nextId++,
      name: input.name,
      schemes: [...input.schemes],
      host: input.host,
      port: input.port,
      username: input.username,
      secretRef,
      credentialFingerprint,
      fingerprint,
      groupId: input.groupId,
      enabled: input.enabled,
      udp: input.udp,
      checkStatus: 'unknown',
      checkedScheme: null,
      checkedAt: null,
      exitIp: null,
      exitIpCheckedAt: null,
      previousExitIp: null,
      previousExitIpCheckedAt: null,
      geo: null,
      reputation: null,
      riskScore: null,
      isProxy: null,
      isVpn: null,
      isHosting: null,
      latencyMs: null,
      checkError: null,
      deleted: false,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    document.endpoints.push(row)
    return { status: 'created', row }
  }

  const changed =
    existing.fingerprint !== fingerprint ||
    existing.schemes.join(',') !== input.schemes.join(',')
  existing.name = input.name
  existing.schemes = [...input.schemes]
  existing.host = input.host
  existing.port = input.port
  existing.username = input.username
  existing.secretRef = secretRef
  existing.credentialFingerprint = credentialFingerprint
  existing.fingerprint = fingerprint
  existing.groupId = input.groupId
  existing.enabled = input.enabled
  existing.udp = input.udp
  existing.updatedAt = timestamp
  if (changed) resetObservation(existing)
  return { status: 'updated', row: existing }
}

export async function createEndpoint(
  document: StoreDocument,
  input: ProxyInput,
  options: Omit<UpsertOptions, 'existing'>,
): Promise<EndpointRecord> {
  const outcome = await upsertEndpoint(document, input, options)
  if (outcome.status !== 'created') {
    throw invalidRequest('已存在相同地址及认证信息的代理，请编辑其协议列表')
  }
  return outcome.row
}

export async function updateEndpoint(
  document: StoreDocument,
  input: ProxyInput,
  options: UpsertOptions & { existing: EndpointRecord },
): Promise<EndpointRecord> {
  const outcome = await upsertEndpoint(document, input, options)
  if (outcome.status !== 'updated') {
    throw invalidRequest('已存在相同地址及认证信息的代理，请编辑其协议列表')
  }
  return outcome.row
}

export async function importEndpoints(
  document: StoreDocument,
  inputs: ProxyInput[],
  options: Omit<UpsertOptions, 'existing'>,
): Promise<BatchResult> {
  const result: BatchResult = {
    requested: inputs.length,
    created: 0,
    duplicates: 0,
    merged: 0,
  }
  for (const input of inputs) {
    const outcome = await upsertEndpoint(document, input, options)
    if (outcome.status === 'created') result.created += 1
    else if (outcome.status === 'duplicate') result.duplicates += 1
    else result.merged += 1
  }
  return result
}

export function activeEndpoints(document: StoreDocument): EndpointRecord[] {
  return document.endpoints.filter((row) => !row.deleted)
}

export function findEndpoint(document: StoreDocument, id: number): EndpointRecord {
  const row = document.endpoints.find((entry) => entry.id === id && !entry.deleted)
  if (row === undefined) throw invalidRequest('代理不存在或已删除')
  return row
}

export function selectedEndpoints(
  document: StoreDocument,
  ids: number[],
): EndpointRecord[] {
  const unique = [...new Set(ids)]
  const byId = new Map(
    document.endpoints.filter((row) => !row.deleted).map((row) => [row.id, row] as const),
  )
  const rows = unique.map((id) => byId.get(id))
  if (rows.some((row) => row === undefined)) {
    throw invalidRequest('部分选中代理不存在或已删除，请刷新列表')
  }
  return rows as EndpointRecord[]
}

/** Soft delete keeps historical references resolvable while dropping the secret. */
export async function deleteEndpoints(
  document: StoreDocument,
  ids: number[],
  options: { vault: SecretVault; now: () => string },
): Promise<number> {
  const rows = selectedEndpoints(document, ids)
  const timestamp = options.now()
  for (const row of rows) {
    row.deleted = true
    row.deletedAt = timestamp
    row.enabled = false
    row.updatedAt = timestamp
    if (row.secretRef !== null) {
      await options.vault.drop(row.secretRef)
      row.secretRef = null
      row.credentialFingerprint = ''
    }
  }
  return rows.length
}
