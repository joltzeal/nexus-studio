import { BrowserWindowSchema } from '@nexus/contracts/browser'
import { nativeApi } from '../api'

export async function findDetailProfile(id: string) {
  const profiles = BrowserWindowSchema.array().parse(
    await nativeApi.call('browser_window_list', { connectionId: null }),
  )
  const matches = profiles.filter((profile) => profile.id === id)
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? 'Profile 标识重复，请刷新核对。'
        : '关联 Profile 已删除、移入回收站或不可见。',
    )
  return matches[0]!
}
