export class AgentFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'AgentFailure'
  }
}

export function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentFailure('CANCELLED', '任务调用已取消')
}

export function invalid(message: string): never {
  throw new AgentFailure('INVALID_REQUEST', message)
}
