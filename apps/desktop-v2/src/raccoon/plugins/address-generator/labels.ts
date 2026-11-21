import {
  LABEL_CHUNK_BYTES,
  LabelAppendReplySchema,
  LabelBeginReplySchema,
  LabelBeginSchema,
  LabelChunkSchema,
  LabelCloseReplySchema,
  LabelIdSchema,
  LabelJobSchema,
  LABEL_METHODS,
  type LabelJob,
  type LabelOptions,
} from '@nexus/plugin-contracts/vinted-helper'
import { ADDRESS_CAPABILITY, ADDRESS_PLUGIN_ID } from './model'

type Rpc = <T>(
  id: string,
  capability: string,
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
) => Promise<T>
type Access = {
  enabled: boolean
  state: string
  capabilities: readonly string[]
  granted: readonly string[]
  methods: readonly string[]
}
export function supportsLabelExtraction(plugin: Access | undefined) {
  return (
    !!plugin &&
    plugin.enabled &&
    plugin.state === 'running' &&
    plugin.capabilities.includes(ADDRESS_CAPABILITY) &&
    plugin.granted.includes(ADDRESS_CAPABILITY) &&
    LABEL_METHODS.every((method) => plugin.methods.includes(method))
  )
}
function encode(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
function wait(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, 800)
    signal.addEventListener('abort', abort, { once: true })
  })
}
async function digest(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export function createLabelsApi(call: Rpc) {
  const request = <T>(method: string, payload: unknown, parse: (value: unknown) => T) =>
    call(ADDRESS_PLUGIN_ID, ADDRESS_CAPABILITY, `vinted.labels.${method}`, payload, parse)
  const close = async (id: string) => {
    await request('close', LabelIdSchema.parse({ id }), (value) =>
      LabelCloseReplySchema.parse(value),
    )
  }
  return {
    close,
    async process(
      input: { name: string; bytes: Uint8Array },
      options: LabelOptions,
      signal: AbortSignal,
      onProgress?: (received: number, status: string) => void,
      onSession?: (id: string) => void,
    ): Promise<LabelJob> {
      signal.throwIfAborted()
      const parsed = LabelBeginSchema.parse({
        filename: input.name,
        size: input.bytes.length,
        ...options,
      })
      const begin = await request('begin', parsed, (value) =>
        LabelBeginReplySchema.parse(value),
      )
      try {
        onSession?.(begin.id)
        signal.throwIfAborted()
        for (let offset = 0; offset < input.bytes.length; offset += begin.chunkSize) {
          signal.throwIfAborted()
          const end = Math.min(input.bytes.length, offset + begin.chunkSize)
          const reply = await request(
            'append',
            { id: begin.id, offset, data: encode(input.bytes.subarray(offset, end)) },
            (value) => LabelAppendReplySchema.parse(value),
          )
          if (reply.received !== end) throw new Error('面单上传分块校验失败')
          onProgress?.(end, 'uploading')
        }
        signal.throwIfAborted()
        let result = await request('start', { id: begin.id }, (value) =>
          LabelJobSchema.parse(value),
        )
        const deadline = Date.now() + 240_000
        for (;;) {
          signal.throwIfAborted()
          if (
            result.id !== begin.id ||
            result.filename !== parsed.filename ||
            result.inputSize !== parsed.size ||
            result.received !== parsed.size
          )
            throw new Error('插件面单结果与上传文件不一致')
          onProgress?.(parsed.size, result.status)
          if (result.status === 'completed') return result
          if (result.status === 'failed') throw new Error(result.error ?? '面单处理失败')
          if (!['queued', 'running'].includes(result.status))
            throw new Error('插件面单状态无效')
          if (Date.now() > deadline) throw new Error('面单等待超时，请重试')
          await wait(signal)
          result = await request('status', { id: begin.id }, (value) =>
            LabelJobSchema.parse(value),
          )
        }
      } catch (cause) {
        await close(begin.id).catch(() => undefined)
        throw cause
      }
    },
    async download(
      rawJob: LabelJob,
      signal: AbortSignal,
    ): Promise<Uint8Array<ArrayBuffer>> {
      signal.throwIfAborted()
      const job = LabelJobSchema.parse(rawJob)
      if (job.status !== 'completed') throw new Error('面单尚未完成')
      const bytes = new Uint8Array(job.outputSize)
      for (let offset = 0; offset < job.outputSize;) {
        signal.throwIfAborted()
        const chunk = await request(
          'read',
          { id: job.id, offset, length: LABEL_CHUNK_BYTES },
          (value) => LabelChunkSchema.parse(value),
        )
        signal.throwIfAborted()
        const decoded = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0))
        if (
          encode(decoded) !== chunk.data ||
          chunk.total !== job.outputSize ||
          decoded.length !== Math.min(LABEL_CHUNK_BYTES, job.outputSize - offset) ||
          chunk.next !== offset + decoded.length ||
          chunk.done !== (chunk.next === job.outputSize)
        )
          throw new Error('面单下载分块校验失败')
        bytes.set(decoded, offset)
        offset = chunk.next
      }
      if ((await digest(bytes)) !== job.sha256)
        throw new Error('面单完整性校验失败，请重新处理')
      signal.throwIfAborted()
      return bytes
    },
  }
}
