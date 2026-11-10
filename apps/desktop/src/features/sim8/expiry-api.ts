import { callPlugin } from '@/lib/platform/native-plugins'
import { SIM8_CAPABILITY, SIM8_PLUGIN_ID, type ExpirySnapshot } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function parseExpirySnapshot(value: unknown): ExpirySnapshot {
  if (
    !isRecord(value) ||
    !Array.isArray(value['items']) ||
    value['items'].length > 2000 ||
    !value['items'].every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item['tel'] === 'string' &&
        item['tel'].length > 0 &&
        isDate(item['expiresAt']) &&
        (item['checkedAt'] === null || isDate(item['checkedAt'])),
    ) ||
    !Array.isArray(value['pendingTels']) ||
    value['pendingTels'].length > 8 ||
    !value['pendingTels'].every(
      (tel: unknown) => typeof tel === 'string' && tel.length > 0,
    ) ||
    typeof value['failed'] !== 'number' ||
    !Number.isInteger(value['failed']) ||
    value['failed'] < 0 ||
    typeof value['storageDurable'] !== 'boolean'
  )
    throw new Error('SIM8 到期提醒响应无效，请更新插件后重试')
  return value as unknown as ExpirySnapshot
}

async function call(method: string, payload: unknown = {}): Promise<ExpirySnapshot> {
  return parseExpirySnapshot(
    await callPlugin(
      SIM8_PLUGIN_ID,
      SIM8_CAPABILITY,
      method,
      payload,
      method === 'sim8.expiry.refresh' ? 60_000 : 30_000,
    ),
  )
}

export const expiryApi = {
  list: () => call('sim8.expiry.list'),
  refresh: (tels: string[]) => call('sim8.expiry.refresh', { tels }),
  dismiss: (tel: string, expiresAt: string) =>
    call('sim8.expiry.dismiss', { tel, expiresAt }),
}
