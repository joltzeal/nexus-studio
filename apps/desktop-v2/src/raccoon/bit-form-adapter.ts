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
  type BitProfileFields,
} from '../features/profile-form/model/useProfileForm'
import { toast } from '../shared/model/toast'
import { nativeError } from './api'
import { cancelNativeProfileFormOpen } from './profile-form-adapter'
import { cancelCloakProfileFormOpen } from './cloak-form-adapter'
import { workspace } from './store'
import { nativeTagApi } from './tag-api'
import { profileProxyBinding, profileProxyChoice } from './profile-proxy'

export const useBitForm = create<{
  connectionId: string | null
  operationId: string
  loading: boolean
  error: string | null
}>(() => ({ connectionId: null, operationId: '', loading: false, error: null }))

let opening = 0
export function cancelBitProfileFormOpen() {
  opening++
}

const blankBit = (): BitProfileFields => ({
  kernel: '130',
  geoip: true,
  timezone: '',
  locale: '',
  viewport: 'default',
  startUrl: '',
  coreProduct: 'chrome',
  version: '',
  userAgent: '',
  ostype: 'PC',
  os: '',
  osVersion: '',
  gpuVendor: '',
  gpuRenderer: '',
  hardwareConcurrency: '',
  deviceMemory: '',
  screenWidth: '',
  screenHeight: '',
  devicePixelRatio: '',
  resolutionType: '',
  windowSizeLimit: '',
  canvas: '0',
  webgl: '0',
  audioContext: '0',
  mediaDevice: '0',
  speechVoices: '0',
  webRtc: '',
  ignoreHttpsErrors: '',
  position: '',
  isIpCreatePosition: '',
  lat: '',
  lng: '',
  precisionData: '',
  isIpCreateDisplayLanguage: '',
  displayLanguages: '',
  fontType: '',
  doNotTrack: '',
  clientRectNoiseEnabled: '',
  portScanProtect: '',
  portWhiteList: '',
  deviceInfoEnabled: '',
  computerName: '',
  macAddr: '',
  hostIp: '',
  disableSslCipherSuitesFlag: '',
  disableSslCipherSuites: '',
  enablePlugins: '',
  plugins: '',
  launchArgs: '',
  randomFingerprint: false,
})

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}
function number(value: unknown) {
  return typeof value === 'number' ? String(value) : ''
}
function switchValue(value: unknown) {
  return value === '1' ? '1' : '0'
}
function tri(value: unknown): '' | '0' | '1' {
  return value === true ? '1' : value === false ? '0' : ''
}

/** Minutes east of UTC for an IANA zone; BitBrowser takes the offset in hours. */
function zoneOffset(timeZone: string): number | undefined {
  if (!timeZone) return undefined
  try {
    const name = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value
    const match = /^GMT(?:([+-])(\d{1,2}):(\d{2}))?$/.exec(name ?? '')
    if (!match) return undefined
    const minutes = Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
    return match[1] === '-' ? -minutes : minutes
  } catch {
    return undefined
  }
}

function bitOf(profile: BrowserWindow): BitProfileFields {
  const config = profile.settings.bitbrowser ?? {}
  return {
    kernel: profile.kernelVersion ?? '130',
    geoip: profile.settings.geoip,
    timezone: profile.settings.timezone,
    locale: profile.settings.locale,
    viewport: profile.settings.viewport,
    startUrl: profile.settings.startUrl,
    coreProduct: config.coreProduct === 'firefox' ? 'firefox' : 'chrome',
    version: text(config.version),
    userAgent: text(config.userAgent),
    ostype: config.ostype || 'PC',
    os: text(config.os),
    osVersion: text(config.osVersion),
    gpuVendor: text(config.webglManufacturer),
    gpuRenderer: text(config.webglRender),
    hardwareConcurrency: number(config.hardwareConcurrency),
    deviceMemory: number(config.deviceMemory),
    screenWidth: number(config.resolutionWidth),
    screenHeight: number(config.resolutionHeight),
    devicePixelRatio: (config.devicePixelRatio ??
      '') as BitProfileFields['devicePixelRatio'],
    resolutionType:
      config.resolutionType === '0' ? '0' : config.resolutionType === '1' ? '1' : '',
    windowSizeLimit: tri(config.windowSizeLimit),
    canvas: switchValue(config.canvas),
    webgl: switchValue(config.webGL),
    audioContext: switchValue(config.audioContext),
    mediaDevice: switchValue(config.mediaDevice),
    speechVoices: switchValue(config.speechVoices),
    webRtc: (config.webRTC ?? '') as BitProfileFields['webRtc'],
    ignoreHttpsErrors: tri(config.ignoreHttpsErrors),
    position: (config.position ?? '') as BitProfileFields['position'],
    isIpCreatePosition: tri(config.isIpCreatePosition),
    lat: text(config.lat),
    lng: text(config.lng),
    precisionData: text(config.precisionData),
    isIpCreateDisplayLanguage: tri(config.isIpCreateDisplayLanguage),
    displayLanguages: text(config.displayLanguages),
    fontType: (config.fontType ?? '') as BitProfileFields['fontType'],
    doNotTrack: (config.doNotTrack ?? '') as BitProfileFields['doNotTrack'],
    clientRectNoiseEnabled: tri(config.clientRectNoiseEnabled),
    portScanProtect: (config.portScanProtect ??
      '') as BitProfileFields['portScanProtect'],
    portWhiteList: text(config.portWhiteList),
    deviceInfoEnabled: tri(config.deviceInfoEnabled),
    computerName: text(config.computerName),
    macAddr: text(config.macAddr),
    hostIp: text(config.hostIP),
    disableSslCipherSuitesFlag: tri(config.disableSslCipherSuitesFlag),
    disableSslCipherSuites: text(config.disableSslCipherSuites),
    enablePlugins: tri(config.enablePlugins),
    plugins: text(config.plugins),
    launchArgs: text(config.launchArgs),
    randomFingerprint: config.randomFingerprint === true,
  }
}

