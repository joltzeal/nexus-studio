import { z } from 'zod'

export const LABEL_MAX_INPUT_BYTES = 10 * 1024 * 1024
export const LABEL_MAX_OUTPUT_BYTES = 50 * 1024 * 1024
export const LABEL_CHUNK_BYTES = 192 * 1024
export const LABEL_MAX_PAGES = 50
export const LABEL_MAX_FILES = 20
export const LABEL_TTL_MS = 30 * 60 * 1000
export const LABEL_METHODS = [
  'vinted.labels.begin',
  'vinted.labels.append',
  'vinted.labels.start',
  'vinted.labels.status',
  'vinted.labels.read',
  'vinted.labels.close',
] as const

export const LabelCropSchema = z
  .tuple([
    z.number().finite().min(0).max(2000),
    z.number().finite().min(0).max(2000),
    z.number().finite().positive().max(2000),
    z.number().finite().positive().max(2000),
  ])
  .refine(
    ([left, top, right, bottom]) => left < right && top < bottom,
    '裁剪区右下角必须大于左上角',
  )

export const LabelOptionsSchema = z.strictObject({
  marginMm: z.number().finite().min(0).lt(52.5).default(3),
  cropMm: LabelCropSchema.nullable().default(null),
})
export const LabelBeginSchema = LabelOptionsSchema.extend({
  filename: z
    .string()
    .min(5)
    .max(240)
    .refine(
      (value) =>
        !/[\\/]/.test(value) &&
        !Array.from(value).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ) &&
        /\.pdf$/i.test(value),
      '请选择 PDF 文件',
    ),
  size: z.number().int().min(5).max(LABEL_MAX_INPUT_BYTES),
})
const id = z.uuid()
export const LabelIdSchema = z.strictObject({ id })
export const LabelBeginReplySchema = z.strictObject({
  id,
  chunkSize: z.literal(LABEL_CHUNK_BYTES),
})
export const LabelAppendSchema = z.strictObject({
  id,
  offset: z.number().int().min(0).max(LABEL_MAX_INPUT_BYTES),
  data: z
    .string()
    .min(4)
    .max(Math.ceil(LABEL_CHUNK_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
})
export const LabelAppendReplySchema = z.strictObject({
  received: z.number().int().min(0).max(LABEL_MAX_INPUT_BYTES),
})
export const LabelPageNoteSchema = z.strictObject({
  page: z.number().int().min(1).max(LABEL_MAX_PAGES),
  mode: z.enum(['isolated', 'full_content', 'manual']),
})
export const LabelJobSchema = z
  .strictObject({
    id,
    filename: LabelBeginSchema.shape.filename,
    status: z.enum(['uploading', 'queued', 'running', 'completed', 'failed']),
    inputSize: z.number().int().min(5).max(LABEL_MAX_INPUT_BYTES),
    received: z.number().int().min(0).max(LABEL_MAX_INPUT_BYTES),
    outputSize: z.number().int().min(0).max(LABEL_MAX_OUTPUT_BYTES),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    pageCount: z.number().int().min(0).max(LABEL_MAX_PAGES),
    notes: z.array(LabelPageNoteSchema).max(LABEL_MAX_PAGES),
    error: z.string().min(1).max(500).nullable(),
  })
  .refine((job) => {
    if (job.received > job.inputSize) return false
    if (job.status === 'completed')
      return (
        job.received === job.inputSize &&
        job.outputSize > 0 &&
        job.sha256 !== null &&
        job.error === null &&
        job.pageCount > 0 &&
        job.notes.length === job.pageCount &&
        job.notes.every((note, index) => note.page === index + 1)
      )
    return (
      job.outputSize === 0 &&
      job.sha256 === null &&
      job.pageCount === 0 &&
      job.notes.length === 0 &&
      (job.status === 'failed' ? job.error !== null : job.error === null)
    )
  }, '面单任务结果不完整')
export const LabelReadSchema = z.strictObject({
  id,
  offset: z.number().int().min(0).max(LABEL_MAX_OUTPUT_BYTES),
  length: z.number().int().min(1).max(LABEL_CHUNK_BYTES),
})
export const LabelChunkSchema = z.strictObject({
  total: z.number().int().min(1).max(LABEL_MAX_OUTPUT_BYTES),
  next: z.number().int().positive().max(LABEL_MAX_OUTPUT_BYTES),
  data: LabelAppendSchema.shape.data,
  done: z.boolean(),
})
export const LabelCloseReplySchema = z.strictObject({ closed: z.literal(true) })
export type LabelOptions = z.infer<typeof LabelOptionsSchema>
export type LabelBegin = z.infer<typeof LabelBeginSchema>
export type LabelJob = z.infer<typeof LabelJobSchema>
export type LabelPageNote = z.infer<typeof LabelPageNoteSchema>
