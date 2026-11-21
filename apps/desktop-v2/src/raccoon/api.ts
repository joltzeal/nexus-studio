import { invoke } from '@tauri-apps/api/core'
import { LABEL_COLORS, type LabelColorId } from '../shared/constants/index.ts'
import { FOLDER_ICON_GLYPHS } from '../shared/icons/index.tsx'
import type { FolderIcon } from '../entities/profile/lib/folderMeta'
import {
  BrowserConnectionSchema,
  BrowserConnectionProbeSchema,
  BrowserWindowSchema,
  BrowserOperationSchema,
  BrowserErrorSchema,
  CreateBrowserWindowInputSchema,
  UpdateBrowserWindowInputSchema,
  ResolveBrowserOperationInputSchema,
} from '@nexus/contracts/browser'
import {
  isKernelVersion,
  parseCloakKernelRelease,
  parseCloakKernelStatus,
  parseCloakLicense,
} from './cloakbrowser-contract.ts'
export {
  isKernelVersion,
  parseCloakKernelRelease,
  parseCloakKernelStatus,
  parseCloakLicense,
  type CloakKernelFailure,
  type CloakKernelPhase,
  type CloakKernelRelease,
  type CloakKernelStatus,
  type CloakLicenseStatus,
} from './cloakbrowser-contract.ts'

export type NativeFolder = {
  id: string
  connectionId: string
  name: string
  note: string
  windowCount: number
  color?: LabelColorId | null
  icon?: FolderIcon
}
export type KernelStatus = {
  platform: string
  installed: { version: string; binaryPath: string }[]
  downloading: boolean
  download: {
    phase:
      | 'idle'
      | 'preparing'
      | 'downloading'
      | 'extracting'
      | 'verifying'
      | 'ready'
      | 'failed'
    label: string | null
    receivedBytes: number
    totalBytes: number | null
    percent: number | null
    error: string | null
  }
}
function folder(value: unknown): NativeFolder {
  if (!value || typeof value !== 'object') throw new Error('Folder 返回格式无效')
  const row = value as Record<string, unknown>
  if (
    typeof row.id !== 'string' ||
    typeof row.connectionId !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.note !== 'string' ||
    typeof row.windowCount !== 'number'
  )
    throw new Error('Folder 返回格式无效')
  if (
    (row.color !== undefined &&
      row.color !== null &&
      !LABEL_COLORS.some((color) => color.id === row.color)) ||
    (row.icon !== undefined &&
      (typeof row.icon !== 'string' ||
        !Object.prototype.hasOwnProperty.call(FOLDER_ICON_GLYPHS, row.icon)))
  )
    throw new Error('Folder 外观返回格式无效')
  return row as NativeFolder
}

function kernels(value: unknown): KernelStatus {
  if (!value || typeof value !== 'object') throw new Error('内核状态返回格式无效')
  const status = value as Record<string, unknown>
  if (
    typeof status.platform !== 'string' ||
    typeof status.downloading !== 'boolean' ||
    !Array.isArray(status.installed) ||
    status.installed.some(
      (item: unknown) =>
        !item ||
        typeof item !== 'object' ||
        typeof (item as Record<string, unknown>).version !== 'string' ||
        typeof (item as Record<string, unknown>).binaryPath !== 'string',
    )
  )
    throw new Error('内核状态返回格式无效')
  if (!status.download || typeof status.download !== 'object')
    throw new Error('内核下载进度返回格式无效')
  const job = status.download as Record<string, unknown>
  if (
    typeof job.phase !== 'string' ||
    ![
      'idle',
      'preparing',
      'downloading',
      'extracting',
      'verifying',
      'ready',
      'failed',
    ].includes(job.phase) ||
    (job.label !== null && typeof job.label !== 'string') ||
    typeof job.receivedBytes !== 'number' ||
    !Number.isSafeInteger(job.receivedBytes) ||
    job.receivedBytes < 0 ||
    (job.totalBytes !== null &&
      (typeof job.totalBytes !== 'number' ||
        !Number.isSafeInteger(job.totalBytes) ||
        job.totalBytes <= 0)) ||
    (job.percent !== null &&
      (typeof job.percent !== 'number' ||
        !Number.isFinite(job.percent) ||
        job.percent < 0 ||
        job.percent > 100)) ||
    (job.error !== null && typeof job.error !== 'string') ||
    status.downloading !==
      ['preparing', 'downloading', 'extracting', 'verifying'].includes(job.phase) ||
    (job.percent !== null && (job.phase !== 'downloading' || job.totalBytes === null))
  )
    throw new Error('内核下载进度返回格式无效')
  return status as KernelStatus
}

export function nativeError(cause: unknown): Error {
  let value = cause
  if (typeof cause === 'string') {
    try {
      value = JSON.parse(cause)
    } catch {
      value = cause
    }
  }
  const parsed = BrowserErrorSchema.safeParse(value)
  return parsed.success
    ? Object.assign(new Error(parsed.data.message), { code: parsed.data.code })
    : cause instanceof Error
      ? cause
      : new Error(typeof cause === 'string' ? cause : '原生操作失败')
}

export const nativeApi = {
  async call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    let request = args
    if (command === 'browser_window_create')
      request = { input: CreateBrowserWindowInputSchema.parse(args?.input) }
    if (command === 'browser_window_update')
      request = { input: UpdateBrowserWindowInputSchema.parse(args?.input) }
    if (command === 'browser_operation_resolve')
      request = { input: ResolveBrowserOperationInputSchema.parse(args?.input) }
    try {
      const value = await invoke<unknown>(command, request)
      switch (command) {
        case 'browser_connection_list':
          return BrowserConnectionSchema.array().parse(value)
        case 'browser_managed_cloakbrowser_set':
          return BrowserConnectionSchema.parse(value)
        case 'browser_managed_shardbrowser_set':
          return BrowserConnectionSchema.parse(value)
        case 'browser_connection_probe':
          return BrowserConnectionProbeSchema.parse(value)
        case 'browser_bitbrowser_launch':
          return BrowserConnectionProbeSchema.parse(value)
        case 'browser_window_list':
          return BrowserWindowSchema.array().parse(value)
        case 'browser_window_create':
          return BrowserWindowSchema.parse(value)
        case 'browser_operation_list':
          return BrowserOperationSchema.array().parse(value)
        case 'browser_operation_get':
          return value === null ? null : BrowserOperationSchema.parse(value)
        case 'browser_operation_reconcile':
          return value === null ? null : BrowserWindowSchema.parse(value)
        case 'browser_operation_resolve':
          return value === null ? null : BrowserWindowSchema.parse(value)
        case 'browser_folder_list': {
          if (!Array.isArray(value)) throw new Error('Folder 列表返回格式无效')
          return value.map(folder)
        }
        case 'browser_folder_create':
          return folder(value)
        case 'kernel_status':
          return parseCloakKernelStatus(value)
        case 'kernel_check_latest':
          return parseCloakKernelRelease(value)
        case 'kernel_download':
          if (typeof value !== 'string' || !isKernelVersion(value))
            throw new Error('内核下载回执无效')
          return value
        case 'license_status':
        case 'license_set':
          return parseCloakLicense(value)
        case 'shardbrowser_kernel_status':
          return kernels(value)
        default:
          return value
      }
    } catch (cause) {
      throw nativeError(cause)
    }
  },
}
