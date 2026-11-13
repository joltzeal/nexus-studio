import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  AccountAgentSnapshotInputSchema,
  AccountAgentSnapshotResultSchema,
  AccountObservationInputSchema,
  type AccountAgentSnapshotResult,
  type AccountObservationInput,
  type AccountObservationResult,
  type AccountObservationState,
  type AccountObservedBalance,
} from '../agent-contracts.js'
import { invalidRequest, unavailable } from '../domain/errors.js'
import { MAX_OBSERVATION_OPERATIONS } from '../domain/observations.js'
import type { AccountRecord } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { parseHomepage } from '../services/order-source.js'
import type { AccountStore, StoreDocument } from '../store/account-store.js'

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw invalidRequest('账号观察参数或快照无效')
  return parsed.data
}

function boundAccount(document: StoreDocument, windowId: string): AccountRecord {
  const bindings = document.bindings.filter((entry) => entry.windowId === windowId)
  if (bindings.length !== 1) throw invalidRequest('窗口未关联唯一账号，请刷新后重试')
  const account = document.accounts.find((entry) => entry.id === bindings[0]!.accountId)
  if (account === undefined) throw invalidRequest('关联账号不存在或已被删除')
  return account
}

function homepageUserId(homepageUrl: string): string | null {
  try {
    return parseHomepage(homepageUrl).userId
  } catch {
    return null
  }
}

export async function accountAgentSnapshot(
  store: AccountStore,
  context: DispatchContext,
): Promise<AccountAgentSnapshotResult> {
  const input = parse(AccountAgentSnapshotInputSchema, context.payload)
  context.assertAlive()
  const document = await store.read()
  context.assertAlive()
  const account = boundAccount(document, input.windowId)
  return parse(AccountAgentSnapshotResultSchema, {
    account: {
      accountId: account.id,
      account: account.account,
      status: account.status,
      homepageUrl: account.homepageUrl,
      platformUserId:
        account.observation?.platformUserId ?? homepageUserId(account.homepageUrl),
      observation: account.observation ?? null,
    },
    windowId: input.windowId,
  })
}

function mergeBalance(
  previous: AccountObservedBalance | undefined,
  input: AccountObservationInput,
): AccountObservedBalance | undefined {
  const balance = input.balance
  if (balance === undefined) return previous
  if (balance.available === null && balance.pending === null && previous !== undefined) {
    return previous
  }
  const sameCurrency = previous?.currency === balance.currency ? previous : undefined
  const evidence = { source: input.source, observedAt: input.observedAt }
  return {
    currency: balance.currency,
    available: balance.available ?? sameCurrency?.available ?? null,
    pending: balance.pending ?? sameCurrency?.pending ?? null,
    availableEvidence:
      balance.available === null ? (sameCurrency?.availableEvidence ?? null) : evidence,
    pendingEvidence:
      balance.pending === null ? (sameCurrency?.pendingEvidence ?? null) : evidence,
  }
}

function applyObservation(account: AccountRecord, input: AccountObservationInput): void {
  const state: AccountObservationState = {
    ...account.observation,
    lastObservation: {
      operationId: input.operationId,
      accountId: input.accountId,
      windowId: input.windowId,
      observedAt: input.observedAt,
      source: input.source,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.balance === undefined ? {} : { balance: input.balance }),
    },
  }
  if (input.platformUserId !== undefined) state.platformUserId = input.platformUserId
  if (input.tags !== undefined) state.tags = input.tags
  if (input.summary !== undefined) state.summary = input.summary
  if (input.rating !== undefined) state.rating = input.rating
  const balance = mergeBalance(state.balance, input)
  if (balance !== undefined) state.balance = balance
  if (input.status !== undefined) {
    const pageDowngrade =
      input.source === 'page' &&
      input.status !== 'blocked' &&
      (account.status === 'blocked' ||
        (state.statusEvidence?.source === 'official' &&
          state.statusEvidence.status !== 'active'))
    if (input.source !== 'model' && !pageDowngrade) {
      account.status = input.status
      state.statusEvidence = {
        status: input.status,
        source: input.source,
        observedAt: input.observedAt,
      }
    } else if (
      state.statusEvidence === undefined &&
      account.status !== 'blocked' &&
      input.status !== 'blocked'
    ) {
      account.status = input.status
    }
  }
  account.observation = state
}

export async function recordAccountObservation(
  store: AccountStore,
  context: DispatchContext,
  now: () => Date,
): Promise<AccountObservationResult> {
  const input = parse(AccountObservationInputSchema, context.payload)
  // Strict parsing has a fixed key order without normalizing input field values.
  const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  context.assertAlive()
  return store.mutate((document) => {
    context.assertAlive()
    const account = boundAccount(document, input.windowId)
    if (account.id !== input.accountId) throw invalidRequest('窗口关联账号已变化')
    const existing = document.observationOperations.find(
      (entry) => entry.operationId === input.operationId,
    )
    if (existing !== undefined) {
      if (existing.inputHash !== inputHash)
        throw invalidRequest('观察操作标识已用于其他输入')
      return {
        operationId: existing.operationId,
        accountId: existing.accountId,
        applied: existing.applied,
        storageDurable: store.durable,
      }
    }
    const homepageIdentity = homepageUserId(account.homepageUrl)
    const observedIdentity = account.observation?.platformUserId
    if (
      input.platformUserId !== undefined &&
      ((homepageIdentity !== null && homepageIdentity !== input.platformUserId) ||
        (observedIdentity !== undefined && observedIdentity !== input.platformUserId))
    ) {
      throw invalidRequest('观察到的平台身份与关联账号不一致')
    }
    if (document.observationOperations.length >= MAX_OBSERVATION_OPERATIONS) {
      throw unavailable('账号观察操作记录已达上限，本次修改未保存')
    }
    const previous = account.observation?.lastObservation
    const applied =
      previous === undefined ||
      Date.parse(input.observedAt) > Date.parse(previous.observedAt)
    if (applied) {
      applyObservation(account, input)
      account.updatedAt = now().toISOString()
    }
    document.observationOperations.push({
      operationId: input.operationId,
      accountId: input.accountId,
      inputHash,
      applied,
    })
    return {
      operationId: input.operationId,
      accountId: input.accountId,
      applied,
      storageDurable: store.durable,
    }
  })
}
