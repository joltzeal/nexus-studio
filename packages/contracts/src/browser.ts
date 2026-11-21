import { z } from 'zod'

export const BrowserProviderIdSchema = z.enum([
  'cloakbrowser',
  'adspower',
  'bitbrowser',
  'aliasmode',
  'shardbrowser',
])
export const WindowStateSchema = z.enum([
  'stopped',
  'starting',
  'running',
  'stopping',
  'unknown',
  'missing',
])
export const ProxyModeSchema = z.enum(['direct', 'manual', 'plugin', 'provider'])

export const BrowserProxyEntrySchema = z.strictObject({
  id: z.string().max(128),
  name: z.string(),
  kind: z.enum(['http', 'https', 'socks5']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  username: z.string(),
  password: z.string(),
  country: z.string(),
  notes: z.string(),
})

export const BrowserProxyTestSnapshotSchema = z.strictObject({
  first_seen: z.string(),
  last_seen: z.string(),
  ip: z.string(),
  country_code: z.string(),
  country: z.string(),
  region: z.string(),
  city: z.string(),
  isp: z.string(),
  timezone: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  tcp_ms: z.number().int().nonnegative().nullable(),
  udp_ms: z.number().int().nonnegative().nullable(),
  udp_error: z.string().nullable(),
  geo_error: z.string().nullable(),
  provider: z.string(),
})

export const BrowserProxyUsageSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  connectionId: z.string().min(1),
  proxyId: z.string().min(1),
})

export type BrowserProxyEntry = z.infer<typeof BrowserProxyEntrySchema>
export type BrowserProxyTestSnapshot = z.infer<typeof BrowserProxyTestSnapshotSchema>
export type BrowserProxyUsage = z.infer<typeof BrowserProxyUsageSchema>

const id = z.string().min(1)
const timestamp = z.number().int().nonnegative()
const kernelVersion = z.string().min(1).nullable()

export const CloakFingerprintSchema = z.strictObject({
  nativeFingerprint: z.boolean().optional(),
  platform: z.enum(['windows', 'macos', 'linux']).optional(),
  gpuVendor: z.enum(['nvidia', 'intel']).optional(),
  hardwareConcurrency: z.number().int().min(1).max(64).optional(),
  deviceMemory: z.number().int().min(1).max(64).optional(),
  screenWidth: z.number().int().min(800).max(7680).optional(),
  screenHeight: z.number().int().min(600).max(4320).optional(),
  platformVersion: z
    .string()
    .max(32)
    .regex(/^\d+(?:\.\d+)*$/)
    .optional(),
  storageQuota: z.number().int().min(1024).max(1_048_576).optional(),
  taskbarHeight: z.number().int().min(0).max(200).optional(),
  webrtcIp: z
    .string()
    .max(45)
    .refine((value) => value === 'auto' || /^[0-9a-f:.]+$/i.test(value))
    .optional(),
  noise: z.boolean().optional(),
  allowThirdPartyCookies: z.boolean().optional(),
  sapiVoices: z.boolean().optional(),
  maxTouchPoints: z.number().int().min(0).max(10).optional(),
  searchEngine: z
    .string()
    .max(512)
    .refine(
      (value) =>
        ['google', 'bing', 'duckduckgo', 'none'].includes(value) ||
        /^https?:\/\/[^/\s]+/i.test(value),
    )
    .optional(),
  transparentProxy: z.boolean().optional(),
  transparentProxyDns: z
    .string()
    .max(512)
    .refine((value) => value === 'local' || /^https?:\/\/[^/\s]+/i.test(value))
    .optional(),
  portableCookies: z.boolean().optional(),
})

const switchValue = z.enum(['0', '1'])

