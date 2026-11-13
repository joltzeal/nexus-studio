import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentSettingsSchema,
  AgentStepInputSchema,
  type AgentScope,
} from '@nexus/plugin-sdk/agent'
import { SalesAgentService } from './capability.js'
import type { AgentHost } from './host.js'
import { createSettingsStore } from './store/settings.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const settings = AgentSettingsSchema.parse({
  decision: {
    baseUrl: 'https://model.test/v1',
    model: 'decision',
    apiKey: 'fixture-key',
    protocol: 'openai',
  },
  generation: {
    baseUrl: 'https://model.test/v1',
    model: 'vision',
    apiKey: 'fixture-key',
  },
  notifications: { deviceKey: 'frozen-device-key' },
})
const input = AgentStepInputSchema.parse({
  scope: {
    batchId: id(1),
    jobId: id(2),
    windowId: id(3),
    accountId: id(4),
    leaseId: id(5),
    fence: 1,
  },
  preset: 'inspect_accounts',
  instruction: '',
  settings,
  snapshot: {
    windowId: id(3),
    windowName: 'Fixture',
    providerId: 'cloakbrowser',
    connectionId: 'builtin',
    profileId: id(3),
    platformOrigin: 'https://www.vinted.fr',
    account: {
      accountId: id(4),
      account: 'fixture',
      status: 'active',
      homepageUrl: 'https://www.vinted.fr/member/7',
      platformUserId: '7',
    },
    products: [],
    messages: [],
  },
})

class Host implements AgentHost {
  tuple: unknown = null
  calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  constructor(private readonly acquired: boolean) {}

