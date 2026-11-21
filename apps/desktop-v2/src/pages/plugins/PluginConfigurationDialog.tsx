import { useEffect, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Modal,
  SegmentControl,
} from '@proxyshard/shardx-ui-kit'
import {
  DownloadIcon,
  NavSettingsIcon,
  RefreshIcon,
  UploadIcon,
} from '../../shared/icons'
import { pluginApi } from '../../raccoon/plugins/api'
import {
  configurationError,
  exportPluginConfiguration,
  importPluginConfiguration,
  openPluginConfigurationFile,
  pluginConfigurationTargets,
  savePluginConfigurationFile,
  type ConfigurationArchive,
  type ConfigurationResult,
  type ConfigurationTarget,
} from '../../raccoon/plugins/configuration'
import { usePluginTask } from './usePluginTask'

type Tab = 'export' | 'import'

export function PluginConfigurationDialog({ onClose }: { onClose: () => void }) {
  const native = isTauri()
  const task = usePluginTask()
  const [tab, setTab] = useState<Tab>('export')
  const [targets, setTargets] = useState<ConfigurationTarget[]>([])
  const [loading, setLoading] = useState(native)
  const [catalogReady, setCatalogReady] = useState(false)
  const [exportSelected, setExportSelected] = useState<string[] | null>(null)
  const [importSelected, setImportSelected] = useState<string[]>([])
  const [file, setFile] = useState<{
    name: string
    archive: ConfigurationArchive
  } | null>(null)
  const [results, setResults] = useState<ConfigurationResult[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!native) return
    let active = true
    void pluginApi
      .list()
      .then(
        (plugins) => {
          if (!active) return
          setTargets(pluginConfigurationTargets(plugins))
          setCatalogReady(true)
        },
        (cause: unknown) => {
          if (active) setError(configurationError(cause))
        },
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [native])

  async function run(kind: string, action: (token: number) => Promise<void>) {
    if (!native || !task.acquire()) return
    const token = task.begin()
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      await action(token)
    } catch (cause) {
      if (task.current(token)) setError(configurationError(cause))
    } finally {
      task.release()
      if (task.current(token)) setBusy(null)
    }
  }

  async function refresh(token: number) {
    try {
      const plugins = await pluginApi.list()
      if (!task.current(token)) return
      setTargets(pluginConfigurationTargets(plugins))
      setCatalogReady(true)
    } catch (cause) {
      if (task.current(token)) setCatalogReady(false)
      throw cause
    }
  }

  async function chooseFile(token: number) {
    const next = await openPluginConfigurationFile()
    if (!next || !task.current(token)) return
    const nextTargets = pluginConfigurationTargets(await pluginApi.list())
    if (!task.current(token)) return
    setTargets(nextTargets)
    setCatalogReady(true)
    setFile(next)
    setResults([])
    setImportSelected(
      next.archive.plugins
        .filter((plugin) =>
          nextTargets.some((target) => target.id === plugin.id && target.available),
        )
        .map((plugin) => plugin.id),
    )
  }

  const selected =
    tab === 'export'
      ? (exportSelected ??
        targets.filter((target) => target.available).map((target) => target.id))
      : importSelected
  const rows =
    tab === 'export'
      ? targets.map((target) => ({
          ...target,
          detail: `v${target.version} · ${target.id}`,
          result: undefined as ConfigurationResult | undefined,
        }))
      : (file?.archive.plugins ?? []).map((plugin) => {
          const target = targets.find((entry) => entry.id === plugin.id)
          return {
            id: plugin.id,
            name: plugin.name,
            available: target?.available ?? false,
            reason: target?.reason ?? (target ? null : '插件未安装'),
            detail:
              target && target.version !== plugin.version
                ? `来源 v${plugin.version} · 本机 v${target.version}`
                : `v${plugin.version} · ${plugin.id}`,
            result: results.find((result) => result.id === plugin.id),
          }
        })
  const availableIds = rows
    .filter((row) => row.available && !row.result?.success)
    .map((row) => row.id)
  const selectedIds = availableIds.filter((id) => selected.includes(id))
  const setSelected = (ids: string[]) =>
    tab === 'export' ? setExportSelected(ids) : setImportSelected(ids)
  const blocked = loading || busy !== null || !native || !catalogReady

  async function exportFile(token: number) {
    const archive = await exportPluginConfiguration(selectedIds, () =>
      task.current(token),
    )
    if (!task.current(token)) return
    const path = await savePluginConfigurationFile(archive)
    if (path && task.current(token))
      setNotice(`已导出 ${archive.plugins.length} 项插件配置`)
  }

  async function importFile(token: number) {
    if (!file) return
    let next: ConfigurationResult[]
    try {
      next = await importPluginConfiguration(file.archive, selectedIds, () =>
        task.current(token),
      )
    } finally {
      window.dispatchEvent(new Event('raccoon:plugin-catalog-changed'))
    }
    if (!task.current(token)) return
    setResults((previous) => [
      ...previous.filter((result) => !next.some((entry) => entry.id === result.id)),
      ...next,
    ])
    const failures = next.filter((result) => !result.success)
    setImportSelected(failures.map((result) => result.id))
    setNotice(
      failures.length
        ? `已导入 ${next.length - failures.length} 项，${failures.length} 项失败，可重试`
        : `已导入 ${next.length} 项插件配置`,
    )
  }

  return (
    <Modal
      open
      title="插件配置"
      description="导入或导出插件设置，不包含账号库存、邮件、商品和浏览器环境数据"
      icon={<NavSettingsIcon />}
      size="lg"
      closeLabel="关闭插件配置"
      onOpenChange={(open) => {
        if (!open && busy === null) onClose()
      }}
      footer={
        <>
          <span className="mr-auto text-secondary tabular-nums text-text-sub-600">
            已选择 {selectedIds.length} 项
          </span>
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={busy !== null}
            onClick={onClose}
          >
            关闭
          </Button>
          <Button
            size="xsmall"
            leftIcon={
              tab === 'export' ? (
                <DownloadIcon className="size-3.5" />
              ) : (
                <UploadIcon className="size-3.5" />
              )
            }
            disabled={blocked || !selectedIds.length || (tab === 'import' && !file)}
            isLoading={busy === 'export' || busy === 'import'}
            onClick={() => void run(tab, tab === 'export' ? exportFile : importFile)}
          >
            {tab === 'export'
              ? `导出所选（${selectedIds.length}）`
              : `导入所选（${selectedIds.length}）`}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentControl
            fit
            size="xsmall"
            semantics="tabs"
            aria-label="插件配置操作"
            value={tab}
            onChange={(value) => {
              setTab(value as Tab)
              setError(null)
              setNotice(null)
            }}
            items={[
              { value: 'export', label: '导出', disabled: busy !== null },
              { value: 'import', label: '导入', disabled: busy !== null },
            ]}
          />
          <div className="flex items-center gap-2">
            {tab === 'import' && (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                leftIcon={<UploadIcon className="size-3.5" />}
                disabled={!native || busy !== null || loading}
                isLoading={busy === 'open'}
                onClick={() => void run('open', chooseFile)}
              >
                选择配置文件
              </Button>
            )}
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              leftIcon={<RefreshIcon className="size-3.5" />}
              disabled={!native || busy !== null || loading}
              isLoading={busy === 'refresh'}
              onClick={() => void run('refresh', refresh)}
            >
              刷新插件
            </Button>
          </div>
        </div>
        {!native && (
          <Alert status="information" variant="lighter">
            请在 Raccoon 桌面应用中导入导出插件配置
          </Alert>
        )}
        <p className="m-0 text-help text-text-sub-600">
          配置文件为明文，包含所选插件的实际密钥和 Token，请妥善保管
        </p>
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        {notice && (
          <Alert
            status={results.some((result) => !result.success) ? 'warning' : 'success'}
            variant="lighter"
          >
            {notice}
          </Alert>
        )}
        {tab === 'import' && file && (
          <div className="flex min-w-0 flex-col gap-1 rounded-control bg-bg-weak-50 p-3">
            <span className="break-all text-body font-medium text-text-strong-950">
              {file.name}
            </span>
            <span className="text-help text-text-sub-600">
              {file.archive.plugins.length} 项插件配置 ·{' '}
              {new Date(file.archive.exportedAt).toLocaleString()}
            </span>
            {file.archive.plugins.some(
              (plugin) =>
                !targets.some((target) => target.id === plugin.id && target.available),
            ) && (
              <span className="text-help text-text-sub-600">
                不可用项不会导入；可保留原文件，安装或更新插件后再导入
              </span>
            )}
            {(file.archive.preferences !== null ||
              file.archive.networkProxy !== null) && (
              <span className="text-help text-text-sub-600">
                本页只导入插件配置，文件中的外观和应用代理设置不会修改
              </span>
            )}
          </div>
        )}
        <div
          className="flex min-w-0 flex-col"
          role="group"
          aria-label={tab === 'export' ? '可导出的插件配置' : '待导入的插件配置'}
        >
          {loading ? (
            <p className="m-0 py-4 text-body text-text-sub-600">正在读取插件…</p>
          ) : rows.length === 0 ? (
            <p className="m-0 py-4 text-body text-text-sub-600">
              {tab === 'import' && !file
                ? '选择配置文件后预览可导入的插件设置'
                : '没有可显示的插件配置'}
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 pb-3 row-line">
                <Checkbox
                  label="选择全部可用插件"
                  disabled={blocked || availableIds.length === 0}
                  checked={
                    availableIds.length > 0 && selectedIds.length === availableIds.length
                  }
                  indeterminate={
                    selectedIds.length > 0 && selectedIds.length < availableIds.length
                  }
                  onCheckedChange={(checked) => setSelected(checked ? availableIds : [])}
                />
                <span className="text-help tabular-nums text-text-soft-400">
                  {rows.length} 项
                </span>
              </div>
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="flex min-w-0 items-center gap-3 row-line py-3 last:pb-0"
                >
                  <Checkbox
                    aria-label={`选择 ${row.name}`}
                    disabled={blocked || !row.available || row.result?.success}
                    checked={
                      row.available && !row.result?.success && selected.includes(row.id)
                    }
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked
                          ? [...selected, row.id]
                          : selected.filter((id) => id !== row.id),
                      )
                    }
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="break-words text-body font-medium text-text-strong-950">
                      {row.name}
                    </span>
                    <span className="break-all text-help text-text-soft-400">
                      {row.detail}
                    </span>
                    {row.result?.error && (
                      <span className="text-help text-error-base">
                        {row.result.error}
                      </span>
                    )}
                  </div>
                  <Badge
                    size="small"
                    color={
                      row.result?.success
                        ? 'success'
                        : !row.available || row.result?.error
                          ? 'warning'
                          : 'gray'
                    }
                  >
                    {row.result?.success
                      ? '已导入'
                      : row.result?.error
                        ? '导入失败'
                        : (row.reason ?? '可用')}
                  </Badge>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
