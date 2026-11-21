import { isAbsolute } from 'node:path'
import { isKernelVersion } from './kernel-cache.js'

export interface RuntimeWindow {
  schema_version: 2
  id: string
  name: string
  binding: {
    provider_id: 'cloakbrowser'
    connection_id: 'builtin-cloakbrowser'
    profile_id: string
  }
  kernel_version: string
  binary_path: string
  proxy: string | null
  proxy_plugin: string | null
  proxy_endpoint: number | null
  proxy_mode: 'direct' | 'manual' | 'plugin'
  settings: {
    platform: string
    note: string
    geoip: boolean
    timezone: string
    locale: string
    viewport: string
    fingerprintSeed: number
    aliasEngine: null
    operatingSystem: 'host'
    cpuCores: null
    startUrl: string
    shardbrowser?: Record<string, unknown> | null
    cloakbrowser?: RuntimeCloakFingerprint | null
  }
  origin: 'created' | 'attached'
  provider_config: Record<string, unknown>
  created_at: number
  last_opened_at: number | null
  sort_order: number
}

export interface RuntimeCloakFingerprint {
  nativeFingerprint?: boolean
  platform?: 'windows' | 'macos' | 'linux'
  gpuVendor?: 'nvidia' | 'intel'
  hardwareConcurrency?: number
  deviceMemory?: number
  screenWidth?: number
  screenHeight?: number
  platformVersion?: string
  storageQuota?: number
  taskbarHeight?: number
  webrtcIp?: string
  noise?: boolean
  allowThirdPartyCookies?: boolean
  sapiVoices?: boolean
  maxTouchPoints?: number
  searchEngine?: string
  transparentProxy?: boolean
  transparentProxyDns?: string
  portableCookies?: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WINDOW_FIELDS = [
  'schema_version',
  'id',
  'name',
  'binding',
  'kernel_version',
  'binary_path',
  'proxy',
  'proxy_plugin',
  'proxy_endpoint',
  'proxy_mode',
  'settings',
  'origin',
  'provider_config',
  'created_at',
  'last_opened_at',
  'sort_order',
]
const BINDING_FIELDS = ['provider_id', 'connection_id', 'profile_id']
const SETTING_STRINGS = ['platform', 'note', 'timezone', 'locale', 'viewport', 'startUrl']
const SETTING_FIELDS = [
  ...SETTING_STRINGS,
  'geoip',
  'fingerprintSeed',
  'aliasEngine',
  'operatingSystem',
  'cpuCores',
]
const OPTIONAL_SETTING_FIELDS = ['shardbrowser', 'cloakbrowser']
const CLOAK_FIELDS = [
  'nativeFingerprint',
  'platform',
  'gpuVendor',
  'hardwareConcurrency',
  'deviceMemory',
  'screenWidth',
  'screenHeight',
  'platformVersion',
  'storageQuota',
  'taskbarHeight',
  'webrtcIp',
  'noise',
  'allowThirdPartyCookies',
  'sapiVoices',
  'maxTouchPoints',
  'searchEngine',
  'transparentProxy',
  'transparentProxyDns',
  'portableCookies',
]

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}

function reference(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0)
}

function proxyEndpoint(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  )
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function optionalSettingFields(value: Record<string, unknown>): boolean {
  return Object.keys(value).every(
    (field) => SETTING_FIELDS.includes(field) || OPTIONAL_SETTING_FIELDS.includes(field),
  )
}

function boundedInteger(value: unknown, low: number, high: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= low &&
    value <= high
  )
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname
  } catch {
    return false
  }
}