  async call<T>(_scope: AgentScope, method: string, value: unknown): Promise<T> {
    const payload = value as Record<string, unknown>
    this.calls.push({ method, payload })
    let result: unknown = {}
    if (method === 'agent.controls.get') result = { revision: 0, items: [] }
    if (method === 'agent.checkpoint.get') result = this.tuple
    if (method === 'agent.checkpoint.put') {
      const checkpoint = payload['checkpoint'] as { id: string }
      const config = {
        configurable: {
          thread_id: id(2),
          checkpoint_ns: '',
          checkpoint_id: checkpoint.id,
        },
      }
      this.tuple = {
        config,
        checkpoint,
        metadata: payload['metadata'],
        pendingWrites: [],
      }
      result = config
    }
    if (method === 'agent.browser.execute') {
      const request = payload['input'] as { path?: string }
      result =
        payload['operation'] === 'snapshot'
          ? { url: 'https://www.vinted.fr/', title: '', text: '', controls: [] }
          : {
              url: `https://www.vinted.fr${request.path}`,
              status: 200,
              text: JSON.stringify({
                user: { id: 7, login: 'fixture', status: 'active' },
              }),
            }
    }
    if (method === 'agent.model.acquire')
      result = {
        acquired: this.acquired,
        requestId: payload['requestId'],
        ...(this.acquired ? {} : { reason: 'capacity', retryAfterMs: 2000 }),
      }
    if (method === 'agent.model.complete') result = { recorded: true }
    return structuredClone(result) as T
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('model permits through the production capability', () => {
  it.each([false, true])(
    'respects native acquire and reports completion only when acquired: %s',
    async (acquired) => {
      let traffic = 0
      vi.stubGlobal('fetch', async () => {
        traffic++
        return Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  tags: [],
                  summary: 'No confident classification.',
                }),
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 8 },
        })
      })
      const service = new SalesAgentService({
        read: async () => settings,
        save: async (value) => AgentSettingsSchema.parse(value),
        clear: async () => {},
      })
      const host = new Host(acquired)
      const context = {
        method: 'salesAgent.jobs.step',
        payload: input,
        signal: new AbortController().signal,
        assertAlive: () => {},
      }
      for (let n = 0; n < 8; n++) {
        const result = (await service.call(context, host)) as {
          phase: string
          retry?: unknown
        }
        if (result.phase === 'classify') break
      }
      const result = await service.call(context, host)
      expect(result).toMatchObject({
        phase: acquired ? 'record_classification' : 'classify',
      })
      expect(traffic).toBe(acquired ? 1 : 0)
      const acquire = host.calls.find((call) => call.method === 'agent.model.acquire')
      expect(acquire?.payload).toEqual({
        requestId: expect.any(String),
        kind: 'decision',
      })
      const complete = host.calls.filter((call) => call.method === 'agent.model.complete')
      expect(complete).toHaveLength(acquired ? 1 : 0)
      if (acquired)
        expect(complete[0]?.payload).toMatchObject({
          requestId: acquire!.payload['requestId'],
          outcome: 'succeeded',
          inputTokens: 50,
          outputTokens: 8,
        })
      expect(service.scrub('fixture-key frozen-device-key')).toBe('[REDACTED] [REDACTED]')
    },
  )

  it('routes native notification payloads to the sender and scrubs their frozen device key', async () => {
    let traffic = 0
    vi.stubGlobal('fetch', async () => {
      traffic++
      return Response.json({ code: 200 })
    })
    const service = new SalesAgentService({
      read: async () => null,
      save: async (value) => AgentSettingsSchema.parse(value),
      clear: async () => {},
    })
    const result = await service.call(
      {
        method: 'salesAgent.notifications.send',
        payload: {
          notificationId: id(9),
          batchId: id(1),
          kind: 'completed',
          settings: { enabled: true, deviceKey: 'outbox-frozen-key' },
          title: 'Batch finished',
          body: 'One item published.',
        },
        signal: new AbortController().signal,
        assertAlive: () => {},
      },
      new Host(true),
    )
    expect(result).toEqual({ delivered: true, notificationId: id(9) })
    expect(traffic).toBe(1)
    expect(service.scrub('outbox-frozen-key')).toBe('[REDACTED]')
  })

  it('scrubs a frozen notification device key when delivery fails after settings change', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('outbox-frozen-key')
    })
    const service = new SalesAgentService({
      read: async () => settings,
      save: async (value) => AgentSettingsSchema.parse(value),
      clear: async () => {},
    })
    const error: unknown = await service
      .call(
        {
          method: 'salesAgent.notifications.send',
          payload: {
            notificationId: id(9),
            batchId: id(1),
            kind: 'attention',
            settings: { enabled: true, deviceKey: 'outbox-frozen-key' },
            title: 'Batch needs review',
            body: 'One item needs review.',
          },
          signal: new AbortController().signal,
          assertAlive: () => {},
        },
        new Host(true),
      )
      .catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'NOTIFICATION_FAILED', retryable: true })
    expect(String(error)).not.toContain('outbox-frozen-key')
    expect(service.scrub('Failure with outbox-frozen-key')).toBe(
      'Failure with [REDACTED]',
    )
  })

  it('roundtrips execution, pricing, notifications, and retention through configuration transfer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-agent-transfer-'))
    try {
      const configured = AgentSettingsSchema.parse({
        ...settings,
        execution: {
          modelConcurrency: 2,
          modelRequestsPerMinute: 24,
          providerConcurrency: { cloakbrowser: 2, adspower: 4, bitbrowser: 1 },
          maxReadRetries: 3,
          retryBaseMs: 2500,
          platformCooldownMs: 45_000,
          maxBatchModelRequests: 50,
          maxBatchCostUsd: 5,
        },
        pricing: {
          decision: { inputPerMillionUsd: 2, outputPerMillionUsd: 3 },
          generation: { inputPerMillionUsd: 4, outputPerMillionUsd: 5 },
        },
        notifications: {
          enabled: true,
          baseUrl: 'https://bark.fixture.test',
          deviceKey: 'transfer-device-key',
          onCompleted: false,
          onAttention: true,
        },
        retention: { enabled: true, days: 14 },
      })
      const source = new SalesAgentService(createSettingsStore(join(directory, 'source')))
      const destination = new SalesAgentService(
        createSettingsStore(join(directory, 'destination')),
      )
      const context = (method: string, payload: unknown) => ({
        method,
        payload,
        signal: new AbortController().signal,
        assertAlive: () => {},
      })
      const host = new Host(true)
      await source.call(
        context('salesAgent.settings.save', { settings: configured }),
        host,
      )
      const exported = await source.call(context('configuration.export', {}), host)
      expect(
        await destination.call(context('configuration.validate', exported), host),
      ).toEqual({ valid: true })
      expect(
        await destination.call(context('configuration.import', exported), host),
      ).toEqual({ imported: true })
      expect(await destination.call(context('configuration.export', {}), host)).toEqual({
        schemaVersion: 1,
        data: configured,
      })
      expect(
        await destination.call(context('salesAgent.settings.get', {}), host),
      ).toEqual({ settings: configured })
      expect(destination.scrub('fixture-key transfer-device-key')).toBe(
        '[REDACTED] [REDACTED]',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
