import type { NativeProfile } from '@/lib/platform/native-profiles'
import { transferError } from '@/lib/platform/native-transfer'
import { WaitTimeoutError, withDeadline } from './transfer-state'

export class LaunchUnconfirmedError extends Error {
  override name = 'LaunchUnconfirmedError'
}

export async function launchAndConfirm(
  id: string,
  start: () => Promise<void>,
  read: () => Promise<NativeProfile[]>,
): Promise<NativeProfile[]> {
  try {
    await withDeadline(
      start(),
      120_000,
      '等待宿主启动超过 120 秒，结果尚未确认；后台请求仍可能继续。请重新读取状态，避免重复打开。',
    )
  } catch (cause) {
    if (cause instanceof WaitTimeoutError) throw new LaunchUnconfirmedError(cause.message)
    throw cause
  }
  let records: NativeProfile[]
  try {
    records = await withDeadline(
      read(),
      10_000,
      '读取窗口状态超过 10 秒，请刷新窗口列表。',
    )
  } catch (cause) {
    throw new LaunchUnconfirmedError(
      `启动调用已返回，但运行状态尚未确认：${transferError(cause)}`,
    )
  }
  if (!records.some((record) => record.id === id && record.running)) {
    throw new LaunchUnconfirmedError(
      '宿主尚未确认窗口正在运行。请重新读取状态后再决定是否重试。',
    )
  }
  return records
}
