import { listMailboxTargets } from '@/features/email/api'
import type { MailboxTarget } from '@/features/email/types'

export async function readMailboxes(): Promise<MailboxTarget[]> {
  const result: MailboxTarget[] = []
  const seen = new Set<string>()
  let total: number | null = null
  for (let page = 1; ; page += 1) {
    const current = await listMailboxTargets({ page, pageSize: 50 })
    if (total !== null && (total !== current.total || current.page !== page))
      throw new Error('邮箱列表已变化，请重新加载后预览。')
    total = current.total
    if (total > 2000) throw new Error('邮箱数量超过账号池上限，请分批处理。')
    const expected = Math.min(50, total - result.length)
    if (current.items.length !== expected)
      throw new Error('邮箱列表分页不完整，请重新加载。')
    for (const item of current.items) {
      if (seen.has(item.id)) throw new Error('邮箱列表发生变化，请重新加载。')
      seen.add(item.id)
      result.push(item)
    }
    if (result.length >= total) break
    if (current.items.length === 0) throw new Error('邮箱列表不完整，请重新加载。')
  }
  if (new Set(result.map((item) => item.email.toLowerCase())).size !== result.length)
    throw new Error('邮箱管理中有重复的邮箱地址，请先整理。')
  return result
}