function bitConfigOf(fields: BitProfileFields) {
  const out: Record<string, unknown> = {}
  const put = (key: string, value: string) => {
    const trimmed = value.trim()
    if (trimmed) out[key] = trimmed
  }
  const int = (key: string, value: string) => {
    if (value.trim()) out[key] = Number(value)
  }
  const bool = (key: string, value: '' | '0' | '1') => {
    if (value) out[key] = value === '1'
  }
  out.coreProduct = fields.coreProduct || 'chrome'
  put('version', fields.version)
  put('userAgent', fields.userAgent)
  out.ostype = fields.ostype || 'PC'
  put('os', fields.os)
  put('osVersion', fields.osVersion)
  put('webglManufacturer', fields.gpuVendor)
  put('webglRender', fields.gpuRenderer)
  int('hardwareConcurrency', fields.hardwareConcurrency)
  int('deviceMemory', fields.deviceMemory)
  int('resolutionWidth', fields.screenWidth)
  int('resolutionHeight', fields.screenHeight)
  put('devicePixelRatio', fields.devicePixelRatio)
  put('resolutionType', fields.resolutionType)
  bool('windowSizeLimit', fields.windowSizeLimit)
  out.canvas = fields.canvas
  out.webGL = fields.webgl
  out.audioContext = fields.audioContext
  out.mediaDevice = fields.mediaDevice
  out.speechVoices = fields.speechVoices
  put('webRTC', fields.webRtc)
  bool('ignoreHttpsErrors', fields.ignoreHttpsErrors)
  put('position', fields.position)
  bool('isIpCreatePosition', fields.isIpCreatePosition)
  put('lat', fields.lat)
  put('lng', fields.lng)
  put('precisionData', fields.precisionData)
  bool('isIpCreateDisplayLanguage', fields.isIpCreateDisplayLanguage)
  put('displayLanguages', fields.displayLanguages)
  put('fontType', fields.fontType)
  put('doNotTrack', fields.doNotTrack)
  bool('clientRectNoiseEnabled', fields.clientRectNoiseEnabled)
  put('portScanProtect', fields.portScanProtect)
  put('portWhiteList', fields.portWhiteList)
  bool('deviceInfoEnabled', fields.deviceInfoEnabled)
  put('computerName', fields.computerName)
  put('macAddr', fields.macAddr)
  put('hostIP', fields.hostIp)
  bool('disableSslCipherSuitesFlag', fields.disableSslCipherSuitesFlag)
  put('disableSslCipherSuites', fields.disableSslCipherSuites)
  bool('enablePlugins', fields.enablePlugins)
  put('plugins', fields.plugins)
  put('launchArgs', fields.launchArgs)
  const offset = zoneOffset(fields.timezone)
  if (offset !== undefined) out.timezoneOffset = offset
  out.randomFingerprint = fields.randomFingerprint
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function metaOf(profile: BrowserWindow | null | undefined) {
  const source = profile?.settings.shardbrowser
  const config = isRecord(source) ? { ...source } : {}
  const meta = isRecord(config._meta) ? { ...config._meta } : {}
  return {
    color: typeof meta.color === 'string' ? meta.color : '',
    previous: meta,
    config,
  }
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

export async function openBitProfileForm(
  opts: { mode: 'edit'; id: string } | { mode: 'create'; proxyId?: string | null },
) {
  cancelNativeProfileFormOpen()
  cancelCloakProfileFormOpen()
  const request = ++opening
  const connectionId = workspace.state.connectionId
  const connection = workspace.state.connections.find((row) => row.id === connectionId)
  const openShell = () => {
    if (opts.mode === 'edit')
      openPreparedProfileForm({ mode: 'edit', id: opts.id, provider: 'bitbrowser' })
    else
      openPreparedProfileForm({
        mode: 'create',
        proxyId: opts.proxyId,
        provider: 'bitbrowser',
      })
  }
  if (!connection || connection.providerId !== 'bitbrowser') {
    openShell()
    const error = '请选择比特浏览器 Workspace'
    useBitForm.setState({ connectionId, operationId: '', loading: false, error })
    useProfileForm.setState({ status: 'error', error })
    return
  }
  const profile =
    opts.mode === 'edit'
      ? workspace.state.profiles.find((row) => row.id === opts.id)
      : null
  if (opts.mode === 'edit' && !profile) {
    openShell()
    useBitForm.setState({
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
  useBitForm.setState({ connectionId, operationId, loading: true, error: null })
  useProfileForm.setState({ cloakLoading: true })
  try {
    await useProxy.getState().reload()
    const proxies = useProxy.getState().proxies
    if (
      request !== opening ||
      workspace.state.connectionId !== connectionId ||
      !useProfileForm.getState().open
    )
      return
    const current =
      opts.mode === 'edit'
        ? (workspace.state.profiles.find((row) => row.id === opts.id) ?? null)
        : null
    if (opts.mode === 'edit' && !current) throw new Error('Profile 不存在')
    const listFolder = useProfileUi.getState().folder
    const metadata = metaOf(current)
    const draft = {
      form: {
        ...formOf(current, opts.mode === 'create' ? (opts.proxyId ?? null) : null),
        color: metadata.color,
      },
      folder: current?.groupId
        ? (workspace.state.folders.find((row) => row.id === current.groupId)?.name ?? '')
        : opts.mode === 'create' && listFolder !== 'all'
          ? listFolder
          : '',
      tagIds: current ? [...(useTags.getState().byProfile[current.id] ?? [])] : [],
      newTags: [],
      newProxyLine: '',
      cookies: null,
      cloak: null,
      bit: current ? bitOf(current) : blankBit(),
    }
    if (
      draft.form.proxy_id &&
      !proxies.some((row) => row.id === draft.form.proxy_id) &&
      (!current || draft.form.proxy_id !== profileProxyChoice(current))
    )
      draft.form.proxy_id = current?.id ?? draft.form.proxy_id
    useProfileForm.setState({
      draft,
      saved: structuredClone(draft),
      status: 'idle',
      error: null,
      cloakLoading: false,
    })
    useBitForm.setState({ loading: false, error: null })
  } catch (cause) {
    if (request !== opening) return
    const error = nativeError(cause).message
    useProfileForm.setState({ status: 'error', error, cloakLoading: false })
    useBitForm.setState({ loading: false, error })
  }
}

export function bitFormProblem(): string | null {
  const context = useBitForm.getState()
  const state = useProfileForm.getState()
  if (context.loading || state.cloakLoading) return '正在读取比特浏览器接入和代理'
  if (context.connectionId !== workspace.state.connectionId)
    return 'Workspace 已切换，请重新打开表单'
  if (context.error) return context.error
  if (!state.draft) return '正在准备表单'
  const problems = problemsOf(state.draft)
  if (problems.name) return problems.name
  if (problems.notes) return problems.notes
  const first = problems.bit && Object.values(problems.bit)[0]
  if (first) return first
  if (workspace.state.pendingCreateId === context.operationId)
    return '创建结果待核对，请先核对操作'
  if (state.mode === 'create') return workspace.createBlockReason()
  return null
}

export async function saveBitProfileForm(): Promise<boolean> {
  const state = useProfileForm.getState()
  const context = useBitForm.getState()
  const draft = state.draft
  const problem = bitFormProblem()
  if (!draft?.bit || problem) return false
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
    const settings = WindowSettingsSchema.parse({
      platform: '其他',
      note: draft.form.notes,
      geoip: draft.bit.geoip,
      timezone: draft.bit.timezone,
      locale: draft.bit.locale,
      viewport: draft.bit.viewport,
      fingerprintSeed: null,
      aliasEngine: null,
      operatingSystem: 'host',
      cpuCores: null,
      startUrl: draft.bit.startUrl,
      shardbrowser: config,
      bitbrowser: bitConfigOf(draft.bit),
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
        kernelVersion: draft.bit.kernel || null,
        ...input,
      })
      savedId = created.id
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
    if (workspace.state.pendingCreateId !== context.operationId)
      useBitForm.setState({ operationId: crypto.randomUUID() })
    return false
  }
}
