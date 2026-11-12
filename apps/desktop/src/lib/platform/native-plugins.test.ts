import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { callPlugin, PluginCallError } from './native-plugins'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }))

beforeEach(() => {
  vi.mocked(invoke).mockReset()
})

describe('plugin call failures', () => {
  it('preserves the structured host error code and retry classification', async () => {
    vi.mocked(invoke).mockRejectedValue({
      code: 'PERMISSION_DENIED',
      message: 'Permission is missing',
      retryable: false,
    })
    const error = await callPlugin(
      'studio.email',
      'email.provider',
      'email.messages.list',
      {},
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(PluginCallError)
    expect(error).toMatchObject({
      code: 'PERMISSION_DENIED',
      message: 'Permission is missing',
      retryable: false,
    })
  })

  it.each([
    'password=synthetic-secret',
    { code: 'AUTH_FAILED', message: 'synthetic-secret' },
    { code: 'bad code', message: 'synthetic-secret', retryable: false },
    { code: 'AUTH_FAILED', message: 'synthetic-secret', retryable: 'false' },
  ])('discards malformed host failure payloads', async (failure) => {
    vi.mocked(invoke).mockRejectedValue(failure)
    await expect(
      callPlugin('studio.email', 'email.provider', 'email.messages.list'),
    ).rejects.toThrow('插件调用失败，请重试。')
    await expect(
      callPlugin('studio.email', 'email.provider', 'email.messages.list'),
    ).rejects.not.toThrow('synthetic-secret')
  })
})
