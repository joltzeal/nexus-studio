import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSettingsStore } from './settings.js'

const settings = {
  decision: { baseUrl: 'https://example.com', apiKey: 'test-decision', model: 'test' },
  generation: {
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-generation',
    model: 'test',
  },
}

describe('Agent settings persistence', () => {
  it('survives a process restart and does not silently swallow invalid data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-agent-settings-'))
    try {
      const first = createSettingsStore(directory)
      expect(await first.read()).toBeNull()
      await first.save(settings)
      const second = createSettingsStore(directory)
      expect(await second.read()).toMatchObject(settings)
      await expect(second.save({})).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(await first.read()).toMatchObject(settings)
      await second.clear()
      expect(await first.read()).toBeNull()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('persists execution, prices, notification and retention settings in plain plugin storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-agent-policy-'))
    try {
      const store = createSettingsStore(directory)
      const saved = await store.save({
        ...settings,
        execution: { modelConcurrency: 2, maxBatchCostUsd: 4 },
        pricing: {
          decision: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
          generation: { inputPerMillionUsd: 3, outputPerMillionUsd: 4 },
        },
        notifications: { enabled: true, deviceKey: 'fixture-bark-key' },
        retention: { enabled: true, days: 60 },
      })
      expect(await createSettingsStore(directory).read()).toEqual(saved)
      expect(await readFile(join(directory, 'settings.json'), 'utf8')).toContain(
        'fixture-bark-key',
      )
      await expect(
        store.save({ ...saved, execution: { ...saved.execution, modelConcurrency: 0 } }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(await store.read()).toEqual(saved)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
