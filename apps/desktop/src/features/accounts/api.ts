import { callPlugin } from '@/lib/platform/native-plugins'
import {
  ACCOUNTS_CAPABILITY,
  ACCOUNTS_PLUGIN_ID,
  type AccountInput,
  type AccountList,
  type BindingView,
  type ImportReport,
  type TemplateFile,
} from './types'

function call<T>(method: string, payload: unknown = {}): Promise<T> {
  return callPlugin<T>(ACCOUNTS_PLUGIN_ID, ACCOUNTS_CAPABILITY, method, payload)
}

export function listAccounts(): Promise<AccountList> {
  return call<AccountList>('vinted.accounts.list')
}

export function saveAccount(
  input: AccountInput,
): Promise<{ item: AccountList['items'][number]; created: boolean }> {
  return call('vinted.accounts.save', input)
}

export function removeAccount(accountId: string): Promise<{ removed: boolean }> {
  return call('vinted.accounts.remove', { accountId })
}

export function importAccounts(
  filename: string,
  content: { text: string } | { base64: string },
): Promise<ImportReport> {
  return call<ImportReport>('vinted.accounts.import', { filename, ...content })
}

export function downloadTemplate(format: 'csv' | 'xlsx'): Promise<TemplateFile> {
  return call<TemplateFile>('vinted.accounts.template', { format })
}

export function bindAccount(
  accountId: string,
  windowId: string,
  confirmDuplicates = false,
): Promise<{ bound: boolean; duplicates: string[] }> {
  return call('vinted.accounts.bind', { accountId, windowId, confirmDuplicates })
}

export function unbindWindow(windowId: string): Promise<{ unbound: boolean }> {
  return call('vinted.accounts.unbind', { windowId })
}

export function listBindings(): Promise<{ items: BindingView[] }> {
  return call<{ items: BindingView[] }>('vinted.accounts.bindings')
}
