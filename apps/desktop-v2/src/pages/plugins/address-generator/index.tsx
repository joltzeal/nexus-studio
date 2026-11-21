import { useEffect, useState } from 'react'
import {
  Alert,
  AlertModal,
  Button,
  DataList,
  EmptyState,
  Modal,
  SegmentControl,
  Select,
  type DataListColumn,
} from '@proxyshard/shardx-ui-kit'
import { PageHeader } from '../../../widgets/PageHeader'
import { PluginFilterRow, PluginSearch } from '../PluginFilterRow'
import { PluginWorkspace } from '../PluginWorkspace'
import { ListColumn } from '../../../shared/ui/ListColumn'
import { CopyIcon, DeleteIcon, RefreshIcon, SyncIcon } from '../../../shared/icons'
import { PluginRowAction } from '../PluginRowAction'
import { clip } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import {
  addressApi,
  googleMapsKey,
} from '../../../raccoon/plugins/address-generator/client'
import {
  supportsAddressFeature,
  supportsAddressPage,
} from '../../../raccoon/plugins/address-generator/page-contract'
import {
  ADDRESS_PLUGIN_ID,
  addressKey,
  addressText,
  type Catalog,
  type Profile,
  type SavedPage,
  type SavedProfile,
} from '../../../raccoon/plugins/address-generator/model'
import type { PickState } from '../../../raccoon/plugins/address-generator/picker-session'
import { usePluginTask } from '../usePluginTask'
import { AddressDetails } from './AddressDetails'
import { LinkAccountDialog } from './LinkAccountDialog'
import { MapCanvas } from './MapCanvas'
import { LabelExtractor } from './LabelExtractor'
import { HelperTools } from './HelperTools'
import { supportsLabelExtraction } from '../../../raccoon/plugins/address-generator/labels'

