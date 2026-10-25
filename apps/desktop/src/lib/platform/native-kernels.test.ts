import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  downloadKernel,
  getKernelStatus,
  KernelOperationError,
  nativeKernelsAvailable,
} from './native-kernels'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))

function status() {
  return {
    cacheDir: '/local/kernels',
    platform: 'darwin-arm64',
    installed: [
      {
        version: '155.0.1.2',
        binaryPath: '/local/kernels/155.0.1.2/browser',
      },
    ],
    activationConfigured: false,
    download: {
      phase: 'idle',
      percent: null,
      downloadedMb: null,
      totalMb: null,
      attempt: null,
      version: null,
      error: null,
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isTauri).mockReturnValue(true)
})

describe('native kernel adapter', () => {
  it('refuses native calls in the browser without returning simulated status', async () => {
    vi.mocked(isTauri).mockReturnValue(false)

    expect(nativeKernelsAvailable()).toBe(false)
    await expect(getKernelStatus()).rejects.toMatchObject({
      code: 'desktop_only',
      retryable: false,
    })
    await expect(downloadKernel()).rejects.toMatchObject({
      code: 'desktop_only',
      retryable: false,
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reads installed kernels without requiring activation and forwards refresh', async () => {
    vi.mocked(invoke).mockResolvedValue(status())

    expect(nativeKernelsAvailable()).toBe(true)
    await expect(getKernelStatus()).resolves.toEqual(status())
    await expect(getKernelStatus(true)).resolves.toEqual(status())
    expect(invoke).toHaveBeenNthCalledWith(1, 'kernel_status', { refresh: false })
    expect(invoke).toHaveBeenNthCalledWith(2, 'kernel_status', { refresh: true })
  })

  it('preserves actual progress, retry attempts, and structured backend errors', async () => {
    const response = {
      ...status(),
      activationConfigured: true,
      download: {
        phase: 'retrying',
        percent: 12.5,
        downloadedMb: 18.75,
        totalMb: 150,
        attempt: 2,
        version: '155.0.2.3',
        error: {
          code: 'network_unavailable',
          message: '下载连接中断，请重试。',
          retryable: true,
        },
      },
    }
    vi.mocked(invoke).mockResolvedValue(response)

    await expect(getKernelStatus()).resolves.toEqual(response)
  })

  it.each([
    'idle',
    'preparing',
    'downloading',
    'verifying',
    'extracting',
    'retrying',
    'ready',
    'failed',
  ])('accepts the %s phase without inventing missing progress', async (phase) => {
    const response = status()
    response.download.phase = phase
    vi.mocked(invoke).mockResolvedValue(response)

    const result = await getKernelStatus()
    expect(result.download.phase).toBe(phase)
    expect(result.download.percent).toBeNull()
    expect(result.download.downloadedMb).toBeNull()
    expect(result.download.totalMb).toBeNull()
    expect(result.download.attempt).toBeNull()
  })

  it.each([
    { ...status(), activationConfigured: 'true' },
    { ...status(), installed: [{ version: null, binaryPath: '/bin' }] },
    { ...status(), installed: [{ version: '155.0.1.2' }] },
    { ...status(), download: { ...status().download, phase: 'complete' } },
    { ...status(), download: { ...status().download, percent: 101 } },
    { ...status(), download: { ...status().download, percent: -1 } },
    { ...status(), download: { ...status().download, downloadedMb: -1 } },
    { ...status(), download: { ...status().download, totalMb: Number.NaN } },
    { ...status(), download: { ...status().download, attempt: 1.5 } },
    { ...status(), download: { ...status().download, attempt: 0 } },
    { ...status(), download: { ...status().download, attempt: 4 } },
    { ...status(), download: { ...status().download, error: { message: 'unsafe' } } },
    { ...status(), download: { phase: 'idle' } },
    null,
  ])(
    'rejects malformed external status %# without exposing its contents',
    async (dto) => {
      vi.mocked(invoke).mockResolvedValue(dto)

      await expect(getKernelStatus()).rejects.toMatchObject({
        code: 'invalid_response',
      })
      await expect(getKernelStatus()).rejects.toBeInstanceOf(KernelOperationError)
    },
  )

  it('discards unrecognized fields at the native boundary', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...status(),
      internalDiagnostics: 'private diagnostic data',
      download: { ...status().download, credentials: 'private token' },
    })

    await expect(getKernelStatus()).resolves.toEqual(status())
  })

  it.each([1, 2, 3])(
    'keeps backend attempt %i and measured zero progress',
    async (attempt) => {
      vi.mocked(invoke).mockResolvedValue({
        ...status(),
        download: {
          ...status().download,
          phase: 'downloading',
          percent: 0,
          downloadedMb: 0,
          totalMb: 150,
          attempt,
        },
      })

      const result = await getKernelStatus()
      expect(result.download).toMatchObject({
        attempt,
        percent: 0,
        downloadedMb: 0,
        totalMb: 150,
      })
    },
  )

  it('keeps the download pending until the native operation returns its version', async () => {
    let complete!: (version: string) => void
    const pending = new Promise<string>((resolve) => {
      complete = resolve
    })
    vi.mocked(invoke).mockReturnValue(pending)
    let settled = false
    const download = downloadKernel().then((version) => {
      settled = true
      return version
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('kernel_download')

    complete('155.0.2.3')
    await expect(download).resolves.toBe('155.0.2.3')
  })

  it.each([null, '', '   ', 155, { version: '155.0.2.3' }])(
    'rejects an invalid download result %# rather than announcing success',
    async (result) => {
      vi.mocked(invoke).mockResolvedValue(result)

      await expect(downloadKernel()).rejects.toMatchObject({
        code: 'invalid_response',
      })
    },
  )

  it('preserves the message and retryability of a structured native rejection', async () => {
    vi.mocked(invoke).mockRejectedValue({
      code: 'activation_required',
      message: '请先保存激活码。',
      retryable: false,
      diagnostics: 'private native details',
    })

    await expect(downloadKernel()).rejects.toMatchObject({
      code: 'activation_required',
      message: '请先保存激活码。',
      retryable: false,
    })
  })

  it('surfaces the actionable NETWORK job error as retryable', async () => {
    vi.mocked(invoke).mockRejectedValue({
      code: 'NETWORK',
      message: '下载连接中断，请检查网络或应用代理后重试。',
      retryable: true,
    })

    await expect(downloadKernel()).rejects.toMatchObject({
      code: 'NETWORK',
      message: '下载连接中断，请检查网络或应用代理后重试。',
      retryable: true,
    })
  })

  it('accepts a structured rejection serialized by the native bridge', async () => {
    vi.mocked(invoke).mockRejectedValue(
      JSON.stringify({
        code: 'download_failed',
        message: '下载失败，请重试。',
        retryable: true,
      }),
    )

    await expect(downloadKernel()).rejects.toMatchObject({
      code: 'download_failed',
      message: '下载失败，请重试。',
      retryable: true,
    })
  })

  it.each([
    'raw native error containing private data',
    new Error('private native stack and token'),
    { code: 'failed', message: 'private native data' },
  ])('hides unstructured native failures %# and allows retry', async (cause) => {
    vi.mocked(invoke).mockRejectedValue(cause)

    const error = await getKernelStatus().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(KernelOperationError)
    expect(error).toMatchObject({ retryable: true })
    expect((error as Error).message).not.toContain('private')
  })
})
