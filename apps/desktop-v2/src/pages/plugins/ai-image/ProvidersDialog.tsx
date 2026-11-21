import { useState } from 'react'
import { Alert, AlertModal, Button, Modal } from '@proxyshard/shardx-ui-kit'
import {
  removeProvider,
  saveProvider,
  testProvider,
} from '../../../raccoon/plugins/ai-image/api'
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_IMAGE_TIMEOUT_SECONDS,
  PROVIDER_KINDS,
  message,
  type ImageResponseMode,
  type Provider,
  type ProviderCatalog,
  type ProviderKind,
} from '../../../raccoon/plugins/ai-image/types'
import { usePluginTask } from '../usePluginTask'
import { AiInput, AiSelect, Failure, Section } from './fields'

interface Form {
  id?: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  imageModel: string
  visionModel: string
  minutes: string
  responseMode: ImageResponseMode
}
function emptyForm(): Form {
  return {
    name: '',
    kind: 'openai_compatible',
    baseUrl: '',
    apiKey: '',
    imageModel: '',
    visionModel: '',
    minutes: String(DEFAULT_IMAGE_TIMEOUT_SECONDS / 60),
    responseMode: 'auto',
  }
}
function providerForm(provider: Provider): Form {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKey: '',
    imageModel: provider.imageModel,
    visionModel: provider.visionModel ?? '',
    minutes: String(provider.imageTimeoutSeconds / 60),
    responseMode: provider.imageResponseMode,
  }
}

