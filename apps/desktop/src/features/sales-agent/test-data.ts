import {
  AGENT_METHODS,
  AgentSettingsSchema,
  type AgentBatchView,
  type AgentJobView,
  type AgentSettings,
} from '@nexus/plugin-sdk/agent'
import { PRODUCT_METHODS, ProductSchema } from '@nexus/plugin-products/contracts'
import type { PluginView } from '@/lib/platform/native-plugins'
import type { BrowserWindow } from '@/lib/platform/windows'
import type { AgentTarget } from './api'

export const ids = {
  batch: '1198ca69-4f78-4705-ac59-2d48bc790194',
  window: '2198ca69-4f78-4705-ac59-2d48bc790194',
  product: '3198ca69-4f78-4705-ac59-2d48bc790194',
  account: '4198ca69-4f78-4705-ac59-2d48bc790194',
  image: '5198ca69-4f78-4705-ac59-2d48bc790194',
  job: '6198ca69-4f78-4705-ac59-2d48bc790194',
  operation: '7198ca69-4f78-4705-ac59-2d48bc790194',
  otherWindow: '8198ca69-4f78-4705-ac59-2d48bc790194',
}
export const now = '2026-11-13T00:00:00.000Z'
export const product = ProductSchema.parse({
  id: ids.product,
  revision: 1,
  sequence: 1,
  name: 'Used mug',
  title: 'Blue ceramic mug',
  description: 'Used mug with a small mark on the base.',
  price: 12,
  currency: 'GBP',
  condition: 'Good',
  category: '',
  images: [
    {
      id: ids.image,
      name: 'mug.jpg',
      mime: 'image/jpeg',
      bytes: 12,
      sha256: 'a'.repeat(64),
    },
  ],
  publicationCount: 0,
  latestPublication: null,
  source: { kind: 'manual' },
  createdAt: now,
  updatedAt: now,
})
export const target: AgentTarget = {
  id: ids.window,
  name: 'UK window',
  provider: 'cloakbrowser',
  state: 'stopped',
  account: {
    id: ids.account,
    account: 'fixture@example.invalid',
    loginMethod: 'email',
    status: 'active',
    note: '',
  },
  unavailable: null,
}
export const nativeWindow: BrowserWindow = {
  id: ids.window,
  name: target.name,
  providerId: 'cloakbrowser',
  connectionId: 'local',
  providerProfileId: 'profile-fixture',
  state: 'stopped',
  origin: 'created',
  version: '1',
  kernelVersion: null,
  createdAt: 1,
  lastOpenedAt: null,
  sortOrder: 1,
  proxyMode: 'direct',
  proxy: null,
  proxyPlugin: null,
  proxyEndpoint: null,
  groupId: null,
  settings: {
    platform: 'Vinted',
    note: '',
    geoip: false,
    timezone: 'UTC',
    locale: 'en-GB',
    viewport: 'default',
    fingerprintSeed: null,
    startUrl: 'https://www.vinted.co.uk',
  },
}
export const batch: AgentBatchView = {
  id: ids.batch,
  preset: 'post_listing',
  instruction: '',
  state: 'queued',
  concurrency: 3,
  total: 1,
  completed: 0,
  attention: 0,
  createdAt: now,
  updatedAt: now,
}
export const job: AgentJobView = {
  id: ids.job,
  windowId: ids.window,
  windowName: target.name,
  accountId: ids.account,
  account: 'fixture@example.invalid',
  state: 'queued',
  phase: 'queued',
  message: '',
  productCount: 1,
  takeover: 'none',
  createdAt: now,
  updatedAt: now,
}
export const settings: AgentSettings = AgentSettingsSchema.parse({
  decision: {
    baseUrl: 'https://decision.example.invalid',
    apiKey: 'fixture-decision-key',
    model: 'fixture-decision',
    protocol: 'typesafe',
  },
  generation: {
    baseUrl: 'https://generation.example.invalid/v1',
    apiKey: 'fixture-generation-key',
    model: 'fixture-vision',
  },
  requestTimeoutMs: 60_000,
  maxStepsPerItem: 30,
  maxCopyRewrites: 2,
  reviewThreshold: 0.8,
})
export function agentPlugin(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: 'studio.sales-agent',
    name: 'Ecom Agent',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.29',
    capabilities: ['sales.agent'],
    granted: ['sales.agent'],
    enabled: true,
    state: 'running',
    source: 'installed',
    sourceDirectory: null,
    methods: [...AGENT_METHODS],
    status: { pid: 100 },
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    permissions: {
      storage: 'private',
      networkDomains: [],
      wantsBrowserAccess: true,
      secrets: [],
    },
    ...overrides,
  }
}

export function agentDependencyPlugins(): PluginView[] {
  return [
    agentPlugin({
      id: 'studio.products',
      capabilities: ['product.catalog'],
      granted: ['product.catalog'],
      methods: [...PRODUCT_METHODS],
    }),
    agentPlugin({
      id: 'studio.vinted-accounts',
      capabilities: ['account.pool'],
      granted: ['account.pool'],
      methods: [
        'vinted.accounts.bindings',
        'vinted.accounts.agent.snapshot',
        'vinted.accounts.observations.record',
      ],
    }),
  ]
}
