import { useCallback, useEffect, useState } from 'react'
import { Button, ProgressBar, Switch, Tabs } from '@proxyshard/shardx-ui-kit'
import { nativeApi, nativeError } from './api'
import { useWorkspace } from './store'
import { SettingRow, SettingsGroup } from '../pages/settings/SettingRow'

type Engine = 'chromium' | 'firefox'
type KernelStatus = {
  platform: string
  installed: { version: string; binaryPath: string }[]
  download: { phase: string; percent: number | null; error: string | null }
}
type KernelRelease = { version: string; platform: string; checkedAt: string }

function parseStatus(value: unknown): KernelStatus {
  if (!value || typeof value !== 'object')
    throw new Error('AliasMode 内核状态返回格式无效')
  const row = value as Record<string, unknown>
  const download = row.download
  if (
    typeof row.platform !== 'string' ||
    !Array.isArray(row.installed) ||
    !download ||
    typeof download !== 'object'
  )
    throw new Error('AliasMode 内核状态返回格式无效')
  const job = download as Record<string, unknown>
  if (
    typeof job.phase !== 'string' ||
    (job.percent !== null &&
      (typeof job.percent !== 'number' || job.percent < 0 || job.percent > 100)) ||
    (job.error !== null && typeof job.error !== 'string')
  )
    throw new Error('AliasMode 下载状态返回格式无效')
  const installed = row.installed.map((entry) => {
    if (!entry || typeof entry !== 'object')
      throw new Error('AliasMode 内核清单返回格式无效')
    const item = entry as Record<string, unknown>
    if (typeof item.version !== 'string' || typeof item.binaryPath !== 'string') {
      throw new Error('AliasMode 内核清单返回格式无效')
    }
    return { version: item.version, binaryPath: item.binaryPath }
  })
  return {
    platform: row.platform,
    installed,
    download: {
      phase: job.phase,
      percent: job.percent as number | null,
      error: job.error as string | null,
    },
  }
}

function parseRelease(value: unknown): KernelRelease {
  if (!value || typeof value !== 'object')
    throw new Error('AliasMode 版本信息返回格式无效')
  const row = value as Record<string, unknown>
  if (
    typeof row.version !== 'string' ||
    typeof row.platform !== 'string' ||
    typeof row.checkedAt !== 'string'
  ) {
    throw new Error('AliasMode 版本信息返回格式无效')
  }
  return { version: row.version, platform: row.platform, checkedAt: row.checkedAt }
}

