import type { Account } from './model.ts'

type Contacts = Pick<Account, 'phone' | 'smsOtpUrl' | 'emailOtpUrl'>

export function accountContactChanges(
  previous: Contacts | null,
  next: Contacts,
): string[] {
  if (!previous) return []
  const changes: string[] = []
  if (previous.phone.trim() && previous.phone.trim() !== next.phone.trim())
    changes.push(
      next.phone.trim()
        ? `更换手机号「${previous.phone.trim()}」为「${next.phone.trim()}」`
        : `清空手机号「${previous.phone.trim()}」`,
    )
  for (const [key, label] of [
    ['smsOtpUrl', '短信接码链接'],
    ['emailOtpUrl', '邮箱接码链接'],
  ] as const)
    if (previous[key].trim() && previous[key].trim() !== next[key].trim())
      changes.push(`${next[key].trim() ? '替换' : '清空'}${label}`)
  return changes
}
