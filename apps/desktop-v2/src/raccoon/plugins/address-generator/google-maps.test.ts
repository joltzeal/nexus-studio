import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadGoogleMaps, onMapsAuthFailure, type MapsSdk } from './google-maps.ts'

test('maps bootstrap retries network failures, ignores late callbacks, shares a key and reports auth failures', async () => {
  const scripts: { src: string; remove(): void; error?: () => void }[] = []
  const target = { setTimeout, clearTimeout } as unknown as Record<string, unknown>
  const previousWindow = globalThis.window,
    previousDocument = globalThis.document
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: () => null,
      createElement: () => ({
        src: '',
        remove() {},
        addEventListener(_event: string, handler: () => void) {
          this.error = handler
        },
        error: undefined as (() => void) | undefined,
      }),
      head: { appendChild: (script: (typeof scripts)[number]) => scripts.push(script) },
    },
  })
  try {
    const failed = loadGoogleMaps('fixture-browser-key')
    const oldCallback = new URL(scripts[0]!.src).searchParams.get('callback')!
    scripts[0]!.error!()
    await assert.rejects(failed, /map-load/)
    const next = loadGoogleMaps('fixture-browser-key')
    ;(target[oldCallback] as () => void)()
    target.google = { maps: {} as MapsSdk }
    const callback = new URL(scripts[1]!.src).searchParams.get('callback')!
    ;(target[callback] as () => void)()
    await next
    assert.equal(loadGoogleMaps('fixture-browser-key'), next)
    assert.equal(scripts.length, 2)
    await assert.rejects(loadGoogleMaps('different-browser-key'), /map-key/)
    let notified = 0
    const off = onMapsAuthFailure(() => {
      notified++
    })
    ;(target.gm_authFailure as () => void)()
    assert.equal(notified, 1)
    off()
    await assert.rejects(loadGoogleMaps('fixture-browser-key'), /map-auth/)
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: previousDocument,
    })
  }
})
test('dev and packaged v2 CSP allow Maps without opening arbitrary HTTPS scripts', () => {
  const config = JSON.parse(
    readFileSync(
      new URL('../../../../../desktop/src-tauri/tauri.v2.conf.json', import.meta.url),
      'utf8',
    ),
  )
  for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
    const script = policy
      .split(';')
      .find((part: string) => part.trim().startsWith('script-src '))
    assert.ok(script.includes('https://maps.googleapis.com'))
    assert.ok(script.includes('https://maps.gstatic.com'))
    assert.ok(!script.split(/\s+/).includes('https:'))
    assert.ok(policy.includes('https://*.googleapis.com'))
  }
})
