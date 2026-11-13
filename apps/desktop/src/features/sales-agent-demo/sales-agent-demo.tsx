import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronRight,
  ClipboardList,
  FlaskConical,
  History,
  ListChecks,
  Monitor,
  Moon,
  PackagePlus,
  Pencil,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
} from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toast'
import { formatMoney, taskPresets, type DemoProduct, type TaskKind } from './demo-data'
import {
  addProducts,
  assignProducts,
  completeProducts,
  createDemoDraft,
  createDemoRun,
  missingFields,
  planErrors,
  reviewProducts,
  setDemoWindowCount,
  setSelectedWindows,
  stopDemoRun,
  tickDemoRun,
  type DemoRun,
} from './demo-state'
import { ProductPicker, WindowPicker } from './pickers'
import { AssignmentBoard } from './assignment-board'
import { ProductEditor } from './product-editor'
import { ProductsTable } from './products-table'
import { RunView } from './run-view'

export default function SalesAgentDemo() {
  const [draft, setDraft] = useState(createDemoDraft)
  const [page, setPage] = useState('prepare')
  const [kind, setKind] = useState<TaskKind>('listing')
  const [name, setName] = useState('周五 · 商品上架')
  const [instruction, setInstruction] = useState(taskPresets[0]!.instruction)
  const [concurrency, setConcurrency] = useState('2')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [editIds, setEditIds] = useState<string[] | null>(null)
  const [picker, setPicker] = useState<'windows' | 'products' | null>(null)
  const [resetId, setResetId] = useState(0)
  const [preview, setPreview] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [run, setRun] = useState<DemoRun | null>(null)
  const [dark, setDark] = useState(false)
  const running = run?.state === 'running'
  const windows = draft.windows.filter((window) => draft.windowIds.includes(window.id))
  const assigned = draft.products.filter((product) => product.windowId).length
  const incomplete = draft.products.filter(
    (product) => missingFields(product).length,
  ).length
  const skipCount = draft.products.filter((product) => product.review === 'skip').length
  const ready = draft.products.filter((product) => product.review === 'ready').length

  useEffect(() => {
    const title = document.title
    document.title = 'ecom agent · Nexus 交互预览'
    return () => {
      document.title = title
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    return () => {
      document.documentElement.classList.remove('dark')
    }
  }, [dark])

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      setRun((current) => (current ? tickDemoRun(current) : current))
    }, 1100)
    return () => clearInterval(timer)
  }, [running])

  function reset() {
    setDraft(createDemoDraft())
    setSelectedIds([])
    setErrors([])
    setRun(null)
    setPage('prepare')
    setKind('listing')
    setName('周五 · 商品上架')
    setInstruction(taskPresets[0]!.instruction)
    setConcurrency('2')
    setResetId((current) => current + 1)
    setPreview(false)
    setEditIds(null)
    setPicker(null)
    toast.info('已重置示例资料')
  }

  function changePreset(value: string) {
    const preset = taskPresets.find((entry) => entry.value === value)
    if (!preset) return
    setKind(preset.value)
    setInstruction(preset.instruction)
    setName(
      preset.value === 'listing'
        ? '周五 · 商品上架'
        : preset.value === 'message'
          ? '周五 · 回复未读消息'
          : '周五 · 账号巡检',
    )
    setErrors([])
  }

  function saveProducts(products: DemoProduct[]) {
    const changes = new Map(products.map((product) => [product.id, product]))
    setDraft((current) => ({
      ...current,
      products: current.products.map((product) => changes.get(product.id) ?? product),
    }))
    setEditIds(null)
    setErrors([])
    toast.success(`已更新 ${products.length} 件商品的演示资料`)
  }

  function removeProducts(ids: string[]) {
    setDraft((current) => ({
      ...current,
      products: current.products.filter((product) => !ids.includes(product.id)),
    }))
    setSelectedIds((current) => current.filter((id) => !ids.includes(id)))
    setErrors([])
  }

  function assign(ids: string[], windowId: string | null) {
    setDraft((current) => assignProducts(current, ids, windowId))
    setErrors([])
  }

  function openPreview() {
    const nextErrors = planErrors(draft, kind, name, instruction)
    setErrors(nextErrors)
    if (nextErrors.length) return
    setPreview(true)
  }

  return (
    <Tabs
      value={page}
      onValueChange={setPage}
      orientation="vertical"
      className="app-shell agent-demo-shell"
    >
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <span className="brand-symbol">N</span>
          <span className="wordmark">
            Nexus<span className="wordmark-dot">.</span>
          </span>
        </div>
        <div className="workspace-switcher">
          <span className="workspace-avatar">
            <Bot className="size-4" />
          </span>
          <div>
            <strong>销售工作台</strong>
            <small>独立交互预览</small>
          </div>
        </div>
        <span className="nav-caption">ecom agent</span>
        <TabsList variant="navigation" aria-label="Agent 导航">
          <TabsTrigger value="prepare">
            <ClipboardList />
            任务准备
          </TabsTrigger>
          <TabsTrigger value="runs">
            <History />
            运行记录{running ? <span className="agent-live-dot" /> : null}
          </TabsTrigger>
        </TabsList>
        <Separator />
        <div className="agent-sidebar-rules">
          <span>已确认的执行规则</span>
          <p>
            <ListChecks />
            商品先分配，再执行
          </p>
          <p>
            <Monitor />
            一件商品只属于一个窗口
          </p>
          <p>
            <ShieldCheck />
            封禁只停止当前账号
          </p>
        </div>
        <div className="sidebar-version">
          <span>交互原型</span>
          <span>DEMO</span>
        </div>
        <Button asChild variant="ghost" size="sm" className="justify-start">
          <a href="/">
            <ArrowLeft data-icon="inline-start" />
            返回 Nexus
          </a>
        </Button>
      </aside>
      <header className="app-header">
        <div className="header-breadcrumb">
          <span>插件中心</span>
          <ChevronRight />
          <strong>ecom agent</strong>
        </div>
        <div className="header-actions">
          <Badge variant="outline">交互预览</Badge>
          <Button
            variant="ghost"
            size="icon"
            aria-label={dark ? '切换为浅色' : '切换为深色'}
            onClick={() => setDark((current) => !current)}
          >
            {dark ? <Moon /> : <Sun />}
          </Button>
        </div>
      </header>
      <main className="app-main agent-demo-main">
        <TabsContent value="prepare" className="agent-scroll-page">
          <div className="agent-page-heading">
            <div>
              <h1 className="page-heading">ecom agent</h1>
              <p className="page-description">
                准备资料、分配窗口，让每个账号按自己的任务执行。
              </p>
            </div>
            <Button variant="outline" onClick={reset} disabled={running}>
              <RotateCcw data-icon="inline-start" />
              重置示例
            </Button>
          </div>
          <Alert className="agent-demo-note" role="status">
            <FlaskConical />
            <AlertDescription>
              交互预览：示例商品、账号和模型结果仅用于调整流程；不会启动浏览器、发布商品或写入插件资料。
            </AlertDescription>
          </Alert>
          {running ? (
            <Alert role="status">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>当前批次正在模拟运行。完成或停止后可以继续编辑。</span>
                <Button size="sm" variant="outline" onClick={() => setPage('runs')}>
                  查看进度
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          <fieldset disabled={running} className="agent-preparation">
            <section className="agent-panel">
              <div className="agent-panel-header">
                <h2>
                  <span className="agent-step">1</span>任务设置
                </h2>
                <span className="text-xs text-muted-foreground">
                  同一指令，按窗口独立执行
                </span>
              </div>
              <div className="agent-panel-body">
                <FieldGroup className="agent-task-fields">
                  <Field>
                    <FieldLabel htmlFor="agent-task-name">任务名称</FieldLabel>
                    <Input
                      id="agent-task-name"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value)
                        setErrors([])
                      }}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="agent-task-preset">任务预设</FieldLabel>
                    <LabeledSelect
                      id="agent-task-preset"
                      ariaLabel="任务预设"
                      value={kind}
                      options={taskPresets}
                      onValueChange={changePreset}
                      className="w-full"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="agent-concurrency">同时执行窗口</FieldLabel>
                    <LabeledSelect
                      id="agent-concurrency"
                      ariaLabel="同时执行窗口"
                      value={concurrency}
                      options={['1', '2', '3', '5'].map((value) => ({
                        value,
                        label: `${value} 个窗口`,
                      }))}
                      onValueChange={setConcurrency}
                      className="w-full"
                    />
                  </Field>
                  <Field className="agent-task-instruction">
                    <FieldLabel htmlFor="agent-instruction">任务指令</FieldLabel>
                    <Textarea
                      id="agent-instruction"
                      rows={2}
                      value={instruction}
                      onChange={(event) => {
                        setInstruction(event.target.value)
                        setErrors([])
                      }}
                    />
                  </Field>
                </FieldGroup>
              </div>
            </section>
            <section className="agent-panel">
              <div className="agent-panel-header">
                <h2>
                  <span className="agent-step">2</span>
                  {kind === 'listing' ? '商品与窗口分配' : '执行窗口'}
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft((current) =>
                        setDemoWindowCount(
                          current,
                          current.windows.length === 100 ? 4 : 100,
                        ),
                      )
                      setErrors([])
                    }}
                  >
                    {draft.windows.length === 100 ? '恢复 4 个窗口' : '体验 100 个窗口'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPicker('windows')}
                  >
                    <Users data-icon="inline-start" />
                    选择窗口
                  </Button>
                </div>
              </div>
              <AssignmentBoard
                key={resetId}
                products={draft.products}
                windows={windows}
                selectedIds={selectedIds}
                onSelect={setSelectedIds}
                onAssign={assign}
                showProducts={kind === 'listing'}
                disabled={running}
              />
            </section>
            {kind === 'listing' ? (
              <section className="agent-panel">
                <div className="agent-panel-header">
                  <h2>
                    <span className="agent-step">3</span>待上架商品
                    <Badge variant="secondary">{draft.products.length}</Badge>
                  </h2>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPicker('products')}
                  >
                    <PackagePlus data-icon="inline-start" />
                    从商品库选择
                  </Button>
                </div>
                <div className="agent-product-toolbar">
                  <span className="agent-selection-count">
                    {selectedIds.length
                      ? `已选 ${selectedIds.length} 件`
                      : `共 ${draft.products.length} 件商品`}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!draft.products.length}
                    onClick={() =>
                      setEditIds(
                        selectedIds.length
                          ? selectedIds
                          : draft.products.map((product) => product.id),
                      )
                    }
                  >
                    <Pencil data-icon="inline-start" />
                    批量编辑资料
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!draft.products.length}
                    onClick={() => {
                      setDraft((current) => ({
                        ...current,
                        products: completeProducts(current.products),
                      }))
                      setErrors([])
                      toast.info('已模拟补全空缺字段，手动填写的资料已保留')
                    }}
                  >
                    <Sparkles data-icon="inline-start" />
                    模拟 AI 补全
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!draft.products.length}
                    onClick={() => {
                      setDraft((current) => ({
                        ...current,
                        products: reviewProducts(current.products),
                      }))
                      setErrors([])
                      toast.info('模拟检查结束，可查看各商品结果及修改后的文案')
                    }}
                  >
                    <ShieldCheck data-icon="inline-start" />
                    运行前检查
                  </Button>
                </div>
                <ProductsTable
                  products={draft.products}
                  windows={windows}
                  selectedIds={selectedIds}
                  onSelect={setSelectedIds}
                  onEdit={setEditIds}
                  onRemove={removeProducts}
                />
                <div className="agent-table-footer">
                  <span>
                    已分配 {assigned}/{draft.products.length} · 资料待补全 {incomplete} ·
                    检查通过 {ready} · 将跳过 {skipCount}
                  </span>
                  <span>每件商品只可分配给一个窗口</span>
                </div>
              </section>
            ) : (
              <section className="agent-panel">
                <div className="agent-panel-header">
                  <h2>
                    <span className="agent-step">3</span>
                    {kind === 'message' ? '回复任务预览' : '账号检查预览'}
                  </h2>
                </div>
                <div className="agent-panel-body">
                  <p className="text-sm">
                    {kind === 'message'
                      ? '每个窗口读取自己的未读对话，结合上下文生成回复。'
                      : '每个窗口检查自己的状态、品类、评价与余额，整理为账号池资料。'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {kind === 'message'
                      ? '演示页只展示任务分发与执行状态，真实消息不会被读取或发送。'
                      : '当前页面展示的是示例结果；没有连接浏览器或写入账号池。'}
                  </p>
                </div>
              </section>
            )}
            {errors.length ? (
              <FieldError>
                <ul className="flex list-inside list-disc flex-col gap-1">
                  {errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </FieldError>
            ) : null}
            <div className="agent-launch-bar">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-muted-foreground" />
                <span>
                  {kind === 'listing'
                    ? `${draft.products.length} 件商品 · ${windows.length} 个窗口`
                    : `${windows.length} 个窗口`}
                </span>
                <span className="text-muted-foreground">封禁停止 · 其余继续</span>
              </div>
              <Button onClick={openPreview}>
                <Play data-icon="inline-start" />
                预览并模拟运行
              </Button>
            </div>
          </fieldset>
        </TabsContent>
        <TabsContent value="runs" className="agent-scroll-page">
          <RunView
            run={run}
            onBack={() => setPage('prepare')}
            onStop={() => setRun((current) => (current ? stopDemoRun(current) : current))}
          />
        </TabsContent>
      </main>
      {editIds ? (
        <ProductEditor
          products={draft.products.filter((product) => editIds.includes(product.id))}
          onSave={saveProducts}
          onClose={() => setEditIds(null)}
        />
      ) : null}
      {picker === 'windows' ? (
        <WindowPicker
          windows={draft.windows}
          selectedIds={draft.windowIds}
          onSave={(ids) => {
            setDraft((current) => setSelectedWindows(current, ids))
            setPicker(null)
            setErrors([])
          }}
          onClose={() => setPicker(null)}
        />
      ) : picker === 'products' ? (
        <ProductPicker
          existingIds={draft.products.map((product) => product.id)}
          onAdd={(ids) => {
            setDraft((current) => addProducts(current, ids))
            setPicker(null)
            setErrors([])
            toast.success(`已添加 ${ids.length} 件示例商品`)
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent className="agent-run-preview">
          <DialogHeader>
            <DialogTitle>确认执行分配</DialogTitle>
            <DialogDescription>
              {name} · {windows.length} 个窗口 · 这是一次模拟运行。
            </DialogDescription>
          </DialogHeader>
          <div className="agent-preview-list">
            {windows.map((window) => {
              const products = draft.products.filter(
                (product) => product.windowId === window.id,
              )
              return (
                <section key={window.id}>
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-sm font-medium">{window.name}</strong>
                    <Badge
                      variant={window.status === 'blocked' ? 'destructive' : 'outline'}
                    >
                      {window.status === 'blocked'
                        ? '封禁 · 该账号将停止'
                        : `@${window.account}`}
                    </Badge>
                  </div>
                  {kind === 'listing' ? (
                    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                      {products.map((product) => (
                        <li key={product.id} className="flex items-center gap-2">
                          <ArrowRight className="size-3" />
                          {product.label}
                          <span
                            className={
                              product.review === 'skip' ? 'text-destructive' : undefined
                            }
                          >
                            {product.review === 'skip'
                              ? '检查不通过 · 跳过'
                              : formatMoney(Number(product.price), product.currency)}
                          </span>
                        </li>
                      ))}
                      {!products.length ? <li>未分配商品，本次无上架任务。</li> : null}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {kind === 'message'
                        ? '读取未读消息 → 生成回复 → 模拟发送'
                        : '检查状态 → 分析账号 → 整理余额与标签'}
                    </p>
                  )}
                </section>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            同一窗口顺序执行。图片检查未通过的商品跳过；某个账号封禁时，其他账号继续。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(false)}>
              返回调整
            </Button>
            <Button
              onClick={() => {
                setRun(createDemoRun(draft, kind, name, instruction, Number(concurrency)))
                setPreview(false)
                setPage('runs')
              }}
            >
              <Play data-icon="inline-start" />
              开始模拟
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  )
}
