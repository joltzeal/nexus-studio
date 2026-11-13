import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AgentStepInputSchema,
  type AgentControls,
  type AgentScope,
} from '@nexus/plugin-sdk/agent'
import type { AgentHost } from '../host.js'
import { AgentFailure } from '../errors.js'
import { operationIdFor, runAgentStep, type WorkflowPorts } from './step.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

class FakeHost implements AgentHost {
  tuple: Record<string, unknown> | null = null
  calls: { method: string; payload: Record<string, unknown> }[] = []
  action: { state: 'prepared' | 'unknown' | 'confirmed'; result?: unknown } | null = null
  nextPrepareFresh = true
  syncFails = false
  failCheckpoint = false
  controls: AgentControls = { revision: 0, items: [] }

  async call<T>(_scope: AgentScope, method: string, value: unknown): Promise<T> {
    const payload = value as Record<string, unknown>
    this.calls.push({ method, payload })
    let result: unknown = {}
    if (method === 'agent.controls.get') result = this.controls
    else if (method === 'agent.checkpoint.get') result = this.tuple
    else if (method === 'agent.checkpoint.put') {
      if (this.failCheckpoint) {
        this.failCheckpoint = false
        throw new Error('checkpoint disk unavailable')
      }
      const checkpoint = payload['checkpoint'] as Record<string, unknown>
      const config = {
        configurable: {
          thread_id: payload['threadId'],
          checkpoint_ns: payload['checkpointNs'],
          checkpoint_id: checkpoint['id'],
        },
      }
      this.tuple = {
        config,
        checkpoint,
        metadata: payload['metadata'],
        pendingWrites: [],
      }
      result = config
    } else if (method === 'agent.artifact.read') {
      result = {
        data: Buffer.from('image').toString('base64'),
        next: 5,
        total: 5,
        done: true,
      }
    } else if (method === 'agent.action.get') result = this.action ?? { state: 'missing' }
    else if (method === 'agent.action.prepare') {
      result = this.action
        ? { ...this.action, fresh: false }
        : {
            state: 'prepared',
            fresh: this.nextPrepareFresh,
          }
      this.action ??= { state: 'prepared' }
    } else if (method === 'agent.action.confirm') {
      this.action = { state: 'confirmed', result: payload['result'] }
      result = { confirmed: true }
    } else if (method === 'agent.action.unknown') this.action = { state: 'unknown' }
    else if (
      method === 'agent.plugin.call' &&
      payload['method'] === 'products.publications.record' &&
      this.syncFails
    )
      throw new Error('disk unavailable')
    return structuredClone(result) as T
  }
}

class MultiActionHost extends FakeHost {
  private readonly actions = new Map<string, NonNullable<FakeHost['action']>>()

  override async call<T>(scope: AgentScope, method: string, value: unknown): Promise<T> {
    if (!method.startsWith('agent.action.')) return super.call(scope, method, value)
    const operationId = (value as { operationId: string }).operationId
    this.action = this.actions.get(operationId) ?? null
    const result = await super.call<T>(scope, method, value)
    if (this.action) this.actions.set(operationId, structuredClone(this.action))
    return result
  }
}

const input = () =>
  AgentStepInputSchema.parse({
    scope: {
      batchId: id(1),
      jobId: id(2),
      windowId: id(3),
      accountId: id(4),
      leaseId: id(5),
      fence: 1,
    },
    preset: 'post_listing',
    instruction: '',
    settings: {
      decision: { baseUrl: 'https://example.test', apiKey: 'fake-key', model: 'jev' },
      generation: {
        baseUrl: 'https://example.test/v1',
        apiKey: 'fake-key',
        model: 'vision',
      },
    },
    snapshot: {
      windowId: id(3),
      windowName: 'Paris',
      providerId: 'cloakbrowser',
      connectionId: 'builtin-cloakbrowser',
      profileId: id(3),
      platformOrigin: 'https://www.vinted.fr',
      account: {
        accountId: id(4),
        account: 'test@example.test',
        status: 'active',
        homepageUrl: 'https://www.vinted.fr/member/123',
        platformUserId: '123',
      },
      products: [
        {
          id: id(6),
          revision: 1,
          name: 'Mug',
          title: 'Blue ceramic mug',
          description: 'A blue mug from my kitchen. Some small marks on the base.',
          price: 12,
          currency: 'EUR',
          condition: 'Good',
          images: [
            {
              id: id(7),
              artifactId: id(8),
              name: 'mug.png',
              mime: 'image/png',
              bytes: 5,
              sha256: createHash('sha256').update('image').digest('hex'),
            },
          ],
        },
      ],
      messages: [],
    },
  })

