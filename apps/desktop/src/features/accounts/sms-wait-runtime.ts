import { pushToast, toast } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import type { PluginView } from '@/lib/platform/native-plugins'
import { listAccounts, readOtp } from './api'
import { SmsWaitManager, type SmsWaitTarget } from './sms-wait'
import { ACCOUNTS_PLUGIN_ID, type AccountList } from './types'
import { VerificationSound } from './verification-sound'

const sound = new VerificationSound()
let pluginIdentity: string | null | undefined

function matches(catalog: AccountList, target: SmsWaitTarget): boolean {
  const account = catalog.items.find((item) => item.id === target.accountId)
  return (
    account?.phone === target.phone &&
    account.smsOtpUrl === target.smsOtpUrl &&
    catalog.bindings.some(
      (binding) =>
        binding.windowId === target.windowId && binding.accountId === target.accountId,
    )
  )
}

export const smsWaits = new SmsWaitManager({
  read: async (target, signal) => {
    const before = await listAccounts()
    signal.throwIfAborted()
    if (!matches(before, target))
      return { stopped: '账号、手机号、接码链接或窗口关联已变化' }
    const result = await readOtp(target.accountId, 'sms')
    signal.throwIfAborted()
    const after = await listAccounts()
    signal.throwIfAborted()
    if (!matches(after, target))
      return { stopped: '账号、手机号、接码链接或窗口关联已变化' }
    if (result.channel !== 'sms') throw new Error('接码服务返回的不是短信结果。')
    return { code: result.code }
  },
  received: (target, code) => {
    pushToast(
      'success',
      `${target.windowName} · ${target.accountName} · ${target.phone}\n验证码：${code}`,
      {
        duration: 0,
        action: {
          label: '复制验证码',
          onClick: () => {
            void copyText(code).then((copied) => {
              if (copied) toast.success('验证码已复制')
              else toast.error('复制失败，请手动复制验证码。')
            })
          },
        },
      },
    )
    void sound.play().then((played) => {
      if (!played) toast.info('验证码已收到，提示音未能播放，请检查应用声音设置。')
    })
  },
  expired: (target, lastError) => {
    toast.info(
      `${target.windowName} · ${target.phone}：5 分钟内未收到验证码，已停止等待。${lastError ? `最后一次查询：${lastError}` : ''}`,
      { duration: 8000 },
    )
  },
  invalidated: (target, reason) => {
    toast.info(`${target.windowName}：${reason}，已停止等待验证码。`)
  },
})

export function startSmsWait(target: SmsWaitTarget): boolean {
  if (smsWaits.getSnapshot().some((task) => task.accountId === target.accountId))
    return false
  // Called inside the user's click so WebView autoplay policies can unlock audio.
  void sound.arm()
  return smsWaits.start(target)
}

export function reconcileSmsWaitPlugin(
  catalog: readonly Pick<PluginView, 'id' | 'enabled' | 'state' | 'version' | 'status'>[],
): void {
  const plugin = catalog.find((entry) => entry.id === ACCOUNTS_PLUGIN_ID)
  const next =
    plugin?.enabled && plugin.state === 'running'
      ? JSON.stringify([plugin.version, plugin.status?.pid ?? null])
      : null
  if (
    (next === null || (pluginIdentity !== undefined && next !== pluginIdentity)) &&
    smsWaits.getSnapshot().length > 0
  ) {
    smsWaits.stopAll()
    toast.info('账号插件状态已变化，已停止等待验证码。')
  }
  pluginIdentity = next
}

export function disposeSmsWaits(): void {
  smsWaits.stopAll()
  sound.close()
  pluginIdentity = undefined
}