function validCloakFingerprint(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (
    !object(value) ||
    Object.keys(value).some((field) => !CLOAK_FIELDS.includes(field))
  ) {
    return false
  }
  return (
    optionalBoolean(value.nativeFingerprint) &&
    (value.platform === undefined ||
      ['windows', 'macos', 'linux'].includes(String(value.platform))) &&
    (value.gpuVendor === undefined ||
      ['nvidia', 'intel'].includes(String(value.gpuVendor))) &&
    (value.hardwareConcurrency === undefined ||
      boundedInteger(value.hardwareConcurrency, 1, 64)) &&
    (value.deviceMemory === undefined || boundedInteger(value.deviceMemory, 1, 64)) &&
    (value.screenWidth === undefined || boundedInteger(value.screenWidth, 800, 7680)) &&
    (value.screenHeight === undefined || boundedInteger(value.screenHeight, 600, 4320)) &&
    (value.platformVersion === undefined ||
      (typeof value.platformVersion === 'string' &&
        /^\d+(?:\.\d+)*$/.test(value.platformVersion))) &&
    (value.storageQuota === undefined ||
      boundedInteger(value.storageQuota, 1024, 1_048_576)) &&
    (value.taskbarHeight === undefined || boundedInteger(value.taskbarHeight, 0, 200)) &&
    (value.webrtcIp === undefined ||
      (typeof value.webrtcIp === 'string' &&
        (value.webrtcIp === 'auto' || /^[0-9a-f:.]+$/i.test(value.webrtcIp)))) &&
    optionalBoolean(value.noise) &&
    optionalBoolean(value.allowThirdPartyCookies) &&
    optionalBoolean(value.sapiVoices) &&
    (value.maxTouchPoints === undefined || boundedInteger(value.maxTouchPoints, 0, 10)) &&
    (value.searchEngine === undefined ||
      (typeof value.searchEngine === 'string' &&
        (['google', 'bing', 'duckduckgo', 'none'].includes(value.searchEngine) ||
          httpUrl(value.searchEngine)))) &&
    optionalBoolean(value.transparentProxy) &&
    (value.transparentProxyDns === undefined ||
      (typeof value.transparentProxyDns === 'string' &&
        (value.transparentProxyDns === 'local' || httpUrl(value.transparentProxyDns)))) &&
    optionalBoolean(value.portableCookies)
  )
}

export function parseRuntimeWindow(value: unknown): RuntimeWindow {
  if (!exactFields(value, WINDOW_FIELDS)) throw new Error('PROFILE_RECORD_INVALID')
  const settings = value.settings
  if (
    value.schema_version !== 2 ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    !exactFields(value.binding, BINDING_FIELDS) ||
    value.binding.provider_id !== 'cloakbrowser' ||
    value.binding.connection_id !== 'builtin-cloakbrowser' ||
    value.binding.profile_id !== value.id ||
    !isKernelVersion(value.kernel_version) ||
    typeof value.binary_path !== 'string' ||
    !isAbsolute(value.binary_path) ||
    value.binary_path.includes('\0') ||
    !reference(value.proxy) ||
    !reference(value.proxy_plugin) ||
    !proxyEndpoint(value.proxy_endpoint) ||
    !object(settings) ||
    !optionalSettingFields(settings) ||
    !SETTING_FIELDS.every((field) => Object.hasOwn(settings, field)) ||
    !SETTING_STRINGS.every((field) => typeof settings[field] === 'string') ||
    typeof settings.geoip !== 'boolean' ||
    settings.aliasEngine !== null ||
    settings.operatingSystem !== 'host' ||
    settings.cpuCores !== null ||
    !['default', '1440x900', '1920x1080'].includes(String(settings.viewport)) ||
    typeof settings.fingerprintSeed !== 'number' ||
    !Number.isInteger(settings.fingerprintSeed) ||
    settings.fingerprintSeed < 1 ||
    settings.fingerprintSeed > 2_147_483_647 ||
    (settings.shardbrowser !== undefined &&
      settings.shardbrowser !== null &&
      !object(settings.shardbrowser)) ||
    !validCloakFingerprint(settings.cloakbrowser) ||
    (value.origin !== 'created' && value.origin !== 'attached') ||
    !object(value.provider_config) ||
    !timestamp(value.created_at) ||
    (value.last_opened_at !== null && !timestamp(value.last_opened_at)) ||
    !Number.isSafeInteger(value.sort_order)
  ) {
    throw new Error('PROFILE_RECORD_INVALID')
  }
  const validProxy =
    value.proxy_mode === 'direct'
      ? value.proxy === null &&
        value.proxy_plugin === null &&
        value.proxy_endpoint === null
      : value.proxy_mode === 'manual'
        ? value.proxy !== null &&
          value.proxy_plugin === null &&
          value.proxy_endpoint === null
        : value.proxy_mode === 'plugin' && value.proxy_plugin !== null
  if (!validProxy) throw new Error('PROFILE_RECORD_INVALID')
  return value as unknown as RuntimeWindow
}
