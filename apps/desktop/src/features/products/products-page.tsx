import { useCallback, useEffect, useState } from 'react'
import {
  PRODUCT_CAPABILITY,
  PRODUCT_METHODS,
  PRODUCTS_PLUGIN_ID,
  type ProductPage,
  type ProductQuery,
  type ProductSummary,
} from '@nexus/plugin-products/contracts'
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  ImagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from '@/components/ui/toast'
import { AI_IMAGE_PLUGIN_ID } from '@/features/ai-image/types'
import { PluginGate } from '@/features/plugins/plugin-gate'
import { watchPluginCatalog } from '@/features/plugins/watch-plugin-catalog'
import type { PluginView } from '@/lib/platform/native-plugins'
import { listProducts, releaseProductImageUrls } from './api'
import { AiProductImportDialog } from './ai-product-import-dialog'
import { aiImportUnavailable, pluginProcessIdentity } from './plugin-state'
import { ProductDeleteDialog } from './product-delete-dialog'
import { ProductEditor } from './product-editor'
import {
  PRODUCT_SOURCE_OPTIONS,
  PRODUCT_STATUS_OPTIONS,
  productError,
  productPrice,
  productTime,
} from './product-form'
import { ProductImagePreview } from './product-image'
import { ProductImportDialog } from './product-import-dialog'
import { ProductPublicationDialog } from './product-publication-history'
import { navigateDetail, useDetailNavigation } from '@/lib/detail-navigation'

export interface ProductsPageProps {
  plugin: PluginView | null
  hostAvailable: boolean
}

