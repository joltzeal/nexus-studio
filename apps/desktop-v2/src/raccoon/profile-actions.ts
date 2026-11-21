import { WindowSettingsSchema } from '@nexus/contracts/browser'
import type { ProfileForm, ProfileMeta } from '../entities/profile/model/types'
import { fromStored } from '../entities/profile/model/form'
import { useProfile } from '../entities/profile/lib/useProfile'
import { clip } from '../shared/lib/clipboard'
import { confirmModal } from '../shared/lib/confirm'
import { toast } from '../shared/model/toast'
import { nativeProfileSetPin } from './profile-cookies-api'
import { nativeApi } from './api'
import { nativeFingerprintApi, shardConnectionId } from './fingerprint-api'
import { loadNativeProfileForm, saveNativeFormFields } from './profile-form-adapter'
import { workspace } from './store'

function profile(id: string) {
  const row = workspace.state.profiles.find((item) => item.id === id)
  if (!row) throw new Error('Profile 不存在')
  return row
}

async function configFor(id: string): Promise<Record<string, unknown>> {
  const value = await nativeApi.call('shardbrowser_profile_config', {
    connectionId: shardConnectionId(),
    id,
  })
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Profile 配置格式无效')
  return value as Record<string, unknown>
}

export async function cloneNativeProfile(id: string) {
  const source = profile(id)
  if (source.state !== 'stopped') throw new Error('请先停止 Profile')
  if (source.providerId === 'cloakbrowser' || source.providerId === 'bitbrowser') {
    const names = new Set(workspace.state.profiles.map((row) => row.name))
    let suffix = 1
    const base = Array.from(source.name)
    let name = `${base.slice(0, 32).join('')} 副本`
    while (names.has(name)) name = `${base.slice(0, 28).join('')} 副本 ${++suffix}`
    await workspace.create({
      operationId: crypto.randomUUID(),
      connectionId: source.connectionId,
      name,
      settings: { ...source.settings, fingerprintSeed: null },
      kernelVersion: source.kernelVersion,
      groupId: source.groupId,
      proxyId: source.proxyId,
      proxyMode: source.proxyMode,
      proxy: source.proxy,
      proxyPlugin: source.proxyPlugin,
      proxyEndpoint: source.proxyEndpoint,
    })
    toast.saved('Profile 已克隆')
    return
  }
  const config = await configFor(id)
  config._meta = {
    ...(config._meta as Record<string, unknown>),
    id: '',
    pinned: false,
    rev: 0,
  }
  const names = new Set(workspace.state.profiles.map((row) => row.name))
  let suffix = 1
  const base = Array.from(source.name)
  let name = `${base.slice(0, 32).join('')} 副本`
  while (names.has(name)) name = `${base.slice(0, 28).join('')} 副本 ${++suffix}`
  config.name = name
  const form = fromStored(config)
  if (form.gpu_preset_id) {
    const picks = await nativeFingerprintApi.enrich(form.gpu_preset_id)
    const nav = config.navigator as Record<string, unknown>
    config.navigator = { ...nav, ...picks }
    if (
      config.client_hints &&
      typeof config.client_hints === 'object' &&
      picks.platform_version
    ) {
      config.client_hints = {
        ...config.client_hints,
        platform_version: picks.platform_version,
      }
    }
  }
  if (config.noise && typeof config.noise === 'object') {
    for (const block of Object.values(config.noise)) {
      if (block && typeof block === 'object' && !Array.isArray(block)) block.seed = 0
    }
  }
  const settings = WindowSettingsSchema.parse({
    ...source.settings,
    fingerprintSeed: null,
    shardbrowser: config,
  })
  await workspace.create({
    operationId: crypto.randomUUID(),
    connectionId: source.connectionId,
    name,
    settings,
    kernelVersion: source.kernelVersion,
    groupId: source.groupId,
    proxyId: source.proxyId,
    proxyMode: source.proxyMode,
    proxy: source.proxy,
    proxyPlugin: source.proxyPlugin,
    proxyEndpoint: source.proxyEndpoint,
  })
  toast.saved('Profile 已克隆')
}

export async function pinNativeProfile(given: ProfileMeta) {
  const current = workspace.state.connections.find(
    (row) => row.id === workspace.state.connectionId,
  )
  if (current?.providerId === 'cloakbrowser' || current?.providerId === 'bitbrowser') {
    toast.ok('当前浏览器暂不保存置顶')
    return
  }
  await nativeProfileSetPin(given.id, !given.pinned)
  await workspace.refresh()
}

