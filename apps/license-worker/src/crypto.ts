const encoder = new TextEncoder()

export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

export function unbase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 4096)
    throw new Error('invalid base64')
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  if (base64(bytes) !== value) throw new Error('invalid base64')
  return bytes
}

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(value)),
  )
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function cardHash(card: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(card.trim().toUpperCase())),
  )
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyDevice(
  request: Request,
  body: string,
  publicKey: string,
): Promise<{ nonce: string; now: number }> {
  const nonce = request.headers.get('x-device-nonce') ?? ''
  const timestamp = request.headers.get('x-device-time') ?? ''
  const signature = request.headers.get('x-device-signature') ?? ''
  const now = Math.floor(Date.now() / 1000)
  if (
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 300
  )
    throw new Error('invalid device request')
  const data = `v1\n${request.method}\n${new URL(request.url).pathname}\n${timestamp}\n${nonce}\n${await sha256(body)}`
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(unbase64(publicKey)),
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      key,
      new Uint8Array(unbase64(signature)),
      encoder.encode(data),
    ))
  )
    throw new Error('invalid device signature')
  return { nonce, now }
}

export async function signLease(
  fields: Record<string, string | number>,
  pkcs8: string,
): Promise<{ payload: typeof fields; signature: string }> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array(unbase64(pkcs8)),
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  return {
    payload: fields,
    signature: base64(
      new Uint8Array(
        await crypto.subtle.sign('Ed25519', key, encoder.encode(JSON.stringify(fields))),
      ),
    ),
  }
}

export function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp * 1000)
  const originalDay = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + months)
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate()
  date.setUTCDate(Math.min(originalDay, lastDay))
  return Math.floor(date.getTime() / 1000)
}
