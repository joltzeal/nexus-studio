import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAiImagePlugin } from '../index.js'
import { createFileImageStore } from '../store/image-files.js'
import type { GenerationRecord, ProviderView } from '../domain/types.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=',
  'base64',
)
const directories: string[] = []

async function setup(directory?: string, exportDirectory?: string) {
  const root = directory ?? (await mkdtemp(join(tmpdir(), 'nexus-ai-export-')))
  if (directory === undefined) directories.push(root)
  const instance = createAiImagePlugin({
    storageDirectory: root,
    images: createFileImageStore(
      join(root, 'images'),
      exportDirectory ?? join(root, 'exports'),
    ),
    diagnostics: new PassThrough(),
  })
  const call = <T>(method: string, payload: unknown): Promise<T> =>
    instance.plugin.call({
      requestId: 'export-test',
      capability: 'image.provider',
      method,
      payload,
      deadlineAt: Date.now() + 5000,
      assertAlive: () => undefined,
    }) as Promise<T>
  return { ...instance, root, call }
}

type Instance = Awaited<ReturnType<typeof setup>>

async function generate(instance: Instance, count = 1) {
  const provider = await instance.call<ProviderView>('image.providers.save', {
    name: 'Export test',
    kind: 'openai_compatible',
    baseUrl: 'https://export.example.test/v1',
    apiKey: 'test-key',
    imageModel: 'test-image',
  })
  return instance.call<{ record: GenerationRecord }>('image.generate', {
    providerId: provider.id,
    imageModel: provider.imageModel,
    mode: 'generate',
    presetId: null,
    prompt: 'A ceramic mug on a kitchen table.',
    size: 'auto',
    count,
    inputFileIds: [],
  })
}

async function finished(instance: Instance, id: string) {
  return vi.waitFor(async () => {
    expect(instance.plugin.status()['running']).toBe(0)
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.records.get',
      { id },
    )
    expect(record.status).not.toBe('running')
    return record
  })
}

function providerImages(count = 1) {
  return vi.fn(async () =>
    Response.json({
      data: Array.from({ length: count }, () => ({ b64_json: PNG.toString('base64') })),
    }),
  )
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('generated image exports', () => {
  it('exports old records into the new destination without reusing their private export paths', async () => {
    const instance = await setup()
    const requests = providerImages()
    vi.stubGlobal('fetch', requests)
    const { record } = await generate(instance)
    const original = await finished(instance, record.id)
    const downloads = join(instance.root, 'Downloads', 'Nexus AI')
    const reopened = await setup(instance.root, downloads)
    const exported = await reopened.call<{ paths: string[] }>('image.records.export', {
      id: record.id,
    })
    expect(exported.paths).toHaveLength(1)
    expect(exported.paths[0]).toBe(
      join(downloads, `nexus-ai-${original.outputs[0]!.id}.png`),
    )
    expect(await readFile(exported.paths[0]!)).toEqual(PNG)
    expect(await readFile(original.exportedPaths![0]!)).toEqual(PNG)
    expect((await reopened.store.read()).records[0]?.exportedPaths).toEqual(
      exported.paths,
    )
    expect(requests).toHaveBeenCalledTimes(1)
  })

  it('writes every generated image into the configured exports directory before completion', async () => {
    const instance = await setup()
    const requests = providerImages(2)
    vi.stubGlobal('fetch', requests)
    const { record } = await generate(instance, 2)
    const result = await finished(instance, record.id)

    expect(result.status).toBe('success')
    const names = await readdir(join(instance.root, 'exports'))
    expect(names).toHaveLength(2)
    for (const name of names) {
      expect(await readFile(join(instance.root, 'exports', name))).toEqual(PNG)
    }
    expect(result.exportedPaths).toHaveLength(2)
    expect(result.exportError).toBeNull()
    expect(requests).toHaveBeenCalledTimes(1)
  })

  it('manual export after restart returns existing files and restores a deleted copy without generating again', async () => {
    const instance = await setup()
    const requests = providerImages(2)
    vi.stubGlobal('fetch', requests)
    const { record } = await generate(instance, 2)
    const result = await finished(instance, record.id)
    expect(result.exportedPaths).toHaveLength(2)
    await rm(result.exportedPaths![0]!)

    const reopened = await setup(instance.root)
    const exported = await reopened.call<{ paths: string[] }>('image.records.export', {
      id: record.id,
    })
    const again = await reopened.call<{ paths: string[] }>('image.records.export', {
      id: record.id,
    })
    expect(exported.paths).toEqual(result.exportedPaths)
    expect(again.paths).toEqual(exported.paths)
    expect(await readdir(join(instance.root, 'exports'))).toHaveLength(2)
    for (const path of exported.paths) expect(await readFile(path)).toEqual(PNG)
    expect(requests).toHaveBeenCalledTimes(1)
  })

  it('keeps paid outputs when the destination is unwritable and repairs export without another model request', async () => {
    const instance = await setup()
    const target = join(instance.root, 'exports')
    await writeFile(target, 'not a directory')
    const requests = providerImages()
    vi.stubGlobal('fetch', requests)
    const { record } = await generate(instance)
    const result = await finished(instance, record.id)

    expect(result.status).toBe('success')
    expect(result.outputs).toHaveLength(1)
    expect(result.exportError).toContain('导出')
    expect(result.error).toBe(result.exportError)
    expect((await instance.images.readAll(result.outputs[0]!.id)).bytes).toEqual(
      new Uint8Array(PNG),
    )
    await expect(
      instance.call('image.records.export', { id: record.id }),
    ).rejects.toThrow('导出')

    await rm(target)
    const reopened = await setup(instance.root)
    const retry = await reopened.call<{ record: GenerationRecord }>(
      'image.records.retry',
      { id: record.id },
    )
    expect(retry.record.exportError).toBeNull()
    expect(retry.record.error).toBeNull()
    expect(retry.record.outputs).toEqual(result.outputs)
    expect(await readFile(retry.record.exportedPaths![0]!)).toEqual(PNG)
    expect(requests).toHaveBeenCalledTimes(1)
  })

  it('exports existing records from older plugins without a model or provider configuration', async () => {
    const instance = await setup()
    vi.stubGlobal('fetch', providerImages())
    const { record } = await generate(instance)
    const result = await finished(instance, record.id)
    await instance.store.mutate((document) => {
      document.providers = []
      const entry = document.records[0]!
      delete entry.exportedPaths
      delete entry.exportError
    })
    await rm(join(instance.root, 'exports'), { recursive: true, force: true })
    const requests = vi.fn(async () => {
      throw new Error('Export must not call a provider')
    })
    vi.stubGlobal('fetch', requests)

    const reopened = await setup(instance.root)
    const exported = await reopened.call<{ paths: string[] }>('image.records.export', {
      id: result.id,
    })
    expect(exported.paths).toHaveLength(1)
    expect(await readFile(exported.paths[0]!)).toEqual(PNG)
    expect(requests).not.toHaveBeenCalled()
  })
})
