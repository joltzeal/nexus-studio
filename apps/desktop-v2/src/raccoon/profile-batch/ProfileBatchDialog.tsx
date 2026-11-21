import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, DialogModal, Input, Popover } from '@proxyshard/shardx-ui-kit'
import type {
  BrowserConnection,
  BrowserProxyEntry,
  WindowSettings,
} from '@nexus/contracts/browser'
import {
  ProxyChoiceList,
  usePoolProxyLabel,
} from '../../features/manage-profiles/ui/ProxyChoiceList'
import { ChevronDownIcon } from '../../shared/icons'
import { FieldGroup } from '../../shared/ui/FieldGroup'
import { ProxyFlag } from '../../shared/ui/ProxyFlag'
import { SelectField } from '../../shared/ui/SelectField'
import { workspace } from '../store'
import { templateProxyChoice } from './proxy'
import { contextProblem, profileBatchApi, type ProfileBatchContext } from './api'
import {
  batchError,
  MAX_BATCH_PROFILES,
  ProfileBatchController,
  prepareProfileBatch,
  type ProfileBatchItem,
  type ProfileBatchStatus,
  type ProfileBatchTarget,
} from './controller'
import {
  buildBatchTemplate,
  initialBatchFields,
  type ProfileBatchFields,
} from './template'

export type ProfileBatchDialogProps = {
  open: boolean
  onOpenChange(open: boolean): void
  targets: readonly ProfileBatchTarget[]
  defaultConnectionId?: string | null
  settings?: Partial<WindowSettings>
  onBind(targetId: string, profileId: string): Promise<void>
  onResults?(items: readonly ProfileBatchItem[]): void | Promise<void>
}

const statuses: Record<ProfileBatchStatus, string> = {
  pending: '待创建',
  creating: '正在创建',
  binding: '正在关联',
  complete: '已完成',
  create_failed: '创建未完成',
  uncertain: '创建结果待核对',
  binding_failed: '已创建，待关联',
}

