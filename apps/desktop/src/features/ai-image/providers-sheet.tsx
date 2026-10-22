import { useState, type FormEvent } from 'react'
import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toast'
import { removeProvider, saveProvider, testProvider, type ProviderInput } from './api'
import {
  DEFAULT_OPENAI_BASE_URL,
  PROVIDER_KINDS,
  message,
  type Provider,
  type ProviderKind,
} from './types'

interface FormState {
  id: string | null
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  imageModel: string
  textModel: string
  supportsVision: boolean
}

function emptyForm(): FormState {
  return {
    id: null,
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: DEFAULT_OPENAI_BASE_URL,
    apiKey: '',
    imageModel: 'gpt-image-1',
    textModel: 'gpt-4o-mini',
    supportsVision: true,
  }
}

function formOf(provider: Provider): FormState {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKey: '',
    imageModel: provider.imageModel,
    textModel: provider.textModel,
    supportsVision: provider.supportsVision,
  }
}

export function ProvidersSheet({
  providers,
  storageDurable,
  onOpenChange,
  onChanged,
}: {
  providers: Provider[]
  storageDurable: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => Promise<void>
}) {
  const [form, setForm] = useState<FormState>(emptyForm)
  const [pending, setPending] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Provider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function switchKind(kind: ProviderKind) {
    setForm((current) => ({
      ...current,
      kind,
      baseUrl:
        kind === 'openai' && current.baseUrl.trim() === ''
          ? DEFAULT_OPENAI_BASE_URL
          : current.baseUrl,
    }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    if (
      form.name.trim() === '' ||
      form.baseUrl.trim() === '' ||
      form.imageModel.trim() === ''
    ) {
      setError('名称、基础地址和生图模型都需要填写。')
      return
    }
    if (form.id === null && form.apiKey.trim() === '') {
      setError('新建配置需要填写 API Key。')
      return
    }
    setPending(true)
    setError(null)
    setNotice(null)
    const input: ProviderInput = {
      name: form.name.trim(),
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      imageModel: form.imageModel.trim(),
      textModel: form.textModel.trim(),
      supportsVision: form.supportsVision,
      ...(form.id === null ? {} : { id: form.id }),
      ...(form.apiKey.trim() === '' ? {} : { apiKey: form.apiKey.trim() }),
    }
    try {
      const saved = await saveProvider(input)
      await onChanged()
      setForm(formOf(saved))
      setNotice(`已保存「${saved.name}」`)
      toast.success('模型配置已保存')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  async function test(provider: Provider) {
    if (testing !== null) return
    setTesting(provider.id)
    setError(null)
    setNotice(null)
    try {
      const result = await testProvider(provider.id)
      setNotice(
        `${provider.name}：${result.message}（${String(result.durationMs)} 毫秒）`,
      )
    } catch (cause) {
      setError(`${provider.name}：${message(cause)}`)
    } finally {
      setTesting(null)
    }
  }

  async function confirmRemove() {
    if (removing === null) return
    setPending(true)
    setError(null)
    try {
      await removeProvider(removing.id)
      await onChanged()
      if (form.id === removing.id) setForm(emptyForm())
      setRemoving(null)
      toast.success('已删除模型配置')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>模型配置</SheetTitle>
          <SheetDescription>
            生图与文案各用一个模型，可以来自同一服务商。只支持 OpenAI 官方与 OpenAI
            兼容接口。
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="ai-provider-body">
          <section className="ai-provider-list" aria-label="已保存的服务商">
            {providers.length === 0 ? (
              <p className="ai-muted">还没有保存服务商。填写下面的表单后可以开始生成。</p>
            ) : null}
            {providers.map((provider) => (
              <div key={provider.id} className="ai-provider-row">
                <div className="ai-provider-main">
                  <div className="ai-provider-title">
                    <strong>{provider.name}</strong>
                    <Badge variant="secondary">
                      {provider.kind === 'openai' ? 'OpenAI 官方' : 'OpenAI 兼容'}
                    </Badge>
                    {provider.hasApiKey ? null : (
                      <Badge variant="destructive">缺少 Key</Badge>
                    )}
                  </div>
                  <p className="ai-provider-meta">{provider.baseUrl}</p>
                  <p className="ai-provider-meta">
                    生图 {provider.imageModel}
                    {provider.textModel === ''
                      ? ' · 未配置文案模型'
                      : ` · 文案 ${provider.textModel}`}
                    {provider.hasApiKey ? ` · Key ${provider.apiKeyHint}` : ''}
                  </p>
                </div>
                <div className="ai-provider-actions">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={testing !== null || pending}
                    onClick={() => void test(provider)}
                  >
                    {testing === provider.id ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : null}
                    测试
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setForm(formOf(provider))
                      setNotice(null)
                      setError(null)
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`删除 ${provider.name}`}
                    disabled={pending}
                    onClick={() => setRemoving(provider)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
          </section>

          <form id="ai-provider-form" className="ai-provider-form" onSubmit={submit}>
            <div className="ai-form-head">
              <h3>{form.id === null ? '新增服务商' : '编辑服务商'}</h3>
              {form.id === null ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setForm(emptyForm())}
                >
                  <Plus data-icon="inline-start" />
                  新建
                </Button>
              )}
            </div>
            <div className="ai-form-grid">
              <Field>
                <FieldLabel htmlFor="ai-provider-name">名称</FieldLabel>
                <Input
                  id="ai-provider-name"
                  maxLength={60}
                  value={form.name}
                  disabled={pending}
                  onChange={(event) => update('name', event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="ai-provider-kind">接口类型</FieldLabel>
                <LabeledSelect
                  id="ai-provider-kind"
                  ariaLabel="接口类型"
                  value={form.kind}
                  disabled={pending}
                  options={PROVIDER_KINDS.map((entry) => ({
                    value: entry.value,
                    label: entry.label,
                  }))}
                  onValueChange={(value) =>
                    switchKind(value === 'openai' ? 'openai' : 'openai_compatible')
                  }
                />
                <FieldDescription>
                  {PROVIDER_KINDS.find((entry) => entry.value === form.kind)?.hint}
                </FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="ai-provider-base">基础地址</FieldLabel>
              <Input
                id="ai-provider-base"
                maxLength={300}
                placeholder={DEFAULT_OPENAI_BASE_URL}
                value={form.baseUrl}
                disabled={pending}
                onChange={(event) => update('baseUrl', event.target.value)}
              />
              <FieldDescription>
                写到版本段为止，例如 https://api.openai.com/v1 或自建网关的 /v1 地址。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="ai-provider-key">API Key</FieldLabel>
              <Input
                id="ai-provider-key"
                type="password"
                autoComplete="off"
                maxLength={400}
                placeholder={form.id === null ? 'sk-…' : '留空表示不修改已保存的 Key'}
                value={form.apiKey}
                disabled={pending}
                onChange={(event) => update('apiKey', event.target.value)}
              />
              <FieldDescription>
                明文保存在插件私有目录的 ai-image.json（权限
                0600），宿主不托管；只用于请求你填写的接口地址。
              </FieldDescription>
            </Field>
            <div className="ai-form-grid">
              <Field>
                <FieldLabel htmlFor="ai-provider-image">生图模型</FieldLabel>
                <Input
                  id="ai-provider-image"
                  maxLength={120}
                  placeholder="gpt-image-1"
                  value={form.imageModel}
                  disabled={pending}
                  onChange={(event) => update('imageModel', event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="ai-provider-text">文案模型</FieldLabel>
                <Input
                  id="ai-provider-text"
                  maxLength={120}
                  placeholder="gpt-4o-mini"
                  value={form.textModel}
                  disabled={pending}
                  onChange={(event) => update('textModel', event.target.value)}
                />
                <FieldDescription>留空则不生成标题与描述。</FieldDescription>
              </Field>
            </div>
            <div className="ai-switch-row">
              <Switch
                id="ai-provider-vision"
                checked={form.supportsVision}
                disabled={pending}
                onCheckedChange={(checked) => update('supportsVision', checked)}
              />
              <div>
                <label htmlFor="ai-provider-vision">文案模型支持识图</label>
                <p className="ai-muted">
                  开启后把生成的图片发给文案模型写标题与描述；关闭则不调用文案模型。
                </p>
              </div>
            </div>
            {storageDurable ? null : (
              <FieldDescription>
                宿主没有提供私有目录，这次保存的配置与记录只在内存中，重启后失效。
              </FieldDescription>
            )}
            {error === null ? null : (
              <FieldError role="alert" className="ai-inline-status">
                <XCircle aria-hidden="true" />
                {error}
              </FieldError>
            )}
            {notice === null ? null : (
              <p className="ai-inline-status" role="status">
                <CheckCircle2 aria-hidden="true" />
                {notice}
              </p>
            )}
          </form>
        </SheetBody>
        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button type="submit" form="ai-provider-form" disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {pending ? '保存中…' : '保存配置'}
          </Button>
        </SheetFooter>
      </SheetContent>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除模型配置</AlertDialogTitle>
            <AlertDialogDescription>
              删除「{removing?.name ?? ''}」后，它的 API Key
              与地址会一并从插件私有目录移除； 已有的生成记录会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault()
                void confirmRemove()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
