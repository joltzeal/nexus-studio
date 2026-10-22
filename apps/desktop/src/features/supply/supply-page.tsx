import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Camera, Copy, Download, Loader2, RefreshCw, Search, Store } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import {
  enablePlugin,
  listPlugins,
  pluginHostAvailable,
  restartPlugin,
  type PluginView,
} from '@/lib/platform/native-plugins'
import {
  favoritesCsv,
  getCatalog,
  imageSearch,
  listFavorites,
  listProducts,
  listStores,
  searchProducts,
} from './api'
import { ProductDialog } from './product-dialog'
import { Pager, ProductGrid, ProductViewToggle, type ProductView } from './product-grid'
import { checkImageFile, prepareJpeg } from './image-prepare'
import {
  SUPPLY_CAPABILITY,
  SUPPLY_PLUGIN_ID,
  merchantLocation,
  merchantTitle,
  message,
  type Category,
  type Favorite,
  type Merchant,
  type Product,
} from './types'

type Section = 'browse' | 'search' | 'image' | 'favorites'

const SECTIONS: { value: Section; label: string }[] = [
  { value: 'browse', label: '分类商户' },
  { value: 'search', label: '搜索商品' },
  { value: 'image', label: '以图搜图' },
  { value: 'favorites', label: '我的收藏' },
]

const COPY_FAILED = '复制失败，请检查剪贴板权限后重试。'

export interface SupplyPageProps {
  plugin: PluginView | null
  hostAvailable: boolean
  onEnable?: () => Promise<void>
}

/**
 * `null` means "not loaded yet", which the page shows as loading. Keeping it
 * apart from `[]` ("loaded, nothing there") is what makes the empty states
 * honest.
 */
