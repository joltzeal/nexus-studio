import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import {
  ACCOUNT_AGENT_METHODS,
  ACCOUNT_AGENT_SNAPSHOT_METHOD,
  ACCOUNT_OBSERVATION_RECORD_METHOD,
  AccountAgentSnapshotResultSchema,
  AccountObservationResultSchema,
} from '../agent-contracts.js'
import { createVintedAccountsPlugin } from '../index.js'
import type { PluginResponse, ReadyMessage } from './protocol.js'

const accountId = '11111111-1111-4111-8111-111111111111'
const windowId = '22222222-2222-4222-8222-222222222222'

describe('account observation RPC', () => {
  it('advertises both methods and returns narrow snapshots and idempotent write receipts', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const diagnostics = new PassThrough()
    const messages: unknown[] = []
    const pending = new Map<string, (value: PluginResponse) => void>()
    let buffer = ''
    output.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const message = JSON.parse(line) as PluginResponse
        messages.push(message)
        pending.get(message.requestId)?.(message)
        pending.delete(message.requestId)
      }
    })
    const instance = createVintedAccountsPlugin({
      input,
      output,
      diagnostics,
      idFactory: () => accountId,
    })
    let sequence = 0
    const request = (method: string, payload: unknown) =>
      new Promise<PluginResponse>((resolve) => {
        const requestId = `agent-${++sequence}`
        pending.set(requestId, resolve)
        input.write(
          `${JSON.stringify({
            protocolVersion: 1,
            requestId,
            capability: 'account.pool',
            method,
            payload,
            deadlineMs: 10_000,
          })}\n`,
        )
      })
    try {
      instance.server.start()
      input.write('{"type":"handshake","protocolVersion":1}\n')
      const ready = messages.find(
        (message) => (message as { type?: unknown }).type === 'ready',
      ) as ReadyMessage
      expect(ready.methods).toEqual(expect.arrayContaining([...ACCOUNT_AGENT_METHODS]))
      expect(
        (
          await request('vinted.accounts.save', {
            loginMethod: 'email',
            account: 'seller@example.test',
            password: 'synthetic account password',
            phone: '',
            emailOtpUrl: 'https://example.test/mail?key=synthetic',
            smsOtpUrl: 'https://example.test/sms?key=synthetic',
            note: 'Private operator note.',
            status: 'active',
            homepageUrl: 'https://www.vinted.fr/member/123-seller',
          })
        ).ok,
      ).toBe(true)
      expect((await request('vinted.accounts.bind', { accountId, windowId })).ok).toBe(
        true,
      )
      const observation = {
        operationId: '33333333-3333-4333-8333-333333333333',
        accountId,
        windowId,
        observedAt: '2026-11-13T08:00:00.000Z',
        source: 'official',
        platformUserId: '123',
        status: 'blocked',
        summary: 'Official block confirmed.',
      }
      const receipt = await request(ACCOUNT_OBSERVATION_RECORD_METHOD, observation)
      expect(receipt.ok).toBe(true)
      expect(AccountObservationResultSchema.parse(receipt.result)).toEqual({
        operationId: observation.operationId,
        accountId,
        applied: true,
        storageDurable: false,
      })
      expect(
        (await request(ACCOUNT_OBSERVATION_RECORD_METHOD, observation)).result,
      ).toEqual(receipt.result)
      const snapshot = await request(ACCOUNT_AGENT_SNAPSHOT_METHOD, { windowId })
      expect(snapshot.ok).toBe(true)
      expect(AccountAgentSnapshotResultSchema.parse(snapshot.result)).toMatchObject({
        account: {
          accountId,
          status: 'blocked',
          platformUserId: '123',
          observation: { summary: 'Official block confirmed.' },
        },
        windowId,
      })
      const encoded = JSON.stringify(snapshot)
      for (const privateText of [
        'password',
        'mailbox',
        'OtpUrl',
        'Private operator note.',
        '?key=synthetic',
      ])
        expect(encoded).not.toContain(privateText)
      const conflict = await request(ACCOUNT_OBSERVATION_RECORD_METHOD, {
        ...observation,
        status: 'active',
      })
      expect(conflict).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST', retryable: false },
      })
    } finally {
      instance.stop()
      await instance.plugin.orders.stop()
      input.destroy()
      output.destroy()
      diagnostics.destroy()
    }
  })
})