export function ProductsPage({ plugin, hostAvailable }: ProductsPageProps) {
  if (!hostAvailable || !plugin || plugin.state !== 'running') {
    return (
      <PluginGate
        label="商品"
        hostAvailable={hostAvailable}
        plugin={plugin?.state === 'available' ? null : plugin}
      />
    )
  }
  const denied =
    plugin.id !== PRODUCTS_PLUGIN_ID ||
    !plugin.enabled ||
    !plugin.capabilities.includes(PRODUCT_CAPABILITY) ||
    !plugin.granted.includes(PRODUCT_CAPABILITY)
  const compatible = PRODUCT_METHODS.every((method) => plugin.methods.includes(method))
  if (denied || !compatible) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{denied ? '商品插件未获授权' : '商品插件需要更新'}</EmptyTitle>
          <EmptyDescription>
            {denied
              ? '请在插件中心检查商品插件的启用状态与 product.catalog 授权。'
              : '当前插件缺少商品、图片或导入方法，请更新后使用。'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return <ProductsWorkspace key={pluginProcessIdentity(plugin)} />
}

export function ProductsWorkspace() {
  const [query, setQuery] = useState<ProductQuery>({ query: '', page: 1, pageSize: 20 })
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<{ id: string | null } | null>(null)
  const [removing, setRemoving] = useState<ProductSummary | null>(null)
  const [publicationProduct, setPublicationProduct] = useState<{
    id: string
    name: string
  } | null>(null)
  const [importing, setImporting] = useState<'file' | 'ai' | null>(null)
  useDetailNavigation(
    'product',
    useCallback((request) => {
      setEditing((current) => current ?? { id: request.id })
    }, []),
  )
  const [catalog, setCatalog] = useState<{
    loaded: boolean
    plugin: PluginView | null
    error: string | null
  }>({ loaded: false, plugin: null, error: null })
  const requestKey = JSON.stringify([query, attempt])
  const [list, setList] = useState<{
    key: string
    data: ProductPage | null
    error: string | null
  }>({ key: '', data: null, error: null })

  useEffect(() => {
    return watchPluginCatalog(
      (plugins) =>
        setCatalog({
          loaded: true,
          plugin: plugins.find((plugin) => plugin.id === AI_IMAGE_PLUGIN_ID) ?? null,
          error: null,
        }),
      () =>
        setCatalog({
          loaded: true,
          plugin: null,
          error: '无法读取 AI 生图插件状态；可继续手动创建或文件导入。',
        }),
    )
  }, [])

  useEffect(() => () => releaseProductImageUrls(), [])

  useEffect(() => {
    let current = true
    void listProducts(query).then(
      (data) => {
        if (!current) return
        const lastPage = Math.max(1, Math.ceil(data.total / query.pageSize))
        if (query.page > lastPage) {
          setQuery((value) => ({ ...value, page: lastPage }))
          return
        }
        setList({ key: requestKey, data, error: null })
      },
      (cause: unknown) => {
        if (current) setList({ key: requestKey, data: null, error: productError(cause) })
      },
    )
    return () => {
      current = false
    }
  }, [query, attempt, requestKey])

  const data = list.key === requestKey ? list.data : null
  const error = list.key === requestKey ? list.error : null
  const loading = !data && !error
  const rows = data?.items ?? []
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / query.pageSize))
  const allSelected = rows.length > 0 && rows.every((product) => selected.has(product.id))
  const someSelected = rows.some((product) => selected.has(product.id))
  const aiUnavailable =
    data?.storageDurable === false
      ? '商品插件未启用持久存储，暂不能导入 AI 生成图片。'
      : (catalog.error ??
        (!catalog.loaded
          ? '正在读取 AI 生图插件状态…'
          : aiImportUnavailable(catalog.plugin)))
  const first = data && data.total > 0 ? (query.page - 1) * query.pageSize + 1 : 0
  const last = data ? Math.min(query.page * query.pageSize, data.total) : 0

  function refresh() {
    setAttempt((value) => value + 1)
  }

  return (
    <section
      className="collection-page page-reveal flex min-h-0 w-full flex-1 flex-col"
      aria-labelledby="products-heading"
    >
      <Card className="flex min-h-0 flex-1 flex-col gap-0 py-0">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>
              <h1 id="products-heading">商品</h1>
            </CardTitle>
            <CardDescription>管理商品资料和图片，供后续工作流选用。</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" disabled={loading} onClick={refresh}>
              <RefreshCw data-icon="inline-start" />
              刷新
            </Button>
            <Button type="button" variant="outline" onClick={() => setImporting('file')}>
              <Upload data-icon="inline-start" />
              导入资料
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={aiUnavailable !== null}
              title={aiUnavailable ?? '选择 AI 生图记录，整组导入为商品'}
              onClick={() => setImporting('ai')}
            >
              <ImagePlus data-icon="inline-start" />从 AI 生图导入
            </Button>
            <Button type="button" onClick={() => setEditing({ id: null })}>
              <Plus data-icon="inline-start" />
              新建商品
            </Button>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-0">
          <div className="flex flex-col gap-3 px-4 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="搜索商品"
                placeholder="搜索名称、英文标题、SKU 或标签"
                maxLength={200}
                value={query.query}
                className="min-w-0 flex-1 basis-60"
                onChange={(event) =>
                  setQuery((current) => ({
                    ...current,
                    query: event.target.value,
                    page: 1,
                  }))
                }
              />
              <LabeledSelect
                ariaLabel="商品状态"
                value={query.status ?? 'all'}
                options={[
                  { value: 'all', label: '全部准备状态' },
                  ...PRODUCT_STATUS_OPTIONS,
                ]}
                onValueChange={(value) =>
                  setQuery((current) => {
                    const next = { ...current, page: 1 }
                    delete next.status
                    if (value === 'draft' || value === 'ready' || value === 'archived')
                      next.status = value
                    return next
                  })
                }
              />
              <LabeledSelect
                ariaLabel="发布状态"
                value={query.publicationStatus ?? 'all'}
                options={[
                  { value: 'all', label: '全部发布状态' },
                  { value: 'published', label: '已发布' },
                  { value: 'unpublished', label: '未发布' },
                ]}
                onValueChange={(value) =>
                  setQuery((current) => {
                    const next = { ...current, page: 1 }
                    delete next.publicationStatus
                    if (value === 'published' || value === 'unpublished')
                      next.publicationStatus = value
                    return next
                  })
                }
              />
              <LabeledSelect
                ariaLabel="商品来源"
                value={query.sourceKind ?? 'all'}
                options={[{ value: 'all', label: '全部来源' }, ...PRODUCT_SOURCE_OPTIONS]}
                onValueChange={(value) =>
                  setQuery((current) => {
                    const next = { ...current, page: 1 }
                    delete next.sourceKind
                    if (value === 'manual' || value === 'import' || value === 'ai-image')
                      next.sourceKind = value
                    return next
                  })
                }
              />
            </div>
            {aiUnavailable && (
              <p className="text-xs text-muted-foreground" role="status">
                {aiUnavailable}
              </p>
            )}
            {data?.storageDurable === false && (
              <Alert>
                <AlertTitle>仅本次运行</AlertTitle>
                <AlertDescription>
                  商品插件当前未启用持久存储，应用重启后资料可能丢失。
                </AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertTitle>商品列表读取失败</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  已选 {selected.size} 件（保留跨页选择）
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setSelected(new Set())}
                >
                  清空选择
                </Button>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-4" aria-busy={loading}>
            {loading ? (
              <div className="flex flex-col gap-2">
                {[0, 1, 2, 3, 4].map((value) => (
                  <Skeleton key={value} className="h-12 w-full" />
                ))}
                <span className="sr-only" role="status">
                  正在读取商品…
                </span>
              </div>
            ) : data && rows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>
                    {query.query ||
                    query.status ||
                    query.sourceKind ||
                    query.publicationStatus
                      ? '没有匹配的商品'
                      : '还没有商品'}
                  </EmptyTitle>
                  <EmptyDescription>
                    可以新建草稿、导入文件资料或从 AI 生成记录整组导入。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              data && (
                <Table aria-label="商品列表" className="min-w-240">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          aria-label="选择当前页商品"
                          checked={
                            allSelected ? true : someSelected ? 'indeterminate' : false
                          }
                          onCheckedChange={(value) =>
                            setSelected((current) => {
                              const next = new Set(current)
                              for (const product of rows) {
                                if (value === true) next.add(product.id)
                                else next.delete(product.id)
                              }
                              return next
                            })
                          }
                        />
                      </TableHead>
                      <TableHead>图片</TableHead>
                      <TableHead>商品资料</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>价格</TableHead>
                      <TableHead>分类</TableHead>
                      <TableHead>准备状态</TableHead>
                      <TableHead>发布状态</TableHead>
                      <TableHead>发布使用</TableHead>
                      <TableHead>来源</TableHead>
                      <TableHead>更新时间</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((product) => (
                      <TableRow
                        key={product.id}
                        data-state={selected.has(product.id) ? 'selected' : undefined}
                      >
                        <TableCell>
                          <Checkbox
                            aria-label={`选择商品 ${product.name}`}
                            checked={selected.has(product.id)}
                            onCheckedChange={(value) =>
                              setSelected((current) => {
                                const next = new Set(current)
                                if (value === true) next.add(product.id)
                                else next.delete(product.id)
                                return next
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          {product.cover ? (
                            <ProductImagePreview image={product.cover} compact />
                          ) : (
                            <span className="text-xs text-muted-foreground">无图片</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex max-w-72 min-w-0 flex-col items-start gap-1">
                            <Button
                              type="button"
                              variant="link"
                              className="h-auto max-w-full justify-start p-0"
                              title={product.name}
                              onClick={() => setEditing({ id: product.id })}
                            >
                              <span className="truncate">{product.name}</span>
                            </Button>
                            <span
                              className="max-w-full truncate text-xs text-muted-foreground"
                              title={product.title}
                            >
                              {product.title || '尚未填写英文标题'}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {product.imageCount} 张图片 · #{product.sequence}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="block max-w-36 truncate" title={product.sku}>
                            {product.sku || '—'}
                          </span>
                        </TableCell>
                        <TableCell>{productPrice(product)}</TableCell>
                        <TableCell>
                          <span
                            className="block max-w-36 truncate"
                            title={product.category}
                          >
                            {product.category || '未分类'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={product.status === 'ready' ? 'secondary' : 'outline'}
                          >
                            {
                              PRODUCT_STATUS_OPTIONS.find(
                                (option) => option.value === product.status,
                              )?.label
                            }
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              product.publicationCount > 0 ? 'secondary' : 'outline'
                            }
                          >
                            {product.publicationCount > 0 ? '已发布' : '未发布'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {product.latestPublication ? (
                            <div className="flex max-w-52 min-w-0 flex-col items-start gap-1">
                              <span
                                className="max-w-full truncate"
                                title={product.latestPublication.windowName}
                              >
                                <span className="sr-only">最近发布窗口：</span>
                                {product.latestPublication.windowName}
                              </span>
                              <Button
                                type="button"
                                variant="link"
                                className="h-auto max-w-full justify-start p-0"
                                aria-label={`查看商品 ${product.name} 的发布历史`}
                                onClick={() =>
                                  setPublicationProduct({
                                    id: product.id,
                                    name: product.name,
                                  })
                                }
                              >
                                共 {product.publicationCount} 次发布 · 查看历史
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {
                            PRODUCT_SOURCE_OPTIONS.find(
                              (option) => option.value === product.source.kind,
                            )?.label
                          }
                        </TableCell>
                        <TableCell>{productTime(product.updatedAt)}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`查看商品 ${product.name} 的执行记录`}
                              title="执行记录"
                              onClick={() =>
                                navigateDetail({
                                  kind: 'agent',
                                  id: product.id,
                                  related: 'product',
                                })
                              }
                            >
                              <ClipboardList />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`编辑商品 ${product.name}`}
                              onClick={() => setEditing({ id: product.id })}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`删除商品 ${product.name}`}
                              onClick={() => setRemoving(product)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            )}
          </div>
        </CardContent>
        <Separator />
        <CardFooter className="flex flex-wrap items-center justify-between gap-2 p-4">
          <span className="text-xs text-muted-foreground">
            {loading
              ? '正在加载…'
              : data
                ? `${String(first)}–${String(last)} 条 · 共 ${String(data.total)} 件`
                : '未能读取商品数量'}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <LabeledSelect
              ariaLabel="每页商品数量"
              value={String(query.pageSize)}
              options={[
                { value: '20', label: '20 条 / 页' },
                { value: '50', label: '50 条 / 页' },
              ]}
              onValueChange={(value) =>
                setQuery((current) => ({
                  ...current,
                  page: 1,
                  pageSize: value === '50' ? 50 : 20,
                }))
              }
            />
            <span className="text-xs text-muted-foreground">
              第 {query.page} / {data ? pages : '—'} 页
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="上一页商品"
              disabled={loading || query.page <= 1}
              onClick={() =>
                setQuery((current) => ({ ...current, page: current.page - 1 }))
              }
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="下一页商品"
              disabled={loading || !data || query.page >= pages}
              onClick={() =>
                setQuery((current) => ({ ...current, page: current.page + 1 }))
              }
            >
              <ChevronRight />
            </Button>
          </div>
        </CardFooter>
      </Card>
      {publicationProduct && (
        <ProductPublicationDialog
          key={publicationProduct.id}
          productId={publicationProduct.id}
          productName={publicationProduct.name}
          onClose={() => setPublicationProduct(null)}
        />
      )}
      {editing && (
        <ProductEditor
          key={editing.id ?? 'new'}
          productId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            toast.success('商品已保存')
            refresh()
          }}
        />
      )}
      {removing && (
        <ProductDeleteDialog
          key={removing.id}
          product={removing}
          onClose={() => setRemoving(null)}
          onDeleted={(id) => {
            setRemoving(null)
            setSelected((current) => {
              const next = new Set(current)
              next.delete(id)
              return next
            })
            toast.success('商品已删除')
            refresh()
          }}
        />
      )}
      {importing === 'file' && (
        <ProductImportDialog onClose={() => setImporting(null)} onImported={refresh} />
      )}
      {importing === 'ai' && (
        <AiProductImportDialog
          key={catalog.plugin ? pluginProcessIdentity(catalog.plugin) : 'unavailable'}
          unavailable={aiUnavailable}
          onClose={() => setImporting(null)}
          onImported={refresh}
        />
      )}
    </section>
  )
}