function ports(overrides: Partial<WorkflowPorts> = {}): WorkflowPorts {
  return {
    inspectAccount: async () => ({
      identity: { id: '123', username: 'seller' },
      status: 'active',
      source: 'official',
      evidence: {},
    }),
    readBalance: async () => ({ balanceStatus: 'unavailable', evidence: {} }),
    readAccountEvidence: async () => ({ items: [], feedback: null }),
    classifyAccount: async () => ({ tags: ['homeware'], summary: 'Household items' }),
    reviewImage: async () => ({
      decision: 'pass',
      confidence: 0.95,
      reason: 'Natural lighting',
    }),
    reviewCopy: async () => ({
      decision: 'pass',
      confidence: 0.95,
      reason: 'Personal description',
    }),
    rewriteCopy: async () => ({
      title: 'Blue ceramic mug',
      description: 'My kitchen mug.',
    }),
    plan: async () => ({ action: 'submit', target: { role: 'button', name: 'Upload' } }),
    openListing: async () => {},
    openConversation: async () => {},
    snapshot: async () => ({
      url: 'https://www.vinted.fr/items/new',
      title: '',
      text: '',
      controls: [],
    }),
    executePlan: async () => ({}),
    readListingForm: async () => ({
      title: input().snapshot.products[0]!.title,
      description: input().snapshot.products[0]!.description,
      price: '12',
      currency: 'EUR',
    }),
    readMessageForm: async () => ({ text: 'Thanks for your interest.' }),
    readListingBaseline: async () => ({
      url: 'https://www.vinted.fr/items/new',
      listingIds: [],
      observedAt: new Date().toISOString(),
    }),
    readMessageBaseline: async (conversationId) => ({
      conversationId,
      messageIds: ['100'],
      observedAt: new Date().toISOString(),
    }),
    confirmListing: async () => ({
      listingId: '456',
      listingUrl: 'https://www.vinted.fr/items/456',
      publishedAt: '2026-11-13T00:00:00Z',
    }),
    confirmMessage: async () => ({ messageId: '101', sentAt: new Date().toISOString() }),
    ...overrides,
  }
}

async function through(
  host: FakeHost,
  adapter: WorkflowPorts,
  until: (phase: string, state: string) => boolean,
  draft = input(),
) {
  for (let n = 0; n < 35; n++) {
    const result = await runAgentStep(draft, host, adapter)
    if (until(result.phase, result.state)) return result
  }
  throw new Error('workflow did not reach expected phase')
}

