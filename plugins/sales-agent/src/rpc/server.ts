import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import { AGENT_METHODS, SALES_AGENT_CAPABILITY } from '@nexus/plugin-sdk/agent'
import manifest from '../../nexus.plugin.js'
import { AgentFailure } from '../errors.js'
import { HostChannel, type AgentHost } from '../host.js'

const MAX_LINE = 1024 * 1024
const RequestSchema = z.strictObject({
  protocolVersion: z.literal(1),
  requestId: z.string().min(1).max(128),
  capability: z.literal(SALES_AGENT_CAPABILITY),
  method: z.enum(AGENT_METHODS),
  deadlineMs: z.number().int().positive().max(120_000),
  payload: z.unknown(),
})

export interface AgentDispatchContext {
  method: string
  payload: unknown
  signal: AbortSignal
  assertAlive(): void
}
export interface AgentServerOptions {
  input: Readable
  output: Writable
  dispatch(context: AgentDispatchContext, host: AgentHost): Promise<unknown>
  status?: () => Record<string, unknown>
  scrub?: (message: string) => string
  onFatal?: () => void
}

export function createAgentServer(options: AgentServerOptions) {
  let stopped = false
  let started = false
  let handshaken = false
  let protocolErrors = 0
  let fragments: Buffer[] = []
  let bytes = 0
  let oversized = false
  const active = new Map<string, AbortController>()
  const used = new Set<string>()
  const send = (message: Record<string, unknown>) => {
    if (stopped) return
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line) > MAX_LINE)
      throw new AgentFailure('PROTOCOL_ERROR', '插件响应超过消息上限')
    options.output.write(line)
  }
  const host = new HostChannel(send)
  const fail = (requestId: string, code: string, message: string, retryable = false) =>
    send({
      protocolVersion: 1,
      requestId,
      ok: false,
      error: {
        code,
        message: (options.scrub?.(message) ?? message).slice(0, 1000),
        retryable,
      },
    })
  const stop = () => {
    if (stopped) return
    stopped = true
    options.input.off('data', onData)
    options.input.off('end', stop)
    options.input.off('error', stop)
    for (const controller of active.values()) controller.abort()
    active.clear()
    host.close()
    fragments = []
    bytes = 0
  }
  const protocolFailure = (requestId: string) => {
    fail(requestId, 'PROTOCOL_ERROR', '插件请求格式无效')
    if (++protocolErrors >= 3) {
      stop()
      options.onFatal?.()
    }
  }
  const handle = (line: Buffer) => {
    let message: unknown
    try {
      message = JSON.parse(line.toString('utf8'))
      if (host.receive(message)) return
    } catch {
      protocolFailure('')
      return
    }
    if (typeof message !== 'object' || message === null) {
      protocolFailure('')
      return
    }
    if ('type' in message && message.type === 'handshake') {
      if (handshaken || !('protocolVersion' in message) || message.protocolVersion !== 1)
        return protocolFailure('')
      handshaken = true
      send({
        type: 'ready',
        protocolVersion: 1,
        pluginId: manifest.id,
        version: manifest.version,
        capabilities: manifest.capabilities,
        methods: [...AGENT_METHODS],
        status: { ...options.status?.(), pid: process.pid },
      })
      return
    }
    if (
      'type' in message &&
      message.type === 'cancel' &&
      'requestId' in message &&
      typeof message.requestId === 'string'
    ) {
      active.get(message.requestId)?.abort()
      return
    }
    const request = RequestSchema.safeParse(message)
    const requestId =
      'requestId' in message && typeof message.requestId === 'string'
        ? message.requestId
        : ''
    if (!handshaken || !request.success || used.has(requestId))
      return protocolFailure(requestId)
    if (active.size >= 16)
      return fail(requestId, 'RATE_LIMITED', '正在执行的任务过多', true)
    used.add(requestId)
    if (used.size > 4096) used.delete(used.values().next().value!)
    const controller = new AbortController()
    active.set(requestId, controller)
    let answered = false
    const deadlineAt = Date.now() + request.data.deadlineMs
    const timeout = setTimeout(() => controller.abort(), request.data.deadlineMs)
    const aborted = () => {
      if (answered || stopped) return
      answered = true
      const timedOut = Date.now() >= deadlineAt
      fail(
        requestId,
        timedOut ? 'TIMEOUT' : 'CANCELLED',
        timedOut ? '任务步骤超过截止时间，执行结果需要核对' : '任务步骤已取消',
      )
    }
    controller.signal.addEventListener('abort', aborted, { once: true })
    void (async () => {
      try {
        const result = await options.dispatch(
          {
            method: request.data.method,
            payload: request.data.payload,
            signal: controller.signal,
            assertAlive: () => {
              if (controller.signal.aborted || stopped || Date.now() >= deadlineAt)
                throw new AgentFailure('CANCELLED', '任务步骤已取消')
            },
          },
          host,
        )
        if (!answered && !stopped) {
          answered = true
          send({ protocolVersion: 1, requestId, ok: true, result })
        }
      } catch (error) {
        if (!answered && !stopped) {
          answered = true
          if (error instanceof AgentFailure)
            fail(requestId, error.code, error.message, error.retryable)
          else fail(requestId, 'UNAVAILABLE', '任务步骤执行失败，详情请查看任务状态')
        }
      } finally {
        clearTimeout(timeout)
        controller.signal.removeEventListener('abort', aborted)
        active.delete(requestId)
      }
    })()
  }
  function onData(chunk: Buffer | string): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    let offset = 0
    while (offset < data.length && !stopped) {
      const newline = data.indexOf(10, offset)
      const end = newline < 0 ? data.length : newline + 1
      const part = data.subarray(offset, end)
      if (!oversized) {
        bytes += part.length
        if (bytes > MAX_LINE) {
          oversized = true
          fragments = []
        } else fragments.push(part)
      }
      if (newline >= 0) {
        if (oversized) protocolFailure('')
        else if (bytes > 1) handle(Buffer.concat(fragments, bytes))
        fragments = []
        bytes = 0
        oversized = false
      }
      offset = end
    }
  }
  return {
    host,
    start() {
      if (started || stopped) return
      started = true
      options.input.on('data', onData)
      options.input.once('end', stop)
      options.input.once('error', stop)
      send({
        type: 'hello',
        protocolVersion: 1,
        pluginId: manifest.id,
        version: manifest.version,
        apiVersion: 1,
        capabilities: manifest.capabilities,
      })
    },
    stop,
  }
}
