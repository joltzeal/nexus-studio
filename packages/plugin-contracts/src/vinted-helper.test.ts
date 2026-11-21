import { describe, expect, it } from 'vitest'
import { LabelBeginSchema, LabelJobSchema, LABEL_MAX_INPUT_BYTES } from './vinted-helper'

describe('VInted helper label boundary', () => {
  it('accepts bounded PDFs with default margins and an explicit optional crop', () => {
    expect(LabelBeginSchema.parse({ filename: 'label.pdf', size: 100 })).toEqual({
      filename: 'label.pdf',
      size: 100,
      marginMm: 3,
      cropMm: null,
    })
    expect(
      LabelBeginSchema.safeParse({
        filename: 'label.pdf',
        size: LABEL_MAX_INPUT_BYTES + 1,
      }).success,
    ).toBe(false)
    expect(
      LabelBeginSchema.safeParse({ filename: '../label.pdf', size: 100 }).success,
    ).toBe(false)
    expect(LabelBeginSchema.safeParse({ filename: 'label.png', size: 100 }).success).toBe(
      false,
    )
    expect(
      LabelBeginSchema.safeParse({ filename: 'label.pdf', size: 100, marginMm: 52.5 })
        .success,
    ).toBe(false)
    expect(
      LabelBeginSchema.safeParse({
        filename: 'label.pdf',
        size: 100,
        cropMm: [10, 0, 5, 5],
      }).success,
    ).toBe(false)
    expect(
      LabelBeginSchema.safeParse({
        filename: 'label.pdf',
        size: 100,
        cropMm: [0, 0, 100, 148],
      }).success,
    ).toBe(true)
  })
  it('requires a complete and ordered per-page report for downloads', () => {
    const job = {
      id: '00000000-0000-4000-8000-000000000001',
      filename: 'label.pdf',
      status: 'completed',
      received: 100,
      inputSize: 100,
      outputSize: 100,
      sha256: 'a'.repeat(64),
      pageCount: 1,
      notes: [{ page: 1, mode: 'isolated' }],
      error: null,
    }
    expect(LabelJobSchema.safeParse(job).success).toBe(true)
    expect(LabelJobSchema.safeParse({ ...job, notes: [] }).success).toBe(false)
    expect(
      LabelJobSchema.safeParse({ ...job, notes: [{ page: 2, mode: 'isolated' }] })
        .success,
    ).toBe(false)
    expect(LabelJobSchema.safeParse({ ...job, sha256: null }).success).toBe(false)
    expect(
      LabelJobSchema.safeParse({ ...job, status: 'failed', error: null }).success,
    ).toBe(false)
  })
})
