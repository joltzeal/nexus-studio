import { z } from 'zod'

export const BrowserProviderIdSchema = z.enum(['cloakbrowser', 'adspower', 'bitbrowser'])
export const WindowStateSchema = z.enum([
  'stopped',
  'starting',
  'running',
  'stopping',
  'unknown',
  'missing',
])
export const ProxyModeSchema = z.enum(['direct', 'manual', 'plugin', 'provider'])

const id = z.string().min(1)
const timestamp = z.number().int().nonnegative()
const kernelVersion = z.string().min(1).nullable()

export const WindowSettingsSchema = z.strictObject({
  platform: z.enum(['Vinted', 'Poshmark', '其他']),
  note: z.string().refine((value) => Array.from(value).length <= 120),
  geoip: z.boolean(),
  timezone: z.string(),
  locale: z.string(),
  viewport: z.enum(['default', '1440x900', '1920x1080']),
  fingerprintSeed: z.number().int().min(1).max(2_147_483_647).nullable(),
  startUrl: z.string(),
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