export const BitBrowserFingerprintSchema = z.strictObject({
  coreProduct: z.enum(['chrome', 'firefox']).optional(),
  version: z.string().max(32).optional(),
  userAgent: z.string().max(512).optional(),
  ostype: z.enum(['PC', 'Android', 'IOS']).optional(),
  os: z.string().max(32).optional(),
  osVersion: z.string().max(32).optional(),
  webglManufacturer: z.string().max(128).optional(),
  webglRender: z.string().max(256).optional(),
  webGLMeta: switchValue.optional(),
  hardwareConcurrency: z.number().int().min(1).max(64).optional(),
  deviceMemory: z.number().int().min(1).max(8).optional(),
  resolutionWidth: z.number().int().min(800).max(7680).optional(),
  resolutionHeight: z.number().int().min(600).max(4320).optional(),
  devicePixelRatio: z
    .string()
    .regex(/^(?:1|1\.5|2|2\.5|3)$/)
    .optional(),
  canvas: switchValue.optional(),
  webGL: switchValue.optional(),
  audioContext: switchValue.optional(),
  mediaDevice: switchValue.optional(),
  speechVoices: switchValue.optional(),
  webRTC: z.enum(['0', '1', '2', '3']).optional(),
  ignoreHttpsErrors: z.boolean().optional(),
  position: z.enum(['0', '1', '2']).optional(),
  isIpCreatePosition: z.boolean().optional(),
  lat: z.string().optional(),
  lng: z.string().optional(),
  precisionData: z.string().optional(),
  isIpCreateDisplayLanguage: z.boolean().optional(),
  displayLanguages: z.string().max(256).optional(),
  resolutionType: switchValue.optional(),
  windowSizeLimit: z.boolean().optional(),
  fontType: z.enum(['0', '2']).optional(),
  doNotTrack: switchValue.optional(),
  clientRectNoiseEnabled: z.boolean().optional(),
  portScanProtect: switchValue.optional(),
  portWhiteList: z.string().max(512).optional(),
  deviceInfoEnabled: z.boolean().optional(),
  computerName: z.string().max(64).optional(),
  macAddr: z.string().max(64).optional(),
  hostIP: z.string().max(45).optional(),
  disableSslCipherSuitesFlag: z.boolean().optional(),
  disableSslCipherSuites: z.string().max(1024).optional(),
  enablePlugins: z.boolean().optional(),
  plugins: z.string().max(8192).optional(),
  launchArgs: z.string().max(1024).optional(),
  timezoneOffset: z.number().int().min(-840).max(840).optional(),
  randomFingerprint: z.boolean().optional(),
})

export const WindowSettingsSchema = z.strictObject({
  platform: z.enum(['Vinted', 'Poshmark', '其他']),
  note: z.string().refine((value) => Array.from(value).length <= 120),
  geoip: z.boolean(),
  timezone: z.string(),
  locale: z.string(),
  viewport: z.enum(['default', '1440x900', '1920x1080']),
  fingerprintSeed: z.number().int().min(1).max(2_147_483_647).nullable(),
  aliasEngine: z.enum(['chromium', 'firefox']).nullable(),
  operatingSystem: z.enum(['host', 'windows', 'macos', 'linux']),
  cpuCores: z.number().int().min(1).max(64).nullable(),
  startUrl: z.string(),
  shardbrowser: z.record(z.string(), z.json()).nullable().optional(),
  cloakbrowser: CloakFingerprintSchema.nullable().optional(),
  bitbrowser: BitBrowserFingerprintSchema.nullable().optional(),
})

export const BrowserCapabilitiesSchema = z.strictObject({
  create: z.boolean(),
  update: z.boolean(),
  deleteEnvironment: z.boolean(),
  attach: z.boolean(),
  manualProxy: z.boolean(),
  proxyPlugin: z.boolean(),
  geoip: z.boolean(),
  fingerprintSeed: z.boolean(),
  kernelSelection: z.boolean(),
  transfer: z.boolean(),
})

const editableFields = {
  name: z.string().min(1),
  proxyMode: ProxyModeSchema,
  proxy: z.string().nullable(),
  proxyId: id.nullable().optional(),
  proxyPlugin: id.nullable(),
  proxyEndpoint: z.number().int().positive().nullable(),
  settings: WindowSettingsSchema,
  groupId: id.nullable(),
}

