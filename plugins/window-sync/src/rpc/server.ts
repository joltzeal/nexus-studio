import type { Readable, Writable } from 'node:stream'

import manifest from '../../nexus.plugin.js'
import { SYNC_METHODS, SyncError, record } from '../types.js'
import type { WindowSync } from '../transport.js'

interface Options {
  input: Readable
  output: Writable
  diagnostics: Writable
  transport: WindowSync
}

export interface PluginServer {
  start(): void
  stop(): Promise<void>
  readonly ready: boolean
}

interface Call {
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
  settled: boolean
}

const MAX_LINE_BYTES = 1024 * 1024
const MAX_DEADLINE_MS = 120_000

export function createPluginServer(options: Options): PluginServer {
  const calls = new Map<string, Call>()
  const usedIds = new Set<string>()
  const tasks = new Set<Promise<void>>()
  let ready = false
  let started = false
  let stopped = false
  let stopTask: Promise<void> | undefined
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined
  let pending: Buffer[] = []
  let length = 0
  let discarding = false
  let protocolErrors = 0

  const write = (value: unknown): void => {
    if (!stopped) options.output.write(`${JSON.stringify(value)}\n`)
  }
  const fail = (requestId: string, code: string, message: string): void => {
    write({
      protocolVersion: 1,
      requestId,
      ok: false,
      error: { code, message, retryable: ['UNAVAILABLE', 'TIMEOUT'].includes(code) },
    })
  }
  const stop = (): Promise<void> => {
    stopTask ??= (async () => {
      stopped = true
      ready = false
      if (handshakeTimer) clearTimeout(handshakeTimer)
      options.input.off('data', onData)
      options.input.off('end', onEnd)
      options.input.off('close', onEnd)
      options.input.off('error', onError)
      options.input.pause()
      pending = []
      for (const call of calls.values()) {
        call.settled = true
        clearTimeout(call.timer)
        call.abort.abort()
      }
      await options.transport.close()
      await Promise.allSettled([...tasks])
      calls.clear()
    })()
    return stopTask
  }
  const protocolError = (requestId: string): void => {
    fail(requestId, 'PROTOCOL_ERROR', 'Invalid host protocol message')
    protocolErrors += 1
    // Never log payloads, IDs, paths, invitations or caught exception messages.
    if (protocolErrors >= 3) {
      options.diagnostics.write('window-sync: too many protocol errors\n')
      void stop()
    }
  }

  const dispatch = async (
    method: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (method === 'sync.offer') return options.transport.offer(payload, signal)
    if (method === 'sync.receive') return options.transport.receive(payload, signal)
    if (method === 'sync.status') return options.transport.status(payload)
    return options.transport.cancel(payload)
  }

  const request = (input: Record<string, unknown>): void => {
    const requestId = input['requestId']
    if (
      typeof requestId !== 'string' ||
      requestId.length < 1 ||
      requestId.length > 128 ||
      input['protocolVersion'] !== 1 ||
      typeof input['method'] !== 'string' ||
      typeof input['capability'] !== 'string' ||
      typeof input['deadlineMs'] !== 'number' ||
      !Number.isFinite(input['deadlineMs']) ||
      input['deadlineMs'] <= 0 ||
      input['deadlineMs'] > MAX_DEADLINE_MS ||
      usedIds.has(requestId)
    ) {
      protocolError(
        typeof requestId === 'string' && requestId.length <= 128 ? requestId : '',
      )
      return
    }
    if (input['capability'] !== 'window.sync') {
      fail(requestId, 'PERMISSION_DENIED', 'Capability is not declared')
      return
    }
    if (!(SYNC_METHODS as readonly string[]).includes(input['method'])) {
      fail(requestId, 'INVALID_REQUEST', 'Method is not supported')
      return
    }
    if (calls.size >= 32 || usedIds.size >= 65_536) {
      fail(
        requestId,
        'UNAVAILABLE',
        'Host call limit reached; recycle plugin if necessary',
      )
      return
    }
    usedIds.add(requestId)
    const abort = new AbortController()
    const settle = (code: string, message: string): void => {
      const call = calls.get(requestId)
      if (!call || call.settled) return
      call.settled = true
      abort.abort()
      clearTimeout(call.timer)
      fail(requestId, code, message)
    }
    const call: Call = {
      abort,
      settled: false,
      timer: setTimeout(
        () => settle('TIMEOUT', 'Host call timed out'),
        input['deadlineMs'],
      ),
    }
    calls.set(requestId, call)
    const task = (async () => {
      try {
        const result = await dispatch(
          input['method'] as string,
          input['payload'],
          abort.signal,
        )
        if (!call.settled) {
          call.settled = true
          write({ protocolVersion: 1, requestId, ok: true, result })
        }
      } catch (error) {
        if (!call.settled) {
          call.settled = true
          if (error instanceof SyncError) fail(requestId, error.code, error.message)
          else fail(requestId, 'UNAVAILABLE', 'Plugin operation failed')
        }
      } finally {
        clearTimeout(call.timer)
        calls.delete(requestId)
      }
    })()
    tasks.add(task)
    void task.finally(() => tasks.delete(task)).catch(() => undefined)
  }

  const handle = (line: Buffer): void => {
    if (stopped) return
    let input: Record<string, unknown>
    try {
      input = record(JSON.parse(line.toString('utf8')))
    } catch {
      protocolError('')
      return
    }
    if (input['type'] === 'handshake') {
      if (input['protocolVersion'] !== 1 || ready) {
        protocolError('')
        return
      }
      ready = true
      if (handshakeTimer) clearTimeout(handshakeTimer)
      write({
        type: 'ready',
        protocolVersion: 1,
        pluginId: manifest.id,
        version: manifest.version,
        capabilities: [...manifest.capabilities],
        methods: [...SYNC_METHODS],
        status: { transport: 'direct-tcp', pid: process.pid },
      })
    } else if (input['type'] === 'cancel') {
      const id = input['requestId']
      const call = typeof id === 'string' ? calls.get(id) : undefined
      if (call && !call.settled) {
        call.settled = true
        call.abort.abort()
        clearTimeout(call.timer)
        fail(id as string, 'CANCELLED', 'Host call cancelled')
      }
    } else if (!ready) {
      protocolError(typeof input['requestId'] === 'string' ? input['requestId'] : '')
    } else request(input)
  }

  function onData(data: Buffer | string): void {
    const chunk = typeof data === 'string' ? Buffer.from(data) : data
    let offset = 0
    while (offset < chunk.length && !stopped) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline
      if (!discarding) {
        const piece = chunk.subarray(offset, end)
        length += piece.length
        if (length > MAX_LINE_BYTES) {
          pending = []
          length = 0
          discarding = true
          protocolError('')
        } else pending.push(piece)
      }
      if (newline !== -1) {
        if (!discarding && length !== 0) handle(Buffer.concat(pending, length))
        discarding = false
        pending = []
        length = 0
      }
      offset = end + 1
    }
  }
  function onEnd(): void {
    void stop()
  }
  function onError(): void {
    options.diagnostics.write('window-sync: host stream failed\n')
    void stop()
  }
  options.output.on('error', onError)

  return {
    get ready() {
      return ready
    },
    start() {
      if (started || stopped) return
      started = true
      write({
        type: 'hello',
        protocolVersion: 1,
        pluginId: manifest.id,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        capabilities: [...manifest.capabilities],
      })
      options.input.on('data', onData)
      options.input.once('end', onEnd)
      options.input.once('close', onEnd)
      options.input.once('error', onError)
      handshakeTimer = setTimeout(() => {
        void stop()
      }, 15_000)
      handshakeTimer.unref()
    },
    stop,
  }
}
