import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  BrowserConnection,
  BrowserWindow,
  CreateBrowserWindowInput,
} from '@nexus/contracts/browser'
import {
  ProfileBatchController,
  pendingCreateProblem,
  prepareProfileBatch,
  type ProfileBatchConfig,
  type ProfileBatchPorts,
} from './controller.ts'

const connection = (
  providerId: BrowserConnection['providerId'] = 'cloakbrowser',
): BrowserConnection => ({
  id: 'connection-1',
  providerId,
  name: 'Workspace',
  endpoint: '',
  apiKey: null,
  defaultGroupId: null,
  scopeId: 'scope-1',
  scopeLabel: 'Scope',
  scopeConfirmed: true,
  enabled: true,
  revision: 1,
  capabilities: {
    create: true,
    update: true,
    deleteEnvironment: true,
    attach: true,
    manualProxy: true,
    proxyPlugin: true,
    geoip: true,
    fingerprintSeed: true,
    kernelSelection: true,
    transfer: false,
  },
})
function config(
  providerId: BrowserConnection['providerId'] = 'cloakbrowser',
): ProfileBatchConfig {
  return {
    connection: connection(providerId),
    targets: [
      { id: 'one', name: 'Target' },
      { id: 'two', name: 'Target' },
    ],
    namePrefix: '',
    template: {
      kernelVersion: null,
      proxyMode: 'direct',
      proxy: null,
      proxyId: null,
      proxyPlugin: null,
      proxyEndpoint: null,
      groupId: null,
      settings: {
        platform: '其他',
        note: 'original',
        geoip: true,
        timezone: '',
        locale: '',
        viewport: 'default',
        fingerprintSeed: null,
        aliasEngine: providerId === 'aliasmode' ? 'chromium' : null,
        operatingSystem: 'host',
        cpuCores: null,
        startUrl: '',
      },
    },
  }
}
function record(
  input: CreateBrowserWindowInput,
  overrides: Partial<BrowserWindow> = {},
): BrowserWindow {
  const { operationId, ...fields } = input
  void operationId
  return {
    ...fields,
    id: crypto.randomUUID(),
    providerId: 'cloakbrowser',
    providerProfileId: 'remote',
    origin: 'created',
    state: 'stopped',
    version: '152',
    kernelVersion: '152.0.0.1',
    createdAt: 1,
    lastOpenedAt: null,
    sortOrder: 1,
    ...overrides,
  }
}
function fixture(overrides: Partial<ProfileBatchPorts> = {}, setup = config()) {
  const calls: CreateBrowserWindowInput[] = []
  const bound: string[] = []
  const ports: ProfileBatchPorts = {
    checkConnection: async () => {},
    create: async (input) => {
      calls.push(structuredClone(input))
      return record(input, { providerId: setup.connection.providerId })
    },
    reconcile: async () => null,
    onBind: async (targetId) => {
      bound.push(targetId)
    },
    ...overrides,
  }
  return {
    job: new ProfileBatchController(setup, [], ports, () => 10),
    calls,
    bound,
    ports,
  }
}

test('freezes names, settings, unique seeds, operation IDs, and the resolved managed kernel', async () => {
  const setup = config()
  const { job, calls, bound } = fixture({}, setup)
  setup.template.settings.note = 'changed later'
  setup.targets[0].name = 'changed later'
  await job.run(() => {})
  assert.deepEqual(
    calls.map((input) => input.name),
    ['Target', 'Target-2'],
  )
  assert.deepEqual(
    calls.map((input) => input.settings.fingerprintSeed),
    [10, 11],
  )
  assert.deepEqual(
    calls.map((input) => input.settings.note),
    ['original', 'original'],
  )
  assert.deepEqual(
    calls.map((input) => input.kernelVersion),
    [null, '152.0.0.1'],
  )
  assert.equal(new Set(calls.map((input) => input.operationId)).size, 2)
  assert.deepEqual(bound, ['one', 'two'])
})

test('keeps a created Profile and retries only binding', async () => {
  let failure = true
  const { job, calls } = fixture({
    onBind: async () => {
      if (failure) throw new Error('binding failed')
    },
  })
  await job.run(() => {})
  assert.equal(job.items[0].status, 'binding_failed')
  const ids = job.items.map((item) => item.profileId)
  failure = false
  await job.run(() => {})
  assert.equal(calls.length, 2)
  assert.deepEqual(
    job.items.map((item) => item.profileId),
    ids,
  )
  assert.ok(job.items.every((item) => item.status === 'complete'))
})

