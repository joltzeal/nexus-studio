import { WindowSettingsSchema, type BrowserWindow } from '@nexus/contracts/browser'
import { create } from 'zustand'
import { defaultForm } from '../entities/profile/model/form'
import type { ProfileForm } from '../entities/profile/model/types'
import { useProfileUi } from '../entities/profile'
import { clean, nextTagColor, settleNativeTagWrites, useTags } from '../entities/tag'
import { proxyBulkParse, proxySave, useProxy } from '../entities/proxy'
import {
  closeProfileForm,
  nextProfileName,
  openPreparedProfileForm,
  problemsOf,
  useProfileForm,
  type CloakProfileFields,
} from '../features/profile-form/model/useProfileForm'
import { toast } from '../shared/model/toast'
import { nativeError } from './api'
import { cancelNativeProfileFormOpen } from './profile-form-adapter'
import { cancelBitProfileFormOpen } from './bit-form-adapter'
import { workspace } from './store'
import { nativeTagApi } from './tag-api'
import { profileProxyBinding, profileProxyChoice } from './profile-proxy'

export const useCloakForm = create<{
  connectionId: string | null
  operationId: string
  loading: boolean
  error: string | null
}>(() => ({ connectionId: null, operationId: '', loading: false, error: null }))

let opening = 0

export function cancelCloakProfileFormOpen() {
  opening++
}

const blankCloak = (): CloakProfileFields => ({
  platform: '其他',
  kernel: '__latest',
  geoip: true,
  timezone: '',
  locale: '',
  viewport: 'default',
  seed: '',
  platformIdentity: '',
  gpuVendor: '',
  hardwareConcurrency: '',
  deviceMemory: '',
  screenWidth: '',
  screenHeight: '',
  platformVersion: '',
  storageQuota: '',
  taskbarHeight: '',
  webrtcIp: '',
  noiseOff: false,
  allowThirdPartyCookies: false,
  sapiVoicesOff: false,
  maxTouchPoints: '',
  searchEngine: '',
  transparentProxy: false,
  transparentProxyDns: '',
  portableCookies: false,
  nativeFingerprint: false,
  startUrl: '',
})

function cloakOf(profile: BrowserWindow): CloakProfileFields {
  const config = profile.settings.cloakbrowser ?? {}
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const number = (value: unknown) => (typeof value === 'number' ? String(value) : '')
  return {
    platform: profile.settings.platform,
    // Editing never rebinds it; a missing label must not block other fields.
    kernel: profile.kernelVersion ?? '未绑定',
    geoip: profile.settings.geoip,
    timezone: profile.settings.timezone,
    locale: profile.settings.locale,
    viewport: profile.settings.viewport,
    seed: profile.settings.fingerprintSeed?.toString() ?? '',
    platformIdentity: text(config.platform) as CloakProfileFields['platformIdentity'],
    gpuVendor: text(config.gpuVendor) as CloakProfileFields['gpuVendor'],
    hardwareConcurrency: number(config.hardwareConcurrency),
    deviceMemory: number(config.deviceMemory),
    screenWidth: number(config.screenWidth),
    screenHeight: number(config.screenHeight),
    platformVersion: text(config.platformVersion),
    storageQuota: number(config.storageQuota),
    taskbarHeight: number(config.taskbarHeight),
    webrtcIp: text(config.webrtcIp),
    noiseOff: config.noise === false,
    allowThirdPartyCookies: config.allowThirdPartyCookies === true,
    sapiVoicesOff: config.sapiVoices === false,
    maxTouchPoints: number(config.maxTouchPoints),
    searchEngine: text(config.searchEngine),
    transparentProxy: config.transparentProxy === true,
    transparentProxyDns: text(config.transparentProxyDns),
    portableCookies: config.portableCookies === true,
    nativeFingerprint: config.nativeFingerprint === true,
    startUrl: profile.settings.startUrl,
  }
}

function fingerprintConfigOf(fields: CloakProfileFields) {
  const out: Record<string, string | number | boolean> = {}
  const text = (key: string, value: string) => {
    const trimmed = value.trim()
    if (trimmed) out[key] = trimmed
  }
  const number = (key: string, value: string) => {
    if (value.trim()) out[key] = Number(value)
  }
  if (fields.nativeFingerprint) out.nativeFingerprint = true
  text('platform', fields.platformIdentity)
  text('gpuVendor', fields.gpuVendor)
  number('hardwareConcurrency', fields.hardwareConcurrency)
  number('deviceMemory', fields.deviceMemory)
  number('screenWidth', fields.screenWidth)
  number('screenHeight', fields.screenHeight)
  text('platformVersion', fields.platformVersion)
  number('storageQuota', fields.storageQuota)
  number('taskbarHeight', fields.taskbarHeight)
  text('webrtcIp', fields.webrtcIp)
  if (fields.noiseOff) out.noise = false
  if (fields.allowThirdPartyCookies) out.allowThirdPartyCookies = true
  if (fields.sapiVoicesOff) out.sapiVoices = false
  number('maxTouchPoints', fields.maxTouchPoints)
  text('searchEngine', fields.searchEngine)
  if (fields.transparentProxy) out.transparentProxy = true
  text('transparentProxyDns', fields.transparentProxyDns)
  if (fields.portableCookies) out.portableCookies = true
  return Object.keys(out).length > 0 ? out : null
}

