import { useEffect, useState } from 'react'
import {
  AgentItemControlSchema,
  type AgentItemControl,
  type AgentItemView,
  type AgentJobView,
} from '@nexus/plugin-sdk/agent'
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { navigateDetail } from '@/lib/detail-navigation'
import { agentError, controlAgentItem, listAgentItems } from './api'
import { AgentPagination } from './agent-pagination'
import { ArtifactCover } from './artifact-cover'
import { englishText } from './assignment'
import { recoveryHint } from './presentation'
import { itemControlReason, RequestScope } from './state'
import { useAgentQuery } from './use-query'

const ITEM_LABELS: Record<string, string> = {
  pending: '等待执行',
  reviewing: '审查中',
  preparing: '准备资料',
  submitting: '提交中',
  published: '已发布',
  skipped: '已跳过',
  review_required: '待人工审查',
  result_unknown: '结果待核对',
  sync_pending: '记录待同步',
  failed: '失败',
  cancelled: '已取消',
}

export function JobItems({
  jobId,
  windowName,
  jobState,
  revision = 0,
  onChanged,
}: {
  jobId: string
  windowName: string
  jobState: AgentJobView['state']
  revision?: number
  onChanged?: () => void
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<AgentItemView | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const result = useAgentQuery(
    JSON.stringify([jobId, page, pageSize, attentionOnly, attempt, revision]),
    () => listAgentItems(jobId, page, pageSize, attentionOnly),
    3000,
  )
  return (
    <section className="sales-agent-items" aria-label={`${windowName} 商品进度与审查`}>
      <div className="sales-agent-toolbar">
        <strong>{windowName} · 商品进度与审查</strong>
        <Button
          size="sm"
          variant={attentionOnly ? 'secondary' : 'outline'}
          onClick={() => {
            setAttentionOnly((value) => !value)
            setPage(1)
          }}
        >
          {attentionOnly ? '显示全部商品' : '只看待处理'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={result.loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          刷新商品
        </Button>
      </div>
      {notice ? (
        <p role="status" className="sales-agent-control-help">
          {notice}
        </p>
      ) : null}
      {result.error ? (
        <Alert variant="destructive">
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      ) : null}
      {result.loading ? <Skeleton className="h-24 w-full" /> : null}
      {result.data ? (
        <>
          <div className="sales-agent-table">
            <Table aria-label="商品任务进度">
              <TableHeader>
                <TableRow>
                  <TableHead>商品 / 当前文案</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>原因与恢复</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.items.map((item) => (
                  <TableRow key={item.productId}>
                    <TableCell>
                      <div className="sales-agent-inline">
                        <ArtifactCover
                          jobId={jobId}
                          artifactId={item.artifactId}
                          title={item.title || item.originalTitle}
                        />
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() =>
                            navigateDetail({ kind: 'product', id: item.productId })
                          }
                        >
                          {item.title || item.originalTitle || '查看商品'}
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          [
                            'review_required',
                            'result_unknown',
                            'sync_pending',
                            'failed',
                          ].includes(item.state)
                            ? 'destructive'
                            : 'outline'
                        }
                      >
                        {ITEM_LABELS[item.state] ?? '处理中'}
                      </Badge>
                      <p className="sales-agent-control-help">
                        修订 {item.controlRevision}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p>{item.reason || '—'}</p>
                      <p className="sales-agent-control-help">
                        {recoveryHint(item.state)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!result.error}
                        onClick={() => {
                          setNotice(null)
                          setSelected(item)
                        }}
                      >
                        查看与处理
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!result.data.items.length ? (
              <p className="sales-agent-control-help">没有匹配的商品任务。</p>
            ) : null}
          </div>
          <AgentPagination
            label="商品"
            total={result.data.total}
            page={result.data.page}
            pageSize={pageSize}
            busy={result.loading}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size)
              setPage(1)
            }}
          />
        </>
      ) : null}
      {selected ? (
        <ItemReview
          key={`${selected.productId}-${selected.controlRevision}`}
          item={selected}
          jobState={jobState}
          onClose={() => setSelected(null)}
          onReload={async () => {
            const fresh = await listAgentItems(jobId, page, pageSize, attentionOnly)
            const item = fresh.items.find((item) => item.productId === selected.productId)
            if (!item) throw new Error('商品已离开当前结果，请关闭后刷新列表核对。')
            setSelected(item)
            setAttempt((value) => value + 1)
            onChanged?.()
            return item
          }}
          onSaved={() => {
            setSelected(null)
            setAttempt((value) => value + 1)
            setNotice('商品操作已保存。执行前仍会核对账号、提交事实及最新资料。')
            onChanged?.()
          }}
        />
      ) : null}
    </section>
  )
}