test('a lost response reconciles once and manual retry preserves the exact input', async () => {
  const submitted: CreateBrowserWindowInput[] = []
  let reconciles = 0
  const { job } = fixture({
    create: async (input) => {
      submitted.push(structuredClone(input))
      if (submitted.length === 1) throw new Error('timeout')
      return record(input)
    },
    reconcile: async () => {
      reconciles++
      return null
    },
  })
  await job.run(() => {}, new Set(['one']))
  assert.equal(job.items[0].status, 'uncertain')
  assert.equal(reconciles, 1)
  await job.run(() => {}, new Set(['one']))
  assert.deepEqual(submitted[1], submitted[0])
  assert.equal(job.items[0].status, 'complete')
})

test('a reconciled success is bound without submitting a second create', async () => {
  let submitted: CreateBrowserWindowInput | null = null
  const { job, bound } = fixture({
    create: async (input) => {
      submitted = input
      throw new Error('lost response')
    },
    reconcile: async () => record(submitted!),
  })
  await job.run(() => {}, new Set(['one']))
  assert.deepEqual(bound, ['one'])
  assert.equal(job.items[0].status, 'complete')
})

for (const kernelVersion of [null, '152']) {
  test(`missing or partial kernel ${kernelVersion} blocks the batch until reconciliation`, async () => {
    const creates: CreateBrowserWindowInput[] = []
    let recovered = false
    const firstId = crypto.randomUUID()
    const { job, bound } = fixture({
      create: async (input) => {
        creates.push(input)
        return record(input, creates.length === 1 ? { id: firstId, kernelVersion } : {})
      },
      reconcile: async () => (recovered ? record(creates[0], { id: firstId }) : null),
    })
    await job.run(() => {})
    assert.equal(creates.length, 1)
    assert.equal(job.items[0].profileId, firstId)
    assert.equal(job.items[0].status, 'uncertain')
    assert.equal(job.items[1].status, 'pending')
    assert.deepEqual(bound, [])
    await job.run(() => {}, new Set(['two']))
    assert.equal(
      creates.length,
      1,
      'cannot bypass the unresolved kernel by unchecking its row',
    )
    await job.run(() => {})
    assert.equal(creates.length, 1, 'retrying an existing Profile must not create again')
    recovered = true
    await job.run(() => {})
    assert.equal(creates.length, 2)
    assert.equal(creates[1].kernelVersion, '152.0.0.1')
    assert.deepEqual(bound, ['one', 'two'])
  })
}

for (const invalid of [
  { connectionId: 'other-connection' },
  { providerId: 'bitbrowser' as const },
]) {
  test(`rejects an out-of-scope created Profile ${JSON.stringify(invalid)}`, async () => {
    const { job, bound } = fixture({ create: async (input) => record(input, invalid) })
    await job.run(() => {}, new Set(['one']))
    assert.equal(job.items[0].status, 'create_failed')
    assert.equal(job.items[0].profileId, null)
    assert.deepEqual(bound, [])
  })
}

test('one Profile ID cannot be associated with two targets in this batch', async () => {
  const id = crypto.randomUUID()
  const { job, bound } = fixture({ create: async (input) => record(input, { id }) })
  await job.run(() => {})
  assert.equal(job.items[0].status, 'complete')
  assert.equal(job.items[1].status, 'create_failed')
  assert.deepEqual(bound, ['one'])
  await job.run(() => {})
  assert.deepEqual(bound, ['one'])
})

test('reentrant runs are deduplicated and stopping waits for the current binding', async () => {
  const setup = fixture()
  setup.ports.onBind = async () => setup.job.stopAfterCurrent()
  const first = setup.job.run(() => {
    void setup.job.run(() => {})
  })
  assert.equal(
    setup.job.run(() => {}),
    first,
  )
  await first
  assert.equal(setup.calls.length, 1)
  assert.equal(setup.job.items[1].status, 'pending')
  setup.ports.onBind = async () => {}
  await setup.job.run(() => {})
  assert.equal(setup.calls.length, 2)
})

