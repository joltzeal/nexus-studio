import { isTauri } from '@tauri-apps/api/core'
import {
  BrowserOperationSchema,
  BrowserWindowSchema,
  CreateBrowserWindowInputSchema,
  MoveBrowserWindowsGroupInputSchema,
  ResolveBrowserOperationInputSchema,
  UpdateBrowserWindowInputSchema,
  type BrowserWindow,
  type CreateBrowserWindowInput,
  type MoveBrowserWindowsGroupInput,
  type ResolveBrowserOperationInput,
  type UpdateBrowserWindowInput,
} from '@nexus/contracts/browser'
import { invokeBrowser, readBrowser } from './browser-api'

export type {
  BrowserWindow,
  CreateBrowserWindowInput,
  UpdateBrowserWindowInput,
  MoveBrowserWindowsGroupInput,
  ResolveBrowserOperationInput,
  WindowSettings,
  WindowState,
  ProxyMode,
} from '@nexus/contracts/browser'

export function browserWindowsAvailable(): boolean {
  return isTauri()
}

export function orderBrowserWindows(windows: readonly BrowserWindow[]): BrowserWindow[] {
  return [...windows].sort(
    (left, right) =>
      right.createdAt - left.createdAt ||
      right.sortOrder - left.sortOrder ||
      (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
  )
}

export async function listBrowserWindows(
  connectionId?: string,
): Promise<BrowserWindow[]> {
  return orderBrowserWindows(
    await readBrowser(BrowserWindowSchema.array(), 'browser_window_list', {
      ...(connectionId === undefined ? {} : { connectionId }),
    }),
  )
}

export async function createBrowserWindow(input: CreateBrowserWindowInput) {
  return readBrowser(BrowserWindowSchema, 'browser_window_create', {
    input: CreateBrowserWindowInputSchema.parse(input),
  })
}

export async function updateBrowserWindow(input: UpdateBrowserWindowInput) {
  await invokeBrowser('browser_window_update', {
    input: UpdateBrowserWindowInputSchema.parse(input),
  })
}

export async function deleteBrowserWindow(id: string, deleteEnvironment: boolean) {
  await invokeBrowser('browser_window_delete', { id, deleteEnvironment })
}

export async function updateBrowserWindowNote(id: string, input: string) {
  const note = input.trim()
  if (Array.from(note).length > 120) throw new Error('备注最多 120 个字符。')
  const saved = await invokeBrowser('browser_window_update_note', { id, note })
  if (typeof saved !== 'string' || saved !== note) {
    throw new Error('备注保存结果未确认，请刷新窗口列表后重试。')
  }
  return saved
}

export async function moveBrowserWindowsGroup(input: MoveBrowserWindowsGroupInput) {
  const request = MoveBrowserWindowsGroupInputSchema.parse(input)
  const saved = await readBrowser(
    MoveBrowserWindowsGroupInputSchema,
    'browser_window_move_group',
    { input: request },
  )
  if (
    saved.connectionId !== request.connectionId ||
    saved.groupId !== request.groupId ||
    saved.ids.length !== request.ids.length ||
    saved.ids.some((id, index) => id !== request.ids[index])
  ) {
    throw new Error('分组移动结果未确认，请刷新窗口列表后重试。')
  }
  return saved
}

export async function startBrowserWindow(id: string): Promise<void> {
  await invokeBrowser('browser_window_start', { id })
}

export async function stopBrowserWindow(id: string): Promise<void> {
  await invokeBrowser('browser_window_stop', { id })
}

export async function listBrowserOperations(connectionId?: string) {
  return readBrowser(BrowserOperationSchema.array(), 'browser_operation_list', {
    ...(connectionId === undefined ? {} : { connectionId }),
  })
}

export async function reconcileBrowserOperation(operationId: string) {
  const id = CreateBrowserWindowInputSchema.shape.operationId.parse(operationId)
  return readBrowser(BrowserWindowSchema.nullable(), 'browser_operation_reconcile', {
    operationId: id,
  })
}

export async function resolveBrowserOperation(
  input: ResolveBrowserOperationInput,
): Promise<BrowserWindow | null> {
  return readBrowser(BrowserWindowSchema.nullable(), 'browser_operation_resolve', {
    input: ResolveBrowserOperationInputSchema.parse(input),
  })
}
