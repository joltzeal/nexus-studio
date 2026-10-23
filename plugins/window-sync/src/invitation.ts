import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { isAbsolute } from 'node:path'
import { fields, isHex, OFFER_LIFETIME_MS, SyncError, type Invitation } from './types.js'

export function hostName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    throw new SyncError('Invalid peer host')
  }
  if (isIP(value) !== 0) return value
  if (
    !value
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    /^[\d.]+$/.test(value)
  ) {
    throw new SyncError('Invalid peer host')
  }
  return value
}

export function absolutePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    value.includes('\0') ||
    !isAbsolute(value)
  ) {
    throw new SyncError('Expected an absolute file path')
  }
  return value
}

export function lanAddresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
  const privateAddress = (address: string): boolean =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)
  addresses.sort(
    (left, right) => Number(privateAddress(right)) - Number(privateAddress(left)),
  )
  return [...new Set(addresses.length === 0 ? ['127.0.0.1'] : addresses)]
}

export function encodeInvitation(value: Invitation): string {
  return `nexus-sync:${Buffer.from(JSON.stringify(value)).toString('base64url')}`
}

export function decodeInvitation(value: unknown, now: number): Invitation {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^nexus-sync:[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new SyncError('Invalid invitation')
  }
  let decoded: unknown
  try {
    const encoded = value.slice('nexus-sync:'.length)
    const buffer = Buffer.from(encoded, 'base64url')
    if (buffer.toString('base64url') !== encoded) throw new Error()
    decoded = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new SyncError('Invalid invitation')
  }
  const input = fields(decoded, [
    'v',
    'host',
    'port',
    'secret',
    'transferId',
    'sha256',
    'size',
    'expiresAt',
  ])
  const host = hostName(input['host'])
  if (
    input['v'] !== 1 ||
    !Number.isInteger(input['port']) ||
    (input['port'] as number) < 1 ||
    (input['port'] as number) > 65535 ||
    !isHex(input['secret'], 32) ||
    !isHex(input['transferId'], 16) ||
    !isHex(input['sha256'], 32) ||
    !Number.isSafeInteger(input['size']) ||
    (input['size'] as number) < 0 ||
    !Number.isSafeInteger(input['expiresAt']) ||
    (input['expiresAt'] as number) <= now ||
    (input['expiresAt'] as number) > now + OFFER_LIFETIME_MS
  ) {
    throw new SyncError('Invalid or expired invitation')
  }
  return {
    v: 1,
    host,
    port: input['port'] as number,
    secret: input['secret'],
    transferId: input['transferId'],
    sha256: input['sha256'],
    size: input['size'] as number,
    expiresAt: input['expiresAt'] as number,
  }
}