/** Raccoon metadata Cloak keeps in the optional fingerprint object: colour,
 *  and the code objects the tag relation uses. */
function metaOf(profile: BrowserWindow | null | undefined): {
  color: string
  previous: Record<string, unknown>
  config: Record<string, unknown>
} {
  const source = profile?.settings.shardbrowser
  const config = isRecord(source) ? { ...source } : {}
  const meta = config._meta
  const nav = isRecord(config.navigator) ? config.navigator : {}
  const previous = isRecord(meta) ? { ...meta } : {}
  return {
    color: typeof previous.color === 'string' ? previous.color : '',
    previous,
    config: {
      ...config,
      navigator: {
        ...nav,
        platform:
          typeof nav.platform === 'string' && nav.platform
            ? nav.platform
            : 'CloakBrowser',
      },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function formOf(profile: BrowserWindow | null, proxyId: string | null): ProfileForm {
  const form = defaultForm()
  return {
    ...form,
    id: profile?.id ?? '',
    name: profile?.name ?? nextProfileName(),
    notes: profile?.settings.note ?? '',
    proxy_id: profile ? profileProxyChoice(profile) : proxyId,
  }
}

export async function openCloakProfileForm(
  opts: { mode: 'edit'; id: string } | { mode: 'create'; proxyId?: string | null },
) {
  cancelNativeProfileFormOpen()
  cancelBitProfileFormOpen()
  const request = ++opening
  const connectionId = workspace.state.connectionId
  const connection = workspace.state.connections.find((row) => row.id === connectionId)
  const openShell = () => {
    if (opts.mode === 'edit')
      openPreparedProfileForm({ mode: 'edit', id: opts.id, provider: 'cloakbrowser' })
    else
      openPreparedProfileForm({
        mode: 'create',
        proxyId: opts.proxyId,
        provider: 'cloakbrowser',
      })
  }
  if (!connection || connection.providerId !== 'cloakbrowser') {
    openShell()
    useCloakForm.setState({
      connectionId,
      operationId: '',
      loading: false,
      error: '请选择已启用的 CloakBrowser Workspace',
    })
    useProfileForm.setState({
      status: 'error',
      error: '请选择已启用的 CloakBrowser Workspace',
    })
    return
  }
  const profile =
    (opts.mode === 'edit'
      ? workspace.state.profiles.find((row) => row.id === opts.id)
      : null) ?? null
  if (opts.mode === 'edit' && !profile) {
    openShell()
    useCloakForm.setState({
      connectionId,
      operationId: '',
      loading: false,
      error: 'Profile 不存在',
    })
    useProfileForm.setState({ status: 'error', error: 'Profile 不存在' })
    return
  }
  openShell()
  const operationId = crypto.randomUUID()
  useCloakForm.setState({ connectionId, operationId, loading: true, error: null })
  useProfileForm.setState({ cloakLoading: true })
  try {
    await Promise.all([
      opts.mode === 'create' ? workspace.loadKernels('cloakbrowser') : undefined,
      useProxy.getState().reload(),
    ])
    const proxies = useProxy.getState().proxies
    if (
      request !== opening ||
      workspace.state.connectionId !== connectionId ||
      !useProfileForm.getState().open
    )
      return
    const currentProfile =
      opts.mode === 'edit'
        ? (workspace.state.profiles.find((row) => row.id === opts.id) ?? null)
        : null
    if (opts.mode === 'edit' && !currentProfile) throw new Error('Profile 不存在')
    const listFolder = useProfileUi.getState().folder
    const metadata = metaOf(currentProfile)
    const draft = {
      form: {
        ...formOf(currentProfile, opts.mode === 'create' ? (opts.proxyId ?? null) : null),
        color: metadata.color,
      },
      folder: currentProfile?.groupId
        ? (workspace.state.folders.find((row) => row.id === currentProfile.groupId)
            ?.name ?? '')
        : opts.mode === 'create' && listFolder !== 'all'
          ? listFolder
          : '',
      tagIds: currentProfile
        ? [...(useTags.getState().byProfile[currentProfile.id] ?? [])]
        : [],
      newTags: [],
      newProxyLine: '',
      cookies: null,
      cloak: currentProfile ? cloakOf(currentProfile) : blankCloak(),
      bit: null,
    }
    if (
      draft.form.proxy_id &&
      !proxies.some((row) => row.id === draft.form.proxy_id) &&
      (!currentProfile || draft.form.proxy_id !== profileProxyChoice(currentProfile))
    ) {
      draft.form.proxy_id = currentProfile?.id ?? draft.form.proxy_id
    }
    useProfileForm.setState({
      draft,
      saved: structuredClone(draft),
      status: 'idle',
      error: null,
      cloakLoading: false,
    })
    useCloakForm.setState({ loading: false, error: null })
  } catch (cause) {
    if (request !== opening) return
    const error = nativeError(cause).message
    useProfileForm.setState({ status: 'error', error, cloakLoading: false })
    useCloakForm.setState({ loading: false, error })
  }
}

export function cloakFormProblem(): string | null {
  const context = useCloakForm.getState()
  const state = useProfileForm.getState()
  if (context.loading || state.cloakLoading)
    return state.mode === 'create' ? '正在读取 CloakBrowser 内核和代理' : '正在读取代理'
  if (context.connectionId !== workspace.state.connectionId)
    return 'Workspace 已切换，请重新打开表单'
  if (context.error) return context.error
  if (!state.draft) return '正在准备表单'
  const problems = problemsOf(state.draft)
  if (problems.name) return problems.name
  if (problems.notes) return problems.notes
  const first = problems.cloak && Object.values(problems.cloak)[0]
  if (first) return first
  if (workspace.state.pendingCreateId === context.operationId)
    return '创建结果待核对，请先核对操作'
  if (state.mode === 'create') {
    const blocked = workspace.createBlockReason()
    if (blocked) return blocked
  }
  return null
}

export async function saveCloakProfileForm(): Promise<boolean> {
  const state = useProfileForm.getState()
  const context = useCloakForm.getState()
  const draft = state.draft
  const problem = cloakFormProblem()
  if (!draft?.cloak || problem) return false
  const session = state.session
  const current = () => useProfileForm.getState().session === session
  const profile = state.id
    ? workspace.state.profiles.find((row) => row.id === state.id)
    : null
  if (state.mode === 'edit' && !profile) {
    useProfileForm.setState({ status: 'error', error: 'Profile 不存在' })
    return false
  }
  if (state.mode === 'create') {
    const blocked = workspace.createBlockReason()
    if (blocked) {
      useProfileForm.setState({ status: 'error', error: blocked })
      return false
    }
  } else if (profile?.state !== 'stopped') {
    useProfileForm.setState({ status: 'error', error: '请先确认 Profile 已停止' })
    return false
  }
  useProfileForm.setState({
    status: 'saving',
    error: null,
    errorDetail: null,
    tried: true,
  })
  try {
    let proxyId = draft.form.proxy_id
    if (draft.newProxyLine.trim()) {
      const [parsed] = await proxyBulkParse(draft.newProxyLine.trim(), 'socks5')
      if (!parsed) throw new Error('代理格式无效')
      proxyId = (await proxySave(parsed)).id
      await useProxy.getState().reload()
      if (current())
        useProfileForm.setState({
          draft: {
            ...draft,
            newProxyLine: '',
            form: { ...draft.form, proxy_id: proxyId },
          },
        })
    }
    let folder = workspace.state.folders.find((row) => row.name === draft.folder)
    if (draft.folder && !folder) folder = await workspace.saveFolder(draft.folder)
    if (workspace.state.connectionId !== context.connectionId)
      throw new Error('Workspace 已切换，请重新打开表单')
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
    const metadata = metaOf(profile)
    const config = {
      ...metadata.config,
      _meta: {
        ...metadata.previous,
        color: draft.form.color,
        raccoon_tag_ids: [...new Set(tagIds)],
      },
    }
    const seed = draft.cloak.seed.trim() === '' ? null : Number(draft.cloak.seed)
    const settings = WindowSettingsSchema.parse({
      platform: draft.cloak.platform,
      note: draft.form.notes,
      geoip: draft.cloak.geoip,
      timezone: draft.cloak.timezone,
      locale: draft.cloak.locale,
      viewport: draft.cloak.viewport,
      fingerprintSeed:
        state.mode === 'edit' ? (profile?.settings.fingerprintSeed ?? null) : seed,
      aliasEngine: null,
      operatingSystem: 'host',
      cpuCores: null,
      startUrl: draft.cloak.startUrl,
      shardbrowser: config,
      cloakbrowser: fingerprintConfigOf(draft.cloak),
    })
    const input = {
      name: draft.form.name.trim(),
      settings,
      groupId: folder?.id ?? null,
      ...profileProxyBinding(proxyId, profile),
    }
    let savedId = profile?.id
    if (state.mode === 'edit' && profile) {
      await workspace.update({ id: profile.id, ...input })
    } else {
      const created = await workspace.create({
        operationId: context.operationId,
        connectionId: context.connectionId!,
        kernelVersion: draft.cloak.kernel === '__latest' ? null : draft.cloak.kernel,
        ...input,
      })
      savedId = created.id
      // A later Cookie failure keeps an edit form for the saved identity.
      if (current())
        useProfileForm.setState({
          mode: 'edit',
          id: savedId,
          draft: { ...draft, form: { ...draft.form, id: savedId } },
        })
    }
    await useTags.getState().reload()
    toast.saved(state.mode === 'edit' ? 'Profile 已保存' : 'Profile 已创建')
    if (current()) closeProfileForm()
    return true
  } catch (cause) {
    if (current())
      useProfileForm.setState({ status: 'error', error: nativeError(cause).message })
    if (workspace.state.pendingCreateId !== context.operationId) {
      useCloakForm.setState({ operationId: crypto.randomUUID() })
    }
    return false
  }
}
