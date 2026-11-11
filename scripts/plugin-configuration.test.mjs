import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configurationTransfer as aiTransfer } from '../plugins/ai-image/src/configuration.ts'
import { createMemoryStore as aiStore } from '../plugins/ai-image/src/store/private-store.ts'
import { configurationTransfer as simTransfer } from '../plugins/sim8/src/configuration.ts'
import {
  createMemoryStore as simStore,
  createFileStore as simFileStore,
} from '../plugins/sim8/src/store/private-store.ts'
import {
  createMemoryVault as simVault,
  createFileVault as simFileVault,
} from '../plugins/sim8/src/store/secret-vault.ts'
import { configurationTransfer as addressTransfer } from '../plugins/address-generator/src/configuration.ts'
import { createMemoryStore as addressStore } from '../plugins/address-generator/src/store/private-store.ts'
import { configurationTransfer as proxyTransfer } from '../plugins/proxy-pool/src/configuration.ts'
import { createMemoryStore as proxyStore } from '../plugins/proxy-pool/src/store/private-store.ts'
import { createMemoryVault as proxyVault } from '../plugins/proxy-pool/src/store/secret-vault.ts'
import { configurationTransfer as monitorTransfer } from '../plugins/vinted-monitor/src/configuration.ts'
import { createMemoryStore as monitorStore } from '../plugins/vinted-monitor/src/store/private-store.ts'
import {
  AiImage,
  AI_IMAGE_METHODS,
} from '../plugins/ai-image/src/capabilities/ai-image.ts'
import { Sim8Provider, SIM8_METHODS } from '../plugins/sim8/src/capabilities/sim8.ts'
import {
  AddressGenerator,
  ADDRESS_METHODS,
} from '../plugins/address-generator/src/capabilities/address-generator.ts'
import {
  ProxyPool,
  PROXY_METHODS,
} from '../plugins/proxy-pool/src/capabilities/proxy-provider.ts'
import {
  VintedMonitor,
  VINTED_METHODS,
} from '../plugins/vinted-monitor/src/capabilities/vinted-monitor.ts'

const context = (method, payload) => ({ method, payload, assertAlive() {} })

