import { randomUUID } from 'node:crypto'
import { AgentScopeSchema, type AgentScope } from '@nexus/plugin-sdk/agent'
import { AgentFailure, assertActive } from './errors.js'

export interface AgentHost {
  call<T = unknown>(
    scope: AgentScope,
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<T>
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

export class HostChannel implements AgentHost {
  private readonly pending = new Map<string, Pending>()
  private closed = false

  constructor(
    private readonly send: (message: Record<string, unknown>) => void,
    private readonly timeoutMs = 95_000,
  ) {}

  async call<T = unknown>(
    scope: AgentScope,
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    assertActive(signal)
    if (this.closed) throw new AgentFailure('CANCELLED', '宿主连接已关闭')
    if (this.pending.size >= 32)
      throw new AgentFailure('RATE_LIMITED', '宿主请求过多，请稍后重试', true)
    const validatedScope = AgentScopeSchema.parse(scope)
    if (!/^agent\.[a-zA-Z.]+$/.test(method) || method.length > 100)
      throw new AgentFailure('INVALID_REQUEST', '宿主方法无效')
    const requestId = randomUUID()
    const message = {
      type: 'host.request',
      hostVersion: 1,
      requestId,
      scope: validatedScope,
      method,
      payload,
      deadlineMs: this.timeoutMs,
    }
    if (Buffer.byteLength(JSON.stringify(message)) > 1024 * 1024 - 1)
      throw new AgentFailure('INVALID_REQUEST', '宿主请求超过消息上限')
    return new Promise<T>((resolve, reject) => {
      const settleError = (error: Error) => {
        const item = this.pending.get(requestId)
        if (!item) return
        this.pending.delete(requestId)
        item.cleanup()
        reject(error)
      }
      const aborted = () => settleError(new AgentFailure('CANCELLED', '任务调用已取消'))
      const timer = setTimeout(
        () => settleError(new AgentFailure('TIMEOUT', '宿主操作超时，执行结果需要核对')),
        this.timeoutMs,
      )
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', aborted)
        },
      })
      signal?.addEventListener('abort', aborted, { once: true })
      try {
        this.send(message)
      } catch {
        settleError(new AgentFailure('UNAVAILABLE', '无法向宿主发送请求'))
      }
      if (signal?.aborted) aborted()
    })
  }

  receive(message: unknown): boolean {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== 'host.response'
    )
      return false
    if (
      !('requestId' in message) ||
      typeof message.requestId !== 'string' ||
      !('hostVersion' in message) ||
      message.hostVersion !== 1
    )
      throw new AgentFailure('PROTOCOL_ERROR', '宿主响应格式无效')
    const pending = this.pending.get(message.requestId)
    if (!pending) return true
    this.pending.delete(message.requestId)
    pending.cleanup()
    if ('ok' in message && message.ok === true && 'result' in message) {
      pending.resolve(message.result)
    } else {
      const error =
        'error' in message && typeof message.error === 'object' && message.error !== null
          ? message.error
          : null
      pending.reject(
        new AgentFailure(
          error && 'code' in error && typeof error.code === 'string'
            ? error.code.slice(0, 100)
            : 'UNAVAILABLE',
          error && 'message' in error && typeof error.message === 'string'
            ? error.message.slice(0, 1000)
            : '宿主拒绝了本次请求',
          Boolean(error && 'retryable' in error && error.retryable === true),
        ),
      )
    }
    return true
  }

  close(): void {
    this.closed = true
    for (const item of this.pending.values()) {
      item.cleanup()
      item.reject(new AgentFailure('CANCELLED', '宿主连接已关闭'))
    }
    this.pending.clear()
  }
}
