import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const tauri = new URL('../../../desktop/src-tauri/', import.meta.url)
const json = (path: string) => JSON.parse(readFileSync(new URL(path, tauri), 'utf8'))

test('v2 dev and build use an overlay without removing native macOS traffic lights', () => {
  const base = json('tauri.conf.json')
  const v2 = json('tauri.v2.conf.json')
  const merged = { ...base.app, ...v2.app }
  assert.equal(merged.windows.length, 1)
  const main = merged.windows[0]
  assert.equal(main.label ?? 'main', 'main')
  assert.equal(main.titleBarStyle, 'Overlay')
  assert.equal(main.hiddenTitle, true)
  assert.notEqual(main.decorations, false)
  assert.deepEqual(main.trafficLightPosition, { x: 14, y: 21 })
  assert.equal(main.dragDropEnabled, false)
  assert.equal(main.minWidth, base.app.windows[0].minWidth)
  assert.equal(main.minHeight, base.app.windows[0].minHeight)
  assert.equal(v2.build.frontendDist, '../../desktop-v2/dist')
})

test('native startup applies embedded v2 chrome before creating windows', () => {
  const source = readFileSync(new URL('src/lib.rs', tauri), 'utf8')
  const context = source.indexOf('let mut context = tauri::generate_context!();')
  const configure = source.indexOf('configure_main_window(context.config_mut());')
  const build = source.indexOf('.build(context)')
  assert.ok(context >= 0 && configure > context && build > configure)
  assert.match(source, /include_str!\("\.\.\/tauri\.v2\.conf\.json"\)/)
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
