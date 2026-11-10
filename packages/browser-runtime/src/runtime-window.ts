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
    startUrl: string
  }
  origin: 'created' | 'attached'
  provider_config: Record<string, unknown>
  created_at: number
  last_opened_at: number | null
  sort_order: number
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
const SETTING_FIELDS = [...SETTING_STRINGS, 'geoip', 'fingerprintSeed']

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
    !exactFields(settings, SETTING_FIELDS) ||
    !SETTING_STRINGS.every((field) => typeof settings[field] === 'string') ||
    typeof settings.geoip !== 'boolean' ||
    !['default', '1440x900', '1920x1080'].includes(String(settings.viewport)) ||
    typeof settings.fingerprintSeed !== 'number' ||
    !Number.isInteger(settings.fingerprintSeed) ||
    settings.fingerprintSeed < 1 ||
    settings.fingerprintSeed > 2_147_483_647 ||
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