test('external providers receive no Raccoon seed and retain the chosen vendor kernel', async () => {
  const setup = config('bitbrowser')
  setup.template.kernelVersion = '130'
  const { job, calls } = fixture({}, setup)
  await job.run(() => {})
  assert.ok(
    calls.every(
      (input) => input.settings.fingerprintSeed === null && input.kernelVersion === '130',
    ),
  )
})

test('AliasMode uses the existing engine-specific exact version and independent seeds', async () => {
  const setup = config('aliasmode')
  const { job, calls } = fixture(
    {
      create: async (input) => {
        calls.push(input)
        return record(input, {
          providerId: 'aliasmode',
          kernelVersion: '152.0.0.1-aliasmode.1',
        })
      },
    },
    setup,
  )
  await job.run(() => {})
  assert.deepEqual(
    calls.map((input) => input.kernelVersion),
    [null, '152.0.0.1-aliasmode.1'],
  )
  assert.deepEqual(
    calls.map((input) => input.settings.fingerprintSeed),
    [10, 11],
  )
})

test('pending create gates only allow the exact retry ID and reject cross-Workspace operation lists', () => {
  const operation = {
    id: crypto.randomUUID(),
    windowId: crypto.randomUUID(),
    connectionId: 'connection-1',
    kind: 'create',
    phase: 'uncertain',
    message: null,
    createdAt: 1,
    updatedAt: 1,
  }
  assert.match(pendingCreateProblem([operation], 'connection-1')!, /尚未核对/)
  assert.equal(pendingCreateProblem([operation], 'connection-1', operation.id), null)
  assert.match(
    pendingCreateProblem([operation], 'connection-1', crypto.randomUUID())!,
    /尚未核对/,
  )
  assert.match(
    pendingCreateProblem([operation], 'different-connection', operation.id)!,
    /不属于/,
  )
  for (const phase of ['committed', 'failed', 'cancelled'])
    assert.equal(pendingCreateProblem([{ ...operation, phase }], 'connection-1'), null)
})

test('closing and opening a fresh batch cannot bypass an unresolved persisted create', async () => {
  const setup = config()
  setup.targets = [setup.targets[0]]
  const pending = new Map<
    string,
    {
      id: string
      windowId: string
      connectionId: string
      kind: string
      phase: string
      message: null
      createdAt: number
      updatedAt: number
    }
  >()
  let submissions = 0
  const ports: ProfileBatchPorts = {
    checkConnection: async (snapshot, ownId) => {
      const problem = pendingCreateProblem([...pending.values()], snapshot.id, ownId)
      if (problem) throw new Error(problem)
    },
    create: async (input) => {
      submissions++
      if (submissions === 1) {
        pending.set(input.operationId, {
          id: input.operationId,
          windowId: crypto.randomUUID(),
          connectionId: input.connectionId,
          kind: 'create',
          phase: 'uncertain',
          message: null,
          createdAt: 1,
          updatedAt: 1,
        })
        throw new Error('response lost')
      }
      pending.delete(input.operationId)
      return record(input)
    },
    reconcile: async () => null,
    onBind: async () => {},
  }
  const first = new ProfileBatchController(setup, [], ports)
  await first.run(() => {})
  assert.equal(first.items[0].status, 'uncertain')
  const reopened = new ProfileBatchController(setup, [], ports)
  assert.notEqual(reopened.items[0].operationId, first.items[0].operationId)
  await reopened.run(() => {})
  assert.equal(submissions, 1)
  assert.equal(reopened.items[0].status, 'create_failed')
  await first.run(() => {})
  assert.equal(submissions, 2)
  assert.equal(first.items[0].status, 'complete')
})

for (const phase of ['connection', 'profiles']) {
  test(`a disposed batch cannot start creating after late ${phase} preflight`, async () => {
    let release: () => void = () => {}
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let current = true
    let reads = 0
    let writes = 0
    const ports: ProfileBatchPorts = {
      checkConnection: async () => {
        if (phase === 'connection') await waiting
      },
      create: async (input) => {
        writes++
        return record(input)
      },
      reconcile: async () => null,
      onBind: async () => {},
    }
    const preparing = prepareProfileBatch(
      config(),
      ports,
      async () => {
        reads++
        if (phase === 'profiles') await waiting
        return []
      },
      () => current,
    )
    await Promise.resolve()
    current = false
    release()
    const job = await preparing
    if (job) await job.run(() => {})
    assert.equal(job, null)
    assert.equal(writes, 0)
    if (phase === 'connection') assert.equal(reads, 0)
  })
}
