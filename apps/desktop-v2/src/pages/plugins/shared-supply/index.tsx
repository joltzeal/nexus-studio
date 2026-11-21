import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import {
  Alert,
  Button,
  EmptyState,
  Input,
  SegmentControl,
  Select,
} from '@proxyshard/shardx-ui-kit'
import {
  BuildingIcon,
  DownloadIcon,
  RefreshIcon,
  SearchIcon,
  UploadIcon,
} from '../../../shared/icons'
import { clip } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'
import { PageHeader } from '../../../widgets/PageHeader'
import { PluginFilterRow, PluginSearch } from '../PluginFilterRow'
import { PluginWorkspace } from '../PluginWorkspace'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import {
  sharedSupplyApi,
  sharedSupplyRpc,
} from '../../../raccoon/plugins/shared-supply/api'
import { SupplyImageSession } from '../../../raccoon/plugins/shared-supply/image-session'
import { createSupplyImageReader } from '../../../raccoon/plugins/shared-supply/image-transfer'
import { supportsSharedSupplyFeature } from '../../../raccoon/plugins/shared-supply/page-contract'
import {
  supplyMessage,
  supplyMerchantLocation,
  supplyMerchantTitle,
  type SupplyCategory,
  type SupplyFavorite,
  type SupplyMerchant,
  type SupplyProduct,
} from '../../../raccoon/plugins/shared-supply/model'
import { ProductGrid, ProductImage } from './ProductGrid'
import { ProductDetail } from './ProductDetail'

type Section = 'browse' | 'search' | 'image' | 'favorites'

const tabs = [
  { value: 'browse', label: '分类浏览' },
  { value: 'search', label: '搜索商品' },
  { value: 'image', label: '以图搜图' },
  { value: 'favorites', label: '我的收藏' },
]

async function prepareSearchImage(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('只支持 JPEG、PNG、WebP 图片。')
  if (file.size === 0 || file.size > 5 * 1024 * 1024)
    throw new Error('图片不能超过 5 MB。')
  if (typeof createImageBitmap !== 'function') throw new Error('当前环境无法处理图片。')
  const image = await createImageBitmap(file)
  try {
    if (
      Math.min(image.width, image.height) < 100 ||
      Math.max(image.width, image.height) > 8000
    )
      throw new Error('图片边长需在 100 至 8000 像素之间。')
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('当前环境无法处理图片。')
    let scale = Math.min(1, 1800 / Math.max(image.width, image.height))
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt > 0 && attempt % 4 === 0) scale *= 0.8
      canvas.width = Math.max(100, Math.round(image.width * scale))
      canvas.height = Math.max(100, Math.round(image.height * scale))
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const quality = [0.88, 0.78, 0.68, 0.58][attempt % 4]
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality),
      )
      if (blob === null) continue
      if (Math.ceil(blob.size / 3) * 4 > 700 * 1024) continue
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      return btoa(binary)
    }
    throw new Error('图片过大，无法压缩到插件接口可接受的范围。')
  } finally {
    image.close()
  }
}

