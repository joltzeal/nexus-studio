import { BrowserWindowSchema } from '@nexus/contracts/browser'
import { nativeApi } from '../../../raccoon/api'
import { accountsApi } from '../../../raccoon/plugins/vinted-accounts/api'
import { productApi } from '../../../raccoon/plugins/products/api'

export type BindingView = Awaited<
  ReturnType<typeof accountsApi.bindings>
>['items'][number]
export const listBindings = accountsApi.bindings
export const listProducts = productApi.list
export const getProduct = productApi.get

export async function listBrowserWindows(connectionId: string) {
  if (!connectionId) throw new Error('请先选择 Workspace。')
  const profiles = BrowserWindowSchema.array().parse(
    await nativeApi.call('browser_window_list', { connectionId }),
  )
  if (profiles.some((profile) => profile.connectionId !== connectionId))
    throw new Error('Profile 列表与当前 Workspace 不一致。')
  return profiles
}

export const VINTED_CONDITION_OPTIONS = [
  'New with tags',
  'New without tags',
  'Very good',
  'Good',
  'Satisfactory',
] as const
