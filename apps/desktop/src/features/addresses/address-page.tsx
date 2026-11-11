import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Copy,
  Download,
  Loader2,
  MapPin,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Dialog } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import {
  listPlugins,
  pluginHostAvailable,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { PluginGate } from '@/features/plugins/plugin-gate'
import { AddressCard } from './address-card'
import { AddressMap } from './address-map'
import { AddressSettingsSheet } from './address-settings-sheet'
import { LinkAddressAccountDialog } from './link-account-dialog'
import { SavedAddressesPanel } from './saved-addresses-panel'
import {
  csvOf,
  exportCsv,
  generateProfiles,
  getCatalog,
  getMapsConfig,
  profileFromPick,
  saveAddress,
} from './api'
import {
  ADDRESS_PLUGIN_ID,
  MAX_RESULTS,
  addressKey,
  message,
  profileText,
  profileData,
  type AddressCatalog,
  type AddressRecord,
  type MapsConfig,
  type Profile,
} from './types'

type Mode = 'public' | 'map'

const COPY_FAILED = '复制失败，请检查剪贴板权限后重试。'

export interface AddressPageProps {
  plugin: PluginView | null
  hostAvailable: boolean
}

export function AddressPage({ plugin, hostAvailable }: AddressPageProps) {
  const [catalog, setCatalog] = useState<AddressCatalog | null>(null)
  const [config, setConfig] = useState<MapsConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [country, setCountry] = useState('FR')
  const [cityId, setCityId] = useState('paris')
  const [count, setCount] = useState('5')
  const [mode, setMode] = useState<Mode>('public')
  const [items, setItems] = useState<Profile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [linking, setLinking] = useState<Profile | null>(null)
  const [resultTab, setResultTab] = useState('generated')
  const [savedRevision, setSavedRevision] = useState(0)
  const [savedKeys, setSavedKeys] = useState<Set<string>>(() => new Set())

  const running = plugin !== null && plugin.state === 'running'
  const supportsSaved = plugin?.methods.includes('address.saved.list') === true

  useEffect(() => {
    if (!running) return
    let active = true
    void Promise.all([getCatalog(), getMapsConfig()]).then(
      ([loadedCatalog, loadedConfig]) => {
        if (!active) return
        setCatalog(loadedCatalog)
        setConfig(loadedConfig)
        const first = loadedCatalog.cities.find((city) => city.country === 'FR')
        if (first !== undefined) setCityId(first.id)
      },
      (cause: unknown) => {
        if (active) setLoadError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [running])

  const countryOptions = useMemo(
    () =>
      (catalog?.countries ?? []).map((entry) => ({
        value: entry.code,
        label: entry.label,
      })),
    [catalog],
  )
  const cityOptions = useMemo(
    () =>
      (catalog?.cities ?? [])
        .filter((city) => city.country === country)
        .map((city) => ({ value: city.id, label: city.name })),
    [catalog, country],
  )
  const city = catalog?.cities.find((entry) => entry.id === cityId) ?? null
  const requested = Number(count)
  const validCount =
    Number.isInteger(requested) && requested >= 1 && requested <= MAX_RESULTS

  function changeCountry(next: string) {
    setCountry(next)
    const first = catalog?.cities.find((entry) => entry.country === next)
    setCityId(first?.id ?? '')
    setError(null)
    setNotice(null)
  }

  async function generate() {
    if (busy || !validCount) return
    setBusy(true)
    setError(null)
    setNotice(null)
    setExportedPath(null)
    try {
      const result = await generateProfiles(country, cityId, requested)
      setItems(result.items)
      setResultTab('generated')
      if (result.found < result.requested) {
        setNotice(`该区域仅找到 ${result.found} 条完整且不重复的地址。`)
      } else if (result.cached) {
        setNotice('这批地址来自 15 分钟缓存；同一城市短时间内重复生成会得到同一批候选。')
      }
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  const prepare = useCallback(async (address: AddressRecord): Promise<Profile | null> => {
    try {
      const result = await profileFromPick(address)
      return result.item
    } catch (cause) {
      setError(message(cause))
      return null
    }
  }, [])

  async function addPick(profile: Profile) {
    if (busy) return
    setError(null)
    setNotice(null)
    if (items.length >= MAX_RESULTS) {
      setError(`最多保留 ${MAX_RESULTS} 条结果，请先清空或删除部分地址。`)
      return
    }
    if (items.some((entry) => addressKey(entry) === addressKey(profile))) {
      setError('这个地址已经在结果里。')
      return
    }
    setBusy(true)
    try {
      const saved = await saveAddress(profile)
      setItems((current) => [...current, profileData(saved.item)])
      setSavedKeys((current) => new Set(current).add(addressKey(saved.item)))
      setSavedRevision((value) => value + 1)
      setResultTab('generated')
      toast.success(
        saved.storageDurable ? '选点地址已保存' : '选点地址已添加，本次仅在内存中保存',
      )
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  async function persistProfile(profile: Profile) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const saved = await saveAddress(profile)
      setItems((current) =>
        current.map((item) => (item.id === profile.id ? profileData(saved.item) : item)),
      )
      setSavedKeys((current) => new Set(current).add(addressKey(saved.item)))
      setSavedRevision((value) => value + 1)
      toast.success(saved.storageDurable ? '地址已保存' : '地址本次仅在内存中保存')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  async function copy(text: string) {
    if (await copyText(text)) {
      setError(null)
      toast.success('已复制')
    } else {
      setError(COPY_FAILED)
      toast.error(COPY_FAILED)
    }
  }

  async function copyCsv() {
    try {
      const result = await csvOf(items)
      await copy(result.text)
    } catch (cause) {
      setError(message(cause))
    }
  }

  async function writeCsv() {
    setError(null)
    setNotice(null)
    try {
      const result = await exportCsv(items)
      setExportedPath(result.path)
      setNotice(`已写入 ${result.count} 条到插件私有目录。`)
    } catch (cause) {
      setError(message(cause))
    }
  }

  function remove(id: string) {
    setItems((current) => current.filter((entry) => entry.id !== id))
    setNotice(null)
    setExportedPath(null)
  }

  if (!running) {
    return (
      <PageHeader>
        <PluginGate label="地址生成器" plugin={plugin} hostAvailable={hostAvailable} />
      </PageHeader>
    )
  }

  return (
    <section className="collection-page page-reveal" aria-labelledby="addresses-heading">
      <div className="section-intro">
        <div>
          <h1 className="page-heading" id="addresses-heading">
            地址生成器
          </h1>
          <p className="page-description">
            从 OpenStreetMap 公开地址生成收货资料，或在 Google 地图上选点。
            选定的地址可保存，并关联到账号池中的账号。
          </p>
        </div>
        <div className="section-actions">
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings2 data-icon="inline-start" />
            地图 Key
          </Button>
        </div>
      </div>

      <div className="address-toolbar">
        <Field className="address-control">
          <FieldLabel htmlFor="address-country">国家</FieldLabel>
          <LabeledSelect
            id="address-country"
            ariaLabel="国家"
            value={country}
            options={countryOptions}
            disabled={busy || catalog === null}
            onValueChange={changeCountry}
          />
        </Field>
        <Field className="address-control">
          <FieldLabel htmlFor="address-city">城市</FieldLabel>
          <LabeledSelect
            id="address-city"
            ariaLabel="城市"
            value={cityId}
            options={cityOptions}
            disabled={busy || catalog === null || cityOptions.length === 0}
            onValueChange={(value) => {
              setCityId(value)
              setError(null)
              setNotice(null)
            }}
          />
        </Field>
        <Field className="address-control address-control-count">
          <FieldLabel htmlFor="address-count">生成数量</FieldLabel>
          <Input
            id="address-count"
            type="number"
            min={1}
            max={MAX_RESULTS}
            disabled={busy}
            aria-invalid={!validCount}
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </Field>
        <ToggleGroup
          type="single"
          className="address-mode"
          aria-label="地址来源"
          value={mode}
          onValueChange={(value) => {
            if (value === 'public' || value === 'map') setMode(value)
          }}
        >
          <ToggleGroupItem value="public">公开地址</ToggleGroupItem>
          <ToggleGroupItem value="map">
            <MapPin aria-hidden="true" />
            地图选点
          </ToggleGroupItem>
        </ToggleGroup>
        {mode === 'public' ? (
          <Button
            disabled={busy || !validCount || catalog === null}
            aria-busy={busy}
            onClick={() => void generate()}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            {busy ? '正在获取地址…' : '生成地址'}
          </Button>
        ) : null}
      </div>

      {loadError === null ? null : <FieldError role="alert">{loadError}</FieldError>}

      {mode === 'public' ? (
        <div className="address-source-note">
          <p className="address-hint">
            每次最多 {MAX_RESULTS} 条，生成会替换当前结果；重复生成优先使用 15
            分钟缓存。美国城市的 OSM 门牌覆盖较薄，返回条数可能少于请求数量。
          </p>
          <p className="address-hint">
            地址数据来自{' '}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
            >
              © OpenStreetMap 贡献者 · ODbL
            </a>
            。
          </p>
        </div>
      ) : (
        <div className="address-map-panel">
          {config === null ? (
            <p className="address-hint" role="status">
              正在读取地图配置…
            </p>
          ) : config.hasApiKey && config.apiKey !== null ? (
            city === null ? (
              <p className="address-hint" role="status">
                正在读取城市列表…
              </p>
            ) : (
              <AddressMap
                apiKey={config.apiKey}
                city={city}
                busy={busy}
                onPrepare={prepare}
                onAdd={(profile) => void addPick(profile)}
                onCopied={(ok) => {
                  if (ok) {
                    setError(null)
                    toast.success('已复制')
                  } else {
                    setError(COPY_FAILED)
                    toast.error(COPY_FAILED)
                  }
                }}
              />
            )
          ) : (
            <div className="address-map-missing">
              <p className="address-hint">
                还没有保存 Google Maps Key，地图选点不可用。公开地址生成不需要 Key。
              </p>
              <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                填写地图 Key
              </Button>
            </div>
          )}
        </div>
      )}

      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      {notice === null ? null : (
        <p className="address-notice" role="status">
          {notice}
          {exportedPath === null ? null : (
            <Button variant="link" size="sm" onClick={() => void copy(exportedPath)}>
              复制文件路径
            </Button>
          )}
        </p>
      )}

      <Tabs value={resultTab} onValueChange={setResultTab} className="min-w-0">
        <TabsList aria-label="地址列表">
          <TabsTrigger value="generated">生成结果</TabsTrigger>
          <TabsTrigger value="saved" disabled={!supportsSaved}>
            已保存地址
          </TabsTrigger>
        </TabsList>
        {!supportsSaved ? (
          <p className="address-hint">
            请在插件中心更新地址生成器，以保存地址并关联账号。
          </p>
        ) : null}
        <TabsContent value="generated">
          <section className="address-results" aria-busy={busy} aria-label="生成结果">
            <div className="address-results-head">
              <span>
                生成结果 <span className="address-muted">({items.length})</span>
              </span>
              <div className="address-results-actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={items.length === 0}
                  onClick={() => void copy(items.map(profileText).join('\n\n'))}
                >
                  <Copy data-icon="inline-start" />
                  复制全部
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={items.length === 0}
                  onClick={() => void copyCsv()}
                >
                  <Copy data-icon="inline-start" />
                  复制 CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={items.length === 0}
                  onClick={() => void writeCsv()}
                >
                  <Download data-icon="inline-start" />
                  写入 CSV 文件
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={items.length === 0 || busy}
                  onClick={() => {
                    setItems([])
                    setNotice(null)
                    setError(null)
                    setExportedPath(null)
                  }}
                >
                  <Trash2 data-icon="inline-start" />
                  清空结果
                </Button>
              </div>
            </div>
            {items.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>还没有结果</EmptyTitle>
                  <EmptyDescription>
                    选择国家和城市后点「生成地址」，或切换到「地图选点」逐个添加。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="address-grid">
                {items.map((profile) => (
                  <AddressCard
                    key={profile.id}
                    profile={profile}
                    busy={busy}
                    saved={savedKeys.has(addressKey(profile))}
                    onCopy={(text) => void copy(text)}
                    onDelete={remove}
                    {...(supportsSaved
                      ? {
                          onSave: (item: Profile) => void persistProfile(item),
                          onLink: setLinking,
                        }
                      : {})}
                  />
                ))}
              </div>
            )}
          </section>
        </TabsContent>
        <TabsContent value="saved">
          <SavedAddressesPanel
            refreshToken={savedRevision}
            onCopy={(text) => void copy(text)}
            onLink={setLinking}
            onRemoved={(profile) =>
              setSavedKeys((current) => {
                const next = new Set(current)
                next.delete(addressKey(profile))
                return next
              })
            }
          />
        </TabsContent>
      </Tabs>

      <Dialog
        open={linking !== null}
        onOpenChange={(open) => {
          if (!open) setLinking(null)
        }}
      >
        {linking ? (
          <LinkAddressAccountDialog
            profile={linking}
            onClose={() => setLinking(null)}
            onSaved={(saved) => {
              setItems((current) =>
                current.map((item) =>
                  addressKey(item) === addressKey(saved) ? saved : item,
                ),
              )
              setSavedKeys((current) => new Set(current).add(addressKey(saved)))
              setSavedRevision((value) => value + 1)
            }}
          />
        ) : null}
      </Dialog>

      {settingsOpen ? (
        <AddressSettingsSheet
          config={config ?? { hasApiKey: false, apiKey: null, storageDurable: true }}
          onOpenChange={setSettingsOpen}
          onSaved={(saved) => {
            setConfig(saved)
            toast.success('地图 Key 已保存')
            setError(null)
          }}
        />
      ) : null}
    </section>
  )
}

function PageHeader({ children }: { children: ReactNode }) {
  return (
    <section className="collection-page page-reveal" aria-labelledby="addresses-heading">
      <div className="section-intro">
        <div>
          <h1 className="page-heading" id="addresses-heading">
            地址生成器
          </h1>
          <p className="page-description">
            从 OpenStreetMap 公开地址生成收货资料，或在 Google 地图上选点。
          </p>
        </div>
      </div>
      {children}
    </section>
  )
}

export function AddressGeneratorRoute() {
  const hostAvailable = pluginHostAvailable()
  const [plugin, setPlugin] = useState<PluginView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!hostAvailable) return
    try {
      const catalog = await listPlugins()
      setPlugin(catalog.find((entry) => entry.id === ADDRESS_PLUGIN_ID) ?? null)
    } catch (cause) {
      setError(message(cause))
    }
  }, [hostAvailable])

  useEffect(() => {
    if (!hostAvailable) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active) {
          setPlugin(catalog.find((entry) => entry.id === ADDRESS_PLUGIN_ID) ?? null)
        }
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [hostAvailable])

  // The host has no push channel: keep looking while the process is coming up.
  const pending = plugin === null || plugin.state !== 'running'
  useEffect(() => {
    if (!hostAvailable || !pending) return
    const timer = setInterval(() => {
      void refresh()
    }, 2000)
    return () => clearInterval(timer)
  }, [hostAvailable, pending, refresh])

  return (
    <>
      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      <AddressPage plugin={plugin} hostAvailable={hostAvailable} />
    </>
  )
}
