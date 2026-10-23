import { createHash, randomUUID } from 'node:crypto'

import { invalidRequest } from '../domain/errors.js'
import {
  AccountTransferDataSchema,
  TransferExportInputSchema,
  TransferImportInputSchema,
  TransferReceiptInputSchema,
  parseTransfer,
  type AccountTransferData,
  type AccountTransferImportResult,
  type AccountTransferReceipt,
} from '../domain/transfer.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { AccountStore, StoreDocument } from '../store/account-store.js'

export const TRANSFER_METHODS = [
  'transfer.export',
  'transfer.import',
  'transfer.rollback',
  'transfer.commit',
] as const

export async function exportAccounts(
  store: AccountStore,
  context: DispatchContext,
): Promise<AccountTransferData> {
  const input = parseTransfer(TransferExportInputSchema, context.payload)
  const document = await store.read()
  context.assertAlive()
  const windows = new Set(input.windowIds)
  const bindings = document.bindings.filter((entry) => windows.has(entry.windowId))
  const accounts = new Set(bindings.map((entry) => entry.accountId))
  return parseTransfer(AccountTransferDataSchema, {
    schemaVersion: 1,
    accounts: document.accounts.filter((entry) => accounts.has(entry.id)),
    bindings,
  })
}

export async function importAccounts(
  store: AccountStore,
  context: DispatchContext,
  maxAccounts: number,
): Promise<AccountTransferImportResult> {
  const input = parseTransfer(TransferImportInputSchema, context.payload)
  const data = parseTransfer(AccountTransferDataSchema, input.data)
  const receipt = input.transactionId ?? randomUUID()
  const inputHash = createHash('sha256')
    .update(JSON.stringify([data, Object.entries(input.windowIdMap).sort()]))
    .digest('hex')
  let created = false
  try {
    const result = await store.mutate((document) => {
      context.assertAlive()
      const existing = document.transferReceipts.find(
        (entry) => entry.receipt === receipt,
      )
      if (existing !== undefined) {
        if (existing.inputHash !== inputHash)
          throw invalidRequest('迁移事务标识已用于其他数据')
        return { created: false }
      }
      if (document.accounts.length + data.accounts.length > maxAccounts) {
        throw invalidRequest('迁移后账号数量超过上限')
      }
      const targets = new Set<string>()
      const remapped = data.bindings.map((entry) => {
        if (!Object.hasOwn(input.windowIdMap, entry.windowId)) {
          throw invalidRequest('迁移缺少窗口标识映射')
        }
        const windowId = input.windowIdMap[entry.windowId]!
        if (targets.has(windowId)) throw invalidRequest('迁移窗口标识映射重复')
        targets.add(windowId)
        const previous = document.bindings.find(
          (candidate) => candidate.windowId === windowId,
        )
        if (previous !== undefined && windowId !== entry.windowId) {
          throw invalidRequest('迁移目标窗口已经关联账号')
        }
        return { source: entry, windowId, previous: previous ?? null }
      })
      const accountIdMap = new Map(data.accounts.map((entry) => [entry.id, randomUUID()]))
      const accounts = data.accounts.map((entry) => ({
        ...entry,
        id: accountIdMap.get(entry.id)!,
      }))
      if (
        accounts.some((entry) =>
          document.accounts.some((existing) => existing.id === entry.id),
        )
      ) {
        throw invalidRequest('迁移账号标识冲突')
      }
      const journal: AccountTransferReceipt = {
        receipt,
        inputHash,
        accountIds: accounts.map((entry) => entry.id),
        bindings: remapped.map((entry) => ({
          imported: {
            ...entry.source,
            windowId: entry.windowId,
            accountId: accountIdMap.get(entry.source.accountId)!,
          },
          previous: entry.previous,
        })),
      }
      document.accounts.unshift(...accounts)
      for (const { imported } of journal.bindings) {
        const index = document.bindings.findIndex(
          (entry) => entry.windowId === imported.windowId,
        )
        if (index === -1) document.bindings.push(imported)
        else document.bindings[index] = imported
      }
      document.transferReceipts.push(journal)
      return { created: true }
    })
    created = result.created
    context.assertAlive()
    return { receipt }
  } catch (error) {
    // The data and receipt share one atomic document. A cancelled successful
    // write can therefore be compensated using the same durable journal.
    if (created) await store.mutate((document) => undo(document, receipt))
    throw error
  }
}

function undo(document: StoreDocument, receipt: string): void {
  const journal = document.transferReceipts.find((entry) => entry.receipt === receipt)
  if (journal === undefined) return
  const accounts = new Set(journal.accountIds)
  for (const { imported, previous } of journal.bindings) {
    const current = document.bindings.find(
      (entry) => entry.windowId === imported.windowId,
    )
    if (
      current?.accountId === imported.accountId &&
      current.boundAt === imported.boundAt
    ) {
      const index = document.bindings.indexOf(current)
      if (
        previous !== null &&
        document.accounts.some((entry) => entry.id === previous.accountId)
      ) {
        document.bindings[index] = previous
      } else document.bindings.splice(index, 1)
    }
  }
  document.accounts = document.accounts.filter((entry) => !accounts.has(entry.id))
  document.bindings = document.bindings.filter((entry) => !accounts.has(entry.accountId))
  document.transferReceipts = document.transferReceipts.filter(
    (entry) => entry.receipt !== receipt,
  )
}

export async function finishAccountsTransfer(
  store: AccountStore,
  context: DispatchContext,
  rollback: boolean,
): Promise<{ success: true }> {
  const { receipt } = parseTransfer(TransferReceiptInputSchema, context.payload)
  await store.mutate((document) => {
    context.assertAlive()
    if (rollback) undo(document, receipt)
    else
      document.transferReceipts = document.transferReceipts.filter(
        (entry) => entry.receipt !== receipt,
      )
  })
  return { success: true }
}
