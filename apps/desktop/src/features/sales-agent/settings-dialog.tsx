import { useEffect, useState } from 'react'
import { AgentSettingsSchema, type AgentSettings } from '@nexus/plugin-sdk/agent'
import { RefreshCw } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toast'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ExecutionSettings, NotificationRetentionSettings } from './execution-settings'
import {
  getAgentSettings,
  saveAgentSettings,
  testAgentModel,
  type ModelKind,
} from './api'
import { useAgentQuery } from './use-query'
import { RequestScope } from './state'

function blankSettings(): AgentSettings {
  return {
    decision: { baseUrl: '', apiKey: '', model: '', protocol: 'typesafe' },
    generation: { baseUrl: '', apiKey: '', model: '' },
    requestTimeoutMs: 60_000,
    maxStepsPerItem: 30,
    maxCopyRewrites: 2,
    reviewThreshold: 0.8,
    execution: AgentSettingsSchema.shape.execution.parse({}),
    pricing: AgentSettingsSchema.shape.pricing.parse({}),
    notifications: AgentSettingsSchema.shape.notifications.parse({}),
    retention: AgentSettingsSchema.shape.retention.parse({}),
  }
}

export function AgentSettingsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => void
}) {
  const [attempt, setAttempt] = useState(0)
  const result = useAgentQuery(`settings-${attempt}`, async () => ({
    settings: await getAgentSettings(),
  }))
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sales-agent-dialog">
        <DialogHeader>
          <DialogTitle>Ecom Agent 设置</DialogTitle>
          <DialogDescription>
            判断模型负责结构化判断；生成模型同时负责识图和英文文案。配置由插件明文持久保存，不写入浏览器存储。
          </DialogDescription>
        </DialogHeader>
        {result.loading ? (
          <Skeleton className="h-32 w-full" aria-label="读取模型配置" />
        ) : null}
        {result.error ? (
          <Alert variant="destructive">
            <AlertDescription>模型配置读取失败，请检查插件状态后重试。</AlertDescription>
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              <RefreshCw data-icon="inline-start" />
              重新读取
            </Button>
          </Alert>
        ) : null}
        {result.data ? (
          <AgentSettingsForm initial={result.data.settings} onSaved={onSaved} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export function AgentSettingsForm({
  initial,
  onSaved,
}: {
  initial: AgentSettings | null
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<AgentSettings>(() => initial ?? blankSettings())
  const [saved, setSaved] = useState<AgentSettings | null>(initial)
  const [busy, setBusy] = useState<'save' | ModelKind | null>(null)
  const [tab, setTab] = useState('models')
  const [error, setError] = useState<string | null>(null)
  const [invalidField, setInvalidField] = useState<string | null>(null)
  const [tests, setTests] = useState<
    Partial<Record<ModelKind, Awaited<ReturnType<typeof testAgentModel>>>>
  >({})
  const [scope] = useState(() => new RequestScope())
  useEffect(() => () => scope.invalidate(), [scope])
  const dirty = saved === null || JSON.stringify(saved) !== JSON.stringify(draft)

  async function submit(kind?: ModelKind) {
    if (busy) return
    const parsed = AgentSettingsSchema.safeParse(draft)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!
      const [section, field] = issue.path
      setTab(
        section === 'execution' || section === 'pricing'
          ? 'execution'
          : section === 'notifications' || section === 'retention'
            ? 'notifications'
            : 'models',
      )
      setInvalidField(issue.path.join('.'))
      const model = section === 'decision' ? '判断模型' : '生成 / 识图模型'
      setError(
        section === 'decision' || section === 'generation'
          ? field === 'baseUrl'
            ? `请填写${model}的接口地址，使用 HTTPS 或本机 HTTP 地址。`
            : field === 'apiKey'
              ? `请填写${model}的 API Key。`
              : field === 'model'
                ? `请填写${model}的模型名称。`
                : `请检查${model}的协议。`
          : issue.code === 'custom'
            ? issue.message
            : '请检查当前设置中的地址、数字范围与必填项。',
      )
      return
    }
    setBusy(kind ?? 'save')
    setError(null)
    setInvalidField(null)
    if (kind)
      setTests((previous) => {
        const next = { ...previous }
        delete next[kind]
        return next
      })
    const current = scope.begin()
    let stage: 'save' | 'test' = 'save'
    try {
      if (dirty) {
        const settings = await saveAgentSettings(parsed.data)
        if (!current()) return
        setSaved(settings)
        setDraft(settings)
        setTests({})
        onSaved()
        toast.success('模型配置已保存。')
      }
      if (kind) {
        stage = 'test'
        const result = await testAgentModel(kind)
        if (current()) setTests((previous) => ({ ...previous, [kind]: result }))
      }
    } catch {
      // Provider/transport errors can contain a submitted key; do not echo them.
      if (current())
        setError(
          stage === 'save'
            ? '模型配置保存未确认，请保留当前输入并重试，或重新读取核对。'
            : '模型测试失败，请检查已保存的地址、密钥、模型名和服务商能力。',
        )
    } finally {
      if (current()) setBusy(null)
    }
  }

  function endpoint(kind: ModelKind, key: 'baseUrl' | 'apiKey' | 'model', value: string) {
    setError(null)
    setInvalidField(null)
    setDraft((previous) => ({
      ...previous,
      [kind]: { ...previous[kind], [key]: value },
    }))
  }
  function checkStatus(passed: boolean | undefined) {
    return dirty ? '保存后测试' : passed ? '通过' : '未测试'
  }

  return (
    <>
      <div className="sales-agent-settings-body">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="models">模型与测试</TabsTrigger>
            <TabsTrigger value="execution">执行与预算</TabsTrigger>
            <TabsTrigger value="notifications">通知与保留</TabsTrigger>
          </TabsList>
          <TabsContent value="models" className="sales-agent-settings-section">
            {(['decision', 'generation'] as const).map((kind) => (
              <FieldSet key={kind} disabled={busy !== null}>
                <FieldLegend>
                  {kind === 'decision' ? '判断模型' : '生成模型 · 识图与英文文案'}
                </FieldLegend>
                <FieldGroup className="sales-agent-form-grid">
                  {kind === 'decision' ? (
                    <Field>
                      <FieldLabel htmlFor="agent-decision-protocol">协议</FieldLabel>
                      <LabeledSelect
                        id="agent-decision-protocol"
                        ariaLabel="判断模型协议"
                        value={draft.decision.protocol}
                        disabled={busy !== null}
                        options={[
                          { value: 'typesafe', label: 'TypeSafe / Jev' },
                          { value: 'openai', label: 'OpenAI 兼容' },
                        ]}
                        onValueChange={(value) => {
                          if (value === 'typesafe' || value === 'openai')
                            setDraft((previous) => ({
                              ...previous,
                              decision: { ...previous.decision, protocol: value },
                            }))
                        }}
                      />
                    </Field>
                  ) : null}
                  <Field
                    className="sales-agent-field-wide"
                    data-invalid={invalidField === `${kind}.baseUrl` || undefined}
                  >
                    <FieldLabel htmlFor={`agent-${kind}-url`}>接口地址</FieldLabel>
                    <Input
                      id={`agent-${kind}-url`}
                      type="url"
                      value={draft[kind].baseUrl}
                      placeholder="https://provider.example/v1"
                      maxLength={2048}
                      autoComplete="off"
                      aria-invalid={invalidField === `${kind}.baseUrl` || undefined}
                      onChange={(event) => endpoint(kind, 'baseUrl', event.target.value)}
                    />
                  </Field>
                  <Field data-invalid={invalidField === `${kind}.apiKey` || undefined}>
                    <FieldLabel htmlFor={`agent-${kind}-key`}>API Key</FieldLabel>
                    <Input
                      id={`agent-${kind}-key`}
                      type="password"
                      value={draft[kind].apiKey}
                      maxLength={4096}
                      autoComplete="new-password"
                      spellCheck={false}
                      aria-invalid={invalidField === `${kind}.apiKey` || undefined}
                      onChange={(event) => endpoint(kind, 'apiKey', event.target.value)}
                    />
                  </Field>
                  <Field data-invalid={invalidField === `${kind}.model` || undefined}>
                    <FieldLabel htmlFor={`agent-${kind}-model`}>模型名称</FieldLabel>
                    <Input
                      id={`agent-${kind}-model`}
                      value={draft[kind].model}
                      maxLength={200}
                      autoComplete="off"
                      aria-invalid={invalidField === `${kind}.model` || undefined}
                      onChange={(event) => endpoint(kind, 'model', event.target.value)}
                    />
                  </Field>
                </FieldGroup>
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  title={
                    dirty
                      ? '先保存全部配置，成功后测试所选模型。'
                      : '实际调用插件测试已保存模型'
                  }
                  onClick={() => {
                    void submit(kind)
                  }}
                >
                  {busy === kind
                    ? '正在测试…'
                    : `${dirty ? '保存并测试' : '测试'}${kind === 'decision' ? '判断' : '生成 / 识图'}模型`}
                </Button>
                <div
                  className="sales-agent-toolbar"
                  aria-label={`${kind === 'decision' ? '判断' : '生成'}模型测试结果`}
                >
                  {kind === 'decision' ? (
                    <Badge variant="outline">
                      结构化判断：{checkStatus(tests.decision?.checks.judgement)}
                    </Badge>
                  ) : (
                    <>
                      <Badge variant="outline">
                        图片识别：{checkStatus(tests.generation?.checks.vision)}
                      </Badge>
                      <Badge variant="outline">
                        英文文案：{checkStatus(tests.generation?.checks.english)}
                      </Badge>
                    </>
                  )}
                  {!dirty && tests[kind] ? (
                    <span className="text-muted-foreground">{tests[kind]?.model}</span>
                  ) : null}
                </div>
              </FieldSet>
            ))}
            <FieldSet disabled={busy !== null}>
              <FieldLegend>执行限制</FieldLegend>
              <FieldGroup className="sales-agent-form-grid">
                {(
                  [
                    {
                      key: 'requestTimeoutMs',
                      label: '模型等待时间（毫秒）',
                      min: 5000,
                      max: 90_000,
                      step: 1000,
                    },
                    {
                      key: 'maxStepsPerItem',
                      label: '每件商品最多步骤',
                      min: 5,
                      max: 60,
                      step: 1,
                    },
                    {
                      key: 'maxCopyRewrites',
                      label: '文案最多改写次数',
                      min: 0,
                      max: 2,
                      step: 1,
                    },
                    {
                      key: 'reviewThreshold',
                      label: '审查置信度阈值',
                      min: 0.5,
                      max: 1,
                      step: 0.01,
                    },
                  ] as const
                ).map((field) => (
                  <Field key={field.key}>
                    <FieldLabel htmlFor={`agent-${field.key}`}>{field.label}</FieldLabel>
                    <Input
                      id={`agent-${field.key}`}
                      type="number"
                      value={Number.isFinite(draft[field.key]) ? draft[field.key] : ''}
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      onChange={(event) =>
                        setDraft((previous) => ({
                          ...previous,
                          [field.key]: event.target.valueAsNumber,
                        }))
                      }
                    />
                  </Field>
                ))}
              </FieldGroup>
              <FieldDescription>
                两个模型均需填写。测试会先保存修改；生成模型需支持图片输入和英文文案输出。
              </FieldDescription>
            </FieldSet>
          </TabsContent>
          <TabsContent value="execution" className="sales-agent-settings-section">
            <ExecutionSettings
              draft={draft}
              onChange={setDraft}
              disabled={busy !== null}
            />
          </TabsContent>
          <TabsContent value="notifications" className="sales-agent-settings-section">
            <NotificationRetentionSettings
              draft={draft}
              onChange={setDraft}
              disabled={busy !== null}
            />
          </TabsContent>
        </Tabs>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button
          disabled={busy !== null || !dirty}
          onClick={() => {
            void submit()
          }}
        >
          {busy === 'save' ? '保存中…' : '保存模型配置'}
        </Button>
      </DialogFooter>
    </>
  )
}
