import {
  ManualProviderSubscriptionInputSchema,
  ManualProviderSubscriptionResultSchema,
  ProviderAccountInputSchema,
  ProviderAccountSchema,
  ProviderIdInputSchema,
  ProviderSubscriptionSchema,
  ProviderSyncResultSchema,
  ProxySiteDefinitionSchema,
  type ManualProviderSubscriptionInput,
  type ProviderAccountInput,
  type ProxyProduct,
} from '@nexus/plugin-contracts/proxy-pool'
import { callPlugin } from '../call'
import { PROXY_PLUGIN_ID } from './model'
import { array, object } from './parse'

export const PROXY_PRODUCT_LABELS: Record<ProxyProduct, string> = {
  residential: '住宅代理',
  datacenter: '数据中心',
  isp: 'ISP',
  mobile: '移动代理',
  other: '其他',
}

export const PROVIDER_MANAGEMENT_METHODS = [
  'proxy.providers.list',
  'proxy.providerAccounts.list',
  'proxy.providerAccounts.save',
  'proxy.providerAccounts.delete',
  'proxy.providerAccounts.sync',
  'proxy.providerSubscriptions.list',
  'proxy.providerSubscriptions.manual',
  'proxy.providerSubscriptions.delete',
] as const

const call = <T>(
  method: (typeof PROVIDER_MANAGEMENT_METHODS)[number],
  payload: unknown,
  parse: (value: unknown) => T,
  deadlineMs?: number,
) => callPlugin(PROXY_PLUGIN_ID, 'proxy.provider', method, payload, parse, deadlineMs)

function confirmedRemoval(value: unknown) {
  if (object(value).removed !== true) throw new Error('插件未确认删除')
}

export const proxySiteApi = {
  providers: () =>
    call('proxy.providers.list', {}, (value) =>
      array(object(value).items, (item) => ProxySiteDefinitionSchema.parse(item)),
    ),
  accounts: () =>
    call('proxy.providerAccounts.list', {}, (value) =>
      array(object(value).items, (item) => ProviderAccountSchema.parse(item)),
    ),
  subscriptions: () =>
    call('proxy.providerSubscriptions.list', {}, (value) =>
      array(object(value).items, (item) => ProviderSubscriptionSchema.parse(item)),
    ),
  saveAccount: (input: ProviderAccountInput) =>
    call(
      'proxy.providerAccounts.save',
      ProviderAccountInputSchema.parse(input),
      (value) => {
        const saved = ProviderAccountSchema.parse(value)
        if (saved.providerId !== input.providerId || (input.id && saved.id !== input.id))
          throw new Error('服务商接入保存结果无效')
        return saved
      },
    ),
  deleteAccount: (id: string) =>
    call(
      'proxy.providerAccounts.delete',
      ProviderIdInputSchema.parse({ id }),
      confirmedRemoval,
    ),
  sync: (id: string) =>
    call(
      'proxy.providerAccounts.sync',
      ProviderIdInputSchema.parse({ id }),
      (value) => ProviderSyncResultSchema.parse(value),
      60_000,
    ),
  saveManual: (input: ManualProviderSubscriptionInput) =>
    call(
      'proxy.providerSubscriptions.manual',
      ManualProviderSubscriptionInputSchema.parse(input),
      (value) => {
        const saved = ManualProviderSubscriptionResultSchema.parse(value)
        if (
          saved.subscription.accountId !== input.accountId ||
          saved.subscription.source !== 'manual' ||
          (input.id && saved.subscription.id !== input.id)
        )
          throw new Error('手动订阅保存结果无效')
        return saved
      },
    ),
  deleteSubscription: (id: string) =>
    call(
      'proxy.providerSubscriptions.delete',
      ProviderIdInputSchema.parse({ id }),
      confirmedRemoval,
    ),
}