export function AddressGeneratorPage({ onManage }: { onManage: () => void }) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === ADDRESS_PLUGIN_ID),
  )
  const accounts = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === 'studio.vinted-accounts'),
  )
  const compatible = isNativeRaccoon() && supportsAddressPage(plugin)
  const canSave = supportsAddressFeature(plugin, 'saved')
  const canLink =
    canSave &&
    !!accounts &&
    accounts.enabled &&
    accounts.state === 'running' &&
    accounts.capabilities.includes('account.pool') &&
    accounts.granted.includes('account.pool') &&
    ['vinted.accounts.address.targets', 'vinted.accounts.address.set'].every((method) =>
      accounts.methods.includes(method),
    )
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [durable, setDurable] = useState(true)
  const [cityId, setCityId] = useState('')
  const [tab, setTab] = useState('map')
  const [picked, setPicked] = useState<PickState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadEpoch, setLoadEpoch] = useState(0)
  const [listEpoch, setListEpoch] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [linking, setLinking] = useState<Profile | null>(null)
  const [inspecting, setInspecting] = useState<SavedProfile | null>(null)
  const [removing, setRemoving] = useState<SavedProfile | null>(null)
  const [saved, setSaved] = useState<SavedPage | null>(null)
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [exportPath, setExportPath] = useState<string | null>(null)
  const task = usePluginTask()

  useEffect(() => {
    if (!compatible) return
    let alive = true
    setLoading(true)
    setError(null)
    void addressApi
      .catalog()
      .then(
        (catalog) => {
          if (!alive) return
          setCatalog(catalog)
          setCityId((current) =>
            catalog.cities.some((city) => city.id === current)
              ? current
              : catalog.cities[0]!.id,
          )
        },
        (cause) => {
          if (alive)
            setError(cause instanceof Error ? cause.message : '地址插件初始化失败')
        },
      )
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [compatible, loadEpoch])
  useEffect(() => {
    if (!compatible || !canSave || tab !== 'saved') return
    let alive = true
    setListStatus('loading')
    setError(null)
    setSelected(new Set())
    void addressApi.list(query, page).then(
      (result) => {
        if (!alive) return
        setSaved(result)
        setPage(result.page)
        setListStatus('ready')
      },
      (cause) => {
        if (alive) {
          setError(cause instanceof Error ? cause.message : '保存列表读取失败')
          setListStatus('error')
        }
      },
    )
    return () => {
      alive = false
    }
  }, [compatible, canSave, tab, query, page, listEpoch])

  async function run(action: (active: () => boolean) => Promise<void>) {
    if (!compatible || !task.acquire()) return
    const token = task.begin()
    const active = () => task.current(token)
    setBusy(true)
    setError(null)
    try {
      await action(active)
    } catch (cause) {
      if (active()) setError(cause instanceof Error ? cause.message : '地址操作失败')
    } finally {
      task.release()
      if (active()) setBusy(false)
    }
  }
  function remember(item: SavedProfile, durable: boolean) {
    setPicked((current) =>
      current?.profile && addressKey(current.profile) === addressKey(item)
        ? { status: 'ready', profile: item, error: null }
        : current,
    )
    setDurable(durable)
    setListEpoch((value) => value + 1)
  }
  function copy(profile: Profile) {
    void run(async (active) => {
      await clip.write(addressText(profile))
      if (active()) toast.ok('地址已复制')
    })
  }
  const city = catalog?.cities.find((city) => city.id === cityId)
  const profile = picked?.profile ?? null
  const selectedItems = saved?.items.filter((item) => selected.has(item.id)) ?? []
  const columns: DataListColumn<SavedProfile>[] = [
    {
      id: 'address',
      header: '地址',
      width: 'minmax(0,2fr)',
      cell: (item) => (
        <div className="min-w-0">
          <div className="truncate font-medium">
            {item.houseNumber} {item.street}
          </div>
          <div className="truncate text-help text-text-soft-400">
            {item.postalCode} · {item.city}
            {item.state ? `, ${item.state}` : ''} · {item.countryCode}
          </div>
        </div>
      ),
    },
    {
      id: 'identity',
      header: '资料',
      width: 'minmax(0,1fr)',
      cell: (item) => (
        <div className="min-w-0">
          <div className="truncate">
            {item.firstName} {item.lastName}
          </div>
          <div className="truncate text-help text-text-soft-400">{item.username}</div>
        </div>
      ),
    },
    {
      id: 'precision',
      header: '精度',
      width: 'minmax(0,0.6fr)',
      cell: (item) => (item.approximate ? '近似位置' : '建筑物'),
    },
  ]
  return (
    <>
      <PageHeader title="VInted helper" />
      <PluginWorkspace>
        {!compatible ? (
          <EmptyState
            title={
              isNativeRaccoon()
                ? 'VInted helper 尚不可用'
                : '请在桌面应用中使用 VInted helper'
            }
            hint="请安装、启用并授权 VInted helper；普通网页预览不调用插件或保存业务数据"
            action={{ label: '管理插件', onClick: onManage }}
          />
        ) : (
          <HelperTools
            labels={
              supportsLabelExtraction(plugin) ? (
                <LabelExtractor
                  key={JSON.stringify([
                    plugin?.installation,
                    plugin?.runtimeGeneration,
                    plugin?.version,
                  ])}
                />
              ) : (
                <EmptyState
                  title="面单提取接口尚不可用"
                  hint="请更新并重新启动 VInted helper"
                  action={{ label: '管理插件', onClick: onManage }}
                />
              )
            }
            address={
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
                  <SegmentControl
                    semantics="tabs"
                    fit
                    size="xsmall"
                    aria-label="地址工具"
                    value={tab}
                    onChange={(value) => {
                      if (!busy) setTab(value)
                    }}
                    items={[
                      { value: 'map', label: '地图选点' },
                      {
                        value: 'saved',
                        label: '已保存地址',
                        ...(saved ? { count: saved.total } : {}),
                      },
                    ]}
                  />
                </div>
                {error && (
                  <Alert status="error" variant="lighter" onClose={() => setError(null)}>
                    {error}
                  </Alert>
                )}
                {(!durable ||
                  plugin?.storageDurable === false ||
                  (tab === 'saved' && saved?.storageDurable === false)) && (
                  <Alert status="warning" variant="lighter">
                    插件正在使用内存存储，地址在退出后会丢失
                  </Alert>
                )}
                {loading ? (
                  <p role="status" className="text-body text-text-sub-600">
                    正在读取地址插件…
                  </p>
                ) : !catalog ? (
                  <EmptyState
                    title="地址插件读取失败"
                    action={{
                      label: '重新读取',
                      onClick: () => setLoadEpoch((value) => value + 1),
                    }}
                  />
                ) : tab === 'map' ? (
                  <>
                    <PluginFilterRow label="地图定位条件">
                      <Select
                        className="w-[128px]!"
                        size="xsmall"
                        label="国家"
                        value={city?.country}
                        disabled={busy}
                        onChange={(country) => {
                          const first = catalog.cities.find(
                            (city) => city.country === country,
                          )
                          if (first) {
                            setCityId(first.id)
                            setPicked(null)
                          }
                        }}
                        options={catalog.countries.map((country) => ({
                          value: country.code,
                          label: country.label,
                        }))}
                      />
                      <Select
                        className="min-w-[176px] flex-1"
                        size="xsmall"
                        label="地图定位城市"
                        isSearchable
                        value={cityId}
                        disabled={busy}
                        onChange={(id) => {
                          setCityId(id)
                          setPicked(null)
                        }}
                        options={catalog.cities
                          .filter((item) => item.country === city?.country)
                          .map((city) => ({ value: city.id, label: city.name }))}
                      />
                    </PluginFilterRow>
                    {!googleMapsKey ? (
                      <EmptyState
                        title="当前应用尚未配置地图服务"
                        hint="请联系应用维护者提供已配置地图的版本。已保存地址仍可查看、复制和导出。"
                      />
                    ) : (
                      city && (
                        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto lg:flex-row">
                          <MapCanvas
                            apiKey={googleMapsKey}
                            city={city}
                            busy={busy}
                            prepare={addressApi.profile}
                            onPick={setPicked}
                          />
                          <aside
                            className="flex min-h-0 shrink-0 flex-col gap-4 lg:w-[320px]"
                            aria-label="选点资料"
                          >
                            <div className="flex shrink-0 items-center justify-between gap-3">
                              <h2 className="m-0 text-panel-title text-text-strong-950">
                                选点资料
                              </h2>
                              <span className="text-help text-text-soft-400">
                                {profile && 'savedAt' in profile
                                  ? '已保存'
                                  : profile
                                    ? '尚未保存'
                                    : ''}
                              </span>
                            </div>
                            {picked?.status === 'loading' ? (
                              <p
                                className="m-0 text-secondary text-text-sub-600"
                                role="status"
                              >
                                正在解析地址并生成资料…
                              </p>
                            ) : picked?.error ? (
                              <Alert status="warning" variant="lighter">
                                {picked.error}
                              </Alert>
                            ) : profile ? (
                              <>
                                <div className="min-h-0 flex-1 overflow-y-auto">
                                  <AddressDetails profile={profile} />
                                </div>
                                <div className="flex shrink-0 flex-col gap-3">
                                  <div className="flex flex-wrap gap-2">
                                    <Button
                                      size="xsmall"
                                      disabled={busy || !canSave || 'savedAt' in profile}
                                      onClick={() =>
                                        void run(async (active) => {
                                          const result = await addressApi.save(profile)
                                          if (active()) {
                                            remember(result.item, result.storageDurable)
                                            toast.ok(
                                              result.created
                                                ? '地址已保存'
                                                : '该地址已保存，沿用原资料',
                                            )
                                          }
                                        })
                                      }
                                    >
                                      保存地址
                                    </Button>
                                    <Button
                                      size="xsmall"
                                      mode="stroke"
                                      variant="neutral"
                                      disabled={busy}
                                      onClick={() => copy(profile)}
                                    >
                                      复制地址
                                    </Button>
                                    <Button
                                      size="xsmall"
                                      mode="ghost"
                                      variant="neutral"
                                      disabled={busy || !canLink}
                                      onClick={() => setLinking(profile)}
                                    >
                                      关联账号
                                    </Button>
                                  </div>
                                  {!canSave && (
                                    <p className="m-0 text-help text-text-soft-400">
                                      更新插件后可保存地址
                                    </p>
                                  )}
                                  {!canLink && (
                                    <p className="m-0 text-help text-text-soft-400">
                                      启用并授权支持地址关联的 Vinted 账号池后可关联账号
                                    </p>
                                  )}
                                </div>
                              </>
                            ) : (
                              <p className="m-0 text-secondary leading-relaxed text-text-soft-400">
                                放大地图后点击建筑物。解析到当前国家的门牌、街道、城市和邮编后，资料会显示在这里。
                              </p>
                            )}
                          </aside>
                        </div>
                      )
                    )}
                  </>
                ) : !canSave ? (
                  <EmptyState
                    title="当前插件不支持保存列表"
                    hint="更新地址插件后可查看与管理已保存地址"
                    action={{ label: '管理插件', onClick: onManage }}
                  />
                ) : (
                  <>
                    <PluginFilterRow label="已保存地址筛选">
                      <PluginSearch
                        pageShortcut
                        label="搜索地址"
                        aria-label="搜索已保存地址"
                        placeholder="搜索姓名、街道或城市"
                        value={query}
                        disabled={busy}
                        onChange={(event) => {
                          setQuery(event.target.value)
                          setPage(1)
                        }}
                      />
                      <Button
                        size="xsmall"
                        mode="stroke"
                        variant="neutral"
                        leftIcon={<RefreshIcon className="size-3.5" />}
                        disabled={busy}
                        onClick={() => setListEpoch((value) => value + 1)}
                      >
                        刷新
                      </Button>
                    </PluginFilterRow>
                    {selectedItems.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="xsmall"
                          mode="stroke"
                          variant="neutral"
                          disabled={
                            busy ||
                            !selectedItems.length ||
                            listStatus !== 'ready' ||
                            !supportsAddressFeature(plugin, 'csv')
                          }
                          onClick={() =>
                            void run(async (active) => {
                              const csv = await addressApi.csv(selectedItems)
                              if (!active()) return
                              await clip.write(csv)
                              if (active()) toast.ok('CSV 已复制')
                            })
                          }
                        >
                          复制 CSV
                          {selectedItems.length ? ` · ${selectedItems.length}` : ''}
                        </Button>
                        <Button
                          size="xsmall"
                          mode="ghost"
                          variant="neutral"
                          disabled={
                            busy ||
                            !selectedItems.length ||
                            listStatus !== 'ready' ||
                            !supportsAddressFeature(plugin, 'export') ||
                            !saved?.storageDurable
                          }
                          onClick={() =>
                            void run(async (active) => {
                              const path = await addressApi.export(selectedItems)
                              if (active()) setExportPath(path)
                            })
                          }
                        >
                          写入 CSV 文件
                        </Button>
                      </div>
                    )}
                    {exportPath && (
                      <Alert
                        status="information"
                        variant="lighter"
                        onClose={() => setExportPath(null)}
                      >
                        CSV 已写入插件私有目录：
                        <span className="break-all">{exportPath}</span>
                      </Alert>
                    )}
                    <ListColumn>
                      <DataList<SavedProfile>
                        aria-label="已保存地址"
                        items={saved?.items ?? []}
                        columns={columns}
                        getId={(item) => item.id}
                        getName={(item) => `${item.houseNumber} ${item.street}`}
                        selected={selected}
                        onSelectedChange={setSelected}
                        status={listStatus}
                        rowHeight={60}
                        labels={{
                          selectAll: '选择本页地址',
                          select: (name) => `选择 ${name}`,
                          more: '更多地址操作',
                          actions: '操作',
                        }}
                        empty={
                          <EmptyState
                            title="没有已保存地址"
                            hint="在地图上选取地址后，点击保存地址"
                          />
                        }
                        error={
                          <EmptyState
                            title="地址列表读取失败"
                            action={{
                              label: '重试',
                              onClick: () => setListEpoch((value) => value + 1),
                            }}
                          />
                        }
                        onOpen={(item) => {
                          if (!busy) setInspecting(item)
                        }}
                        rowActions={(item) => (
                          <>
                            <PluginRowAction
                              label="复制地址"
                              icon={<CopyIcon className="size-3.5" />}
                              disabled={busy}
                              onClick={() => copy(item)}
                            />
                            <PluginRowAction
                              label="关联 Vinted 账号"
                              icon={<SyncIcon className="size-3.5" />}
                              disabled={busy || !canLink}
                              onClick={() => setLinking(item)}
                            />
                            <PluginRowAction
                              label="移除已保存地址"
                              icon={<DeleteIcon className="size-3.5" />}
                              variant="error"
                              disabled={busy}
                              onClick={() => setRemoving(item)}
                            />
                          </>
                        )}
                      />
                    </ListColumn>
                    <div className="flex items-center justify-between gap-3 text-secondary text-text-soft-400">
                      <span className="tabular-nums">
                        共 {saved?.total ?? 0} 条 · 第 {saved?.page ?? page} 页
                      </span>
                      <div className="flex gap-2">
                        <Button
                          size="xsmall"
                          mode="ghost"
                          variant="neutral"
                          disabled={busy || listStatus !== 'ready' || page <= 1}
                          onClick={() => setPage(page - 1)}
                        >
                          上一页
                        </Button>
                        <Button
                          size="xsmall"
                          mode="ghost"
                          variant="neutral"
                          disabled={
                            busy ||
                            listStatus !== 'ready' ||
                            page * 20 >= (saved?.total ?? 0)
                          }
                          onClick={() => setPage(page + 1)}
                        >
                          下一页
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            }
          />
        )}
      </PluginWorkspace>
      {linking && canLink && (
        <LinkAccountDialog
          profile={linking}
          onSaved={remember}
          onClose={() => setLinking(null)}
        />
      )}
      <Modal
        open={!!inspecting}
        onOpenChange={(open) => {
          if (!open) setInspecting(null)
        }}
        title="地址资料"
        size="md"
        footer={
          <Button size="xsmall" onClick={() => setInspecting(null)}>
            关闭
          </Button>
        }
      >
        {inspecting && (
          <AddressDetails profile={inspecting}>
            <Button
              className="self-start"
              size="xsmall"
              mode="stroke"
              variant="neutral"
              disabled={busy}
              onClick={() => copy(inspecting)}
            >
              复制地址
            </Button>
          </AddressDetails>
        )}
      </Modal>
      <AlertModal
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
        status="warning"
        title="移除已保存地址"
        description="仅从地址列表移除；账号池中已经关联的地址快照会保留"
        confirmLabel="移除"
        isLoading={busy}
        onCancel={() => {
          if (!busy) setRemoving(null)
        }}
        onConfirm={() => {
          if (removing)
            void run(async (active) => {
              const result = await addressApi.remove(removing.id)
              if (active()) {
                setRemoving(null)
                setListEpoch((value) => value + 1)
                toast.ok(result.removed ? '地址已移除' : '该地址已不在保存列表')
              }
            })
        }}
      />
    </>
  )
}
