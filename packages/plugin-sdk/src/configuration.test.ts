import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createConfigurationTransfer } from './configuration.js'

it('roundtrips versioned plugin settings including credentials without exporting business records', async () => {
  const schema = z.strictObject({ key: z.string(), model: z.string().min(1) })
  const apply = vi.fn()
  const transfer = createConfigurationTransfer({
    schema,
    read: async () => ({ key: 'fixture-token', model: 'example-model' }),
    apply,
  })
  const assertAlive = vi.fn()
  const document = await transfer.call({
    method: 'configuration.export',
    payload: {},
    assertAlive,
  })
  expect(document).toEqual({
    schemaVersion: 1,
    data: { key: 'fixture-token', model: 'example-model' },
  })
  await expect(
    transfer.call({
      method: 'configuration.validate',
      payload: document,
      assertAlive,
    }),
  ).resolves.toEqual({ valid: true })
  expect(apply).not.toHaveBeenCalled()
  await expect(
    transfer.call({
      method: 'configuration.import',
      payload: document,
      assertAlive,
    }),
  ).resolves.toEqual({ imported: true })
  expect(apply).toHaveBeenCalledExactlyOnceWith({
    key: 'fixture-token',
    model: 'example-model',
  })
})

it('rejects unknown versions, unknown fields and invalid settings before changing storage', async () => {
  const apply = vi.fn()
  const transfer = createConfigurationTransfer({
    schema: z.strictObject({ token: z.string() }),
    read: async () => ({ token: '' }),
    apply,
  })
  for (const payload of [
    { schemaVersion: 2, data: { token: '' } },
    { schemaVersion: 1, data: { token: 123 } },
    { schemaVersion: 1, data: { token: '', records: [] } },
  ]) {
    await expect(
      transfer.call({
        method: 'configuration.import',
        payload,
        assertAlive() {},
      }),
    ).rejects.toThrow('配置')
  }
  expect(apply).not.toHaveBeenCalled()
})

it('propagates persistence failure and observes cancellation before writing', async () => {
  const apply = vi.fn().mockRejectedValue(new Error('disk full'))
  const transfer = createConfigurationTransfer({
    schema: z.strictObject({}),
    read: async () => ({}),
    apply,
  })
  await expect(
    transfer.call({
      method: 'configuration.import',
      payload: { schemaVersion: 1, data: {} },
      assertAlive() {},
    }),
  ).rejects.toThrow('disk full')
  apply.mockClear()
  await expect(
    transfer.call({
      method: 'configuration.import',
      payload: { schemaVersion: 1, data: {} },
      assertAlive() {
        throw new Error('cancelled')
      },
    }),
  ).rejects.toThrow('cancelled')
  expect(apply).not.toHaveBeenCalled()
})
