import { createHash, randomUUID } from 'node:crypto'

import { endpointFingerprint } from '../domain/credentials.js'
import { invalidRequest, unavailable } from '../domain/errors.js'
import type { EndpointRecord, GroupRecord } from '../domain/schemas.js'
import {
  ProxyTransferDataSchema,
  ProxyTransferEndpointSchema,
  TransferExportInputSchema,
  TransferImportInputSchema,
  TransferReceiptInputSchema,
  parseTransfer,
  type ProxyTransferData,
  type ProxyTransferImportResult,
  type ProxyTransferReceipt,
} from '../domain/transfer.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { PrivateStore } from '../store/private-store.js'
import { credentialFingerprint, type SecretVault } from '../store/secret-vault.js'
import { selectedEndpoints } from './inventory.js'

/** These credential-bearing RPCs are reserved for the native archive host. */
export const TRANSFER_METHODS = [
  'transfer.export',
  'transfer.import',
  'transfer.rollback',
  'transfer.commit',
] as const

export class ProxyTransfer {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: PrivateStore,
    private readonly vault: SecretVault,
  ) {}

  call(context: DispatchContext): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      context.assertAlive()
      switch (context.method) {
        case 'transfer.export':
          await this.recoverPending()
          return this.export(context)
        case 'transfer.import':
          await this.recoverPending()
          return this.import(context)
        case 'transfer.rollback': {
          const { receipt } = parseTransfer(TransferReceiptInputSchema, context.payload)
          await this.rollback(receipt)
          return { success: true }
        }
        case 'transfer.commit': {
          const { receipt } = parseTransfer(TransferReceiptInputSchema, context.payload)
          await this.store.mutate((document) => {
            context.assertAlive()
            const journal = document.transferReceipts.find(
              (entry) => entry.receipt === receipt,
            )
            if (journal?.phase === 'pending')
              throw invalidRequest('未完成的迁移不能提交，请先回滚')
            document.transferReceipts = document.transferReceipts.filter(
              (entry) => entry.receipt !== receipt,
            )
          })
          return { success: true }
        }
        default:
          throw invalidRequest('插件不支持该迁移方法')
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async export(context: DispatchContext): Promise<ProxyTransferData> {
    const input = parseTransfer(TransferExportInputSchema, context.payload)
    const document = await this.store.read()
    context.assertAlive()
    const ids = [...input.endpointIds]
    if (input.includeDefault && document.config.defaultEndpointId !== null) {
      ids.push(document.config.defaultEndpointId)
    }
    const rows = selectedEndpoints(document, ids)
    const endpoints: ProxyTransferData['endpoints'] = []
    const groupIds = new Set<number>()
    for (const row of rows) {
      context.assertAlive()
      const password =
        row.secretRef === null ? null : await this.vault.resolve(row.secretRef)
      // Project the trusted inventory onto the portable schema. Local vault
      // references, fingerprints and future private fields cannot escape.
      endpoints.push(
        parseTransfer(ProxyTransferEndpointSchema.strip(), { ...row, password }),
      )
      if (row.groupId !== null) groupIds.add(row.groupId)
    }
    context.assertAlive()
    return parseTransfer(ProxyTransferDataSchema, {
      schemaVersion: 1,
      defaultEndpointId: document.config.defaultEndpointId,
      endpoints,
      groups: document.groups
        .filter((entry) => groupIds.has(entry.id))
        .map((entry) => ({ id: entry.id, name: entry.name, createdAt: entry.createdAt })),
    })
  }

  private async import(context: DispatchContext): Promise<ProxyTransferImportResult> {
    const input = parseTransfer(TransferImportInputSchema, context.payload)
    const data = parseTransfer(ProxyTransferDataSchema, input.data)
    const receipt = input.transactionId ?? randomUUID()
    const inputHash = createHash('sha256')
      .update(JSON.stringify([data, Object.entries(input.windowIdMap).sort()]))
      .digest('hex')
    const staged = await this.store.mutate((document) => {
      context.assertAlive()
      const existing = document.transferReceipts.find(
        (entry) => entry.receipt === receipt,
      )
      if (existing !== undefined) {
        if (existing.inputHash !== inputHash)
          throw invalidRequest('迁移事务标识已用于其他数据')
        return {
          reused: true as const,
          result: { receipt, endpointIdMap: existing.endpointIdMap },
        }
      }
      const groupIdMap = new Map(
        data.groups.map((entry) => [entry.id, document.nextId++]),
      )
      const groups: GroupRecord[] = data.groups.map((entry) => ({
        ...entry,
        id: groupIdMap.get(entry.id)!,
      }))
      const endpointIdMap: Record<string, number> = {}
      const secrets: Array<{ ref: string; password: string }> = []
      const endpoints: EndpointRecord[] = data.endpoints.map((entry) => {
        const { password, ...fields } = entry
        const id = document.nextId++
        endpointIdMap[String(entry.id)] = id
        const secretRef =
          password === null
            ? null
            : `${this.vault.kind === 'file' ? 'file' : 'mem'}:proxy-password:${randomUUID()}`
        if (secretRef !== null && password !== null)
          secrets.push({ ref: secretRef, password })
        const digest = password === null ? '' : credentialFingerprint(password)
        return {
          ...fields,
          id,
          groupId: entry.groupId === null ? null : groupIdMap.get(entry.groupId)!,
          secretRef,
          credentialFingerprint: digest,
          fingerprint: endpointFingerprint(
            entry.host,
            entry.port,
            entry.username,
            digest,
          ),
          deleted: false,
          deletedAt: null,
        }
      })
      const journal: ProxyTransferReceipt = {
        receipt,
        inputHash,
        phase: 'pending',
        endpointIdMap,
        groupIds: groups.map((entry) => entry.id),
        secretRefs: secrets.map((entry) => entry.ref),
      }
      // This write-ahead receipt reserves every new id and secret reference
      // before either business file can contain part of the imported data.
      document.transferReceipts.push(journal)
      return {
        reused: false as const,
        groups,
        endpoints,
        secrets,
        result: { receipt, endpointIdMap },
      }
    })
    if (staged.reused) {
      context.assertAlive()
      return staged.result
    }
    try {
      for (const { ref, password } of staged.secrets) {
        context.assertAlive()
        await this.vault.put('proxy-password', password, ref)
      }
      await this.store.mutate((document) => {
        context.assertAlive()
        const journal = document.transferReceipts.find(
          (entry) => entry.receipt === receipt,
        )
        if (journal?.phase !== 'pending') throw unavailable('迁移恢复日志缺失')
        document.groups.push(...staged.groups)
        document.endpoints.push(...staged.endpoints)
        journal.phase = 'applied'
      })
      context.assertAlive()
      return staged.result
    } catch (error) {
      try {
        await this.rollback(receipt)
      } catch (recoveryError) {
        throw unavailable(
          '迁移未完成，恢复日志已保留；请恢复存储写入后重试',
          recoveryError,
        )
      }
      throw error
    }
  }

  private async recoverPending(): Promise<void> {
    const document = await this.store.read()
    for (const journal of document.transferReceipts) {
      if (journal.phase === 'pending') await this.rollback(journal.receipt)
    }
  }

  private async rollback(receipt: string): Promise<void> {
    const journal = await this.store.mutate((document) => {
      const entry = document.transferReceipts.find(
        (candidate) => candidate.receipt === receipt,
      )
      if (entry === undefined) return null
      const ids = new Set(Object.values(entry.endpointIdMap))
      document.endpoints = document.endpoints.filter((endpoint) => !ids.has(endpoint.id))
      const groupIds = new Set(entry.groupIds)
      const usedGroups = new Set([
        ...document.endpoints.flatMap((endpoint) =>
          endpoint.groupId === null ? [] : [endpoint.groupId],
        ),
        ...document.subscriptions.flatMap((subscription) => subscription.groupIds),
      ])
      document.groups = document.groups.filter(
        (group) => !groupIds.has(group.id) || usedGroups.has(group.id),
      )
      // Keep this journal until vault cleanup has also persisted. A restart
      // retries pending cleanup, and only this import's reserved refs can drop.
      entry.phase = 'pending'
      return entry
    })
    if (journal === null) return
    const document = await this.store.read()
    const usedRefs = new Set([
      ...document.endpoints.map((entry) => entry.secretRef),
      ...document.subscriptions.map((entry) => entry.tokenRef),
      document.config.risk.apiKeyRef,
    ])
    for (const ref of journal.secretRefs) {
      if (!usedRefs.has(ref)) await this.vault.drop(ref)
    }
    await this.store.mutate((draft) => {
      draft.transferReceipts = draft.transferReceipts.filter(
        (entry) => entry.receipt !== receipt,
      )
    })
  }
}
