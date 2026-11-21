import { WindowSettingsSchema, type WindowSettings } from '@nexus/contracts/browser'
import { fromStored, toStored } from '../../entities/profile/model/form'
import type { ProfileBatchContext } from './api'
import { batchProxySnapshot } from './proxy'
import { validBatchKernel, type ProfileBatchTemplate } from './controller'

export type ProfileBatchFields = {
  namePrefix: string
  templateId: string
  fingerprintId: string
  groupId: string
  proxyId: string
  kernelVersion: string
  aliasEngine: 'chromium' | 'firefox'
  note: string
  geoip: boolean
  timezone: string
  locale: string
  viewport: WindowSettings['viewport']
  startUrl: string
}

export function initialBatchFields(context: ProfileBatchContext): ProfileBatchFields {
  return {
    namePrefix: '',
    templateId: '',
    fingerprintId: context.fingerprints[0]?.id ?? '',
    groupId: '',
    proxyId: '',
    aliasEngine: 'chromium',
    kernelVersion: ['cloakbrowser', 'aliasmode'].includes(context.connection.providerId)
      ? '__latest'
      : context.connection.providerId === 'shardbrowser'
        ? (context.kernels[0] ?? '')
        : '',
    note: '',
    geoip: context.connection.capabilities.geoip && context.probe.capabilities.geoip,
    timezone: context.defaults.timezone === 'auto' ? '' : context.defaults.timezone,
    locale: context.defaults.language === 'auto' ? '' : context.defaults.language,
    viewport: 'default',
    startUrl: '',
  }
}

export function buildBatchTemplate(
  context: ProfileBatchContext,
  fields: ProfileBatchFields,
  defaults: Partial<WindowSettings> = {},
): ProfileBatchTemplate {
  const connection = context.connection
  const source = fields.templateId
    ? context.profiles.find((profile) => profile.id === fields.templateId)
    : null
  if (fields.templateId && !source) throw new Error('所选配置模板已不存在，请重新读取')
  if (source && source.connectionId !== connection.id)
    throw new Error('配置模板不属于当前 Workspace')
  const settings = WindowSettingsSchema.parse({
    ...{
      platform: '其他',
      note: '',
      geoip: false,
      timezone: '',
      locale: '',
      viewport: 'default',
      fingerprintSeed: null,
      aliasEngine: null,
      operatingSystem: 'host',
      cpuCores: null,
      startUrl: '',
    },
    ...structuredClone(source?.settings ?? {}),
    ...structuredClone(defaults),
    note: fields.note,
    geoip:
      connection.capabilities.geoip && context.probe.capabilities.geoip && fields.geoip,
    timezone: fields.timezone.trim(),
    locale: fields.locale.trim(),
    viewport: fields.viewport,
    startUrl: fields.startUrl.trim(),
    fingerprintSeed: null,
    aliasEngine: connection.providerId === 'aliasmode' ? fields.aliasEngine : null,
  })
  if (settings.startUrl) {
    const url = new URL(settings.startUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('起始地址需要是无账号密码的 HTTP(S) 地址')
  }
  if (connection.providerId === 'shardbrowser') {
    const fingerprint = context.fingerprints.find(
      (entry) => entry.id === fields.fingerprintId,
    )
    const payload = fingerprint?.payload ?? source?.settings.shardbrowser
    if (!payload || typeof payload !== 'object')
      throw new Error('请选择可用的 ShardBrowser 指纹模板')
    const form = fromStored(payload)
    form.id = ''
    form.rev = 0
    form.name = ''
    form.notes = fields.note
    form.proxy_id = null
    form.gpu_preset_id = fingerprint?.id ?? form.gpu_preset_id
    form.timezone = fields.timezone || 'auto'
    form.language = fields.locale || 'auto'
    if (!source) {
      form.webrtc = context.defaults.webrtc
      form.do_not_track = context.defaults.doNotTrack
      form.maximized = context.defaults.maximized
    }
    settings.shardbrowser = toStored(
      form,
      fingerprint ?? {
        id: form.gpu_preset_id,
        label: '',
        platform: '',
        chrome: '',
        gpu: '',
        tag_color: '',
        builtin: false,
        payload,
      },
    ) as NonNullable<WindowSettings['shardbrowser']>
    if (!context.kernels.includes(fields.kernelVersion))
      throw new Error('请选择已安装的 ShardBrowser 完整内核版本')
  } else if (connection.providerId === 'cloakbrowser') {
    settings.shardbrowser = null
    settings.bitbrowser = null
    if (
      fields.kernelVersion !== '__latest' &&
      !/^\d+(?:\.\d+){3,4}$/.test(fields.kernelVersion)
    )
      throw new Error('请选择完整的 CloakBrowser 内核版本')
  } else {
    settings.shardbrowser = null
    settings.cloakbrowser = null
    if (connection.providerId === 'adspower') settings.bitbrowser = null
    if (connection.providerId === 'aliasmode') {
      settings.bitbrowser = null
      if (
        fields.kernelVersion !== '__latest' &&
        !validBatchKernel('aliasmode', fields.aliasEngine, fields.kernelVersion)
      )
        throw new Error('请选择与 AliasMode 引擎对应的完整内核版本')
    }
  }
  if (fields.groupId && !context.folders.some((folder) => folder.id === fields.groupId))
    throw new Error('所选 Folder 已不存在')
  return {
    settings,
    groupId: fields.groupId || null,
    ...batchProxySnapshot(fields.proxyId, source, context.proxies, {
      manualProxy:
        connection.capabilities.manualProxy && context.probe.capabilities.manualProxy,
      proxyPlugin:
        connection.capabilities.proxyPlugin && context.probe.capabilities.proxyPlugin,
    }),
    kernelVersion:
      connection.providerId === 'adspower' ||
      !context.probe.capabilities.kernelSelection ||
      fields.kernelVersion === '__latest'
        ? null
        : fields.kernelVersion.trim() || null,
  }
}