export function ItemReview({
  item,
  jobState,
  onClose,
  onSaved,
  onReload,
}: {
  item: AgentItemView
  jobState: AgentJobView['state']
  onClose: () => void
  onSaved: () => void
  onReload: () => Promise<AgentItemView>
}) {
  const [title, setTitle] = useState(item.title)
  const [description, setDescription] = useState(item.description)
  const [price, setPrice] = useState('')
  const [fields, setFields] = useState({
    currency: '',
    condition: '',
    brand: '',
    size: '',
    category: '',
  })
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scope] = useState(() => new RequestScope())
  useEffect(() => () => scope.invalidate(), [scope])
  const reason = itemControlReason(item, jobState)
  const changed =
    title !== item.title ||
    description !== item.description ||
    price !== '' ||
    Object.values(fields).some(Boolean)
  const locked = busy || uncertain || !!reason

  async function control(action: AgentItemControl['action']) {
    if (locked) return
    if (action !== 'skip' && (!englishText(title) || !englishText(description))) {
      setError('请填写英文标题与描述，并保留真实商品事实。')
      return
    }
    const parsed = AgentItemControlSchema.safeParse({
      jobId: item.jobId,
      productId: item.productId,
      action,
      ...(action !== 'skip' && (changed || action === 'revise')
        ? {
            override: {
              title,
              description,
              ...(price === '' ? {} : { price: Number(price) }),
              ...Object.fromEntries(
                Object.entries(fields).filter(([, value]) => value !== ''),
              ),
            },
          }
        : {}),
    })
    if (!parsed.success) {
      setError('请检查标题、描述及选填价格；价格须为正数。')
      return
    }
    const current = scope.begin()
    setBusy(true)
    setError(null)
    try {
      const result = await controlAgentItem(parsed.data)
      if (!current()) return
      const receipt = result.items.find((control) => control.productId === item.productId)
      if (!receipt || receipt.revision <= item.controlRevision)
        throw new Error('商品操作修订未确认，请先读取最新资料。')
      onSaved()
    } catch (cause) {
      if (current()) {
        setUncertain(true)
        setError(`${agentError(cause)} 请先重新读取，不要重复操作。`)
      }
    } finally {
      if (current()) setBusy(false)
    }
  }

  async function reload() {
    if (busy) return
    const current = scope.begin()
    setBusy(true)
    try {
      await onReload()
      if (current()) {
        setUncertain(false)
        setError('已读取最新状态，请核对后决定下一步。')
      }
    } catch (cause) {
      if (current()) setError(agentError(cause))
    } finally {
      if (current()) setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sales-agent-dialog sales-agent-review-dialog">
        <DialogHeader>
          <DialogTitle>商品审查与修订</DialogTitle>
          <DialogDescription>
            对照原文、候选文案和判断原因。仅可修改未提交商品；已提交与未知结果保留核对入口。
          </DialogDescription>
        </DialogHeader>
        <div className="sales-agent-settings-body">
          <div className="sales-agent-inline">
            <ArtifactCover
              jobId={item.jobId}
              artifactId={item.artifactId}
              title={item.title}
            />
            <Badge variant="outline">{ITEM_LABELS[item.state] ?? '处理中'}</Badge>
            <span>修订 {item.controlRevision}</span>
          </div>
          <Alert>
            <AlertDescription>
              {item.reason || '暂无额外判断原因。'} {reason ?? recoveryHint(item.state)}
            </AlertDescription>
          </Alert>
          <div className="sales-agent-review-grid">
            <section>
              <strong>原始资料</strong>
              <p className="sales-agent-original-title">
                {item.originalTitle || '无标题'}
              </p>
              <p className="sales-agent-original-copy">
                {item.originalDescription || '无描述'}
              </p>
            </section>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="agent-review-title">候选英文标题</FieldLabel>
                <Input
                  id="agent-review-title"
                  value={title}
                  maxLength={500}
                  disabled={locked}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-review-description">候选英文描述</FieldLabel>
                <Textarea
                  id="agent-review-description"
                  value={description}
                  maxLength={6000}
                  disabled={locked}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-review-price">修订价格（选填）</FieldLabel>
                <Input
                  id="agent-review-price"
                  type="number"
                  min={0.01}
                  step="any"
                  value={price}
                  disabled={locked}
                  onChange={(event) => setPrice(event.target.value)}
                />
              </Field>
              <FieldGroup className="sales-agent-form-grid">
                <Field>
                  <FieldLabel htmlFor="agent-review-currency">币种（选填）</FieldLabel>
                  <LabeledSelect
                    id="agent-review-currency"
                    ariaLabel="修订币种"
                    value={fields.currency || 'keep'}
                    disabled={locked}
                    options={[
                      { value: 'keep', label: '保留原币种' },
                      ...['USD', 'GBP', 'EUR'].map((value) => ({ value, label: value })),
                    ]}
                    onValueChange={(value) =>
                      setFields((previous) => ({
                        ...previous,
                        currency: value === 'keep' ? '' : value,
                      }))
                    }
                  />
                </Field>
                {(['condition', 'brand', 'size', 'category'] as const).map((key) => (
                  <Field key={key}>
                    <FieldLabel htmlFor={`agent-review-${key}`}>
                      {
                        {
                          condition: '成色',
                          brand: '品牌',
                          size: '尺寸',
                          category: '分类',
                        }[key]
                      }
                      （选填）
                    </FieldLabel>
                    <Input
                      id={`agent-review-${key}`}
                      maxLength={key === 'category' ? 200 : 120}
                      value={fields[key]}
                      disabled={locked}
                      placeholder="留空保留原值"
                      onChange={(event) =>
                        setFields((previous) => ({
                          ...previous,
                          [key]: event.target.value,
                        }))
                      }
                    />
                  </Field>
                ))}
              </FieldGroup>
            </FieldGroup>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
              {uncertain ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void reload()}
                >
                  重新读取商品
                </Button>
              ) : null}
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="outline"
            disabled={locked}
            onClick={() => void control('skip')}
          >
            跳过此商品
          </Button>
          <Button
            variant="outline"
            disabled={locked || !changed}
            onClick={() => void control('revise')}
          >
            保存修订
          </Button>
          <Button disabled={locked} onClick={() => void control('approve')}>
            确认资料并继续
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
