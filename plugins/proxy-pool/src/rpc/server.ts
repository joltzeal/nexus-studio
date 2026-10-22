import type { Readable, Writable } from 'node:stream'

import type { PluginManifest } from '@nexus/plugin-sdk'

import { cancelled, isPluginFailure, timedOut } from '../domain/errors.js'
import type { Logger } from './redact.js'
import {
  DEFAULT_MAX_LINE_BYTES,
  MAX_DEADLINE_MS,
  PROTOCOL_VERSION,
  helloMessage,
  type Dispatch,
  type PluginRequest,
  type PluginResponse,
  type ReadyMessage,
} from './protocol.js'

export interface ServerOptions {
  input: Readable
  output: Writable
  manifest: PluginManifest
  methods: readonly string[]
  dispatch: Dispatch
  logger: Logger
  status: () => Record<string, unknown>
  maxLineBytes?: number
  maxProtocolErrors?: number
  /** Called when the process must be recycled after repeated protocol errors. */
  onFatal?: (reason: string) => void
}

interface CallState {
  cancelled: boolean
  settled: boolean
}

const CONTROL_TYPES = new Set(['handshake', 'cancel'])

export interface PluginServer {
  start(): void
  stop(): void
  /** True once the host completed the handshake. */
  readonly ready: boolean
}

/**
 * Line-delimited JSON RPC. stdout carries protocol messages only; diagnostics
 * go through the injected logger (stderr) and are redacted.
 */
