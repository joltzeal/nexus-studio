import type { ChangeEvent, FocusEvent } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Input } from '@/components/ui/input'
import {
  components,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { updateBrowserWindowNote } from '@/lib/platform/windows'
import { WindowNote } from './window-note'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useRef: (initial: unknown) =>
      state.hooks
        ? state.hooks.state(() => ({ current: initial }))[0]
        : react.useRef(initial),
  }
})
vi.mock('@/lib/platform/windows', () => ({ updateBrowserWindowNote: vi.fn() }))
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
let hooks: KernelHookHarness
const onSaved = vi.fn()
const render = () =>
  hooks.render(() => WindowNote({ id: 'window', name: 'shop', note: 'old', onSaved }))
function edit() {
  ;(render().props as { onClick: () => void }).onClick()
  components(render(), Input)[0]!.props.onChange?.({
    target: { value: 'new draft' },
  } as ChangeEvent<HTMLInputElement>)
}
function blur(inside: boolean) {
  const form = elements(render()).find((node) => node.type === 'form')!
  ;(form.props.onBlur as (event: FocusEvent<HTMLFormElement>) => void)({
    currentTarget: { contains: () => inside },
    relatedTarget: null,
  } as unknown as FocusEvent<HTMLFormElement>)
}
beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
  vi.mocked(updateBrowserWindowNote).mockResolvedValue('new draft')
})
afterEach(() => hooks.dispose())

it('persists only when focus leaves the note form and reports the confirmed note', async () => {
  edit()
  blur(true)
  expect(updateBrowserWindowNote).not.toHaveBeenCalled()
  blur(false)
  await flushPromises()
  expect(updateBrowserWindowNote).toHaveBeenCalledExactlyOnceWith('window', 'new draft')
  expect(onSaved).toHaveBeenCalledExactlyOnceWith('new draft')
  expect(components(render(), Input)).toHaveLength(0)
})

it('retains the draft and keeps the editor open after a persistence error', async () => {
  vi.mocked(updateBrowserWindowNote).mockRejectedValueOnce(
    new Error('storage unavailable'),
  )
  edit()
  blur(false)
  await flushPromises()
  expect(components(render(), Input)[0]!.props.value).toBe('new draft')
  expect(text(render())).toContain('storage unavailable')
  expect(onSaved).not.toHaveBeenCalled()
})