describe('durable single-window workflow', () => {
  it('checkpoints a retry deadline and preserves it across reconstruction without waiting', async () => {
    const host = new FakeHost()
    let requests = 0
    const requestIds: Array<string | undefined> = []
    const adapter = ports({
      classifyAccount: async (input) => {
        requestIds.push(input.requestId)
        if (++requests === 1)
          throw Object.assign(new AgentFailure('MODEL_HTTP', 'Rate limited.', true), {
            status: 429,
            retryAfterMs: 90_000,
          })
        return { tags: ['homeware'], summary: 'Household items' }
      },
    })
    await through(host, adapter, (phase) => phase === 'classify')
    const clock = () => new Date('2026-11-13T09:00:00Z')
    const retry = await runAgentStep(input(), host, adapter, undefined, clock)
    expect(retry).toMatchObject({
      state: 'continue',
      phase: 'classify',
      retry: {
        attempt: 1,
        maxAttempts: 2,
        code: 'MODEL_HTTP',
        nextAttemptAt: '2026-11-13T09:01:30.000Z',
      },
    })
    const restored = new FakeHost()
    restored.tuple = structuredClone(host.tuple)
    expect(
      await runAgentStep(input(), restored, adapter, undefined, clock),
    ).toMatchObject({
      retry: retry.retry,
    })
    expect(requests).toBe(1)
    const recovered = await runAgentStep(
      input(),
      restored,
      adapter,
      undefined,
      () => new Date('2026-11-13T09:01:30Z'),
    )
    expect(recovered.phase).toBe('record_classification')
    expect(recovered.retry).toBeUndefined()
    expect(requests).toBe(2)
    expect(requestIds[0]).toMatch(/^[a-f0-9-]{36}$/u)
    expect(requestIds[1]).not.toBe(requestIds[0])
  })

  it('exhausts bounded safe retries and exposes the item requiring review', async () => {
    const host = new FakeHost()
    let requests = 0
    const adapter = ports({
      reviewImage: async () => {
        requests++
        throw new AgentFailure('MODEL_NETWORK', 'Model unavailable.', true)
      },
    })
    await through(host, adapter, (phase) => phase === 'image_review')
    let time = Date.parse('2026-11-13T09:00:00Z')
    const clock = () => new Date(time)
    for (const delay of [2000, 4000]) {
      const result = await runAgentStep(input(), host, adapter, undefined, clock)
      expect(Date.parse(result.retry!.nextAttemptAt) - time).toBe(delay)
      time += delay
    }
    const exhausted = await runAgentStep(input(), host, adapter, undefined, clock)
    expect(exhausted.state).toBe('review_required')
    expect(exhausted.retry).toBeUndefined()
    expect(exhausted.itemUpdates).toEqual([
      expect.objectContaining({
        productId: id(6),
        state: 'review_required',
        reason: expect.stringContaining('Model unavailable.'),
      }),
    ])
    expect(requests).toBe(3)
  })

  it('does not retry an uncertain external submit even when the error is marked retryable', async () => {
    const host = new FakeHost()
    let submits = 0
    const adapter = ports({
      executePlan: async (plan) => {
        if (plan.action === 'submit') {
          submits++
          throw new AgentFailure('MODEL_NETWORK', 'Reply lost.', true)
        }
      },
      confirmListing: async () => {
        throw new AgentFailure('READ_FAILED', 'Unavailable.', true)
      },
    })
    const result = await through(host, adapter, (_, state) => state === 'result_unknown')
    expect(result.retry).toBeUndefined()
    expect(result.itemUpdates?.[0]?.state).toBe('result_unknown')
    await runAgentStep(input(), host, adapter)
    expect(submits).toBe(1)
  })

  it('consumes a skip once and reports the next item without changing immutable products', async () => {
    const host = new MultiActionHost()
    const draft = input()
    draft.snapshot.products.push({ ...draft.snapshot.products[0]!, id: id(9) })
    const original = structuredClone(draft)
    host.controls = {
      revision: 1,
      items: [{ productId: id(6), action: 'skip', revision: 1 }],
    }
    const submitted: string[] = []
    const adapter = ports({
      executePlan: async (plan, product) => {
        if (plan.action === 'submit') submitted.push(product!.id)
      },
    })
    const skipped = await through(host, adapter, (phase) => phase === 'advance', draft)
    expect(skipped.itemUpdates?.[0]).toMatchObject({ productId: id(6), state: 'skipped' })
    const advanced = await runAgentStep(draft, host, adapter)
    expect(advanced.progress).toMatchObject({
      currentIndex: 1,
      currentProductId: id(9),
      skipped: 1,
    })
    await through(host, adapter, (_, state) => state === 'completed', draft)
    expect(submitted).toEqual([id(9)])
    expect(draft).toEqual(original)
  })

  it('keeps a hundred explicit long amendments within the checkpoint budget as items advance', async () => {
    const host = new MultiActionHost()
    const draft = input()
    const first = draft.snapshot.products[0]!
    draft.snapshot.products = Array.from({ length: 100 }, (_, index) => ({
      ...first,
      id: id(100 + index),
    }))
    const adapter = ports()
    await through(host, adapter, (phase) => phase === 'image_review', draft)
    let completed
    for (const [index, product] of draft.snapshot.products.entries()) {
      host.controls = {
        revision: index * 2 + 1,
        items: [
          {
            productId: product.id,
            action: 'revise',
            revision: index * 2 + 1,
            override: { description: `Item ${index}: `.padEnd(6000, 'x') },
          },
        ],
      }
      await runAgentStep(draft, host, adapter)
      host.controls = {
        revision: index * 2 + 2,
        items: [{ productId: product.id, action: 'skip', revision: index * 2 + 2 }],
      }
      await runAgentStep(draft, host, adapter)
      completed = await runAgentStep(draft, host, adapter)
      expect(Buffer.byteLength(JSON.stringify(host.tuple))).toBeLessThan(64 * 1024)
    }
    expect(completed).toMatchObject({
      state: 'skipped',
      progress: { skipped: 100, published: 0 },
    })
    expect(host.calls.some((call) => call.method === 'agent.action.prepare')).toBe(false)
  }, 20_000)

  it('layers an explicit unsubmitted revision over the original snapshot and rereviews it', async () => {
    const host = new FakeHost()
    const draft = input()
    const original = structuredClone(draft)
    const revised = {
      title: 'Blue mug with marks',
      description: 'My used blue mug has small marks on the base.',
      price: 15,
    }
    let reviewed: unknown
    const adapter = ports({
      reviewCopy: async ({ product }) => {
        reviewed = structuredClone(product)
        return { decision: 'pass', confidence: 0.99, reason: 'Supported facts.' }
      },
      readListingForm: async () => ({ ...revised, price: '15', currency: 'EUR' }),
    })
    await through(host, adapter, (phase) => phase === 'submit', draft)
    host.controls = {
      revision: 1,
      items: [{ productId: id(6), action: 'revise', override: revised, revision: 1 }],
    }
    const revision = await runAgentStep(draft, host, adapter)
    expect(revision.phase).toBe('image_review')
    expect(revision.itemUpdates?.[0]).toMatchObject({
      title: revised.title,
      description: revised.description,
      productId: id(6),
    })
    const restored = new FakeHost()
    restored.tuple = structuredClone(host.tuple)
    restored.controls = host.controls
    await through(restored, adapter, (_, state) => state === 'completed', draft)
    expect(reviewed).toMatchObject(revised)
    expect(draft).toEqual(original)
  })

  it('accepts explicit approval of reviewed copy but never skips a prepared action', async () => {
    const host = new FakeHost()
    const adapter = ports({
      reviewCopy: async () => ({
        decision: 'review',
        confidence: 0.99,
        reason: 'Please inspect the copy.',
      }),
    })
    await through(host, adapter, (_, state) => state === 'review_required')
    host.controls = {
      revision: 1,
      items: [{ productId: id(6), action: 'approve', revision: 1 }],
    }
    expect((await runAgentStep(input(), host, adapter)).phase).toBe('open')
    await through(host, adapter, (phase) => phase === 'confirm')
    const receipt = structuredClone(host.action)
    host.controls = {
      revision: 2,
      items: [{ productId: id(6), action: 'skip', revision: 2 }],
    }
    const result = await runAgentStep(input(), host, adapter)
    expect(result.phase).toBe('sync')
    expect(result.progress?.skipped).toBe(0)
    expect(receipt?.state).toBe('prepared')
    expect(host.action?.state).toBe('confirmed')
  })

  it.each([
    { review: 'image', approvedPhase: 'image_review', nextPhase: 'copy_review' },
    { review: 'copy', approvedPhase: 'open', nextPhase: 'prepare' },
  ])(
    'consumes native approval with an empty override at $review review',
    async ({ review, approvedPhase, nextPhase }) => {
      const host = new FakeHost()
      const adapter = ports({
        ...(review === 'image'
          ? {
              reviewImage: async () => ({
                decision: 'review' as const,
                confidence: 0.99,
                reason: 'Please inspect the image.',
              }),
            }
          : {
              reviewCopy: async () => ({
                decision: 'review' as const,
                confidence: 0.99,
                reason: 'Please inspect the copy.',
              }),
            }),
      })
      await through(host, adapter, (_, state) => state === 'review_required')
      host.controls = {
        revision: 1,
        items: [{ productId: id(6), action: 'approve', override: {}, revision: 1 }],
      }
      expect(await runAgentStep(input(), host, adapter)).toMatchObject({
        phase: approvedPhase,
        state: 'continue',
      })
      expect(await runAgentStep(input(), host, adapter)).toMatchObject({
        phase: nextPhase,
        state: 'continue',
      })
      const completed = await through(host, adapter, (_, state) => state === 'completed')
      expect(completed.progress?.published).toBe(1)
    },
  )

  it.each([
    { review: 'image', approvedPhase: 'image_review', nextPhase: 'copy_review' },
    { review: 'copy', approvedPhase: 'open', nextPhase: 'prepare' },
  ])(
    'continues $review review when native approval retains the applied revision',
    async ({ review, approvedPhase, nextPhase }) => {
      const host = new FakeHost()
      const draft = input()
      const original = structuredClone(draft)
      const revised = {
        title: 'Blue mug with marks',
        description: 'My used blue mug has small marks on the base.',
        price: 15,
      }
      host.controls = {
        revision: 1,
        items: [{ productId: id(6), action: 'revise', override: revised, revision: 1 }],
      }
      const submitted: unknown[] = []
      const adapter = ports({
        ...(review === 'image'
          ? {
              reviewImage: async () => ({
                decision: 'review' as const,
                confidence: 0.99,
                reason: 'Please inspect the revised image.',
              }),
            }
          : {
              reviewCopy: async () => ({
                decision: 'review' as const,
                confidence: 0.99,
                reason: 'Please inspect the revised copy.',
              }),
            }),
        executePlan: async (plan, product) => {
          if (plan.action === 'submit') submitted.push(structuredClone(product))
        },
        readListingForm: async () => ({ ...revised, currency: 'EUR' }),
      })
      const halted = await through(
        host,
        adapter,
        (_, state) => state === 'review_required',
        draft,
      )
      expect(halted.itemUpdates?.[0]).toMatchObject({
        title: revised.title,
        description: revised.description,
      })
      const restored = new FakeHost()
      restored.tuple = structuredClone(host.tuple)
      restored.controls = {
        revision: 2,
        items: [
          {
            productId: id(6),
            action: 'approve',
            override: {
              price: revised.price,
              description: revised.description,
              title: revised.title,
            },
            revision: 2,
          },
        ],
      }
      expect(await runAgentStep(draft, restored, adapter)).toMatchObject({
        phase: approvedPhase,
        state: 'continue',
      })
      expect(await runAgentStep(draft, restored, adapter)).toMatchObject({
        phase: nextPhase,
        state: 'continue',
      })
      await through(restored, adapter, (_, state) => state === 'completed', draft)
      expect(submitted).toEqual([expect.objectContaining(revised)])
      expect(draft).toEqual(original)
    },
  )

  it('revalidates an unseen retained amendment on approval after a lost checkpoint', async () => {
    const host = new FakeHost()
    const draft = input()
    const original = structuredClone(draft)
    const revised = {
      title: 'Blue mug with marks',
      description: 'My used blue mug has small marks on the base.',
      price: 15,
    }
    const reviewed: unknown[] = []
    const adapter = ports({
      reviewCopy: async ({ product }) => {
        reviewed.push(structuredClone(product))
        return { decision: 'review', confidence: 0.99, reason: 'Please inspect.' }
      },
    })
    await through(host, adapter, (_, state) => state === 'review_required', draft)
    const beforeRevision = structuredClone(host.tuple)
    host.controls = {
      revision: 1,
      items: [{ productId: id(6), action: 'revise', override: revised, revision: 1 }],
    }
    await runAgentStep(draft, host, adapter)
    await through(host, adapter, (_, state) => state === 'review_required', draft)
    const restored = new FakeHost()
    restored.tuple = beforeRevision
    restored.controls = {
      revision: 2,
      items: [{ productId: id(6), action: 'approve', override: revised, revision: 2 }],
    }
    const amendment = await runAgentStep(draft, restored, adapter)
    expect(amendment).toMatchObject({ phase: 'image_review', state: 'continue' })
    expect(amendment.itemUpdates?.[0]).toMatchObject({
      title: revised.title,
      description: revised.description,
    })
    const halted = await through(
      restored,
      adapter,
      (_, state) => state === 'review_required',
      draft,
    )
    expect(halted.phase).toBe('halt')
    expect(reviewed).toEqual([
      expect.objectContaining({ title: 'Blue ceramic mug', price: 12 }),
      expect.objectContaining(revised),
      expect.objectContaining(revised),
    ])
    expect(restored.calls.some((call) => call.method === 'agent.action.prepare')).toBe(
      false,
    )
    expect(draft).toEqual(original)
  })

  it('does not let item approval bypass failed account identity inspection', async () => {
    const host = new FakeHost()
    const adapter = ports({
      inspectAccount: async () => ({
        identity: { id: '999', username: 'wrong' },
        status: 'active',
        source: 'official',
        evidence: {},
      }),
    })
    await runAgentStep(input(), host, adapter)
    host.controls = {
      revision: 1,
      items: [{ productId: id(6), action: 'approve', revision: 1 }],
    }
    const result = await runAgentStep(input(), host, adapter)
    expect(result.state).toBe('review_required')
    expect(result.phase).toBe('halt')
  })

  it('retries transient pre-submit form reads only while the journal proves no intent exists', async () => {
    const host = new FakeHost()
    let reads = 0
    const adapter = ports({
      readListingForm: async () => {
        if (++reads === 1)
          throw new AgentFailure('PLATFORM_NETWORK', 'Read failed.', true)
        return {
          title: input().snapshot.products[0]!.title,
          description: input().snapshot.products[0]!.description,
          price: '12',
          currency: 'EUR',
        }
      },
    })
    await through(host, adapter, (phase) => phase === 'submit')
    const result = await runAgentStep(input(), host, adapter)
    expect(result).toMatchObject({
      phase: 'submit',
      state: 'continue',
      retry: { attempt: 1 },
    })
    expect(host.action).toBeNull()
  })

  it('preserves stable operation identity across retries', () => {
    expect(operationIdFor(id(2), 'listing:x')).toBe(operationIdFor(id(2), 'listing:x'))
    expect(operationIdFor(id(2), 'listing:x')).not.toBe(
      operationIdFor(id(3), 'listing:x'),
    )
  })

  it('confirms publication then syncs real facts, never from assignment alone', async () => {
    const host = new FakeHost()
    let submits = 0
    const result = await through(
      host,
      ports({
        executePlan: async (plan) => {
          if (plan.action === 'submit') submits++
          return {}
        },
      }),
      (_, state) => state === 'completed',
    )
    expect(result.state).toBe('completed')
    expect(submits).toBe(1)
    const methods = host.calls.filter(
      (call) =>
        call.method === 'agent.action.confirm' ||
        call.payload['method'] === 'products.publications.record',
    )
    expect(methods.map((call) => call.method)).toEqual([
      'agent.action.confirm',
      'agent.plugin.call',
    ])
  })

  it('stops blocked accounts before review, browser writes or publication records', async () => {
    const host = new FakeHost()
    let wrote = false
    const result = await through(
      host,
      ports({
        inspectAccount: async () => ({
          identity: { id: '123', username: 'seller' },
          status: 'blocked',
          source: 'official',
          evidence: { is_blocked: true },
        }),
        executePlan: async () => {
          wrote = true
        },
      }),
      (_, state) => state === 'blocked',
    )
    expect(result.state).toBe('blocked')
    expect(wrote).toBe(false)
    expect(
      host.calls.some(
        (call) => call.payload['method'] === 'products.publications.record',
      ),
    ).toBe(false)
  })

  it('does not resubmit after a lost confirmation or process reconstruction', async () => {
    const host = new FakeHost()
    let submits = 0
    let confirms = 0
    const adapter = ports({
      executePlan: async (plan) => {
        if (plan.action === 'submit') submits++
        return {}
      },
      confirmListing: async () => {
        if (++confirms === 1) throw new Error('network timeout')
        return {
          listingId: '456',
          listingUrl: 'https://www.vinted.fr/items/456',
          publishedAt: '2026-11-13T00:00:00Z',
        }
      },
    })
    const unknown = await through(host, adapter, (_, state) => state === 'result_unknown')
    expect(unknown.phase).toBe('confirm')
    const restored = new FakeHost()
    restored.tuple = structuredClone(host.tuple)
    restored.action = structuredClone(host.action)
    expect((await runAgentStep(input(), restored, adapter)).phase).toBe('sync')
    expect(submits).toBe(1)
  })

  it('retries only record sync after the platform action succeeded', async () => {
    const host = new FakeHost()
    host.syncFails = true
    let submits = 0
    const adapter = ports({
      executePlan: async (plan) => {
        if (plan.action === 'submit') submits++
        return {}
      },
    })
    await through(host, adapter, (_, state) => state === 'sync_pending')
    host.syncFails = false
    await through(host, adapter, (_, state) => state === 'completed')
    expect(submits).toBe(1)
    expect(
      host.calls.filter((call) => call.method === 'agent.action.confirm'),
    ).toHaveLength(1)
  })

  it('finishes all products in one window with separate submission receipts after sync recovery', async () => {
    const host = new MultiActionHost()
    const draft = input()
    const first = draft.snapshot.products[0]!
    const second = {
      ...structuredClone(first),
      id: id(9),
      title: 'Red ceramic mug',
      images: [{ ...first.images[0]!, id: id(10), artifactId: id(11) }],
    }
    draft.snapshot.products.push(second)
    host.syncFails = true
    let prepared = first
    const submitted: string[] = []
    const adapter = ports({
      plan: async ({ product }) => {
        prepared = product!
        return { action: 'submit', target: { role: 'button', name: 'Upload' } }
      },
      readListingForm: async () => ({
        title: prepared.title,
        description: prepared.description,
        price: '12',
        currency: 'EUR',
      }),
      executePlan: async (plan, product) => {
        if (plan.action === 'submit') submitted.push(product!.id)
      },
      confirmListing: async (product) => ({
        listingId: product.id === first.id ? '456' : '457',
        listingUrl:
          product.id === first.id
            ? 'https://www.vinted.fr/items/456'
            : 'https://www.vinted.fr/items/457',
        publishedAt: '2026-11-13T00:00:00Z',
      }),
    })
    await through(host, adapter, (_, state) => state === 'sync_pending', draft)
    expect(submitted).toEqual([first.id])
    host.syncFails = false
    const result = await through(
      host,
      adapter,
      (_, state) => state === 'completed',
      draft,
    )
    expect(result.message).toContain('2')
    expect(submitted).toEqual([first.id, second.id])
    const receipts = host.calls.filter((call) => call.method === 'agent.action.confirm')
    expect(receipts.map((call) => call.payload['operationId'])).toEqual([
      operationIdFor(id(2), `listing:${first.id}`),
      operationIdFor(id(2), `listing:${second.id}`),
    ])
  })

  it('reconciles a sent message after reconstruction without sending it twice', async () => {
    const host = new FakeHost()
    const draft = input()
    draft.preset = 'message'
    draft.snapshot.products = []
    draft.snapshot.messages = [
      { conversationId: '999', text: 'Thanks for your interest.' },
    ]
    let submissions = 0
    let confirmations = 0
    const adapter = ports({
      plan: async () => ({ action: 'submit', target: { role: 'button', name: 'Send' } }),
      executePlan: async (plan) => {
        if (plan.action === 'submit') submissions++
      },
      confirmMessage: async (conversationId, text, baseline) => {
        expect(conversationId).toBe('999')
        expect(text).toBe('Thanks for your interest.')
        expect(baseline.messageIds).toEqual(['100'])
        if (++confirmations === 1) throw new Error('response lost')
        return { messageId: '101', sentAt: new Date().toISOString() }
      },
    })
    await through(host, adapter, (_, state) => state === 'result_unknown', draft)
    const recovered = new FakeHost()
    recovered.tuple = structuredClone(host.tuple)
    recovered.action = structuredClone(host.action)
    const result = await through(
      recovered,
      adapter,
      (_, state) => state === 'completed',
      draft,
    )
    expect(result.state).toBe('completed')
    expect(submissions).toBe(1)
    expect(recovered.action?.result).toMatchObject({
      kind: 'message',
      conversationId: '999',
      text: 'Thanks for your interest.',
      evidence: { messageId: '101' },
    })
    expect(
      recovered.calls.some(
        (call) => call.payload['method'] === 'products.publications.record',
      ),
    ).toBe(false)
  })

  it('does not submit again when only the durable intent survived', async () => {
    const host = new FakeHost()
    let submits = 0
    const adapter = ports({
      executePlan: async (plan) => {
        if (plan.action === 'submit') submits++
        return {}
      },
    })
    await through(host, adapter, (phase) => phase === 'submit')
    host.action = { state: 'prepared' }
    expect((await runAgentStep(input(), host, adapter)).state).toBe('result_unknown')
    expect(submits).toBe(0)
  })

  it('validates the observed form before persisting a submission intent', async () => {
    const host = new FakeHost()
    const result = await through(
      host,
      ports({
        readListingForm: async () => ({
          title: 'A different item',
          description: 'Wrong description',
          price: '1200',
          currency: 'EUR',
        }),
      }),
      (_, state) => state === 'review_required',
    )
    expect(result.message).toContain('表单')
    expect(host.calls.some((call) => call.method === 'agent.action.prepare')).toBe(false)
  })

  it('reports preparation until the native journal actually owns a submission intent', async () => {
    const host = new FakeHost()
    const result = await through(host, ports(), (phase) => phase === 'submit')
    expect(host.action).toBeNull()
    expect(result.itemUpdates?.[0]?.state).toBe('preparing')
  })

  it('reviews rewritten copy against the original disclosed defects before publishing', async () => {
    const host = new FakeHost()
    const original = input().snapshot.products[0]!
    const rewritten = {
      title: 'Blue ceramic mug',
      description: 'My blue mug, ready for a new kitchen.',
    }
    let submits = 0
    const reviewedFacts: string[] = []
    const result = await through(
      host,
      ports({
        reviewCopy: async ({ product, description }) => {
          reviewedFacts.push(product.description)
          if (description === original.description)
            return { decision: 'skip', confidence: 0.99, reason: 'Rewrite the style.' }
          if (
            product.description.includes('small marks on the base') &&
            !description.includes('small marks')
          ) {
            return {
              decision: 'review',
              confidence: 0.99,
              reason: 'The rewrite omits the disclosed marks on the base.',
            }
          }
          return { decision: 'pass', confidence: 0.99, reason: 'No missing facts.' }
        },
        rewriteCopy: async () => rewritten,
        readListingForm: async () => ({
          ...rewritten,
          price: '12',
          currency: 'EUR',
        }),
        executePlan: async (plan) => {
          if (plan.action === 'submit') submits++
        },
      }),
      (_, state) => state === 'review_required' || state === 'completed',
    )
    expect(result.state).toBe('review_required')
    expect(result.message).toContain('omits')
    expect(reviewedFacts).toEqual([original.description, original.description])
    expect(submits).toBe(0)
    expect(host.calls.some((call) => call.method === 'agent.action.prepare')).toBe(false)
  })

  it('keeps original facts through every bounded rewrite attempt', async () => {
    const host = new FakeHost()
    const original = input().snapshot.products[0]!
    const rewriteFacts: string[] = []
    const result = await through(
      host,
      ports({
        reviewCopy: async () => ({
          decision: 'skip',
          confidence: 0.99,
          reason: 'The copy still needs a rewrite.',
        }),
        rewriteCopy: async ({ product }) => {
          rewriteFacts.push(product.description)
          return { title: 'Blue ceramic mug', description: 'A shortened description.' }
        },
      }),
      (_, state) => state === 'review_required',
    )
    expect(result.message).toContain('改写')
    expect(rewriteFacts).toEqual([original.description, original.description])
    expect(host.calls.some((call) => call.method === 'agent.action.prepare')).toBe(false)
  })

  it('blocks a listing whose observed currency differs from the assigned product', async () => {
    const host = new FakeHost()
    const result = await through(
      host,
      ports({
        readListingForm: async () => ({
          title: input().snapshot.products[0]!.title,
          description: input().snapshot.products[0]!.description,
          price: '12',
          currency: 'USD',
        }),
      }),
      (_, state) => state === 'review_required',
    )
    expect(result.message).toContain('表单')
    expect(host.calls.some((call) => call.method === 'agent.action.prepare')).toBe(false)
  })

  it('requires the exact assigned message in the composer before saving an intent', async () => {
    const host = new FakeHost()
    const draft = input()
    draft.preset = 'message'
    draft.snapshot.products = []
    draft.snapshot.messages = [
      { conversationId: '999', text: 'Thanks for your interest.' },
    ]
    let submits = 0
    const result = await through(
      host,
      ports({
        readMessageForm: async () => ({ text: 'An unapproved message' }),
        executePlan: async (plan) => {
          if (plan.action === 'submit') submits++
        },
      }),
      (_, state) => state === 'review_required',
      draft,
    )
    expect(result.message).toContain('消息')
    expect(submits).toBe(0)
    expect(host.calls.some((call) => call.method === 'agent.action.prepare')).toBe(false)
  })

  it('records balance with its observed page source rather than the identity API source', async () => {
    const host = new FakeHost()
    const draft = input()
    draft.preset = 'inspect_accounts'
    draft.snapshot.products = []
    await through(
      host,
      ports({
        readBalance: async () => ({
          balanceStatus: 'observed',
          balanceSource: 'page',
          balance: { currency: 'EUR', available: '12.30', pending: '5.00' },
          evidence: { source: 'page' },
        }),
      }),
      (_, state) => state === 'completed',
      draft,
    )
    const observations = host.calls
      .filter((call) => call.payload['method'] === 'vinted.accounts.observations.record')
      .map((call) => call.payload['payload'] as Record<string, unknown>)
    expect(observations.find((entry) => entry['balance'])).toMatchObject({
      source: 'page',
      balance: { currency: 'EUR', available: '12.30', pending: '5.00' },
    })
    expect(
      observations.find((entry) => entry['status'] === 'active')?.['balance'],
    ).toBeUndefined()
  })

  it('reconciles an existing intent before reading a form that is no longer open', async () => {
    const host = new FakeHost()
    let formReads = 0
    const adapter = ports({
      readListingForm: async () => {
        formReads++
        throw new Error('listing page already open')
      },
    })
    await through(host, adapter, (phase) => phase === 'submit')
    host.action = { state: 'unknown' }
    const result = await runAgentStep(input(), host, adapter)
    expect(result).toMatchObject({ phase: 'confirm', state: 'result_unknown' })
    expect(formReads).toBe(0)
  })

  it('uses the immutable confirmed receipt after checkpoint failure without confirming again', async () => {
    const host = new FakeHost()
    let confirmations = 0
    const adapter = ports({
      confirmListing: async () => {
        confirmations++
        host.failCheckpoint = true
        return {
          listingId: '456',
          listingUrl: 'https://www.vinted.fr/items/456',
          publishedAt: '2026-11-13T00:00:00Z',
        }
      },
    })
    await through(host, adapter, (phase) => phase === 'confirm')
    await expect(runAgentStep(input(), host, adapter)).rejects.toThrow()
    expect(host.action?.state).toBe('confirmed')
    await runAgentStep(input(), host, adapter)
    expect(confirmations).toBe(1)
  })

  it('persists the original listing baseline before submission across process reconstruction', async () => {
    const host = new FakeHost()
    const contexts: unknown[] = []
    let baselineReads = 0
    const adapter = ports({
      readListingBaseline: async () => {
        baselineReads++
        return {
          url: 'https://www.vinted.fr/items/new',
          observedAt: new Date().toISOString(),
          listingIds: ['450'],
        }
      },
      confirmListing: async (_product, context) => {
        contexts.push(structuredClone(context))
        return {
          listingId: '456',
          listingUrl: 'https://www.vinted.fr/items/456',
          publishedAt: new Date().toISOString(),
        }
      },
    })
    await through(host, adapter, (phase) => phase === 'submit')
    const recovered = new FakeHost()
    recovered.tuple = structuredClone(host.tuple)
    await through(recovered, adapter, (_, state) => state === 'completed')
    expect(baselineReads).toBe(1)
    expect(contexts).toEqual([
      expect.objectContaining({
        url: 'https://www.vinted.fr/items/new',
        listingIds: ['450'],
        observedAt: expect.any(String),
        intentStartedAt: expect.any(String),
      }),
    ])
  })

  it('halts on identity mismatch and uncertain image evaluation', async () => {
    const mismatched = await runAgentStep(
      input(),
      new FakeHost(),
      ports({
        inspectAccount: async () => ({
          identity: { id: '999', username: 'wrong' },
          status: 'active',
          source: 'official',
          evidence: {},
        }),
      }),
    )
    expect(mismatched.state).toBe('review_required')
    const uncertain = await through(
      new FakeHost(),
      ports({
        reviewImage: async () => ({
          decision: 'pass',
          confidence: 0.6,
          reason: 'Unclear image',
        }),
      }),
      (_, state) => state === 'review_required',
    )
    expect(uncertain.message).toContain('图片')
  })
})