export async function exportNativeProfiles(ids: string[]) {
  const configs = await Promise.all(
    ids.map(async (id) => {
      const row = profile(id)
      const config = await configFor(id)
      return {
        ...config,
        name: row.name,
        notes: row.settings.note,
        _meta: {
          ...(config._meta as Record<string, unknown>),
          proxy_id: row.proxyId ?? null,
        },
      }
    }),
  )
  await clip.write(JSON.stringify(configs, null, 2))
  toast.ok(`已复制 ${configs.length} 个 Profile 配置`)
}

export async function importNativeProfiles() {
  const text = await clip.read()
  if (text.length > 5 * 1024 * 1024) throw new Error('Profile JSON 超过 5 MB')
  const parsed: unknown = JSON.parse(text)
  const configs = Array.isArray(parsed) ? parsed : [parsed]
  if (configs.length === 0 || configs.length > 100)
    throw new Error('每次导入 1 至 100 个 Profile')
  const connectionId = shardConnectionId()
  await workspace.loadKernels()
  const kernelVersion = workspace.state.kernels?.installed[0]?.version
  if (!kernelVersion) throw new Error('请先安装 ShardBrowser 内核')
  for (const value of configs) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('navigator' in value)
    )
      throw new Error('Profile JSON 格式无效')
    const form = fromStored(value)
    const name = form.name.trim()
    if (!name || Array.from(name).length > 40)
      throw new Error('Profile 名称应为 1 至 40 个字符')
    const imported = structuredClone(value) as Record<string, unknown>
    const metadata =
      imported._meta &&
      typeof imported._meta === 'object' &&
      !Array.isArray(imported._meta)
        ? imported._meta
        : {}
    imported._meta = { ...metadata, id: '', rev: 0, pinned: false, raccoon_tag_ids: [] }
    const settings = WindowSettingsSchema.parse({
      platform: '其他',
      note: form.notes,
      geoip: true,
      timezone: '',
      locale: '',
      viewport: 'default',
      fingerprintSeed: null,
      aliasEngine: null,
      operatingSystem: 'host',
      cpuCores: null,
      startUrl: '',
      shardbrowser: imported,
    })
    if (workspace.state.connectionId !== connectionId) throw new Error('Workspace 已切换')
    const proxyId = form.proxy_id
    await workspace.create({
      operationId: crypto.randomUUID(),
      connectionId,
      name,
      settings,
      kernelVersion,
      groupId: null,
      proxyId,
      proxyMode: proxyId ? 'manual' : 'direct',
      proxy: null,
      proxyPlugin: null,
      proxyEndpoint: null,
    })
  }
  toast.saved(`已导入 ${configs.length} 个 Profile`)
}

export async function regenerateNativeProfiles(ids: string[]) {
  if (
    !(await confirmModal({
      title: '重新生成指纹',
      message: '将为选中的已停止 Profile 选择其他指纹模板并保存。',
      confirmLabel: '重新生成',
    }))
  )
    return 0
  const entries = await nativeFingerprintApi.list()
  useProfile.setState({ fingerprints: entries })
  if (entries.length === 0) return 0
  let changed = 0
  for (const id of ids) {
    try {
      if (profile(id).state !== 'stopped') throw new Error('请先停止 Profile')
      const form = await loadNativeProfileForm(id)
      const current = entries.find((row) => row.id === form.gpu_preset_id)
      const sameOs = entries.filter(
        (row) => row.platform === current?.platform && row.id !== current?.id,
      )
      const pool = sameOs.length ? sameOs : entries
      const selected = pool[Math.floor(Math.random() * pool.length)]
      if (!selected) continue
      const picks = await nativeFingerprintApi.enrich(selected.id)
      const templateForm = fromStored(selected.payload)
      const replacement: ProfileForm = {
        ...templateForm,
        id,
        name: form.name,
        notes: form.notes,
        proxy_id: form.proxy_id,
        color: form.color,
        gpu_preset_id: selected.id,
        hardware_concurrency:
          picks.hardware_concurrency ?? templateForm.hardware_concurrency,
        device_memory: picks.device_memory ?? templateForm.device_memory,
        platform_version: picks.platform_version ?? templateForm.platform_version,
      }
      await saveNativeFormFields(replacement)
      changed++
    } catch (error) {
      toast.fail({ title: '重新生成指纹失败', detail: error })
    }
  }
  if (changed) toast.saved(`已更新 ${changed} 个 Profile 指纹`)
  return changed
}
