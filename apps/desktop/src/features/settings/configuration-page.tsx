import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FieldError } from '@/components/ui/field'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { usePreferences } from '@/hooks/use-preferences'
import {
  configurationError,
  exportConfiguration,
  importConfiguration,
  openConfigurationFile,
  pluginConfigurationTargets,
  saveConfigurationFile,
  type ConfigurationArchive,
  type ConfigurationImportResult,
  type ConfigurationTarget,
} from '@/lib/platform/configuration'
import { listPlugins, pluginHostAvailable } from '@/lib/platform/native-plugins'
import { getNetworkProxy, setNetworkProxy } from '@/lib/platform/native-network-proxy'
import {
  notifyPluginCatalogChanged,
  onPluginCatalogChanged,
} from '@/lib/platform/plugin-catalog-events'

export function ConfigurationPage() {
  const native = pluginHostAvailable()
  const preferences = usePreferences()
  const [targets, setTargets] = useState<ConfigurationTarget[]>([])
  const [selected, setSelected] = useState<string[]>(['preferences', 'networkProxy'])
  const [file, setFile] = useState<{
    name: string
    archive: ConfigurationArchive
  } | null>(null)
  const [results, setResults] = useState<ConfigurationImportResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(native)
  const [attempt, setAttempt] = useState(0)
  const busy = useRef(false)
  const generation = useRef(0)
  const fileRef = useRef<typeof file>(null)

  useEffect(() => {
    const request = ++generation.current
    return () => {
      if (generation.current === request) generation.current += 1
    }
  }, [])
  useEffect(
    () =>
      onPluginCatalogChanged(() => {
        setLoading(true)
        setAttempt((value) => value + 1)
      }),
    [],
  )
  useEffect(() => {
    if (!native) return
    let active = true
    void listPlugins()
      .then(
        (plugins) => {
          if (!active) return
          const next = pluginConfigurationTargets(plugins)
          setTargets(next)
          if (!fileRef.current)
            setSelected([
              'preferences',
              'networkProxy',
              ...next.filter((row) => row.available).map((row) => row.id),
            ])
          setError(null)
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
  }, [native, attempt])

  async function run(action: () => Promise<void>) {
    if (busy.current) return
    const request = generation.current
    busy.current = true
    setPending(true)
    setError(null)
    setStatus(null)
    try {
      await action()
    } catch (cause) {
      if (request === generation.current) setError(configurationError(cause))
    } finally {
      busy.current = false
      if (request === generation.current) setPending(false)
    }
  }
  async function chooseFile() {
    const request = generation.current
    await run(async () => {
      const next = await openConfigurationFile()
      if (!next || request !== generation.current) return
      const current = pluginConfigurationTargets(await listPlugins())
      if (request !== generation.current) return
      setTargets(current)
      fileRef.current = next
      setFile(next)
      setResults([])
      setSelected([
        ...(next.archive.preferences ? ['preferences'] : []),
        ...(next.archive.networkProxy ? ['networkProxy'] : []),
        ...next.archive.plugins
          .filter((plugin) =>
            current.some((target) => target.id === plugin.id && target.available),
          )
          .map((plugin) => plugin.id),
      ])
    })
  }
  async function exportFile() {
    const request = generation.current
    await run(async () => {
      const current = pluginConfigurationTargets(await listPlugins())
      const missing = selected.filter(
        (id) =>
          id !== 'preferences' &&
          id !== 'networkProxy' &&
          !current.some((target) => target.id === id && target.available),
      )
      if (missing.length) throw new Error('所选插件已不可用，请刷新后重新选择。')
      const { archive, skipped } = await exportConfiguration(
        current.filter((target) => selected.includes(target.id)),
        {
          preferences: selected.includes('preferences') ? preferences.preferences : null,
          networkProxy: selected.includes('networkProxy')
            ? await getNetworkProxy()
            : null,
        },
      )
      if (skipped.length)
        throw new Error(`${skipped.join('、')} 暂不可用，请刷新后重新选择。`)
      const path = await saveConfigurationFile(archive)
      if (path && request === generation.current) setStatus(`已导出到 ${path}`)
    })
  }
  async function restoreFile() {
    if (!file) return
    const request = generation.current
    await run(async () => {
      const current = pluginConfigurationTargets(await listPlugins())
      const next = await importConfiguration({
        archive: file.archive,
        targets: current,
        selected,
        async writePreferences(value) {
          if (!(await preferences.update(value)))
            throw new Error('偏好保存失败，请重试。')
        },
        writeNetworkProxy: setNetworkProxy,
      })
      notifyPluginCatalogChanged()
      if (request !== generation.current) return
      setResults(next)
      const failures = next.filter((result) => !result.success)
      setSelected(failures.map((result) => result.id))
      setStatus(
        failures.length
          ? `已导入 ${next.length - failures.length} 项，${failures.length} 项失败，可重试。`
          : `已导入 ${next.length} 项配置。`,
      )
    })
  }
  const rows = file
    ? [
        ...(file.archive.preferences
          ? [
              {
                id: 'preferences',
                name: '外观与工作区',
                detail: '主题、密度、工作区名称',
                available: true,
              },
            ]
          : []),
        ...(file.archive.networkProxy
          ? [
              {
                id: 'networkProxy',
                name: '应用代理',
                detail: '系统、手动或直连设置',
                available: true,
              },
            ]
          : []),
        ...file.archive.plugins.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          detail: `插件 ${plugin.version}`,
          available: targets.some(
            (target) => target.id === plugin.id && target.available,
          ),
        })),
      ]
    : [
        {
          id: 'preferences',
          name: '外观与工作区',
          detail: '主题、密度、工作区名称',
          available: true,
        },
        {
          id: 'networkProxy',
          name: '应用代理',
          detail: '系统、手动或直连设置',
          available: true,
        },
        ...targets.map((target) => ({
          id: target.id,
          name: target.name,
          detail: `插件 ${target.version}`,
          available: target.available,
        })),
      ]
  const ready =
    native &&
    !loading &&
    !pending &&
    !preferences.loading &&
    !preferences.loadError &&
    (file !== null || !preferences.saveError)
  const selectedCount = rows.filter(
    (row) => row.available && selected.includes(row.id),
  ).length
  return (
    <section className="collection-page" aria-label="配置导入导出">
      <div className="section-intro">
        <div>
          <h2 className="page-heading">配置导入导出</h2>
          <p className="page-description">保存应用与插件配置，在另一台设备上导入。</p>
        </div>
        <div className="section-actions">
          <Button
            variant="outline"
            disabled={!native || pending || loading}
            onClick={() => {
              setLoading(true)
              setAttempt((value) => value + 1)
            }}
          >
            <RefreshCw />
            刷新
          </Button>
          <Button
            variant="outline"
            disabled={!native || pending}
            onClick={() => void chooseFile()}
          >
            <Upload />
            选择配置文件
          </Button>
          {file ? (
            <Button
              disabled={!ready || !selectedCount}
              onClick={() => void restoreFile()}
            >
              {pending ? '处理中…' : `导入所选（${selectedCount}）`}
            </Button>
          ) : (
            <Button disabled={!ready || !selectedCount} onClick={() => void exportFile()}>
              <Download />
              {pending ? '处理中…' : `导出所选（${selectedCount}）`}
            </Button>
          )}
        </div>
      </div>
      {!native ? (
        <p role="status" className="text-sm text-muted-foreground">
          请在桌面应用中导入或导出配置。
        </p>
      ) : null}
      {file ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>待导入：{file.name}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              fileRef.current = null
              setFile(null)
              setResults([])
              setStatus(null)
              setError(null)
              setSelected([
                'preferences',
                'networkProxy',
                ...targets.filter((row) => row.available).map((row) => row.id),
              ])
            }}
          >
            返回导出
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        文件包含所选配置的明文密钥；不包含浏览器数据、账号资料和商品图片。
        {file ? '导入会更新所选配置，保留未选中的设置与业务记录。' : ''}
      </p>
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      {preferences.loadError || preferences.saveError ? (
        <FieldError role="alert">
          {preferences.loadError || preferences.saveError}
        </FieldError>
      ) : null}
      {status ? (
        <p role="status" className="break-all text-sm">
          {status}
        </p>
      ) : null}
      <Table aria-label={file ? '待导入配置' : '可导出配置'}>
        <TableHeader>
          <TableRow>
            <TableHead className="w-9">
              <span className="sr-only">选择</span>
            </TableHead>
            <TableHead>配置</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const result = results.find((entry) => entry.id === row.id)
            return (
              <TableRow key={row.id}>
                <TableCell>
                  <Checkbox
                    aria-label={`选择${row.name}`}
                    checked={selected.includes(row.id) && row.available}
                    disabled={!native || pending || loading || !row.available}
                    onCheckedChange={(checked) => {
                      setSelected((current) =>
                        checked === true
                          ? [...new Set([...current, row.id])]
                          : current.filter((id) => id !== row.id),
                      )
                    }}
                  />
                </TableCell>
                <TableCell>
                  <span className="font-medium">{row.name}</span>
                  <small className="block text-muted-foreground">{row.detail}</small>
                </TableCell>
                <TableCell
                  className={
                    result && !result.success
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  }
                >
                  {result
                    ? result.success
                      ? '已导入'
                      : result.error
                    : row.available
                      ? '可用'
                      : file
                        ? '请先安装并启用支持配置迁移的插件'
                        : '无配置项或当前版本不支持迁移'}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </section>
  )
}