export const BrowserWindowSchema = z.strictObject({
  id,
  ...editableFields,
  name: z.string(),
  providerId: BrowserProviderIdSchema,
  connectionId: id,
  providerProfileId: id,
  origin: z.enum(['created', 'attached']),
  state: WindowStateSchema,
  version: z.string(),
  // An external browser may report a vendor-specific kernel label.
  kernelVersion: z.string().nullable(),
  createdAt: timestamp,
  lastOpenedAt: timestamp.nullable(),
  sortOrder: z.number().int().nonnegative(),
  activity: z
    .object({
      launches: z.number().int().nonnegative(),
      totalRuntimeMs: z.number().int().nonnegative(),
    })
    .optional(),
})

export const CreateBrowserWindowInputSchema = z.strictObject({
  operationId: z.uuid(),
  connectionId: id,
  ...editableFields,
  kernelVersion,
})
export const UpdateBrowserWindowInputSchema = z.strictObject({
  id,
  ...editableFields,
})
export const MoveBrowserWindowsGroupInputSchema = z.strictObject({
  connectionId: id,
  ids: z
    .array(z.uuid())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, '窗口不能重复'),
  groupId: z.uuid().nullable(),
})

export const BrowserConnectionSchema = z.strictObject({
  id,
  providerId: BrowserProviderIdSchema,
  name: z.string().min(1),
  endpoint: z.string(),
  apiKey: z.string().nullable(),
  defaultGroupId: id.nullable(),
  scopeLabel: z.string(),
  scopeId: id.nullable(),
  scopeConfirmed: z.boolean(),
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  capabilities: BrowserCapabilitiesSchema,
})

export const SaveBrowserConnectionInputSchema = z.strictObject({
  id: id.optional(),
  providerId: BrowserProviderIdSchema,
  name: z.string().trim().min(1),
  endpoint: z.string(),
  apiKey: z.string().nullable(),
  defaultGroupId: id.nullable(),
  scopeLabel: z.string(),
})
export const BrowserConnectionProbeSchema = z.strictObject({
  connected: z.boolean(),
  message: z.string(),
  scopeId: id.nullable(),
  capabilities: BrowserCapabilitiesSchema,
})
export const RemoteProfileSchema = z.strictObject({
  id,
  name: z.string(),
  kernelVersion: z.string().nullable(),
  createdAt: timestamp.nullable(),
  providerConfig: z.record(z.string(), z.unknown()),
})
export const ProviderGroupSchema = z.strictObject({ id, name: z.string() })
export const BrowserOperationSchema = z.strictObject({
  id: z.uuid(),
  windowId: id,
  connectionId: id,
  kind: z.string().min(1),
  phase: z.string().min(1),
  message: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export const ResolveBrowserOperationInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    id: z.uuid(),
    action: z.literal('associate'),
    providerProfileId: id,
    confirmed: z.literal(true),
  }),
  z.strictObject({
    id: z.uuid(),
    action: z.literal('abandon'),
    confirmed: z.literal(true),
  }),
])
export const BrowserErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
})

export type BrowserProviderId = z.infer<typeof BrowserProviderIdSchema>
export type WindowState = z.infer<typeof WindowStateSchema>
export type ProxyMode = z.infer<typeof ProxyModeSchema>
export type WindowSettings = z.infer<typeof WindowSettingsSchema>
export type BrowserCapabilities = z.infer<typeof BrowserCapabilitiesSchema>
export type BrowserWindow = z.infer<typeof BrowserWindowSchema>
export type CreateBrowserWindowInput = z.infer<typeof CreateBrowserWindowInputSchema>
export type UpdateBrowserWindowInput = z.infer<typeof UpdateBrowserWindowInputSchema>
export type MoveBrowserWindowsGroupInput = z.infer<
  typeof MoveBrowserWindowsGroupInputSchema
>
export type BrowserConnection = z.infer<typeof BrowserConnectionSchema>
export type SaveBrowserConnectionInput = z.infer<typeof SaveBrowserConnectionInputSchema>
export type BrowserConnectionProbe = z.infer<typeof BrowserConnectionProbeSchema>
export type RemoteProfile = z.infer<typeof RemoteProfileSchema>
export type ProviderGroup = z.infer<typeof ProviderGroupSchema>
export type BrowserOperation = z.infer<typeof BrowserOperationSchema>
export type ResolveBrowserOperationInput = z.infer<
  typeof ResolveBrowserOperationInputSchema
>
export type BrowserError = z.infer<typeof BrowserErrorSchema>
