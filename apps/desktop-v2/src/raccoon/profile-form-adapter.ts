import { nativeCookiesImport } from './profile-cookies-api'
import { profileProxyBinding, profileProxyChoice } from './profile-proxy'
import { create } from 'zustand'
import { WindowSettingsSchema, type WindowSettings } from '@nexus/contracts/browser'
import type { ProfileForm } from '../entities/profile/model/types'
import { rememberForm } from '../entities/profile/lib/formCache'
import { fromStored, toStored } from '../entities/profile/model/form'
import { useProfile } from '../entities/profile/lib/useProfile'
import { useTags, nextTagColor, clean, settleNativeTagWrites } from '../entities/tag'
import { nativeTagApi } from './tag-api'
import { useProxy } from '../entities/proxy/lib/useProxy'
import { proxyBulkParse, proxySave } from '../entities/proxy'
import { useFingerprint } from '../entities/fingerprint/lib/useFingerprint'
import {
  closeProfileForm,
  openPreparedProfileForm,
  useProfileForm,
  type openProfileForm,
} from '../features/profile-form/model/useProfileForm'
import { nativeApi, nativeError } from './api'
import { nativeFingerprintApi, shardConnectionId } from './fingerprint-api'
import { workspace } from './store'
import { cancelCloakProfileFormOpen, openCloakProfileForm } from './cloak-form-adapter'
import { cancelBitProfileFormOpen, openBitProfileForm } from './bit-form-adapter'
import { toast } from '../shared/model/toast'

export const useNativeForm = create<{
  connectionId: string | null
  operationId: string
  kernelVersion: string
  loading: boolean
  error: string | null
}>(() => ({
  connectionId: null,
  operationId: '',
  kernelVersion: '',
  loading: false,
  error: null,
}))

let openingRequest = 0

export function cancelNativeProfileFormOpen() {
  openingRequest++
}

export async function openNativeProfileForm(opts: Parameters<typeof openProfileForm>[0]) {
  const provider = workspace.state.connections.find(
    (row) => row.id === workspace.state.connectionId,
  )?.providerId
  if (provider === 'cloakbrowser') {
    await openCloakProfileForm(
      opts.mode === 'edit'
        ? { mode: 'edit', id: opts.id }
        : { mode: 'create', proxyId: opts.proxyId ?? null },
    )
    return
  }
  if (provider === 'bitbrowser') {
    await openBitProfileForm(
      opts.mode === 'edit'
        ? { mode: 'edit', id: opts.id }
        : { mode: 'create', proxyId: opts.proxyId ?? null },
    )
    return
  }
  cancelCloakProfileFormOpen()
  cancelBitProfileFormOpen()
  const request = ++openingRequest
  try {
    const connectionId = shardConnectionId()
    const blocked = opts.mode === 'create' ? workspace.createBlockReason() : null
    if (blocked) throw new Error(blocked)
    useNativeForm.setState({
      connectionId,
      operationId: crypto.randomUUID(),
      loading: true,
      error: null,
    })
    useProfileForm.setState({
      session: useProfileForm.getState().session + 1,
      open: true,
      mode: opts.mode,
      id: opts.mode === 'edit' ? opts.id : null,
      draft: null,
      saved: null,
      status: 'idle',
      error: null,
    })
    const [fingerprints] = await Promise.all([
      nativeFingerprintApi.list(),
      workspace.loadKernels(),
      useProxy.getState().reload(),
      useTags.getState().reload(),
    ])
    if (
      request !== openingRequest ||
      workspace.state.connectionId !== connectionId ||
      !useProfileForm.getState().open
    )
      return
    useProfile.setState({ fingerprints })
    useFingerprint.setState({ items: fingerprints, status: 'ready', error: null })
    const profile =
      opts.mode === 'edit'
        ? workspace.state.profiles.find((row) => row.id === opts.id)
        : null
    if (opts.mode === 'edit' && !profile) throw new Error('Profile 不存在')
    useNativeForm.setState({
      kernelVersion:
        profile?.kernelVersion ?? workspace.state.kernels?.installed[0]?.version ?? '',
      loading: false,
    })
    openPreparedProfileForm({ ...opts, provider: 'shardbrowser' })
  } catch (cause) {
    if (request !== openingRequest) return
    const error = nativeError(cause).message
    useNativeForm.setState({ loading: false, error: null })
    useProfileForm.setState({ status: 'error', error })
  }
}

