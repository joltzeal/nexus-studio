import { describe, expect, it, vi } from 'vitest'
import { saveLabelPdf } from './label-download'

describe('native PDF download', () => {
  it('keeps a long Unicode filename well formed when shortening it', async () => {
    const save = vi.fn().mockResolvedValue(null)
    await saveLabelPdf(
      'a' + '😀'.repeat(116) + '.pdf',
      new TextEncoder().encode('%PDF-label'),
      'a'.repeat(64),
      save,
    )
    const filename = save.mock.calls[0]![0].filename as string
    expect(filename).not.toContain('\ud83d-A6.pdf')
  })
  it('uses the native save result and preserves cancellation', async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce('/downloads/label-A6.pdf')
      .mockResolvedValueOnce(null)
    const bytes = new TextEncoder().encode('%PDF-label')
    expect(await saveLabelPdf('label.pdf', bytes, 'a'.repeat(64), save)).toBe(
      '/downloads/label-A6.pdf',
    )
    expect(save.mock.calls[0]![0]).toEqual({
      filename: 'label-A6.pdf',
      data: btoa('%PDF-label'),
      sha256: 'a'.repeat(64),
    })
    expect(await saveLabelPdf('label.pdf', bytes, 'a'.repeat(64), save)).toBeNull()
  })
  it('does not report success for native errors or invalid results', async () => {
    const bytes = new TextEncoder().encode('%PDF-label')
    await expect(
      saveLabelPdf('label.pdf', bytes, 'a'.repeat(64), async () => {
        throw '文件无法写入'
      }),
    ).rejects.toThrow('文件无法写入')
    await expect(
      saveLabelPdf('label.pdf', bytes, 'a'.repeat(64), async () => true),
    ).rejects.toThrow('保存结果无效')
  })
})
