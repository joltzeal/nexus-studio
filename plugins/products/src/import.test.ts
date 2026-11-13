import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProductImportReportSchema,
  ProductPageSchema,
  ProductReplySchema,
} from './contracts.js'
import { createProductsPlugin } from './index.js'

const instances: ReturnType<typeof createProductsPlugin>[] = []
function harness() {
  const instance = createProductsPlugin({
    input: new PassThrough(),
    output: new PassThrough(),
    diagnostics: new PassThrough(),
  })
  instances.push(instance)
  const call = (method: string, payload: unknown) =>
    instance.plugin.call({
      requestId: randomUUID(),
      capability: 'product.catalog',
      method,
      payload,
      deadlineAt: Date.now() + 120_000,
      assertAlive() {},
    })
  const importFile = async (format: 'csv' | 'json', content: string) =>
    ProductImportReportSchema.parse(await call('products.import', { format, content }))
  return { call, importFile }
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.stop()))
})

describe('metadata file import', () => {
  it('parses BOM, Chinese and English headers, escaped quotes, CRLF, and quoted newlines', async () => {
    const t = harness()
    const report = await t.importFile(
      'csv',
      '\ufeff商品名称,Title,描述,价格,币种,货号,分类,成色,标签\r\n' +
        '"衣服, A","A ""quoted"" title","first\r\nsecond",12.50,GBP,SKU-1,,Good,"red;cotton"\r\n',
    )
    expect(report).toEqual({ total: 1, inserted: 1, skipped: 0, errors: [] })
    const list = ProductPageSchema.parse(await t.call('products.list', {}))
    const { product } = ProductReplySchema.parse(
      await t.call('products.get', { id: list.items[0]!.id }),
    )
    expect(product).toMatchObject({
      name: '衣服, A',
      title: 'A "quoted" title',
      description: 'first\r\nsecond',
      price: 12.5,
      currency: 'GBP',
      sku: 'SKU-1',
      category: '',
      condition: 'Good',
      tags: ['red', 'cotton'],
      images: [],
      status: 'draft',
      source: { kind: 'import' },
    })
  })

  it('reports invalid rows while committing valid rows and includes all rows in totals', async () => {
    const t = harness()
    const report = await t.importFile(
      'json',
      JSON.stringify([
        { name: 'Valid', price: 10, tags: ['new'] },
        { name: '', price: 20 },
        { name: 'Negative', price: -1 },
        { name: 'Ready without images', status: 'ready' },
      ]),
    )
    expect(report).toMatchObject({ total: 4, inserted: 1, skipped: 3 })
    expect(report.errors.map((entry) => entry.row)).toEqual([2, 3, 4])
    expect(ProductPageSchema.parse(await t.call('products.list', {})).total).toBe(1)
  })

  it('preserves shared SKUs across files and deduplicates only the same file rows', async () => {
    const t = harness()
    const csv = 'name,sku,description\nOne,SAME,original\nNo SKU,,unchanged\n'
    expect(await t.importFile('csv', csv)).toMatchObject({ inserted: 2, skipped: 0 })
    expect(await t.importFile('csv', csv)).toMatchObject({ inserted: 0, skipped: 2 })
    expect(
      await t.importFile(
        'json',
        JSON.stringify([
          { name: 'Separate product', sku: 'same', description: 'Keep separately' },
          { name: 'New', sku: 'OTHER' },
        ]),
      ),
    ).toMatchObject({ total: 2, inserted: 2, skipped: 0 })
    const list = ProductPageSchema.parse(
      await t.call('products.list', { sourceKind: 'import' }),
    )
    expect(list.total).toBe(4)
    expect(
      list.items
        .filter((entry) => entry.sku.toLowerCase() === 'same')
        .map((entry) => entry.name),
    ).toEqual(['Separate product', 'One'])
    const original = list.items.find((entry) => entry.sku === 'SAME')!
    expect(
      ProductReplySchema.parse(await t.call('products.get', { id: original.id })).product,
    ).toMatchObject({ name: 'One', description: 'original', revision: 1 })
    await t.call('products.remove', { id: original.id, expectedRevision: 1 })
    expect(await t.importFile('csv', csv)).toMatchObject({ inserted: 0, skipped: 2 })
  })

  it('does not trust imported image IDs, local paths, URLs, or product identity metadata', async () => {
    const t = harness()
    const report = await t.importFile(
      'json',
      JSON.stringify([
        { name: 'Injected ID', id: randomUUID(), revision: 8 },
        { name: 'Foreign image', imageIds: [randomUUID()] },
        { name: 'URL image', images: ['https://example.invalid/image.png'] },
        { name: 'Local path', imagePath: '/tmp/foreign.png' },
        { name: 'Clean metadata', category: '' },
      ]),
    )
    expect(report).toMatchObject({ total: 5, inserted: 1, skipped: 4 })
    expect(report.errors.map((entry) => entry.row)).toEqual([1, 2, 3, 4])
  })

  it('keeps distinct rows with the same SKU and remembers each row after edits or deletion', async () => {
    const t = harness()
    const originalFile = 'name,sku\nFirst,ONE\nDuplicate in file,ONE\n'
    const laterFile = '[{"name":"Another file","sku":"ONE"}]'
    expect(await t.importFile('csv', originalFile)).toMatchObject({
      inserted: 2,
      skipped: 0,
    })
    expect(await t.importFile('json', laterFile)).toMatchObject({
      inserted: 1,
      skipped: 0,
    })
    const list = ProductPageSchema.parse(await t.call('products.list', {}))
    expect(list.items.filter((entry) => entry.sku === 'ONE')).toHaveLength(3)
    expect(new Set(list.items.map((entry) => entry.id)).size).toBe(3)
    const original = list.items.find((entry) => entry.name === 'First')!
    await t.call('products.save', {
      id: original.id,
      expectedRevision: 1,
      data: { name: 'Edited', sku: 'CHANGED' },
    })
    expect(await t.importFile('json', laterFile)).toMatchObject({
      inserted: 0,
      skipped: 1,
    })
    await t.call('products.remove', { id: original.id, expectedRevision: 2 })
    expect(await t.importFile('csv', originalFile)).toMatchObject({
      inserted: 0,
      skipped: 2,
    })
    expect(
      ProductPageSchema.parse(await t.call('products.list', {})).items.map(
        (entry) => entry.name,
      ),
    ).toEqual(['Another file', 'Duplicate in file'])
  })

  it('rejects byte and row overflows before committing any partial data', async () => {
    const t = harness()
    for (const content of [
      JSON.stringify(
        Array.from({ length: 1001 }, (_, index) => ({ name: String(index) })),
      ),
      JSON.stringify([{ name: 'Over byte limit', description: '中'.repeat(180_000) }]),
    ])
      await expect(t.importFile('json', content)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
    expect(ProductPageSchema.parse(await t.call('products.list', {})).total).toBe(0)
  })

  it('rejects malformed CSV and JSON instead of silently importing an empty file', async () => {
    const t = harness()
    for (const [format, content] of [
      ['csv', 'name,description\n"unterminated,quote'],
      ['csv', 'name,name\nA,B'],
      ['csv', 'description,price\nNo name,10'],
      ['json', '{"name":"not an array"}'],
      ['json', '[bad json]'],
    ] as const)
      await expect(t.importFile(format, content)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
  })
})