export function SharedSupplyPage({ onManage }: { onManage: () => void }) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === 'studio.shared-supply'),
  )
  const ready = isNativeRaccoon() && supportsSharedSupplyFeature(plugin, 'base')
  const imagesAvailable = supportsSharedSupplyFeature(plugin, 'images')
  const favoritesAvailable = supportsSharedSupplyFeature(plugin, 'favorites')
  const [reload, setReload] = useState(0)
  const [imageSession, setImageSession] = useState<SupplyImageSession | null>(null)
  useEffect(() => {
    const session =
      ready && imagesAvailable
        ? new SupplyImageSession(createSupplyImageReader(sharedSupplyRpc))
        : null
    setImageSession(session)
    return () => session?.dispose()
  }, [ready, imagesAvailable, reload])

  const [section, setSection] = useState<Section>('browse')
  const [categories, setCategories] = useState<SupplyCategory[]>([])
  const [category, setCategory] = useState('')
  const [merchants, setMerchants] = useState<SupplyMerchant[]>([])
  const [merchant, setMerchant] = useState('')
  const [merchantPage, setMerchantPage] = useState(0)
  const [merchantMore, setMerchantMore] = useState(false)
  const [products, setProducts] = useState<SupplyProduct[]>([])
  const [productPage, setProductPage] = useState(0)
  const [productMore, setProductMore] = useState(false)
  const [query, setQuery] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [searchPage, setSearchPage] = useState(0)
  const [searchRows, setSearchRows] = useState<SupplyProduct[]>([])
  const [searchMore, setSearchMore] = useState(false)
  const [imageRows, setImageRows] = useState<SupplyProduct[]>([])
  const [favorites, setFavorites] = useState<SupplyFavorite[]>([])
  const [selected, setSelected] = useState<SupplyProduct | null>(null)
  const [loading, setLoading] = useState(false)
  const [lookupPending, setLookupPending] = useState(false)
  const [searchPending, setSearchPending] = useState(false)
  const [imagePending, setImagePending] = useState(false)
  const [imageSearched, setImageSearched] = useState(false)
  const [favoritesDurable, setFavoritesDurable] = useState<boolean | null>(null)
  const [searchRevision, setSearchRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const imageRequest = useRef(0)
  const favoriteRequest = useRef(0)
  const favoriteIds = useMemo(
    () => new Set(favorites.map((item) => item.id)),
    [favorites],
  )

  useEffect(() => {
    if (!ready) return
    let live = true
    void sharedSupplyApi
      .catalog()
      .then(({ categories }) => {
        if (!live) return
        setCategories(categories)
        setCategory((current) =>
          categories.some((item) => item.id === current)
            ? current
            : (categories[0]?.id ?? ''),
        )
      })
      .catch((cause: unknown) => {
        if (live) setError(supplyMessage(cause))
      })
    return () => {
      live = false
    }
  }, [ready, reload])
  useEffect(() => {
    if (!ready || !favoritesAvailable) return
    let live = true
    const request = ++favoriteRequest.current
    void sharedSupplyApi
      .favorites()
      .then(({ items, storageDurable }) => {
        if (!live || request !== favoriteRequest.current) return
        setFavorites(items)
        setFavoritesDurable(storageDurable)
      })
      .catch((cause: unknown) => {
        if (live) setError(supplyMessage(cause))
      })
    return () => {
      live = false
    }
  }, [ready, favoritesAvailable, reload])
  useEffect(() => {
    if (!ready || category === '') return
    let live = true
    setLoading(true)
    void sharedSupplyApi
      .stores(category, merchantPage)
      .then((result) => {
        if (!live) return
        setMerchants(result.items)
        setMerchantMore(result.hasMore)
        setMerchant((current) =>
          result.items.some((item) => item.uid === current)
            ? current
            : result.items[0]?.uid || '',
        )
      })
      .catch((cause: unknown) => {
        if (live) setError(supplyMessage(cause))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [ready, category, merchantPage, reload])
  useEffect(() => {
    if (!ready || merchant === '') return
    let live = true
    setLookupPending(true)
    void sharedSupplyApi
      .products(merchant, productPage)
      .then((result) => {
        if (!live) return
        setProducts(result.items)
        setProductMore(result.hasMore)
      })
      .catch((cause: unknown) => {
        if (live) setError(supplyMessage(cause))
      })
      .finally(() => {
        if (live) setLookupPending(false)
      })
    return () => {
      live = false
    }
  }, [ready, merchant, productPage, reload])

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    const next = searchDraft.trim()
    if (next === '') return
    setError(null)
    setSearchRows([])
    setSearchMore(false)
    setQuery(next)
    setSearchPage(0)
    setSearchRevision((current) => current + 1)
  }
  useEffect(() => {
    if (!ready || query === '') return
    let live = true
    setSearchPending(true)
    void sharedSupplyApi
      .search(query, searchPage)
      .then((result) => {
        if (!live) return
        setSearchRows(result.items)
        setSearchMore(result.hasMore)
      })
      .catch((cause: unknown) => {
        if (live) setError(supplyMessage(cause))
      })
      .finally(() => {
        if (live) setSearchPending(false)
      })
    return () => {
      live = false
    }
  }, [ready, query, searchPage, searchRevision, reload])

  const saveFavorite = async (product: SupplyProduct) => {
    try {
      const result = await sharedSupplyApi.addFavorite(product)
      favoriteRequest.current += 1
      setFavorites((current) => [
        result.item,
        ...current.filter((item) => item.id !== result.item.id),
      ])
      toast.ok(result.alreadySaved ? '收藏已更新' : '已收藏')
    } catch (cause) {
      toast.err(supplyMessage(cause))
    }
  }
  const removeFavorite = async (favorite: SupplyFavorite) => {
    try {
      const result = await sharedSupplyApi.removeFavorite(favorite.favoriteId)
      favoriteRequest.current += 1
      setFavorites((current) =>
        current.filter((item) => item.favoriteId !== favorite.favoriteId),
      )
      setSelected(null)
      toast.ok(result.removed ? '已取消收藏' : '该商品已不在收藏中')
    } catch (cause) {
      toast.err(supplyMessage(cause))
    }
  }
  const exportCsv = async () => {
    try {
      const result = await sharedSupplyApi.favoritesCsv()
      await clip.write(result.text)
      toast.ok(`已复制 ${result.count} 条收藏 CSV`)
    } catch (cause) {
      toast.err(supplyMessage(cause))
    }
  }
  const imageSearch = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const request = ++imageRequest.current
    setImagePending(true)
    setError(null)
    try {
      const data = await prepareSearchImage(file)
      if (request !== imageRequest.current) return
      const { items } = await sharedSupplyApi.imageSearch(data)
      if (request !== imageRequest.current) return
      setImageRows(items)
      setImageSearched(true)
    } catch (cause) {
      if (request === imageRequest.current) setError(supplyMessage(cause))
    } finally {
      if (request === imageRequest.current) setImagePending(false)
    }
  }
  useEffect(
    () => () => {
      imageRequest.current += 1
    },
    [ready],
  )

  const selectedFavorite = selected
    ? (favorites.find((item) => item.id === selected.id) ?? null)
    : null
  const currentMerchant = merchants.find((item) => item.uid === merchant)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="共享货源"
        actions={
          ready ? (
            <Button
              variant="neutral"
              mode="stroke"
              size="xsmall"
              leftIcon={<RefreshIcon className="size-3.5" />}
              onClick={() => {
                setError(null)
                setReload((current) => current + 1)
              }}
            >
              刷新
            </Button>
          ) : undefined
        }
      />
      <PluginWorkspace scroll={section !== 'browse'}>
        {!ready ? (
          <EmptyState
            title={isNativeRaccoon() ? '共享货源插件暂不可用' : '需要 Raccoon 桌面应用'}
            hint="请在插件中心启用并启动共享货源插件。"
            action={{ label: '管理插件', onClick: onManage }}
          />
        ) : (
          <div
            className={
              section === 'browse'
                ? 'flex min-h-0 flex-1 flex-col gap-3'
                : 'flex flex-col gap-3'
            }
          >
            {error && (
              <Alert status="error" variant="lighter" onClose={() => setError(null)}>
                {error}
              </Alert>
            )}
            {!imagesAvailable && (
              <Alert status="warning" variant="lighter">
                当前插件不支持受控图片传输，商品文字资料仍可浏览和复制。
              </Alert>
            )}
            <SegmentControl
              fit
              size="xsmall"
              semantics="tabs"
              items={tabs}
              value={section}
              onChange={(value) => setSection(value as Section)}
              aria-label="共享货源分区"
            />
            {section === 'browse' && (
              <div className="grid min-h-0 flex-1 grid-cols-[minmax(176px,224px)_minmax(0,1fr)]">
                <section
                  aria-label="商户列表"
                  className="flex min-h-0 min-w-0 flex-col gap-2 border-r border-stroke-soft-200 pr-3"
                >
                  <Select
                    size="xsmall"
                    label="商品分类"
                    value={category}
                    options={categories.map((item) => ({
                      value: item.id,
                      label: item.name,
                    }))}
                    onChange={(value) => {
                      if (value === category) return
                      setError(null)
                      setCategory(value)
                      setMerchantPage(0)
                      setProductPage(0)
                      setMerchant('')
                      setMerchants([])
                      setProducts([])
                      setLookupPending(false)
                      setMerchantMore(false)
                      setProductMore(false)
                    }}
                  />
                  <h2 className="m-0 text-panel-title">
                    商户{' '}
                    <span className="text-secondary text-text-soft-400">
                      {merchants.length}
                    </span>
                  </h2>
                  <div className="min-h-0 flex-1 overflow-y-auto p-1.5 -m-1.5">
                    {loading ? (
                      <p role="status" className="m-0 text-secondary text-text-sub-600">
                        正在读取商户
                      </p>
                    ) : merchants.length === 0 ? (
                      <p className="m-0 text-secondary text-text-sub-600">暂无商户</p>
                    ) : (
                      merchants.map((item) => (
                        <Button
                          key={item.uid}
                          mode="ghost"
                          variant="neutral"
                          contentAlign="start"
                          aria-pressed={merchant === item.uid}
                          className="mb-1 h-[44px]! w-full aria-pressed:bg-bg-active"
                          onClick={() => {
                            if (merchant === item.uid) return
                            setError(null)
                            setMerchant(item.uid)
                            setProductPage(0)
                            setProducts([])
                            setLookupPending(true)
                            setProductMore(false)
                          }}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="grid size-[28px] shrink-0 place-items-center overflow-hidden rounded-control bg-bg-weak-50">
                              {imagesAvailable && item.iconUrl ? (
                                <ProductImage
                                  url={item.iconUrl}
                                  session={imageSession}
                                  alt=""
                                  compact
                                />
                              ) : (
                                <BuildingIcon className="size-3.5 text-text-soft-400" />
                              )}
                            </span>
                            <span className="flex min-w-0 flex-col text-left">
                              <span className="truncate">
                                {supplyMerchantTitle(item)}
                              </span>
                              {supplyMerchantLocation(item) && (
                                <span className="truncate text-help text-text-soft-400">
                                  {supplyMerchantLocation(item)}
                                </span>
                              )}
                            </span>
                          </span>
                        </Button>
                      ))
                    )}
                  </div>
                  <div className="flex shrink-0 justify-between gap-2">
                    <Button
                      variant="neutral"
                      mode="stroke"
                      size="xsmall"
                      disabled={merchantPage <= 0 || loading}
                      onClick={() => {
                        setMerchantPage((value) => value - 1)
                        setMerchant('')
                        setMerchants([])
                        setProducts([])
                        setProductPage(0)
                        setLookupPending(false)
                        setProductMore(false)
                      }}
                    >
                      上一页
                    </Button>
                    <Button
                      variant="neutral"
                      mode="stroke"
                      size="xsmall"
                      disabled={!merchantMore || loading || merchantPage >= 1000}
                      onClick={() => {
                        setMerchantPage((value) => value + 1)
                        setMerchant('')
                        setMerchants([])
                        setProducts([])
                        setProductPage(0)
                        setLookupPending(false)
                        setProductMore(false)
                      }}
                    >
                      下一页
                    </Button>
                  </div>
                </section>
                <section
                  aria-label="商户货源"
                  className="flex min-h-0 min-w-0 flex-col gap-2 pl-3"
                >
                  <h2 className="m-0 shrink-0 truncate text-panel-title">
                    {currentMerchant ? supplyMerchantTitle(currentMerchant) : '商品'}
                  </h2>
                  <div
                    key={`${merchant}:${productPage}`}
                    className="min-h-0 flex-1 overflow-y-auto p-1.5 -m-1.5"
                  >
                    {loading || lookupPending ? (
                      <p role="status" className="text-secondary text-text-sub-600">
                        正在读取货源目录
                      </p>
                    ) : merchant === '' ? (
                      <EmptyState title="请选择商户" />
                    ) : (
                      <ProductGrid
                        products={products}
                        session={imageSession}
                        imagesAvailable={imagesAvailable}
                        favorites={favoriteIds}
                        favoritesAvailable={favoritesAvailable}
                        onOpen={setSelected}
                        onFavorite={(product) => void saveFavorite(product)}
                      />
                    )}
                  </div>
                  <div className="flex shrink-0 justify-end gap-2">
                    <Button
                      variant="neutral"
                      mode="stroke"
                      size="xsmall"
                      disabled={productPage <= 0 || loading || lookupPending}
                      onClick={() => {
                        setProducts([])
                        setLookupPending(true)
                        setProductPage((value) => value - 1)
                      }}
                    >
                      上一页
                    </Button>
                    <Button
                      variant="neutral"
                      mode="stroke"
                      size="xsmall"
                      disabled={
                        !productMore || loading || lookupPending || productPage >= 1000
                      }
                      onClick={() => {
                        setProducts([])
                        setLookupPending(true)
                        setProductPage((value) => value + 1)
                      }}
                    >
                      下一页
                    </Button>
                  </div>
                </section>
              </div>
            )}
            {section === 'search' && (
              <div className="flex flex-col gap-4">
                <PluginFilterRow label="搜索货源" onSubmit={submitSearch}>
                  <PluginSearch
                    pageShortcut
                    label="搜索关键词"
                    value={searchDraft}
                    maxLength={100}
                    onChange={(event) => setSearchDraft(event.target.value)}
                  />
                  <Button
                    type="submit"
                    size="xsmall"
                    leftIcon={<SearchIcon className="size-3.5" />}
                    isLoading={searchPending}
                  >
                    搜索
                  </Button>
                </PluginFilterRow>
                {query === '' ? (
                  <EmptyState title="输入关键词开始搜索" />
                ) : searchPending ? (
                  <p role="status" className="text-secondary text-text-sub-600">
                    正在搜索商品
                  </p>
                ) : (
                  <>
                    <ProductGrid
                      products={searchRows}
                      session={imageSession}
                      imagesAvailable={imagesAvailable}
                      favorites={favoriteIds}
                      favoritesAvailable={favoritesAvailable}
                      onOpen={setSelected}
                      onFavorite={(product) => void saveFavorite(product)}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="neutral"
                        mode="stroke"
                        size="xsmall"
                        disabled={searchPage <= 0}
                        onClick={() => setSearchPage((value) => value - 1)}
                      >
                        上一页
                      </Button>
                      <Button
                        variant="neutral"
                        mode="stroke"
                        size="xsmall"
                        disabled={!searchMore || searchPage >= 1000}
                        onClick={() => setSearchPage((value) => value + 1)}
                      >
                        下一页
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
            {section === 'image' && (
              <div className="flex flex-col items-start gap-4">
                <div hidden>
                  <Input
                    ref={imageInput}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label="选择搜索图片"
                    onChange={(event) => void imageSearch(event)}
                  />
                </div>
                <Button
                  variant="neutral"
                  mode="stroke"
                  size="xsmall"
                  leftIcon={<UploadIcon className="size-3.5" />}
                  onClick={() => imageInput.current?.click()}
                  isLoading={imagePending}
                >
                  上传图片搜索
                </Button>
                <div className="w-full">
                  {imagePending ? (
                    <p role="status" className="text-secondary text-text-sub-600">
                      正在查找相似商品
                    </p>
                  ) : imageRows.length === 0 ? (
                    <EmptyState
                      title={imageSearched ? '没有匹配商品' : '选择图片查看相似商品'}
                    />
                  ) : (
                    <ProductGrid
                      products={imageRows}
                      session={imageSession}
                      imagesAvailable={imagesAvailable}
                      favorites={favoriteIds}
                      favoritesAvailable={favoritesAvailable}
                      onOpen={setSelected}
                      onFavorite={(product) => void saveFavorite(product)}
                    />
                  )}
                </div>
              </div>
            )}
            {section === 'favorites' && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-body text-text-sub-600">
                    {favorites.length} 件收藏
                    {favoritesDurable === false || plugin?.storageDurable === false
                      ? ' · 仅本次运行'
                      : ''}
                  </span>
                  <Button
                    variant="neutral"
                    mode="stroke"
                    size="xsmall"
                    disabled={!favoritesAvailable || favorites.length === 0}
                    leftIcon={<DownloadIcon className="size-3.5" />}
                    onClick={() => void exportCsv()}
                  >
                    复制 CSV
                  </Button>
                </div>
                {favoritesAvailable ? (
                  <ProductGrid
                    products={favorites}
                    session={imageSession}
                    imagesAvailable={imagesAvailable}
                    favorites={favoriteIds}
                    favoritesAvailable={favoritesAvailable}
                    onOpen={setSelected}
                    onFavorite={(product) => void saveFavorite(product)}
                  />
                ) : (
                  <EmptyState title="当前插件未提供收藏方法" />
                )}
              </div>
            )}
          </div>
        )}
      </PluginWorkspace>
      {ready && selected && (
        <ProductDetail
          key={selected.id}
          product={selected}
          favorite={selectedFavorite}
          session={imageSession}
          imagesAvailable={imagesAvailable}
          favoritesAvailable={favoritesAvailable}
          onClose={() => setSelected(null)}
          onFavorite={(product) => void saveFavorite(product)}
          onRemove={(favorite) => void removeFavorite(favorite)}
        />
      )}
    </div>
  )
}