it('persists imported credentials across fresh store instances on another device directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-configuration-'))
  try {
    const open = (directory) =>
      simTransfer(
        simFileStore(join(root, directory)),
        simFileVault(join(root, directory), { add() {} }),
      )
    const original = {
      schemaVersion: 1,
      data: { baseUrl: 'https://sim.example.test', token: 'fixture-persisted-token' },
    }
    await open('source').call(context('configuration.import', original))
    const exported = await open('source').call(context('configuration.export', {}))
    await open('destination').call(context('configuration.import', exported))
    expect(await open('destination').call(context('configuration.export', {}))).toEqual(
      original,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
const fixtureProxy = {
  id: 'proxy-test',
  name: 'Fixture proxy',
  scheme: 'socks5',
  host: 'proxy.example.test',
  port: 1080,
  username: 'fixture-user',
  password: 'fixture-password',
  enabled: true,
}
const fixtures = [
  {
    name: 'AI image',
    store: aiStore,
    create: aiTransfer,
    data: {
      providers: [
        {
          id: 'provider-fixture',
          name: 'Fixture',
          kind: 'openai_compatible',
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'fixture-api-key',
          imageModel: 'fixture-image',
          visionModel: 'fixture-vision',
          imageTimeoutSeconds: 900,
          imageResponseMode: 'stream',
        },
      ],
      selections: {
        image: { providerId: 'provider-fixture', model: 'fixture-image' },
        vision: { providerId: 'provider-fixture', model: 'fixture-vision' },
      },
    },
    untouched: ['records', 'plans'],
  },
  {
    name: 'SIM8',
    store: simStore,
    create: simTransfer,
    data: { baseUrl: 'https://sim.example.test', token: 'fixture-sim-token' },
    untouched: ['records', 'requests', 'expiry'],
  },
  {
    name: 'address generator',
    store: addressStore,
    create: addressTransfer,
    data: { apiKey: 'fixture-google-maps-key' },
    untouched: ['cache'],
  },
  {
    name: 'proxy pool',
    store: proxyStore,
    create: proxyTransfer,
    data: {
      defaultProxy: {
        name: 'Fixture default',
        host: 'proxy.example.test',
        port: 1080,
        username: 'fixture-user',
        password: 'fixture-proxy-password',
        schemes: ['socks5'],
        enabled: true,
        udp: true,
      },
      risk: { enabled: true, cacheSeconds: 3600, apiKey: 'fixture-risk-key' },
    },
    untouched: ['subscriptions', 'transferReceipts'],
  },
  {
    name: 'Vinted monitor',
    store: monitorStore,
    create: (store) => monitorTransfer(store),
    data: { proxies: [fixtureProxy], defaultProxyId: fixtureProxy.id },
    untouched: ['monitors', 'runs', 'items', 'sellers'],
  },
]

it.each(fixtures)(
  'roundtrips $name settings and credentials on a clean device',
  async (fixture) => {
    const source = fixture.store()
    const sourceVault =
      fixture.name === 'proxy pool' ? proxyVault({ add() {} }) : simVault({ add() {} })
    const destination = fixture.store()
    const destinationVault =
      fixture.name === 'proxy pool' ? proxyVault({ add() {} }) : simVault({ add() {} })
    const first = fixture.create(source, sourceVault)
    await first.call(
      context('configuration.import', { schemaVersion: 1, data: fixture.data }),
    )
    const exported = await first.call(context('configuration.export', {}))
    expect(exported).toEqual({ schemaVersion: 1, data: fixture.data })
    const next = fixture.create(destination, destinationVault)
    const before = await destination.read()
    await next.call(context('configuration.validate', exported))
    expect(await destination.read()).toEqual(before)
    await next.call(context('configuration.import', exported))
    expect(await next.call(context('configuration.export', {}))).toEqual(exported)
    const after = await destination.read()
    for (const key of fixture.untouched) expect(after[key]).toEqual(before[key])
  },
)

it('keeps the original SIM8 credential usable when writing the imported settings fails', async () => {
  const store = simStore()
  const vault = simVault({ add() {} })
  const transfer = simTransfer(store, vault)
  await transfer.call(
    context('configuration.import', {
      schemaVersion: 1,
      data: { baseUrl: 'https://sim.example.test', token: 'fixture-old-token' },
    }),
  )
  const before = await transfer.call(context('configuration.export', {}))
  vi.spyOn(store, 'mutate').mockRejectedValueOnce(new Error('disk full'))
  await expect(
    transfer.call(
      context('configuration.import', {
        schemaVersion: 1,
        data: { baseUrl: 'https://sim.example.test', token: 'fixture-new-token' },
      }),
    ),
  ).rejects.toThrow('disk full')
  expect(await transfer.call(context('configuration.export', {}))).toEqual(before)
})

it('rejects missing proxy references and AI provider selections before writing', async () => {
  const monitor = monitorTransfer(monitorStore())
  await expect(
    monitor.call(
      context('configuration.validate', {
        schemaVersion: 1,
        data: { proxies: [], defaultProxyId: 'missing' },
      }),
    ),
  ).rejects.toThrow()
  const ai = aiTransfer(aiStore())
  await expect(
    ai.call(
      context('configuration.validate', {
        schemaVersion: 1,
        data: {
          providers: [],
          selections: { image: { providerId: 'missing', model: 'x' }, vision: null },
        },
      }),
    ),
  ).rejects.toThrow()
})

it.each(fixtures)(
  'exports an unconfigured $name without inventing settings',
  async (fixture) => {
    const store = fixture.store()
    const vault =
      fixture.name === 'proxy pool' ? proxyVault({ add() {} }) : simVault({ add() {} })
    const configuration = fixture.create(store, vault)
    const exported = await configuration.call(context('configuration.export', {}))
    const before = await store.read()
    await configuration.call(context('configuration.validate', exported))
    expect(await store.read()).toEqual(before)
  },
)

it('advertises and routes the same configuration protocol through all five plugin capabilities', async () => {
  const logger = { info() {}, warn() {}, error() {} }
  const plugins = [
    [new AiImage({ store: aiStore(), images: {}, logger }), AI_IMAGE_METHODS],
    [
      new Sim8Provider({ store: simStore(), vault: simVault({ add() {} }), logger }),
      SIM8_METHODS,
    ],
    [
      new AddressGenerator({
        store: addressStore(),
        vault: simVault({ add() {} }),
        lookup: {},
        logger,
      }),
      ADDRESS_METHODS,
    ],
    [
      new ProxyPool({
        store: proxyStore(),
        vault: proxyVault({ add() {} }),
        check: {},
        logger,
      }),
      PROXY_METHODS,
    ],
    [new VintedMonitor({ store: monitorStore(), logger }), VINTED_METHODS],
  ]
  for (const [plugin, methods] of plugins) {
    for (const method of [
      'configuration.export',
      'configuration.validate',
      'configuration.import',
    ])
      expect(methods).toContain(method)
    const exported = await plugin.call(context('configuration.export', {}))
    expect(exported.schemaVersion).toBe(1)
    expect(await plugin.call(context('configuration.validate', exported))).toEqual({
      valid: true,
    })
    await expect(
      plugin.call(
        context('configuration.validate', {
          schemaVersion: 999,
          data: {},
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false })
  }
})