export function nativeFormProblem(): string | null {
  const context = useNativeForm.getState()
  const form = useProfileForm.getState().draft?.form
  if (context.loading) return '正在读取 ShardBrowser 指纹库和已安装内核'
  if (context.connectionId !== workspace.state.connectionId)
    return 'Workspace 已切换，请重新打开表单'
  if (!context.kernelVersion) return '请先在实验室下载 ShardBrowser 内核'
  if (form && Array.from(form.name).length > 40) return 'Profile 名称最多 40 个字符'
  if (form && Array.from(form.notes).length > 120) return '备注最多 120 个字符'
  if (workspace.state.pendingCreateId === context.operationId)
    return '创建结果待核对，请先核对操作'
  return context.error
}

export async function loadNativeProfileForm(id: string) {
  const profile = workspace.state.profiles.find((row) => row.id === id)
  if (!profile) throw new Error('Profile 不存在')
  const config = await nativeApi.call('shardbrowser_profile_config', {
    connectionId: shardConnectionId(),
    id,
  })
  const form = fromStored(config)
  const loaded = {
    ...form,
    id,
    name: profile.name,
    notes: profile.settings.note,
    proxy_id: profileProxyChoice(profile),
  }
  rememberForm(loaded)
  return loaded
}

export async function saveNativeProfileForm(): Promise<boolean> {
  const formState = useProfileForm.getState()
  const context = useNativeForm.getState()
  const draft = formState.draft
  const problem = nativeFormProblem()
  if (!draft || problem) return false
  const session = formState.session
  const current = () => useProfileForm.getState().session === session
  useProfileForm.setState({
    status: 'saving',
    error: null,
    errorDetail: null,
    tried: true,
  })
  try {
    let proxyId = draft.form.proxy_id
    if (draft.newProxyLine) {
      const [parsed] = await proxyBulkParse(draft.newProxyLine, 'socks5')
      if (!parsed) throw new Error('代理格式无效')
      const proxy = await proxySave(parsed)
      proxyId = proxy.id
      if (current())
        useProfileForm.setState({
          draft: {
            ...draft,
            newProxyLine: '',
            form: { ...draft.form, proxy_id: proxyId },
          },
        })
      await useProxy.getState().reload()
    }
    const profile = formState.id
      ? workspace.state.profiles.find((row) => row.id === formState.id)
      : null
    let folder = workspace.state.folders.find((row) => row.name === draft.folder)
    if (draft.folder && !folder) folder = await workspace.saveFolder(draft.folder)
    if (workspace.state.connectionId !== context.connectionId)
      throw new Error('Workspace 已切换，请重新打开表单')
    const entry =
      useProfile
        .getState()
        .fingerprints.find((row) => row.id === draft.form.gpu_preset_id) ?? null
    const previous = profile
      ? await nativeApi.call('shardbrowser_profile_config', {
          connectionId: context.connectionId,
          id: profile.id,
        })
      : undefined
    const binding = profileProxyBinding(proxyId, profile)
    const config: Record<string, unknown> = toStored(
      { ...draft.form, proxy_id: binding.proxyId ?? null },
      entry,
      previous,
    )
    await settleNativeTagWrites()
    const registry = await nativeTagApi.list(context.connectionId!)
    const knownIds = new Set(registry.tags.map((tag) => tag.id))
    if (draft.tagIds.some((id) => !knownIds.has(id)))
      throw new Error('所选标签已删除，请重新选择后保存')
    const tagIds = [...draft.tagIds]
    for (const value of draft.newTags) {
      const name = clean(value)
      const existing = registry.tags.find(
        (tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
      const tag =
        existing ??
        (await nativeTagApi.save(
          { id: crypto.randomUUID(), name, color: nextTagColor(registry.tags) },
          undefined,
          context.connectionId!,
        ))
      if (!existing) registry.tags.push(tag)
      tagIds.push(tag.id)
    }
    const priorMetadata =
      previous &&
      typeof previous === 'object' &&
      '_meta' in previous &&
      previous._meta &&
      typeof previous._meta === 'object'
        ? previous._meta
        : {}
    const metadata = { ...priorMetadata, ...(config._meta as Record<string, unknown>) }
    delete metadata.raccoon_tags
    config._meta = { ...metadata, raccoon_tag_ids: [...new Set(tagIds)] }
    if (workspace.state.connectionId !== context.connectionId)
      throw new Error('Workspace 已切换，请重新打开表单')
    const settings: WindowSettings = WindowSettingsSchema.parse({
      ...(profile?.settings ?? {
        platform: '其他',
        note: '',
        geoip: true,
        timezone: '',
        locale: '',
        viewport: 'default',
        fingerprintSeed: null,
        aliasEngine: null,
        operatingSystem: 'host',
        cpuCores: null,
        startUrl: '',
      }),
      note: draft.form.notes,
      shardbrowser: config,
    })
    const input = {
      name: draft.form.name.trim(),
      settings,
      groupId: folder?.id ?? null,
      ...binding,
    }
    let savedId = formState.id
    if (formState.mode === 'edit' && savedId)
      await workspace.update({ id: savedId, ...input })
    else {
      const created = await workspace.create({
        operationId: context.operationId,
        connectionId: context.connectionId!,
        kernelVersion: context.kernelVersion,
        ...input,
      })
      savedId = created.id
      // Later cookie import failures keep an edit form for this saved identity.
      if (current())
        useProfileForm.setState({
          mode: 'edit',
          id: savedId,
          draft: { ...draft, form: { ...draft.form, id: savedId } },
        })
    }
    if (draft.cookies && savedId) {
      await nativeCookiesImport(savedId, draft.cookies.items)
      if (current())
        useProfileForm.setState((state) => ({
          draft: state.draft ? { ...state.draft, cookies: null } : null,
        }))
    }
    await useTags.getState().reload()
    if (current()) closeProfileForm()
    toast.saved(formState.mode === 'edit' ? 'Profile 已保存' : 'Profile 已创建')
    return true
  } catch (cause) {
    if (current())
      useProfileForm.setState({ status: 'error', error: nativeError(cause).message })
    if (workspace.state.pendingCreateId !== context.operationId)
      useNativeForm.setState({ operationId: crypto.randomUUID() })
    return false
  }
}

export async function saveNativeFormFields(form: ProfileForm): Promise<void> {
  const profile = workspace.state.profiles.find((row) => row.id === form.id)
  if (!profile) throw new Error('Profile 不存在')
  const previous = await nativeApi.call('shardbrowser_profile_config', {
    connectionId: shardConnectionId(),
    id: profile.id,
  })
  const entry =
    useProfile.getState().fingerprints.find((row) => row.id === form.gpu_preset_id) ??
    null
  const binding = profileProxyBinding(form.proxy_id, profile)
  const config = toStored(
    { ...form, proxy_id: binding.proxyId ?? null },
    entry,
    previous,
  ) as Record<string, unknown>
  const previousMeta =
    previous && typeof previous === 'object' && '_meta' in previous ? previous._meta : {}
  config._meta = {
    ...(previousMeta && typeof previousMeta === 'object' ? previousMeta : {}),
    ...(config._meta as Record<string, unknown>),
  }
  const settings = WindowSettingsSchema.parse({
    ...profile.settings,
    note: form.notes,
    shardbrowser: config,
  })
  await workspace.update({
    id: profile.id,
    name: form.name.trim(),
    groupId: profile.groupId,
    settings,
    ...binding,
  })
  rememberForm(form)
}
