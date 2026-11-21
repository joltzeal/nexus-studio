import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProviderSubscription } from '@nexus/plugin-contracts/proxy-pool'
import { ManualProviderSubscriptionDialog } from './ManualProviderSubscriptionDialog'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

const accountId = '23d4283e-3867-445e-b54e-ba78240ab051'
const subscription: ProviderSubscription = {
  id: '9784c74b-fcbc-46d9-b65d-f74dbdbb0dfc',
  accountId,
  providerId: 'decodo',
  name: 'Decodo 数据中心',
  productType: 'datacenter',
  source: 'manual',
  expiresAt: '2026-12-22T05:10:00.000Z',
  createdAt: '2026-11-21T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:00.000Z',
  enabled: true,
  expired: false,
  memberCount: 1,
}
const onSaved = vi.fn()
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  native.invoke.mockResolvedValue({ subscription, created: 1, updated: 0, withdrawn: 0 })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function open(editing: ProviderSubscription | null) {
  await act(async () =>
    root.render(
      <ManualProviderSubscriptionDialog
        accountId={accountId}
        providerName="Decodo"
        products={['datacenter', 'isp']}
        editing={editing}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    ),
  )
}

async function input(selector: string, value: string) {
  const field = document.querySelector<HTMLInputElement>(selector)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      field,
      value,
    )
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function upload(name: string, bytes: Uint8Array<ArrayBuffer>) {
  const field = document.querySelector<HTMLInputElement>('input[type="file"]')!
  const file = new File([bytes], name)
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  Object.defineProperty(field, 'files', { configurable: true, value: [file] })
  await act(async () => field.dispatchEvent(new Event('change', { bubbles: true })))
}

async function save() {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === '保存订阅',
  )!
  await act(async () => button.click())
}

it('creates a manual subscription with the selected TXT and an exact local expiry', async () => {
  await open(null)
  await input('input[type="text"]', 'Decodo 数据中心')
  await input('input[type="datetime-local"]', '2026-12-22T13:10')
  const text = 'dc.example.test:8010:fixture:fixture-password\r\n'
  await upload('decodo.txt', new TextEncoder().encode(text))
  expect(document.body.textContent).not.toContain('fixture-password')
  await save()
  expect(native.invoke).toHaveBeenCalledOnce()
  expect(native.invoke).toHaveBeenCalledWith(
    'plugin_call',
    expect.objectContaining({
      input: expect.objectContaining({
        method: 'proxy.providerSubscriptions.manual',
        payload: {
          accountId,
          name: 'Decodo 数据中心',
          productType: 'datacenter',
          expiresAt: new Date('2026-12-22T13:10').toISOString(),
          enabled: true,
          scheme: 'http',
          text,
        },
      }),
    }),
  )
  expect(onSaved).toHaveBeenCalledOnce()
})

it('rejects invalid UTF-8 without calling the plugin', async () => {
  await open(subscription)
  await upload('invalid.txt', Uint8Array.of(0xff))
  await save()
  expect(document.body.textContent).toContain('UTF-8')
  expect(native.invoke).not.toHaveBeenCalled()
})

it('rejects a TXT batch above 1000 records before the plugin call', async () => {
  await open(null)
  await input('input[type="text"]', 'Decodo 数据中心')
  await input('input[type="datetime-local"]', '2026-12-22T13:10')
  const text = Array.from(
    { length: 1001 },
    (_, index) => `dc.example.test:${8000 + index}`,
  ).join('\n')
  await upload('decodo.txt', new TextEncoder().encode(text))
  await save()
  expect(document.body.textContent).toContain('最多包含 1000 条代理')
  expect(native.invoke).not.toHaveBeenCalled()
})

it('renews the same subscription without replacing the existing endpoints', async () => {
  await open(subscription)
  await input('input[type="datetime-local"]', '2026-12-23T09:00')
  await save()
  const payload = native.invoke.mock.calls[0]![1].input.payload
  expect(payload).toMatchObject({
    id: subscription.id,
    accountId,
    expiresAt: new Date('2026-12-23T09:00').toISOString(),
  })
  expect(payload).not.toHaveProperty('text')
})
