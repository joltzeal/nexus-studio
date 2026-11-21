import { useState, type DragEvent, type Dispatch, type SetStateAction } from 'react'
import type { AgentBatchView } from '@nexus/plugin-sdk/agent'
import { ChevronLeft, ChevronRight, GripVertical, Plus, RefreshCw, X } from './icons'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldGroup,
  FieldLabel,
  LabeledSelect,
  Skeleton,
  toast,
} from './controls'

import { Checkbox, Input, Textarea, cn } from '@proxyshard/shardx-ui-kit'

import {
  agentError,
  checkAgentPreflight,
  createAgentBatch,
  listAgentTargets,
  type AgentTarget,
} from './api'
import {
  addDraftProducts,
  assignDraftProducts,
  BatchSubmission,
  batchInput,
  draftProblems,
  effectiveProduct,
  listingProblems,
  removeDraftProduct,
  setDraftWindows,
  type AgentDraft,
} from './assignment'
import { BatchProductEditor } from './product-editor'
import { ProductPicker } from './product-picker'
import { AgentProductCover } from './product-cover'
import { PRESET_LABELS } from './state'
import { useAgentQuery } from './use-query'
import { PreflightPanel } from './preflight-panel'
import { WorkspaceLibrary } from './workspace-library'
import { useAgentConnection, useAgentRequestScope } from './scope'

const DRAG_TYPE = 'application/x-nexus-sales-agent-products'
const PROVIDERS: Record<string, string> = {
  cloakbrowser: '内置浏览器',
  adspower: 'AdsPower',
  bitbrowser: '比特浏览器',
  aliasmode: 'AliasMode',
  shardbrowser: 'ShardBrowser',
}
const ACCOUNT_STATES: Record<NonNullable<AgentTarget['account']>['status'], string> = {
  unknown: '未知',
  active: '正常',
  pending: '待验证',
  limited: '受限',
  blocked: '封禁 · blocked',
}