function BatchProxyField({
  value,
  proxies,
  template,
  manual,
  pool,
  onChange,
}: {
  value: string
  proxies: BrowserProxyEntry[]
  template: boolean
  manual: boolean
  pool: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const poolLabel = usePoolProxyLabel(value)
  const label = '所有 Profile 使用的代理'
  const selected = proxies.find((item) => item.id === value)
  const display =
    poolLabel ??
    (value === '__template'
      ? '使用配置模板中的固定代理'
      : selected
        ? selected.name || `${selected.host}:${selected.port}`
        : value
          ? '代理不可用'
          : '选择代理')
  return (
    <FieldGroup label={label}>
      {(labelId) => (
        <>
          <Button
            ref={anchor}
            size="xsmall"
            mode="stroke"
            variant="neutral"
            className="w-full min-w-0 justify-between"
            aria-labelledby={labelId}
            aria-describedby={`${labelId}-value`}
            aria-expanded={open}
            rightIcon={<ChevronDownIcon className="size-3.5" />}
            onClick={() => setOpen((current) => !current)}
          >
            <span id={`${labelId}-value`} className="truncate">
              {display}
            </span>
          </Button>
          <Popover
            open={open}
            onOpenChange={setOpen}
            anchorRef={anchor}
            align="start"
            aria-label={label}
            className="w-[320px] p-0"
          >
            {open && (
              <ProxyChoiceList
                allowPool={pool}
                label={label}
                value={value}
                options={[
                  ...(template
                    ? [{ value: '__template', label: '使用配置模板中的固定代理' }]
                    : []),
                  ...proxies.map((proxy) => ({
                    value: proxy.id,
                    label: proxy.name || `${proxy.host}:${proxy.port}`,
                    hint: `${proxy.host}:${proxy.port}`,
                    icon: <ProxyFlag cc={proxy.country} height={14} />,
                    keywords: [proxy.kind, proxy.country],
                    disabled: !manual,
                  })),
                ]}
                onChange={(next) => {
                  onChange(next)
                  setOpen(false)
                  anchor.current?.focus()
                }}
              />
            )}
          </Popover>
        </>
      )}
    </FieldGroup>
  )
}

/** Mounting a fresh session captures the caller's selected target set. */
export function ProfileBatchDialog(props: ProfileBatchDialogProps) {
  return props.open ? <BatchSession {...props} /> : null
}

function BatchSession(props: ProfileBatchDialogProps) {
  const [targets] = useState(() => props.targets.map((target) => ({ ...target })))
  const [connections, setConnections] = useState<BrowserConnection[]>([])
  const [connectionId, setConnectionId] = useState(
    props.defaultConnectionId ?? workspace.state.connectionId ?? '',
  )
  const [context, setContext] = useState<ProfileBatchContext | null>(null)
  const [fields, setFields] = useState<ProfileBatchFields | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [items, setItems] = useState<readonly ProfileBatchItem[] | null>(null)
  const [selected, setSelected] = useState(
    () => new Set(targets.map((target) => target.id)),
  )
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const job = useRef<ProfileBatchController | null>(null)
  const running = useRef(false)
  const reportAttempt = useRef(0)
  const mounted = useRef(true)
  const fieldsConnection = useRef<string | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      job.current?.stopAfterCurrent()
    }
  }, [])

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    void profileBatchApi.connections().then(
      (rows) => {
        if (!current) return
        setConnections(rows)
        setConnectionId((id) =>
          rows.some((row) => row.id === id)
            ? id
            : (rows.find(
                (row) => row.enabled && row.scopeConfirmed && row.capabilities.create,
              )?.id ??
              rows[0]?.id ??
              ''),
        )
        setLoading(false)
        if (!rows.length) {
          setLoading(false)
          setError('尚未配置 Workspace，请先到设置添加浏览器接入')
        }
      },
      (cause: unknown) => {
        if (current) {
          setLoading(false)
          setError(batchError(cause))
        }
      },
    )
    return () => {
      current = false
    }
  }, [attempt])

  useEffect(() => {
    const connection = connections.find((row) => row.id === connectionId)
    if (!connection || job.current) return
    let current = true
    setLoading(true)
    setError(null)
    setContext(null)
    void profileBatchApi.context(connection).then(
      (value) => {
        if (!current) return
        setContext(value)
        setFields((previous) =>
          fieldsConnection.current === connection.id && previous
            ? previous
            : initialBatchFields(value),
        )
        fieldsConnection.current = connection.id
        setLoading(false)
      },
      (cause: unknown) => {
        if (current) {
          setLoading(false)
          setError(batchError(cause))
        }
      },
    )
    return () => {
      current = false
    }
  }, [connections, connectionId])

  const patch = (changes: Partial<ProfileBatchFields>) =>
    setFields((current) => (current ? { ...current, ...changes } : null))
  const completed = items?.filter((item) => item.status === 'complete').length ?? 0
  const problem =
    targets.length < 1 || targets.length > MAX_BATCH_PROFILES
      ? `每批请选择 1–${MAX_BATCH_PROFILES} 个目标，当前选择 ${targets.length} 个`
      : context
        ? contextProblem(context)
        : null

  async function report(controller: ProfileBatchController) {
    const currentAttempt = ++reportAttempt.current
    try {
      await callbacks.current.onResults?.(controller.items)
      if (mounted.current && currentAttempt === reportAttempt.current)
        setRefreshError(null)
    } catch (cause) {
      if (mounted.current && currentAttempt === reportAttempt.current)
        setRefreshError(`创建结果已保留，列表刷新失败。${batchError(cause)}`)
    }
  }

  async function run() {
    if (running.current || (!job.current && (!context || !fields || problem))) return
    running.current = true
    setBusy(true)
    setStopping(false)
    setError(null)
    setRefreshError(null)
    try {
      let controller = job.current
      if (!controller) {
        if (!context || !fields) return
        const template = buildBatchTemplate(context, fields, callbacks.current.settings)
        controller = await prepareProfileBatch(
          {
            connection: context.connection,
            targets,
            namePrefix: fields.namePrefix,
            template,
          },
          {
            checkConnection: (connection, operationId) =>
              profileBatchApi.checkConnection(connection, operationId),
            create: (input) => profileBatchApi.create(input),
            reconcile: (id) => profileBatchApi.reconcile(id),
            onBind: (targetId, profileId) =>
              callbacks.current.onBind(targetId, profileId),
          },
          async () => {
            const fresh = await profileBatchApi.context(context.connection)
            const blocked = contextProblem(fresh)
            if (blocked) throw new Error(blocked)
            return fresh.profiles
          },
          () => mounted.current,
        )
        if (!controller || !mounted.current) return
        job.current = controller
        if (mounted.current) setItems(controller.items)
      }
      await controller.run((next) => {
        if (!mounted.current) return
        setItems(next)
        const done = new Set(
          next.filter((item) => item.status === 'complete').map((item) => item.targetId),
        )
        setSelected((current) => new Set([...current].filter((id) => !done.has(id))))
      }, selected)
      void report(controller)
    } catch (cause) {
      if (mounted.current) setError(batchError(cause))
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function chooseTemplate(id: string) {
    const source = context?.profiles.find((profile) => profile.id === id)
    if (!source) {
      if (context) setFields(initialBatchFields(context))
      return
    }
    patch({
      templateId: id,
      fingerprintId: '',
      groupId: source.groupId ?? '',
      proxyId: templateProxyChoice(source),
      note: source.settings.note,
      geoip: source.settings.geoip,
      timezone: source.settings.timezone,
      locale: source.settings.locale,
      viewport: source.settings.viewport,
      startUrl: source.settings.startUrl,
      kernelVersion: source.kernelVersion ?? fields?.kernelVersion ?? '',
      aliasEngine: source.settings.aliasEngine === 'firefox' ? 'firefox' : 'chromium',
    })
  }

  const connection = context?.connection
  return (
    <DialogModal
      open
      title="批量创建 Profile"
      size="lg"
      subtitle={
        items
          ? `已完成 ${completed}/${items.length}${stopping && busy ? ' · 正在完成当前项' : ''}`
          : `为 ${targets.length} 个目标分别创建 Profile 并关联`
      }
      showClose={!busy}
      onOpenChange={(open) => {
        if (!running.current) props.onOpenChange(open)
      }}
      footer={
        busy ? (
          <>
            <span className="mr-auto text-help text-text-sub-600" role="status">
              {stopping ? '正在完成当前项' : '批量任务执行中'}
            </span>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              disabled={stopping}
              onClick={() => {
                job.current?.stopAfterCurrent()
                setStopping(true)
              }}
            >
              完成当前项后停止
            </Button>
          </>
        ) : (
          <>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              onClick={() => props.onOpenChange(false)}
            >
              关闭
            </Button>
            {refreshError && job.current ? (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                onClick={() => {
                  if (job.current) void report(job.current)
                }}
              >
                刷新结果
              </Button>
            ) : null}
            {!items || completed < items.length ? (
              <Button
                size="xsmall"
                disabled={
                  loading ||
                  !!problem ||
                  (!items && !fields) ||
                  (items !== null && selected.size === 0)
                }
                onClick={() => void run()}
              >
                {items ? '重试所选未完成项' : `创建 ${targets.length} 个 Profile 并关联`}
              </Button>
            ) : null}
          </>
        )
      }
    >
      <div className="flex flex-col gap-4 py-4">
        {error || problem ? (
          <p className="m-0 text-help text-error-text" role="alert">
            {error ?? problem}
          </p>
        ) : null}
        {error && !items ? (
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重新读取创建配置
          </Button>
        ) : null}
        {loading && !items ? (
          <p className="m-0 text-help" role="status">
            正在读取 Workspace 配置…
          </p>
        ) : null}
        {!items ? (
          <fieldset
            disabled={busy || loading}
            className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
          >
            <p
              className="m-0 max-h-24 overflow-auto text-help text-text-sub-600"
              aria-label="本批目标"
            >
              {targets.map((target) => target.name).join('、')}
            </p>
            <SelectField
              label="Workspace"
              value={connectionId}
              options={connections.map((row) => ({
                value: row.id,
                label: row.name,
                hint: row.providerId,
              }))}
              onChange={(id) => {
                setConnectionId(id)
                setFields(null)
              }}
            />
            {context && fields ? (
              <>
                <SelectField
                  label="公共配置模板"
                  value={fields.templateId}
                  options={[
                    { value: '', label: '新配置' },
                    ...context.profiles.map((profile) => ({
                      value: profile.id,
                      label: profile.name,
                    })),
                  ]}
                  onChange={chooseTemplate}
                />
                <Input
                  label="名称前缀"
                  inputSize="xsmall"
                  maxLength={36}
                  placeholder="留空使用目标名称"
                  value={fields.namePrefix}
                  onChange={(event) => patch({ namePrefix: event.target.value })}
                />
                <div className="grid grid-cols-2 gap-3">
                  <SelectField
                    label="Folder"
                    value={fields.groupId}
                    options={[
                      { value: '', label: '无 Folder' },
                      ...context.folders.map((folder) => ({
                        value: folder.id,
                        label: folder.name,
                      })),
                    ]}
                    onChange={(groupId) => patch({ groupId })}
                  />
                  <BatchProxyField
                    key={connectionId}
                    value={fields.proxyId}
                    proxies={context.proxies}
                    template={!!fields.templateId}
                    manual={
                      !!connection?.capabilities.manualProxy &&
                      context.probe.capabilities.manualProxy
                    }
                    pool={
                      !!connection?.capabilities.proxyPlugin &&
                      context.probe.capabilities.proxyPlugin
                    }
                    onChange={(proxyId) => patch({ proxyId })}
                  />
                </div>
                {connection?.providerId === 'shardbrowser' ? (
                  <SelectField
                    label="ShardBrowser 指纹"
                    value={fields.fingerprintId}
                    options={[
                      ...(fields.templateId
                        ? [{ value: '', label: '使用配置模板中的指纹' }]
                        : []),
                      ...context.fingerprints.map((entry) => ({
                        value: entry.id,
                        label: entry.label,
                        hint: entry.gpu,
                      })),
                    ]}
                    onChange={(fingerprintId) => patch({ fingerprintId })}
                  />
                ) : null}
                {connection?.providerId === 'aliasmode' ? (
                  <SelectField
                    label="AliasMode 引擎"
                    value={fields.aliasEngine}
                    options={[
                      { value: 'chromium', label: 'Chromium' },
                      { value: 'firefox', label: 'Firefox' },
                    ]}
                    onChange={(aliasEngine) =>
                      patch({ aliasEngine, kernelVersion: '__latest' })
                    }
                  />
                ) : null}
                {connection?.providerId === 'cloakbrowser' ||
                connection?.providerId === 'shardbrowser' ||
                connection?.providerId === 'aliasmode' ? (
                  <SelectField
                    label="内核版本"
                    value={fields.kernelVersion}
                    options={[
                      ...(connection.providerId !== 'shardbrowser'
                        ? [{ value: '__latest', label: '最新稳定版' }]
                        : []),
                      ...(connection.providerId === 'aliasmode'
                        ? context.aliasKernels[fields.aliasEngine]
                        : context.kernels
                      ).map((version) => ({ value: version, label: version })),
                    ]}
                    onChange={(kernelVersion) => patch({ kernelVersion })}
                  />
                ) : connection?.providerId === 'bitbrowser' &&
                  context.probe.capabilities.kernelSelection ? (
                  <Input
                    label="厂商内核版本"
                    inputSize="xsmall"
                    placeholder="留空由厂商选择"
                    value={fields.kernelVersion}
                    onChange={(event) => patch({ kernelVersion: event.target.value })}
                  />
                ) : null}
                {context.warning ? (
                  <p className="m-0 text-help text-warning-text">{context.warning}</p>
                ) : null}
                <Input
                  label="备注"
                  inputSize="xsmall"
                  maxLength={120}
                  value={fields.note}
                  onChange={(event) => patch({ note: event.target.value })}
                />
                {connection?.capabilities.geoip && context.probe.capabilities.geoip ? (
                  <Checkbox
                    label="根据代理出口匹配地区"
                    checked={fields.geoip}
                    onCheckedChange={(geoip) => patch({ geoip })}
                  />
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="时区"
                    inputSize="xsmall"
                    placeholder="自动"
                    value={fields.timezone}
                    onChange={(event) => patch({ timezone: event.target.value })}
                  />
                  <Input
                    label="浏览器语言"
                    inputSize="xsmall"
                    placeholder="自动"
                    value={fields.locale}
                    onChange={(event) => patch({ locale: event.target.value })}
                  />
                </div>
                <SelectField
                  label="窗口尺寸"
                  value={fields.viewport}
                  options={[
                    { value: 'default', label: '默认' },
                    { value: '1440x900', label: '1440 × 900' },
                    { value: '1920x1080', label: '1920 × 1080' },
                  ]}
                  onChange={(viewport) => patch({ viewport })}
                />
                <Input
                  label="起始地址"
                  inputSize="xsmall"
                  inputMode="url"
                  value={fields.startUrl}
                  onChange={(event) => patch({ startUrl: event.target.value })}
                />
                <p className="m-0 text-help text-text-sub-600">
                  每个目标创建一个
                  Profile，使用同一公共配置。已确认的创建与关联结果会逐项保留。
                </p>
              </>
            ) : null}
          </fieldset>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-secondary" aria-label="批量创建结果">
              <thead>
                <tr className="border-b border-stroke-soft-200">
                  <th className="p-2">重试</th>
                  <th className="p-2">目标</th>
                  <th className="p-2">Profile</th>
                  <th className="p-2">状态</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.targetId}
                    className="border-b border-stroke-soft-200 align-top"
                  >
                    <td className="p-2">
                      <Checkbox
                        aria-label={`选择 ${item.targetName} 的未完成项`}
                        disabled={busy || item.status === 'complete'}
                        checked={selected.has(item.targetId)}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current)
                            if (checked) next.add(item.targetId)
                            else next.delete(item.targetId)
                            return next
                          })
                        }
                      />
                    </td>
                    <td className="max-w-40 break-words p-2">{item.targetName}</td>
                    <td className="max-w-48 break-words p-2">
                      {item.name}
                      {item.profileId ? (
                        <span className="block text-help text-text-soft-400">
                          {item.profileId}
                        </span>
                      ) : null}
                    </td>
                    <td className="max-w-56 break-words p-2">
                      <span>{statuses[item.status]}</span>
                      {item.error ? (
                        <p className="m-0 mt-1 text-help text-error-text">{item.error}</p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {refreshError ? (
          <p className="m-0 text-help text-error-text" role="alert">
            {refreshError}
          </p>
        ) : null}
      </div>
    </DialogModal>
  )
}
