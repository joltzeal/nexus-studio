import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  WINDOW_DETACH_METHOD,
  WindowDetachInputSchema,
  WindowDetachResultSchema,
  type AccountPool,
  type WindowDetachInput,
  type WindowDetachResult,
} from './index.js'

describe('account pool window lifecycle', () => {
  it('defines a binding-only detach method for account pools', () => {
    expect(WINDOW_DETACH_METHOD).toBe('window.detach')
    expectTypeOf<AccountPool['detachWindow']>().toEqualTypeOf<
      (input: WindowDetachInput) => Promise<WindowDetachResult>
    >()
    expect(WindowDetachInputSchema.parse({ windowId: 'win-1' })).toEqual({
      windowId: 'win-1',
    })
  })

  it.each([true, false])(
    'accepts an idempotent detach result with unbound=%s',
    (unbound) => {
      expect(WindowDetachResultSchema.parse({ windowId: 'win-1', unbound })).toEqual({
        windowId: 'win-1',
        unbound,
      })
    },
  )

  it.each([
    null,
    {},
    { windowId: null },
    { windowId: 7 },
    { windowId: '' },
    { windowId: ' ' },
    { windowId: ' win-1 ' },
    { windowId: 'x'.repeat(65) },
    { windowId: 'win-1', deleteAccount: true },
  ])('rejects invalid detach input without coercion: %j', (input) => {
    expect(WindowDetachInputSchema.safeParse(input).success).toBe(false)
  })

  it.each(
    [
      null,
      [],
      {},
      { windowId: 'win-1' },
      { unbound: true },
      { windowId: '', unbound: true },
      { windowId: 'win-1', unbound: null },
      { windowId: 'win-1', unbound: 1 },
      { windowId: 'win-1', unbound: 'false' },
      { windowId: 'win-1', unbound: true, account: {} },
    ].map((result) => ({ result })),
  )('rejects an invalid detach result: $result', ({ result }) => {
    expect(WindowDetachResultSchema.safeParse(result).success).toBe(false)
  })
})