export function BatchComposer({
  draft,
  setDraft,
  accountsUnavailable,
  productsUnavailable,
  settingsUnavailable,
  onCreated,
  onRuns,
  onSettings = () => {},
}: {
  draft: AgentDraft
  setDraft: Dispatch<SetStateAction<AgentDraft>>
  accountsUnavailable: string | null
  productsUnavailable: string | null
  settingsUnavailable: string | null
  onCreated: (batch: AgentBatchView) => void
  onRuns: () => void
  onSettings?: () => void
}) {
  const connectionId = useAgentConnection()
  const [attempt, setAttempt] = useState(0)
  const [productQuery, setProductQuery] = useState('')
  const [productFilter, setProductFilter] = useState('all')
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(() => new Set())
  const [windowQuery, setWindowQuery] = useState('')
  const [windowFilter, setWindowFilter] = useState('all')
  const [windowAccountFilter, setWindowAccountFilter] = useState('all')
  const [windowPage, setWindowPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [picker, setPicker] = useState(false)
  const [editing, setEditing] = useState<string[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [preflightReady, setPreflightReady] = useState(false)
  const [preflightId] = useState(() => crypto.randomUUID())
  const [workspaceLocked, setWorkspaceLocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [unlocking, setUnlocking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scope = useAgentRequestScope()
  const [submission] = useState(() => new BatchSubmission())
  const targets = useAgentQuery(
    JSON.stringify([accountsUnavailable, attempt]),
    async () => {
      if (accountsUnavailable) throw new Error(accountsUnavailable)
      return listAgentTargets(connectionId)
    },
  )
  const rows = targets.data ?? []
  const byId = new Map(rows.map((target) => [target.id, target]))
  const locked = busy || uncertain || workspaceLocked
  const productsVisible = draft.products.filter((product) => {
    const matches = `${product.name} ${effectiveProduct(draft, product).title}`
      .toLowerCase()
      .includes(productQuery.toLowerCase())
    const assigned = !!draft.assignments[product.id]
    return (
      matches &&
      (productFilter === 'all' || (productFilter === 'assigned' ? assigned : !assigned))
    )
  })
  const windowsVisible = rows.filter(
    (target) =>
      `${target.name} ${target.account?.account ?? ''} ${target.account?.note ?? ''} ${PROVIDERS[target.provider] ?? target.provider}`
        .toLowerCase()
        .includes(windowQuery.toLowerCase()) &&
      (windowFilter === 'all' || draft.windowIds.includes(target.id)) &&
      (windowAccountFilter === 'all' ||
        (windowAccountFilter === 'unknown'
          ? target.account === null
          : target.account?.status === windowAccountFilter)),
  )
  const pages = Math.max(1, Math.ceil(windowsVisible.length / pageSize))
  const currentPage = Math.min(windowPage, pages)
  const windowRows = windowsVisible.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  )
  const dependencyError =
    accountsUnavailable ??
    (draft.preset === 'post_listing' ? productsUnavailable : null) ??
    settingsUnavailable ??
    targets.error ??
    (targets.loading ? '正在读取Profile与账号…' : null)
  const problems = draftProblems(draft, rows)
  const allSelected =
    productsVisible.length > 0 &&
    productsVisible.every((product) => selectedProducts.has(product.id))

  function updateWindows(ids: string[]) {
    if (new Set(ids).size > 100) {
      toast.error('每个批次最多选择 100 个Profile。')
      return
    }
    setDraft((previous) => setDraftWindows(previous, ids))
  }

  function assign(ids: string[], windowId: string | null) {
    if (locked) return
    if (windowId && byId.get(windowId)?.unavailable) return
    try {
      assignDraftProducts(draft, ids, windowId)
      setDraft((previous) => assignDraftProducts(previous, ids, windowId))
      setSelectedProducts(new Set())
    } catch (cause) {
      toast.error(agentError(cause))
    }
  }

  function drag(event: DragEvent, id: string) {
    const ids = selectedProducts.has(id) ? [...selectedProducts] : [id]
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids))
    event.dataTransfer.effectAllowed = 'move'
  }

  function drop(event: DragEvent, windowId: string | null) {
    event.preventDefault()
    if (locked) return
    try {
      const ids: unknown = JSON.parse(event.dataTransfer.getData(DRAG_TYPE))
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 100 ||
        !ids.every((id) => typeof id === 'string')
      )
        throw new Error('无效的商品拖放，请使用勾选与分配按钮。')
      assign(ids, windowId)
    } catch (cause) {
      toast.error(agentError(cause))
    }
  }

  async function create(retry = false) {
    if (busy || workspaceLocked || (uncertain && !retry) || (!retry && dependencyError))
      return
    const current = scope.begin()
    let submitted = false
    setBusy(true)
    setError(null)
    try {
      // Re-read eligibility immediately before freezing the request; blocked updates must win.
      const freshTargets = retry ? [] : await listAgentTargets(connectionId)
      if (!current()) return
      const input = retry
        ? submission.original()
        : submission.prepare(draft, freshTargets)
      if (!retry) {
        const preflight = await checkAgentPreflight(input, connectionId)
        if (!current()) return
        if (!preflight.ready) throw new Error('运行前检查未通过，请重新检查资料与关系。')
      }
      submitted = true
      const batch = await createAgentBatch(input, connectionId)
      if (!current()) return
      setConfirming(false)
      setUncertain(false)
      setSelectedProducts(new Set())
      onCreated(batch)
    } catch (cause) {
      if (current()) {
        setError(agentError(cause))
        setUncertain(submitted || uncertain)
        setConfirming(false)
        if (!submitted) setAttempt((value) => value + 1)
      }
    } finally {
      if (current()) setBusy(false)
    }
  }

  function windowCard(target: AgentTarget) {
    const selected = draft.windowIds.includes(target.id)
    const products = draft.products.filter(
      (product) => draft.assignments[product.id] === target.id,
    )
    return (
      <article
        key={target.id}
        className={cn(
          'flex min-w-0 flex-col gap-2 rounded-control border border-stroke-soft-200 p-3',
          selected && 'border-primary-base!',
        )}
        data-blocked={target.account?.status === 'blocked' || undefined}
        onDragOver={(event) => {
          if (!locked && selected && !target.unavailable) event.preventDefault()
        }}
        onDrop={(event) => {
          if (selected && !target.unavailable) drop(event, target.id)
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Checkbox
            checked={selected}
            aria-label={`选择Profile ${target.name}`}
            disabled={locked || (!!target.unavailable && !selected)}
            onCheckedChange={(checked) =>
              updateWindows(
                checked === true
                  ? [...draft.windowIds, target.id]
                  : draft.windowIds.filter((id) => id !== target.id),
              )
            }
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere [&>span]:text-help [&>span]:text-text-sub-600">
            <strong>{target.name}</strong>
            <span>
              {target.account?.account ?? '账号未关联 / 不可见'} ·{' '}
              {PROVIDERS[target.provider] ?? target.provider}
            </span>
          </div>
          <Badge
            variant={target.account?.status === 'blocked' ? 'destructive' : 'outline'}
          >
            {target.account ? ACCOUNT_STATES[target.account.status] : '未关联'}
          </Badge>
        </div>
        {target.unavailable ? (
          <p className="text-help text-error-text">{target.unavailable}</p>
        ) : null}
        {selected && draft.preset === 'post_listing' ? (
          <>
            <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-help [&>*]:shrink-0">
              <span className="text-text-sub-600">
                {products.length} 件商品 · 拖到此处或点击分配
              </span>
              <Button
                variant="outline"
                disabled={locked || !!target.unavailable || !selectedProducts.size}
                aria-label={`分配到 ${target.name}`}
                onClick={() => assign([...selectedProducts], target.id)}
              >
                分配选中
              </Button>
            </div>
            {products.map((product) => (
              <div
                key={product.id}
                className="flex min-w-0 items-center gap-2 border-b border-stroke-soft-200 py-1 text-help [&[draggable=true]]:cursor-grab"
                draggable={!locked}
                onDragStart={(event) => drag(event, product.id)}
              >
                {product.images[0] ? (
                  <AgentProductCover image={product.images[0]} />
                ) : (
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-control bg-bg-weak-50 text-micro text-text-soft-400">
                    无图
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere [&>span]:text-help [&>span]:text-text-sub-600">
                  <strong>{product.name}</strong>
                  <span>{effectiveProduct(draft, product).title || '待补标题'}</span>
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={locked}
                  aria-label={`取消 ${product.name} 的分配`}
                  onClick={() => assign([product.id], null)}
                >
                  <X />
                </Button>
              </div>
            ))}
          </>
        ) : null}
        {selected && draft.preset === 'message' ? (
          <FieldGroup className="pt-2">
            <Field>
              <FieldLabel htmlFor={`conversation-${target.id}`}>
                Conversation ID
              </FieldLabel>
              <Input
                inputSize="xsmall"
                id={`conversation-${target.id}`}
                inputMode="numeric"
                maxLength={32}
                value={draft.messages[target.id]?.conversationId ?? ''}
                disabled={locked}
                placeholder="明确指定此Profile中的会话 ID"
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    messages: {
                      ...previous.messages,
                      [target.id]: {
                        text: previous.messages[target.id]?.text ?? '',
                        conversationId: event.target.value,
                      },
                    },
                  }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`message-${target.id}`}>英文消息</FieldLabel>
              <Textarea
                id={`message-${target.id}`}
                value={draft.messages[target.id]?.text ?? ''}
                maxLength={4000}
                disabled={locked}
                placeholder="只发送到上方明确指定的会话"
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    messages: {
                      ...previous.messages,
                      [target.id]: {
                        conversationId:
                          previous.messages[target.id]?.conversationId ?? '',
                        text: event.target.value,
                      },
                    },
                  }))
                }
              />
            </Field>
          </FieldGroup>
        ) : null}
      </article>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <WorkspaceLibrary
        draft={draft}
        locked={busy || uncertain}
        onLockChange={setWorkspaceLocked}
        onLoaded={(loaded) => {
          setDraft(loaded)
          setAttempt((value) => value + 1)
        }}
      />
      <FieldGroup className="grid min-w-0 grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="agent-preset">任务预设</FieldLabel>
          <LabeledSelect
            id="agent-preset"
            ariaLabel="任务预设"
            value={draft.preset}
            disabled={locked}
            options={Object.entries(PRESET_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
            onValueChange={(preset) => {
              if (
                preset === 'post_listing' ||
                preset === 'inspect_accounts' ||
                preset === 'message'
              )
                setDraft((previous) => ({ ...previous, preset }))
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-concurrency">同时执行Profile数</FieldLabel>
          <Input
            inputSize="xsmall"
            id="agent-concurrency"
            type="number"
            min={1}
            max={10}
            value={draft.concurrency}
            disabled={locked}
            onChange={(event) =>
              setDraft((previous) => ({
                ...previous,
                concurrency: event.target.valueAsNumber,
              }))
            }
          />
        </Field>
        <Field className="col-span-full">
          <FieldLabel htmlFor="agent-instruction">任务指令（选填）</FieldLabel>
          <Textarea
            id="agent-instruction"
            value={draft.instruction}
            maxLength={4000}
            disabled={locked}
            placeholder="补充本批次要求；商品与Profile归属以明确分配为准"
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, instruction: event.target.value }))
            }
          />
        </Field>
      </FieldGroup>
      {dependencyError ? (
        <Alert variant="destructive">
          <AlertDescription>{dependencyError}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{uncertain ? '提交结果待核对' : '无法创建批次'}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          {uncertain ? (
            <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-help [&>*]:shrink-0">
              <Button variant="outline" disabled={busy} onClick={onRuns}>
                检查运行记录
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void create(true)
                }}
              >
                {busy ? '核对原请求…' : '核对原创建请求'}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setUnlocking(true)}
              >
                已核对，恢复编辑
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : null}
      <div
        className={cn(
          'grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-3',
          draft.preset !== 'post_listing' && 'grid-cols-1!',
        )}
      >
        {draft.preset === 'post_listing' ? (
          <section
            className="flex h-[460px] min-w-0 flex-col overflow-hidden rounded-control border border-stroke-soft-200 bg-bg-white-0"
            aria-label="本批次商品"
            onDragOver={(event) => {
              if (!locked) event.preventDefault()
            }}
            onDrop={(event) => drop(event, null)}
          >
            <div className="flex min-w-0 items-center justify-between gap-2 p-3">
              <strong>本批次商品 · {draft.products.length}</strong>
              <Button
                variant="outline"
                disabled={locked || !!productsUnavailable}
                onClick={() => setPicker(true)}
              >
                <Plus data-icon="inline-start" />
                商品库选择
              </Button>
            </div>
            <div className="flex min-w-0 items-center gap-2 px-3 pb-2 text-help [&>*]:min-w-0 [&>*]:flex-1">
              <Input
                inputSize="xsmall"
                aria-label="搜索本批次商品"
                placeholder="搜索商品"
                value={productQuery}
                onChange={(event) => setProductQuery(event.target.value)}
              />
              <LabeledSelect
                ariaLabel="商品分配筛选"
                value={productFilter}
                onValueChange={setProductFilter}
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'unassigned', label: '未分配' },
                  { value: 'assigned', label: '已分配' },
                ]}
              />
            </div>
            <div className="flex min-w-0 items-center gap-2 px-3 pb-2 text-help [&>*]:min-w-0 [&>*]:flex-1">
              <Checkbox
                checked={allSelected}
                indeterminate={
                  !allSelected &&
                  productsVisible.some((product) => selectedProducts.has(product.id))
                }
                aria-label="全选当前筛选商品"
                disabled={locked || !productsVisible.length}
                onCheckedChange={(checked) =>
                  setSelectedProducts((previous) => {
                    const next = new Set(previous)
                    for (const product of productsVisible) {
                      if (checked === true) next.add(product.id)
                      else next.delete(product.id)
                    }
                    return next
                  })
                }
              />
              <span>已勾选 {selectedProducts.size} 件</span>
              <Button
                variant="ghost"
                disabled={locked || !draft.products.length}
                onClick={() =>
                  setEditing(
                    selectedProducts.size
                      ? [...selectedProducts]
                      : draft.products.map((product) => product.id),
                  )
                }
              >
                批量编辑资料
              </Button>
              <Button
                variant="ghost"
                disabled={locked || !selectedProducts.size}
                onClick={() => assign([...selectedProducts], null)}
              >
                取消分配
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto overscroll-contain border-t border-stroke-soft-200 p-2">
              {productsVisible.map((product) => {
                const problems = listingProblems(draft, product)
                const assignedTo = draft.assignments[product.id]
                return (
                  <div
                    key={product.id}
                    className="flex min-w-0 items-center gap-2 border-b border-stroke-soft-200 p-2 text-help aria-selected:bg-bg-weak-50 [&[draggable=true]]:cursor-grab"
                    draggable={!locked}
                    onDragStart={(event) => drag(event, product.id)}
                  >
                    <Checkbox
                      checked={selectedProducts.has(product.id)}
                      disabled={locked}
                      aria-label={`勾选 ${product.name}`}
                      onCheckedChange={(checked) =>
                        setSelectedProducts((previous) => {
                          const next = new Set(previous)
                          if (checked === true) next.add(product.id)
                          else next.delete(product.id)
                          return next
                        })
                      }
                    />
                    <GripVertical
                      aria-hidden="true"
                      className="w-3 shrink-0 text-icon-sub-600"
                    />
                    {product.images[0] ? (
                      <AgentProductCover image={product.images[0]} />
                    ) : (
                      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-control bg-bg-weak-50 text-micro text-text-soft-400">
                        无图
                      </span>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere [&>span]:text-help [&>span]:text-text-sub-600">
                      <strong>{product.name}</strong>
                      <span>
                        {assignedTo
                          ? `→ ${byId.get(assignedTo)?.name ?? 'Profile不可见'}`
                          : '未分配Profile'}
                      </span>
                      <span>
                        {problems.length
                          ? problems.join(' · ')
                          : `${effectiveProduct(draft, product).currency} ${effectiveProduct(draft, product).price}`}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      disabled={locked}
                      aria-label={`编辑 ${product.name}`}
                      onClick={() => setEditing([product.id])}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={locked}
                      aria-label={`移除商品 ${product.name}`}
                      onClick={() => {
                        setDraft((previous) => removeDraftProduct(previous, product.id))
                        setSelectedProducts((previous) => {
                          const next = new Set(previous)
                          next.delete(product.id)
                          return next
                        })
                      }}
                    >
                      <X />
                    </Button>
                  </div>
                )
              })}
              {!productsVisible.length ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>尚无匹配商品</EmptyTitle>
                    <EmptyDescription>
                      从商品库选择，勾选后使用右侧分配按钮；也可拖放或拖回此处取消分配。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </div>
          </section>
        ) : null}
        <section
          className="flex h-[460px] min-w-0 flex-col overflow-hidden rounded-control border border-stroke-soft-200 bg-bg-white-0"
          aria-label="执行Profile"
        >
          <div className="flex min-w-0 items-center justify-between gap-2 p-3">
            <strong>执行Profile · 已选 {draft.windowIds.length} / 100</strong>
            <Button
              variant="outline"
              disabled={locked || targets.loading}
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RefreshCw data-icon="inline-start" />
              刷新Profile
            </Button>
          </div>
          <div className="flex min-w-0 items-center gap-2 px-3 pb-2 text-help [&>*]:min-w-0 [&>*]:flex-1">
            <Input
              inputSize="xsmall"
              aria-label="搜索执行Profile"
              placeholder="搜索Profile、账号或浏览器"
              value={windowQuery}
              onChange={(event) => {
                setWindowQuery(event.target.value)
                setWindowPage(1)
              }}
            />
            <LabeledSelect
              ariaLabel="执行Profile筛选"
              value={windowFilter}
              options={[
                { value: 'all', label: '全部Profile' },
                { value: 'selected', label: '已选Profile' },
              ]}
              onValueChange={(value) => {
                setWindowFilter(value)
                setWindowPage(1)
              }}
            />
            <LabeledSelect
              ariaLabel="执行Profile账号状态筛选"
              value={windowAccountFilter}
              options={[
                { value: 'all', label: '全部账号状态' },
                ...Object.entries(ACCOUNT_STATES).map(([value, label]) => ({
                  value,
                  label,
                })),
                { value: 'unknown', label: '未关联 / 未知' },
              ]}
              onValueChange={(value) => {
                setWindowAccountFilter(value)
                setWindowPage(1)
              }}
            />
          </div>
          <div className="flex min-w-0 items-center gap-2 px-3 pb-2 text-help [&>*]:min-w-0 [&>*]:flex-1">
            <Button
              variant="ghost"
              disabled={locked || !windowRows.some((target) => !target.unavailable)}
              onClick={() => {
                const ids = [
                  ...new Set([
                    ...draft.windowIds,
                    ...windowRows
                      .filter((target) => !target.unavailable)
                      .map((target) => target.id),
                  ]),
                ]
                if (ids.length > 100) toast.error('每批最多 100 个Profile，请减少选择。')
                else updateWindows(ids)
              }}
            >
              选择本页可用Profile
            </Button>
            <Button
              variant="ghost"
              disabled={locked || !draft.windowIds.length}
              onClick={() => updateWindows([])}
            >
              清空Profile选择
            </Button>
          </div>
          <div
            className="min-h-0 flex-1 space-y-2 overflow-auto overscroll-contain border-t border-stroke-soft-200 p-2"
            aria-busy={targets.loading}
          >
            {targets.loading ? <Skeleton className="h-24 w-full" /> : null}
            {windowRows.map(windowCard)}
            {targets.data && !windowRows.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>没有匹配Profile</EmptyTitle>
                  <EmptyDescription>
                    请调整筛选，或在Profile管理创建Profile并关联 Vinted 账号。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
          </div>
          <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 overflow-x-auto border-t border-stroke-soft-200 py-2 text-help tabular-nums [&>*]:shrink-0">
            <span>
              共 {windowsVisible.length} 个 · {currentPage} / {pages}
            </span>
            <LabeledSelect
              ariaLabel="每页执行Profile数"
              value={String(pageSize)}
              options={[20, 50, 100].map((value) => ({
                value: String(value),
                label: `${value} / 页`,
              }))}
              onValueChange={(value) => {
                setPageSize(Number(value))
                setWindowPage(1)
              }}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="上一页执行Profile"
              disabled={currentPage <= 1}
              onClick={() => setWindowPage(currentPage - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="下一页执行Profile"
              disabled={currentPage >= pages}
              onClick={() => setWindowPage(currentPage + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </section>
      </div>
      {problems.length ? (
        <Alert>
          <AlertTitle>创建前还需处理 {problems.length} 项</AlertTitle>
          <AlertDescription>
            <ul className="max-h-30 list-disc overflow-auto pl-4">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 [&_p]:text-help [&_p]:text-text-sub-600">
        <p>任务在后台执行。暂停停止后续派发；退出应用后重新打开须核对并恢复。</p>
        <Button
          variant="outline"
          disabled={locked}
          onClick={() => {
            setPreflightReady(false)
            setConfirming(true)
          }}
        >
          运行前检查
        </Button>
        <Button
          disabled={locked || !!dependencyError || problems.length > 0}
          onClick={() => {
            setPreflightReady(false)
            setConfirming(true)
          }}
        >
          检查并创建批次
        </Button>
      </div>
      {picker ? (
        <ProductPicker
          existingIds={draft.products.map((product) => product.id)}
          onAdd={(products) =>
            setDraft((previous) => addDraftProducts(previous, products))
          }
          onClose={() => setPicker(false)}
        />
      ) : null}
      {editing ? (
        <BatchProductEditor
          draft={draft}
          ids={editing}
          onClose={() => setEditing(null)}
          onSave={(overrides) =>
            setDraft((previous) => ({
              ...previous,
              overrides: { ...previous.overrides, ...overrides },
            }))
          }
        />
      ) : null}
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!busy) setConfirming(open)
        }}
      >
        <DialogContent className="sales-agent-dialog" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>确认创建任务</DialogTitle>
            <DialogDescription>
              {PRESET_LABELS[draft.preset]} · {draft.windowIds.length} 个Profile · 并发{' '}
              {draft.concurrency}。
              {draft.preset === 'post_listing'
                ? `共 ${draft.products.length} 件商品，确认后固定分配与资料快照。`
                : ''}
              {draft.preset === 'message'
                ? '按每个Profile明确填写的会话与英文消息发送。'
                : ''}
            </DialogDescription>
          </DialogHeader>
          {dependencyError || problems.length ? (
            <Alert variant="destructive">
              <AlertTitle>运行前还需处理</AlertTitle>
              <AlertDescription>
                {dependencyError}
                <ul className="max-h-30 list-disc overflow-auto pl-4">
                  {problems.map((problem, index) => (
                    <li key={index}>{problem}</li>
                  ))}
                </ul>
              </AlertDescription>
              <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-help [&>*]:shrink-0">
                <Button size="sm" variant="outline" onClick={onSettings}>
                  打开模型与执行设置
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!draft.products.length}
                  onClick={() => {
                    setConfirming(false)
                    setEditing(draft.products.map((product) => product.id))
                  }}
                >
                  编辑本批商品资料
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setConfirming(false)
                    setAttempt((value) => value + 1)
                  }}
                >
                  返回核对Profile与账号
                </Button>
              </div>
            </Alert>
          ) : null}
          {confirming && problems.length === 0 ? (
            <PreflightPanel
              input={batchInput(draft, rows, preflightId)}
              targets={rows}
              onReady={setPreflightReady}
              onSettings={onSettings}
            />
          ) : null}
          <div className="max-h-[min(480px,55svh)] overflow-auto overscroll-contain wrap-anywhere [&>div]:border-b [&>div]:border-stroke-soft-200 [&>div]:py-3">
            {draft.windowIds.map((id) => (
              <div key={id}>
                <strong>{byId.get(id)?.name ?? id}</strong>
                <p>{byId.get(id)?.account?.account}</p>
                {draft.preset === 'post_listing' ? (
                  <p>
                    {draft.products
                      .filter((product) => draft.assignments[product.id] === id)
                      .map((product) => product.name)
                      .join('、')}
                  </p>
                ) : null}
                {draft.preset === 'message' ? (
                  <p>
                    会话 {draft.messages[id]?.conversationId}：{draft.messages[id]?.text}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              返回编辑
            </Button>
            <Button
              disabled={
                busy || !!dependencyError || problems.length > 0 || !preflightReady
              }
              onClick={() => {
                void create()
              }}
            >
              {busy ? '核对并提交…' : '确认并创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={unlocking} onOpenChange={setUnlocking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认原请求未创建批次</AlertDialogTitle>
            <AlertDialogDescription>
              先在运行记录核对。已有批次请在原批次操作；创建新批次可能重复发布或发送消息。只有确认原请求未创建时才恢复编辑。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续核对</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setUncertain(false)
                setError(null)
                setAttempt((value) => value + 1)
              }}
            >
              已确认未创建，恢复编辑
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
