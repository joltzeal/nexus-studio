import type { PluginManifest } from '@nexus/plugin-sdk'

export const PROTOCOL_VERSION = 1 as const
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024
export const MAX_DEADLINE_MS = 120_000

export interface PluginRequest {
  protocolVersion: 1
  requestId: string
  capability: string
  method: string
  deadlineMs: number
  payload: unknown
}

export interface PluginErrorPayload {
  code: string
  message: string
  retryable: boolean
}

export interface PluginResponse<T = unknown> {
  protocolVersion: 1
  requestId: string
  ok: boolean
  result?: T
  error?: PluginErrorPayload
}

export interface HandshakeMessage {
  type: 'handshake'
  protocolVersion: 1
}

export interface CancelMessage {
  type: 'cancel'
  requestId: string
}

export interface HelloMessage {
  type: 'hello'
  protocolVersion: 1
  pluginId: string
  version: string
  apiVersion: 1
  capabilities: readonly string[]
}

export interface ReadyMessage {
  type: 'ready'
  protocolVersion: 1
  pluginId: string
  version: string
  capabilities: readonly string[]
  methods: readonly string[]
  status: Record<string, unknown>
}

export function helloMessage(manifest: PluginManifest): HelloMessage {
  return {
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    pluginId: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    capabilities: [...manifest.capabilities],
  }
}

export interface DispatchContext {
  requestId: string
  capability: string
  method: string
  payload: unknown
  deadlineAt: number
  /** Throws TIMEOUT or CANCELLED when the call may no longer touch state. */
  assertAlive: () => void
}

export type Dispatch = (context: DispatchContext) => Promise<unknown>
