import assert from 'node:assert/strict'
import test from 'node:test'

import { servesDesktopV2 } from './ensure-vite.mjs'

test('recognizes the desktop-v2 entry in an existing Vite page', () => {
  assert.equal(
    servesDesktopV2('<script type="module" src="/src/main.ts"></script>'),
    true,
  )
})

test('recognizes desktop-v2 when Vite adds a hot-reload query string', () => {
  assert.equal(
    servesDesktopV2('<script type="module" src="/src/main.ts?t=1795071483625"></script>'),
    true,
  )
})

test('does not reuse the original desktop frontend server', () => {
  assert.equal(
    servesDesktopV2('<script type="module" src="/src/main.tsx"></script>'),
    false,
  )
})
