import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const tauri = new URL('../../../desktop/src-tauri/', import.meta.url)
const json = (path: string) => JSON.parse(readFileSync(new URL(path, tauri), 'utf8'))

test('v2 dev and build use an overlay without removing native macOS traffic lights', () => {
  const config = json('tauri.conf.json')
  assert.equal(config.identifier, 'com.raccoon.desktop')
  assert.equal(config.app.windows.length, 1)
  const main = config.app.windows[0]
  assert.equal(main.label ?? 'main', 'main')
  assert.equal(main.titleBarStyle, 'Overlay')
  assert.equal(main.hiddenTitle, true)
  assert.notEqual(main.decorations, false)
  assert.deepEqual(main.trafficLightPosition, { x: 14, y: 21 })
  assert.equal(main.dragDropEnabled, false)
  assert.equal(main.minWidth, 960)
  assert.equal(main.minHeight, 700)
  assert.equal(config.build.frontendDist, '../../desktop-v2/dist')
})

test('native chrome controls and theme sync have narrowly scoped window permissions', () => {
  const capabilities = readdirSync(new URL('capabilities/', tauri))
    .filter((name) => name.endsWith('.json'))
    .map((name) => json(`capabilities/${name}`))
  for (const label of ['main', 'automation-helper-test', 'automation-fleet-test']) {
    const grants = new Set(
      capabilities
        .filter((capability) =>
          capability.windows.some(
            (pattern: string) =>
              label === pattern ||
              (pattern.endsWith('*') && label.startsWith(pattern.slice(0, -1))),
          ),
        )
        .flatMap((capability) => capability.permissions),
    )
    for (const permission of [
      'core:window:allow-start-dragging',
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-close',
      'core:window:allow-set-theme',
    ])
      assert.ok(grants.has(permission), `${label}: ${permission}`)
  }
})
