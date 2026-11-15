import { describe, expect, it } from 'vitest'
import { addMonths, base64, cardHash, signLease, verifyDevice } from '../src/crypto'

const encoder = new TextEncoder()

describe('license cryptography', () => {
  it('clamps month-end across short months', () => {
    expect(
      new Date(
        addMonths(Date.parse('2027-01-31T09:15:00Z') / 1000, 1) * 1000,
      ).toISOString(),
    ).toBe('2027-02-28T09:15:00.000Z')
  })
  it('isolates card digests by pepper without exposing the card', async () => {
    expect(await cardHash('rac-example', 'pepper')).toBe(
      await cardHash('RAC-EXAMPLE', 'pepper'),
    )
    expect(await cardHash('rac-example', 'other')).not.toBe(
      await cardHash('rac-example', 'pepper'),
    )
  })
  it('verifies the device signature over the exact request body and rejects tampering', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    const key = base64(
      new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    )
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = 'a'.repeat(32)
    const body = '{"pluginId":"studio.sales-agent"}'
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body))),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
    const signature = base64(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          pair.privateKey,
          encoder.encode(`v1\nPOST\n/v1/cards/redeem\n${timestamp}\n${nonce}\n${hash}`),
        ),
      ),
    )
    const request = new Request('https://license.example/v1/cards/redeem', {
      method: 'POST',
      headers: {
        'x-device-time': timestamp,
        'x-device-nonce': nonce,
        'x-device-signature': signature,
      },
    })
    expect((await verifyDevice(request, body, key)).nonce).toBe(nonce)
    await expect(verifyDevice(request, body + ' ', key)).rejects.toThrow()
  })
  it('signs deterministic lease fields with the server key', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    const privateKey = base64(
      new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    )
    const signed = await signLease({ v: 1, pluginId: 'studio.sales-agent' }, privateKey)
    expect(
      await crypto.subtle.verify(
        'Ed25519',
        pair.publicKey,
        Uint8Array.from(atob(signed.signature), (char) => char.charCodeAt(0)),
        encoder.encode(JSON.stringify(signed.payload)),
      ),
    ).toBe(true)
  })
})