export function AliasModeLab({
  connectionEnabled,
  enabled,
  saving,
  probe,
  onToggle,
}: {
  connectionEnabled: boolean
  enabled: boolean
  saving: boolean
  probe: { connected: boolean; message: string | null } | null
  onToggle: (enabled: boolean) => void
}) {
  const workspace = useWorkspace()
  const [engine, setEngine] = useState<Engine>('chromium')
  const [status, setStatus] = useState<KernelStatus | null>(null)
  const [release, setRelease] = useState<KernelRelease | null>(null)
  const [busy, setBusy] = useState<'status' | 'check' | 'download' | string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const readStatus = useCallback(async () => {
    const value = parseStatus(await nativeApi.call('aliasmode_kernel_status', { engine }))
    setStatus(value)
    setError(null)
    return value
  }, [engine])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const value = parseStatus(
          await nativeApi.call('aliasmode_kernel_status', { engine }),
        )
        if (!active) return
        setStatus(value)
        setError(null)
        if (
          ['preparing', 'downloading', 'extracting', 'verifying'].includes(
            value.download.phase,
          )
        ) {
          timer = setTimeout(() => void read(), 1000)
        }
      } catch (cause) {
        if (active) setError(nativeError(cause).message)
      }
    }
    setStatus(null)
    void read()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [engine, busy])

  const run = async (
    kind: 'check' | 'download' | string,
    action: () => Promise<void>,
  ) => {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      await action()
      await readStatus()
    } catch (cause) {
      setError(nativeError(cause).message)
    } finally {
      setBusy(null)
    }
  }

  const downloading =
    !!status &&
    ['preparing', 'downloading', 'extracting', 'verifying'].includes(
      status.download.phase,
    )

  return (
    <>
      <Tabs
        idBase="native-aliasmode-engine"
        aria-label="AliasMode 内核引擎"
        value={engine}
        onChange={(value) => setEngine(value as Engine)}
        items={[
          { value: 'chromium', label: 'Chromium' },
          { value: 'firefox', label: 'Firefox' },
        ]}
      />
      <SettingsGroup
        title={`AliasMode ${engine === 'chromium' ? 'Chromium' : 'Firefox'}`}
      >
        <SettingRow
          id={`native-aliasmode-enable-${engine}`}
          title="启用 AliasMode"
          help="保存后添加或移除 AliasMode Workspace。"
          control={() => (
            <Switch
              checked={enabled}
              disabled={saving || workspace.loading}
              onChange={onToggle}
              aria-label="启用 AliasMode"
            />
          )}
          below={
            <p className="m-0 text-help text-text-sub-600">
              {connectionEnabled ? '已启用' : '未启用'}
              {probe
                ? ` · ${probe.connected ? '接入探测可达' : '接入探测不可达'}${probe.message ? ` · ${probe.message}` : ''}`
                : ''}{' '}
              · 保存后生效。
            </p>
          }
        />
        <SettingRow
          id={`native-aliasmode-kernels-${engine}`}
          title="已安装内核"
          help={status ? `平台 ${status.platform}` : '正在读取本地内核清单'}
          control={() => (
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              disabled={busy !== null}
              isLoading={busy === 'status'}
              onClick={() =>
                void run('status', async () => {
                  await readStatus()
                })
              }
            >
              刷新状态
            </Button>
          )}
        />
        <SettingRow
          id={`native-aliasmode-latest-${engine}`}
          title="官方稳定版本"
          help={
            release
              ? `检查于 ${new Date(release.checkedAt).toLocaleString()} · ${release.platform}`
              : '检查当前平台的官方稳定版本'
          }
          control={() => (
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              disabled={busy !== null}
              isLoading={busy === 'check'}
              onClick={() =>
                void run('check', async () => {
                  setRelease(
                    parseRelease(
                      await nativeApi.call('aliasmode_kernel_check_latest', { engine }),
                    ),
                  )
                })
              }
            >
              {release ? '重新检查' : '检查更新'}
            </Button>
          )}
          below={
            release ? (
              <div className="flex items-center gap-2">
                <code className="text-text-strong-950">{release.version}</code>
                <Button
                  size="3xsmall"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('download', async () => {
                      await nativeApi.call('aliasmode_kernel_download', {
                        engine,
                        version: release.version,
                      })
                    })
                  }
                >
                  下载此版本
                </Button>
              </div>
            ) : undefined
          }
        />
        {downloading && (
          <SettingRow
            id={`native-aliasmode-download-progress-${engine}`}
            title="下载进度"
            help={status?.download.phase}
            below={
              status?.download.percent === null ? (
                <progress
                  aria-label="AliasMode 内核下载进度"
                  className="h-1.5 w-full accent-primary-base"
                />
              ) : (
                <ProgressBar
                  aria-label="AliasMode 内核下载进度"
                  value={status!.download.percent!}
                  showValue
                />
              )
            }
          />
        )}
        {status?.download.error && (
          <p role="alert" className="m-0 text-help text-error-text">
            {status.download.error}
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-help text-error-text">
            {error}
          </p>
        )}
        {status?.installed.map((kernel) => (
          <SettingRow
            key={kernel.version}
            id={`native-aliasmode-kernel-${engine}-${kernel.version}`}
            title={kernel.version}
            help="已安装"
            control={() => (
              <Button
                size="xsmall"
                variant="error"
                mode="ghost"
                disabled={busy !== null}
                onClick={() =>
                  void run(kernel.version, async () => {
                    await nativeApi.call('aliasmode_kernel_delete', {
                      engine,
                      version: kernel.version,
                    })
                  })
                }
              >
                删除
              </Button>
            )}
          />
        ))}
        {status && status.installed.length === 0 && !downloading && (
          <SettingRow
            id={`native-aliasmode-kernel-empty-${engine}`}
            title="尚未安装内核"
            help="检查官方版本后可下载。"
          />
        )}
        {engine === 'firefox' && (
          <SettingRow
            id="native-aliasmode-firefox-automation"
            title="自动化能力"
            help="AliasMode Firefox 不支持 CDP 自动化。"
          />
        )}
      </SettingsGroup>
    </>
  )
}