export function SupplyPage({ plugin, hostAvailable, onEnable }: SupplyPageProps) {
  const running = plugin !== null && plugin.state === 'running'
  const [section, setSection] = useState<Section>('browse')
  const [view, setView] = useState<ProductView>('waterfall')
  const [categories, setCategories] = useState<Category[]>([])
  const [typeId, setTypeId] = useState('')
  const [merchants, setMerchants] = useState<Merchant[] | null>(null)
  const [merchantPage, setMerchantPage] = useState(0)
  const [merchantMore, setMerchantMore] = useState(false)
  const [merchantId, setMerchantId] = useState('')
  const [products, setProducts] = useState<Product[] | null>(null)
  const [productPage, setProductPage] = useState(0)
  const [productMore, setProductMore] = useState(false)
  const [draft, setDraft] = useState('')
  const [keyword, setKeyword] = useState('')
  const [searchPage, setSearchPage] = useState(0)
  const [searchRows, setSearchRows] = useState<Product[] | null>(null)
  const [searchMore, setSearchMore] = useState(false)
  const [searching, setSearching] = useState(false)
  const [imageRows, setImageRows] = useState<Product[] | null>(null)
  const [imageBusy, setImageBusy] = useState(false)
  const [favorites, setFavorites] = useState<Favorite[]>([])
  const [favoritesDurable, setFavoritesDurable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Product | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)

  const loadFavorites = useCallback(async () => {
    try {
      const result = await listFavorites()
      setFavorites(result.items)
      setFavoritesDurable(result.storageDurable)
    } catch (cause) {
      setError(message(cause))
    }
  }, [])

  // Catalogue and favourites load once the plugin process is ready.
  useEffect(() => {
    if (!running) return
    let active = true
    void getCatalog().then(
      (result) => {
        if (!active) return
        setCategories(result.categories)
        setTypeId((current) => current || (result.categories[0]?.id ?? ''))
        void listFavorites().then(
          (saved) => {
            if (!active) return
            setFavorites(saved.items)
            setFavoritesDurable(saved.storageDurable)
          },
          (cause: unknown) => {
            if (active) setError(message(cause))
          },
        )
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [running])

  // Merchants follow the selected category and page.
  useEffect(() => {
    if (!running || typeId === '') return
    let active = true
    void listStores(typeId, merchantPage).then(
      (result) => {
        if (!active) return
        setMerchants(result.items)
        setMerchantMore(result.hasMore)
        setMerchantId((current) =>
          result.items.some((entry) => entry.uid === current)
            ? current
            : (result.items[0]?.uid ?? ''),
        )
        setError(null)
      },
      (cause: unknown) => {
        if (!active) return
        setMerchants([])
        setMerchantMore(false)
        setMerchantId('')
        setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [running, typeId, merchantPage])

  // Products follow the selected merchant and page.
  useEffect(() => {
    if (!running || merchantId === '') return
    let active = true
    void listProducts(merchantId, productPage).then(
      (result) => {
        if (!active) return
        setProducts(result.items)
        setProductMore(result.hasMore)
        setError(null)
      },
      (cause: unknown) => {
        if (!active) return
        setProducts([])
        setProductMore(false)
        setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [running, merchantId, productPage])

  async function runSearch(page: number) {
    if (keyword === '') return
    setSearching(true)
    try {
      const result = await searchProducts(keyword, page)
      setSearchRows(result.items)
      setSearchMore(result.hasMore)
      setSearchPage(page)
      setError(null)
    } catch (cause) {
      setSearchRows([])
      setSearchMore(false)
      setError(message(cause))
    } finally {
      setSearching(false)
    }
  }

  async function runImageSearch(file: File) {
    const invalid = checkImageFile(file)
    if (invalid !== null) {
      setError(invalid)
      toast.error(invalid)
      return
    }
    setImageBusy(true)
    setError(null)
    try {
      const prepared = await prepareJpeg(file)
      const result = await imageSearch(prepared.base64)
      setImageRows(result.items)
      if (result.items.length === 0) toast.info('没有找到相似商品')
    } catch (cause) {
      setImageRows(null)
      setError(message(cause))
      toast.error(message(cause))
    } finally {
      setImageBusy(false)
    }
  }

  async function copy(text: string, what: string) {
    if (await copyText(text)) {
      toast.success(`已复制${what}`)
    } else {
      setError(COPY_FAILED)
      toast.error(COPY_FAILED)
    }
  }

  async function exportCsv() {
    try {
      const result = await favoritesCsv()
      await copy(result.text, `${result.count} 条收藏 CSV`)
    } catch (cause) {
      setError(message(cause))
      toast.error(message(cause))
    }
  }

  const favorite =
    selected === null
      ? null
      : (favorites.find((entry) => entry.id === selected.id) ?? null)
  const currentMerchant =
    (merchants ?? []).find((entry) => entry.uid === merchantId) ?? null
  const merchantsLoading = merchants === null
  const productsLoading = products === null && merchantId !== ''

  if (!hostAvailable) {
    return (
      <PageHeader>
        <p className="native-profiles-hint" role="status">
          共享货源由插件进程提供，只能在 Nexus 桌面应用中运行；网页预览没有插件宿主。
        </p>
      </PageHeader>
    )
  }

  if (plugin === null) {
    return (
      <PageHeader>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>共享货源插件尚未安装</EmptyTitle>
            <EmptyDescription>
              到插件中心安装并启用「共享货源」后，这里可以浏览商户商品与收藏。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageHeader>
    )
  }

  if (!running) {
    return (
      <PageHeader>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {plugin.state === 'failed' ? '插件进程启动失败' : '共享货源插件未启用'}
            </EmptyTitle>
            <EmptyDescription>
              {plugin.lastError ??
                (plugin.enabled
                  ? '插件已授权，但进程没有运行；浏览货源需要进程就绪。'
                  : `到插件中心启用并授予 ${SUPPLY_CAPABILITY} 能力后，这里可以浏览货源。`)}
            </EmptyDescription>
          </EmptyHeader>
          {plugin.enabled && onEnable ? (
            <Button
              onClick={() => {
                void onEnable()
              }}
            >
              重新启动插件进程
            </Button>
          ) : null}
        </Empty>
      </PageHeader>
    )
  }

  return (
    <section className="collection-page page-reveal" aria-labelledby="supply-heading">
      <div className="section-intro">
        <div>
          <h1 className="page-heading" id="supply-heading">
            共享货源
          </h1>
          <p className="page-description">
            按分类浏览商户商品、按关键词或以图搜索，收藏保存在插件私有目录。
            商品资料来自供货方公开接口，不代表可直接下单。
          </p>
        </div>
        <div className="section-actions">
          <ProductViewToggle value={view} onChange={setView} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setMerchants(null)
              setProducts(null)
              setMerchantPage(0)
              setProductPage(0)
              void loadFavorites()
            }}
          >
            <RefreshCw data-icon="inline-start" />
            刷新
          </Button>
        </div>
      </div>

      <div className="supply-tabs" role="tablist" aria-label="货源分区">
        {SECTIONS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={section === entry.value}
            className={section === entry.value ? 'supply-tab is-active' : 'supply-tab'}
            onClick={() => setSection(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error === null ? null : <FieldError role="alert">{error}</FieldError>}

      {section === 'browse' ? (
        <div className="supply-browse">
          <div className="supply-categories">
            {categories.map((category) => (
              <Button
                key={category.id}
                size="sm"
                variant={typeId === category.id ? 'default' : 'outline'}
                onClick={() => {
                  setTypeId(category.id)
                  setMerchants(null)
                  setProducts(null)
                  setMerchantPage(0)
                  setProductPage(0)
                  setMerchantId('')
                }}
              >
                {category.name}
              </Button>
            ))}
          </div>

          <div className="supply-browse-body">
            <div className="supply-merchants">
              <div className="supply-panel-head">
                <span>商户列表</span>
                <span className="supply-muted">
                  {merchantsLoading ? '加载中' : `${merchants.length} 个`}
                </span>
              </div>
              <div className="supply-merchant-list">
                {merchantsLoading ? <p className="supply-empty">正在加载商户…</p> : null}
                {!merchantsLoading && merchants.length === 0 ? (
                  <p className="supply-empty">该分类下暂无商户</p>
                ) : null}
                {(merchants ?? []).map((merchant) => (
                  <button
                    key={merchant.uid}
                    type="button"
                    className={
                      merchant.uid === merchantId
                        ? 'supply-merchant is-active'
                        : 'supply-merchant'
                    }
                    onClick={() => {
                      setMerchantId(merchant.uid)
                      setProducts(null)
                      setProductPage(0)
                    }}
                  >
                    <Store aria-hidden="true" />
                    <span>
                      <span className="supply-merchant-name">
                        {merchantTitle(merchant)}
                      </span>
                      <span className="supply-merchant-meta">
                        {merchantLocation(merchant) === ''
                          ? '位置未提供'
                          : merchantLocation(merchant)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <Pager
                page={merchantPage}
                hasMore={merchantMore}
                disabled={merchantsLoading}
                onChange={(page) => {
                  setMerchantPage(page)
                  setMerchants(null)
                  setProducts(null)
                  setMerchantId('')
                  setProductPage(0)
                }}
              />
            </div>

            <div className="supply-products">
              <div className="supply-panel-head">
                <span>
                  {currentMerchant === null ? '商品' : merchantTitle(currentMerchant)}
                </span>
                <span className="supply-muted">
                  {productsLoading ? '加载中' : `${products?.length ?? 0} 件`}
                </span>
              </div>
              {productsLoading ? <p className="supply-empty">正在加载商品…</p> : null}
              <ProductGrid
                rows={products ?? []}
                view={view}
                onOpen={setSelected}
                empty={merchantId === '' ? '先选择一个商户' : '该商户暂无商品'}
              />
              {merchantId === '' ? null : (
                <Pager
                  page={productPage}
                  hasMore={productMore}
                  disabled={productsLoading}
                  onChange={(page) => {
                    setProductPage(page)
                    setProducts(null)
                  }}
                />
              )}
            </div>
          </div>
        </div>
      ) : null}

      {section === 'search' ? (
        <div className="supply-section">
          <form
            className="supply-search"
            onSubmit={(event) => {
              event.preventDefault()
              const next = draft.trim()
              setKeyword(next)
              if (next !== '') void runSearch(0)
            }}
          >
            <Input
              value={draft}
              maxLength={100}
              placeholder="输入商品关键词"
              aria-label="商品关键词"
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" disabled={searching || draft.trim() === ''}>
              {searching ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Search data-icon="inline-start" />
              )}
              搜索
            </Button>
          </form>
          {keyword === '' ? (
            <p className="supply-empty">输入关键词查看共享货源商品。</p>
          ) : (
            <>
              <ProductGrid
                rows={searchRows ?? []}
                view={view}
                onOpen={setSelected}
                empty={searching ? '正在搜索…' : '没有匹配的商品'}
              />
              <Pager
                page={searchPage}
                hasMore={searchMore}
                disabled={searching}
                onChange={(page) => void runSearch(page)}
              />
            </>
          )}
        </div>
      ) : null}

      {section === 'image' ? (
        <div className="supply-section">
          <input
            ref={imageInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) void runImageSearch(file)
            }}
          />
          <div className="supply-search">
            <Button disabled={imageBusy} onClick={() => imageInput.current?.click()}>
              {imageBusy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Camera data-icon="inline-start" />
              )}
              {imageBusy ? '正在搜索…' : '上传图片搜索'}
            </Button>
            <p className="supply-hint">
              支持 JPEG、PNG、WebP，图片至少 100 × 100 像素，最大 5 MB；页面会先转成 JPEG
              再提交。
            </p>
          </div>
          {imageRows === null ? (
            <p className="supply-empty">选择一张图片开始以图搜图。</p>
          ) : (
            <ProductGrid
              rows={imageRows}
              view={view}
              onOpen={setSelected}
              empty="没有找到相似商品"
            />
          )}
        </div>
      ) : null}

      {section === 'favorites' ? (
        <div className="supply-section">
          <div className="supply-panel-head">
            <span>我的收藏</span>
            <span className="supply-muted">
              {favorites.length} 件{favoritesDurable ? '' : ' · 仅本次运行'}
            </span>
          </div>
          <div className="supply-favorite-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={favorites.length === 0}
              onClick={() => void exportCsv()}
            >
              <Download data-icon="inline-start" />
              复制 CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={favorites.length === 0}
              onClick={() =>
                void copy(favorites.map((entry) => entry.title).join('\n'), '收藏标题')
              }
            >
              <Copy data-icon="inline-start" />
              复制标题
            </Button>
          </div>
          <ProductGrid
            rows={favorites}
            view={view}
            onOpen={setSelected}
            empty="还没有收藏；打开商品详情后可以收藏。"
          />
        </div>
      ) : null}

      <ProductDialog
        product={selected}
        favorite={favorite}
        onClose={() => setSelected(null)}
        onChanged={() => void loadFavorites()}
      />
    </section>
  )
}

function PageHeader({ children }: { children: ReactNode }) {
  return (
    <section className="collection-page page-reveal" aria-labelledby="supply-heading">
      <div className="section-intro">
        <div>
          <h1 className="page-heading" id="supply-heading">
            共享货源
          </h1>
          <p className="page-description">
            按分类浏览商户商品、按关键词或以图搜索，收藏保存在插件私有目录。
          </p>
        </div>
      </div>
      {children}
    </section>
  )
}

export function SharedSupplyRoute() {
  const hostAvailable = pluginHostAvailable()
  const [plugin, setPlugin] = useState<PluginView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!hostAvailable) return
    const catalog = await listPlugins()
    setPlugin(catalog.find((entry) => entry.id === SUPPLY_PLUGIN_ID) ?? null)
  }, [hostAvailable])

  useEffect(() => {
    if (!hostAvailable) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active) {
          setPlugin(catalog.find((entry) => entry.id === SUPPLY_PLUGIN_ID) ?? null)
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

  async function enable() {
    if (plugin === null) return
    setError(null)
    try {
      if (plugin.enabled) await restartPlugin(plugin.id)
      else await enablePlugin(plugin.id, plugin.capabilities)
      await refresh()
    } catch (cause) {
      setError(message(cause))
    }
  }

  return (
    <>
      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      <SupplyPage plugin={plugin} hostAvailable={hostAvailable} onEnable={enable} />
    </>
  )
}