export function ProvidersDialog({
  catalog,
  canTestImage,
  onClose,
  onChanged,
  onImageTest,
}: {
  catalog: ProviderCatalog
  canTestImage: boolean
  onClose: () => void
  onChanged: () => Promise<void>
  onImageTest: (provider: Provider) => void
}) {
  const [form, setForm] = useState<Form>(emptyForm)
  const [baseline, setBaseline] = useState<Form>(emptyForm)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<Provider | null>(null)
  const [switching, setSwitching] = useState<{ provider: Provider | null } | null>(null)
  const task = usePluginTask()
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline)
  const editable =
    catalog.modelConfigVersion === 2 && catalog.transportSettingsVersion === 1
  function edit(provider: Provider | null) {
    const next = provider ? providerForm(provider) : emptyForm()
    setForm(next)
    setBaseline(next)
    setError(null)
    setNotice(null)
  }
  function choose(provider: Provider | null) {
    if (dirty) setSwitching({ provider })
    else edit(provider)
  }
  async function action(run: () => Promise<void>) {
    if (!task.acquire()) return
    const token = task.begin()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await run()
    } catch (cause) {
      if (task.current(token)) setError(message(cause))
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }
  async function save() {
    const token = task.begin()
    const minutes = Number(form.minutes)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60)
      throw new Error('等待时间为 1–60 整分钟')
    if (!form.name.trim() || (!form.imageModel.trim() && !form.visionModel.trim()))
      throw new Error('请填写名称，并至少配置一种模型')
    const saved = await saveProvider({
      ...(form.id ? { id: form.id } : {}),
      name: form.name,
      kind: form.kind,
      baseUrl: form.baseUrl || (form.kind === 'openai' ? DEFAULT_OPENAI_BASE_URL : ''),
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      imageModel: form.imageModel,
      visionModel: form.visionModel,
      imageTimeoutSeconds: minutes * 60,
      imageResponseMode: form.responseMode,
    })
    if (!task.current(token)) return
    const next = providerForm(saved)
    setForm(next)
    setBaseline(next)
    try {
      await onChanged()
    } catch (cause) {
      throw new Error(
        `配置已保存，但列表刷新失败：${message(cause)}。再次保存将更新同一个服务商`,
      )
    }
    if (task.current(token)) setNotice('服务商配置已保存')
  }
  async function connectivity(provider: Provider) {
    const token = task.begin()
    const result = await testProvider(provider.id)
    if (task.current(token))
      setNotice(
        `${result.ok ? '连通性检查完成' : '连通性检查未通过'}：${result.message} · ${result.durationMs} 毫秒。该检查仅访问 /models，不证明生图可用`,
      )
  }
  async function remove() {
    if (!removing) return
    const token = task.begin()
    const result = await removeProvider(removing.id)
    if (!result.removed) throw new Error('服务商未删除，请刷新核对')
    if (!task.current(token)) return
    if (form.id === removing.id) edit(null)
    setRemoving(null)
    try {
      await onChanged()
    } catch (cause) {
      throw new Error(`服务商已删除，但列表刷新失败：${message(cause)}`)
    }
  }
  return (
    <>
      <Modal
        open
        size="lg"
        title="模型服务商"
        description="配置识图与生图两种模型；密钥由插件明文保存在私有目录，不回显完整值。两种模型可来自不同服务商。"
        dirty={dirty}
        onClose={busy ? undefined : onClose}
        footer={
          <Button
            size="xsmall"
            disabled={!editable || busy || !dirty}
            isLoading={busy}
            onClick={() => void action(save)}
          >
            保存服务商
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          <Failure error={error} />
          {notice && (
            <Alert status="information" variant="lighter">
              {notice}
            </Alert>
          )}
          {!catalog.storageDurable && (
            <Alert status="warning" variant="lighter">
              当前插件存储仅在本次运行有效，重启不会保留配置
            </Alert>
          )}
          {!editable && (
            <Alert status="warning" variant="lighter">
              请更新插件以支持两种模型及请求设置，已有配置仍可查看
            </Alert>
          )}
          <Section title="已保存服务商">
            {catalog.items.map((provider) => (
              <div
                key={provider.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-stroke-soft-200 p-3"
              >
                <div className="min-w-0">
                  <p className="m-0 break-words text-body text-text-strong-950">
                    {provider.name}
                  </p>
                  <p className="my-1 break-words text-secondary text-text-sub-600">
                    生图：{provider.imageModel || '未配置'} · 识图：
                    {provider.visionModel || '未配置'}
                  </p>
                  <p className="m-0 text-help text-text-sub-600">
                    {provider.hasApiKey
                      ? `密钥已保存 · ${provider.apiKeyHint}`
                      : '未保存密钥'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xsmall"
                    mode="stroke"
                    variant="neutral"
                    disabled={busy}
                    onClick={() => choose(provider)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="xsmall"
                    mode="ghost"
                    variant="neutral"
                    disabled={
                      busy || !provider.hasApiKey || (dirty && form.id === provider.id)
                    }
                    onClick={() => void action(() => connectivity(provider))}
                  >
                    检查连通性
                  </Button>
                  {canTestImage && (
                    <Button
                      size="xsmall"
                      mode="ghost"
                      variant="neutral"
                      disabled={
                        busy ||
                        !provider.hasApiKey ||
                        !provider.imageModel ||
                        (dirty && form.id === provider.id)
                      }
                      onClick={() => onImageTest(provider)}
                    >
                      测试生图
                    </Button>
                  )}
                  <Button
                    size="xsmall"
                    mode="ghost"
                    variant="error"
                    disabled={busy}
                    onClick={() => setRemoving(provider)}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
            {!catalog.items.length && (
              <p className="m-0 text-secondary text-text-sub-600">尚未配置服务商</p>
            )}
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              className="self-start"
              disabled={busy}
              onClick={() => choose(null)}
            >
              新增服务商
            </Button>
          </Section>
          <Section title={form.id ? `编辑 · ${form.name}` : '新增服务商'}>
            <div className="grid gap-3 sm:grid-cols-2">
              <AiInput
                label="名称"
                value={form.name}
                disabled={!editable || busy}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
              <AiSelect
                label="服务商类型"
                value={form.kind}
                options={PROVIDER_KINDS}
                disabled={!editable || busy}
                onChange={(kind) => {
                  if (kind === 'openai' || kind === 'openai_compatible')
                    setForm({
                      ...form,
                      kind,
                      baseUrl:
                        kind === 'openai' && !form.baseUrl
                          ? DEFAULT_OPENAI_BASE_URL
                          : form.baseUrl,
                    })
                }}
              />
              <AiInput
                label="基础地址"
                value={form.baseUrl}
                placeholder={DEFAULT_OPENAI_BASE_URL}
                disabled={!editable || busy}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
              <AiInput
                label={form.id ? '新 API Key（留空保留原密钥）' : 'API Key'}
                type="password"
                value={form.apiKey}
                autoComplete="new-password"
                disabled={!editable || busy}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              />
              <AiInput
                label="生图模型"
                value={form.imageModel}
                disabled={!editable || busy}
                onChange={(event) => setForm({ ...form, imageModel: event.target.value })}
                hint="使用 Images generations / edits 协议"
              />
              <AiInput
                label="识图模型"
                value={form.visionModel}
                disabled={!editable || busy}
                onChange={(event) =>
                  setForm({ ...form, visionModel: event.target.value })
                }
                hint="使用 Chat Completions 多模态协议"
              />
              <AiInput
                label="生图等待时间（分钟）"
                value={form.minutes}
                inputMode="numeric"
                disabled={!editable || busy}
                onChange={(event) => setForm({ ...form, minutes: event.target.value })}
                hint="1–60 分钟，默认 15 分钟"
              />
              <AiSelect
                label="生图响应方式"
                value={form.responseMode}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'stream', label: '流式 SSE' },
                  { value: 'json', label: '普通 JSON' },
                ]}
                disabled={!editable || busy}
                onChange={(value) => {
                  if (value === 'auto' || value === 'stream' || value === 'json')
                    setForm({ ...form, responseMode: value })
                }}
              />
            </div>
          </Section>
        </div>
      </Modal>
      <AlertModal
        open={!!removing}
        status="warning"
        title={`删除服务商“${removing?.name ?? ''}”？`}
        description="历史模型快照保留；使用此服务商的最近选择会失效，需要重新选择。"
        isLoading={busy}
        confirmLabel="删除服务商"
        confirmVariant="error"
        onClose={() => {
          if (!busy) setRemoving(null)
        }}
        onConfirm={() => void action(remove)}
      />
      <AlertModal
        open={!!switching}
        status="warning"
        title="放弃未保存的服务商修改？"
        confirmLabel="放弃并切换"
        onClose={() => setSwitching(null)}
        onConfirm={() => {
          if (switching) edit(switching.provider)
          setSwitching(null)
        }}
      />
    </>
  )
}
