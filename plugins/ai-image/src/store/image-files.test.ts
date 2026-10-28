import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createFileImageStore, createMemoryImageStore } from './image-files.js'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const directories: string[] = []

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-ai-files-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('图片文件存储', () => {
  it('按块读回完整字节', async () => {
    const directory = await temporary()
    const store = createFileImageStore(
      join(directory, 'images'),
      join(directory, 'exports'),
    )
    const file = await store.write('f1', 'image/png', PNG)
    expect(file.name).toBe('f1.png')

    const first = await store.readChunk('f1', 0, 5)
    expect(first.total).toBe(PNG.byteLength)
    expect(first.done).toBe(false)
    expect(first.next).toBe(5)

    const second = await store.readChunk('f1', first.next, 64)
    expect(second.done).toBe(true)
    const joined = Buffer.concat([
      Buffer.from(first.data, 'base64'),
      Buffer.from(second.data, 'base64'),
    ])
    expect(new Uint8Array(joined)).toEqual(PNG)
  })

  it('导出时复制到 exports 目录且不覆盖同名文件', async () => {
    const directory = await temporary()
    const store = createFileImageStore(
      join(directory, 'images'),
      join(directory, 'exports'),
    )
    const first = await store.exportCopy(PNG, 'image/png', 'nexus-ai-test-1')
    const second = await store.exportCopy(PNG, 'image/png', 'nexus-ai-test-1')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first).not.toBe(second)
    expect(new Uint8Array(await readFile(first ?? ''))).toEqual(PNG)
  })

  it('并行导出同名不同图片时不会相互覆盖', async () => {
    const directory = await temporary()
    const store = createFileImageStore(
      join(directory, 'images'),
      join(directory, 'exports'),
    )
    const secondBytes = new Uint8Array([...PNG, 5])
    const [first, second] = await Promise.all([
      store.exportCopy(PNG, 'image/png', 'same-name'),
      store.exportCopy(secondBytes, 'image/png', 'same-name'),
    ])
    expect(first).not.toBe(second)
    expect(new Uint8Array(await readFile(first!))).toEqual(PNG)
    expect(new Uint8Array(await readFile(second!))).toEqual(secondBytes)
  })

  it('补导出复用相同字节，保留用户修改过的同名文件', async () => {
    const directory = await temporary()
    const store = createFileImageStore(
      join(directory, 'images'),
      join(directory, 'Export Photos'),
    )
    const first = await store.exportCopy(PNG, 'image/png', 'product', true)
    expect(await store.exportCopy(PNG, 'image/png', 'product', true)).toBe(first)
    const changed = new Uint8Array([...PNG, 9])
    const second = await store.exportCopy(changed, 'image/png', 'product', true)
    expect(second).not.toBe(first)
    expect(new Uint8Array(await readFile(first!))).toEqual(PNG)
    expect(new Uint8Array(await readFile(second!))).toEqual(changed)
    expect(await store.exportCopy(changed, 'image/png', 'product', true)).toBe(second)
  })

  it('删除后不再可读', async () => {
    const directory = await temporary()
    const store = createFileImageStore(join(directory, 'images'))
    await store.write('f2', 'image/png', PNG)
    await store.remove('f2')
    await expect(store.readAll('f2')).rejects.toThrow('图片文件不存在')
  })

  it('内存存储不支持导出', async () => {
    const store = createMemoryImageStore()
    await store.write('f3', 'image/png', PNG)
    expect(await store.exportCopy(PNG, 'image/png', 'name')).toBeNull()
    expect((await store.readAll('f3')).mime).toBe('image/png')
  })

  it('拒绝未知格式', async () => {
    const store = createMemoryImageStore()
    const directory = await temporary()
    const fileStore = createFileImageStore(join(directory, 'images'))
    await expect(fileStore.write('f4', 'image/gif', PNG)).rejects.toThrow(
      '不支持的图片格式',
    )
    expect(store.durable).toBe(false)
  })
})