export function createPluginServer(options: ServerOptions): PluginServer {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  const maxProtocolErrors = options.maxProtocolErrors ?? 3
  const declaredCapabilities = new Set<string>(options.manifest.capabilities)
  const inFlight = new Map<string, CallState>()
  const usedRequestIds = new Set<string>()
  let handshaken = false
  let protocolErrors = 0
  let stopped = false
  let pending: Buffer[] = []
  let pendingLength = 0
  let discarding = false

  const write = (message: unknown): void => {
    if (stopped) return
    options.output.write(`${JSON.stringify(message)}\n`)
  }

  const respond = <T>(response: PluginResponse<T>): void => write(response)

  const fail = (
    requestId: string,
    code: string,
    message: string,
    retryable: boolean,
  ): void => {
    respond({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: { code, message, retryable },
    })
  }

  const recordProtocolError = (reason: string, requestId: string): void => {
    protocolErrors += 1
    options.logger.warn('协议错误', { reason, requestId, count: protocolErrors })
    fail(requestId, 'PROTOCOL_ERROR', reason, false)
    if (protocolErrors >= maxProtocolErrors) {
      options.logger.error('连续协议错误，插件进程需要回收', { count: protocolErrors })
      options.onFatal?.(reason)
    }
  }

  const isRequest = (value: unknown): value is PluginRequest => {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Record<string, unknown>
    return (
      typeof candidate.requestId === 'string' &&
      typeof candidate.capability === 'string' &&
      typeof candidate.method === 'string' &&
      typeof candidate.deadlineMs === 'number'
    )
  }

  const runRequest = (request: PluginRequest): void => {
    const requestId = request.requestId
    if (request.protocolVersion !== PROTOCOL_VERSION) {
      recordProtocolError('协议版本不匹配', requestId)
      return
    }
    if (requestId.length === 0 || requestId.length > 128) {
      recordProtocolError('requestId 无效', requestId)
      return
    }
    if (usedRequestIds.has(requestId)) {
      // A retried id must not be able to apply its result twice.
      recordProtocolError('requestId 重复', requestId)
      return
    }
    if (
      !Number.isFinite(request.deadlineMs) ||
      request.deadlineMs <= 0 ||
      request.deadlineMs > MAX_DEADLINE_MS
    ) {
      recordProtocolError('deadlineMs 超出允许范围', requestId)
      return
    }
    if (!declaredCapabilities.has(request.capability)) {
      fail(requestId, 'PERMISSION_DENIED', '插件未声明该能力', false)
      return
    }
    if (!options.methods.includes(request.method)) {
      fail(requestId, 'INVALID_REQUEST', '插件不支持该方法', false)
      return
    }

    usedRequestIds.add(requestId)
    const state: CallState = { cancelled: false, settled: false }
    inFlight.set(requestId, state)
    const deadlineAt = Date.now() + request.deadlineMs

    const assertAlive = (): void => {
      if (state.cancelled) throw cancelled()
      if (Date.now() > deadlineAt) throw timedOut('调用超过截止时间，结果作废')
    }

    const timer = setTimeout(() => {
      if (state.settled) return
      state.settled = true
      inFlight.delete(requestId)
      fail(requestId, 'TIMEOUT', '调用超过截止时间，结果作废', true)
      options.logger.warn('调用超时', { requestId, method: request.method })
    }, request.deadlineMs)

    void (async () => {
      try {
        const result = await options.dispatch({
          requestId,
          capability: request.capability,
          method: request.method,
          payload: request.payload,
          deadlineAt,
          assertAlive,
        })
        if (state.settled) {
          // Late results after timeout or cancellation never reach the host.
          options.logger.warn('丢弃迟到结果', { requestId, method: request.method })
          return
        }
        state.settled = true
        respond({ protocolVersion: PROTOCOL_VERSION, requestId, ok: true, result })
      } catch (error) {
        if (state.settled) return
        state.settled = true
        if (isPluginFailure(error)) {
          fail(requestId, error.code, error.message, error.retryable)
        } else {
          options.logger.error('调用失败', {
            requestId,
            method: request.method,
            error: error instanceof Error ? error.message : String(error),
          })
          fail(requestId, 'UNAVAILABLE', '插件执行失败', true)
        }
      } finally {
        clearTimeout(timer)
        inFlight.delete(requestId)
      }
    })()
  }

  const handleLine = (line: string): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      recordProtocolError('消息不是有效 JSON', '')
      return
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const type = (parsed as { type?: unknown }).type
      if (typeof type === 'string' && CONTROL_TYPES.has(type)) {
        handleControl(parsed as Record<string, unknown>)
        return
      }
    }
    if (!handshaken) {
      recordProtocolError('握手完成前不能调用能力', '')
      return
    }
    if (!isRequest(parsed)) {
      recordProtocolError('请求字段不完整', '')
      return
    }
    runRequest(parsed)
  }

  const handleControl = (message: Record<string, unknown>): void => {
    if (message.type === 'handshake') {
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        recordProtocolError('协议版本不匹配', '')
        return
      }
      handshaken = true
      const ready: ReadyMessage = {
        type: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        pluginId: options.manifest.id,
        version: options.manifest.version,
        capabilities: [...options.manifest.capabilities],
        methods: [...options.methods],
        status: options.status(),
      }
      write(ready)
      return
    }
    const requestId = typeof message.requestId === 'string' ? message.requestId : ''
    const state = inFlight.get(requestId)
    if (state === undefined) {
      // Cancelling an unknown or finished call is a no-op, not a failure.
      options.logger.debug('忽略未知取消请求', { requestId })
      return
    }
    state.cancelled = true
    if (!state.settled) {
      state.settled = true
      inFlight.delete(requestId)
      fail(requestId, 'CANCELLED', '调用已取消', false)
    }
  }

  const onData = (chunk: Buffer): void => {
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(0x0a, start)
      if (newline === -1) {
        if (!discarding) {
          pending.push(chunk.subarray(start))
          pendingLength += chunk.length - start
        }
        break
      }
      const piece = chunk.subarray(start, newline)
      start = newline + 1
      if (discarding) {
        discarding = false
        continue
      }
      if (pendingLength + piece.length > maxLineBytes) {
        // Oversized messages are rejected before parsing.
        pending = []
        pendingLength = 0
        recordProtocolError('消息超过大小上限', '')
        continue
      }
      pending.push(piece)
      pendingLength += piece.length
      const line = Buffer.concat(pending).toString('utf8').trim()
      pending = []
      pendingLength = 0
      if (line !== '') handleLine(line)
    }
    if (pendingLength > maxLineBytes) {
      // An unfinished line already exceeds the limit: drop it without parsing.
      pending = []
      pendingLength = 0
      discarding = true
      recordProtocolError('消息超过大小上限', '')
    }
  }

  return {
    get ready() {
      return handshaken
    },
    start() {
      write(helloMessage(options.manifest))
      options.input.on('data', (chunk: Buffer | string) => {
        onData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      })
      options.input.on('end', () => {
        options.logger.info('宿主关闭了输入流')
      })
      options.input.on('error', (error: Error) => {
        options.logger.error('输入流错误', { error: error.message })
      })
    },
    stop() {
      stopped = true
      for (const [requestId, state] of inFlight) {
        if (state.settled) continue
        state.settled = true
        fail(requestId, 'CANCELLED', '插件已停止', false)
      }
      inFlight.clear()
      options.input.removeAllListeners('data')
    },
  }
}
