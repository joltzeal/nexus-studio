export const SYNC_METHODS = [
  'sync.offer',
  'sync.receive',
  'sync.status',
  'sync.cancel',
] as const
export const OFFER_LIFETIME_MS = 15 * 60 * 1000
export const CHUNK_BYTES = 64 * 1024
export const MAX_HEADER_BYTES = 4096

export interface Invitation {
  v: 1
  host: string
  port: number
  secret: string
  transferId: string
  sha256: string
  size: number
  expiresAt: number
}

export interface SyncStatus {
  state: 'waiting' | 'transferring' | 'completed' | 'failed' | 'cancelled'
  bytes: number
  total: number
  error?: string
  path?: string
}

export interface OfferResult {
  offerId: string
  invitation: string
  addresses: string[]
  expiresAt: number
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code = 'INVALID_REQUEST',
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyncError('Expected an object')
  }
  return value as Record<string, unknown>
}

export function fields(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  const input = record(value)
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new SyncError('Unexpected input field')
  }
  return input
}

export function isHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value)
}

export function terminal(status: SyncStatus): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status.state)
}
