export const SIM8_CAPABILITY = 'verification.provider'
export const SIM8_PLUGIN_ID = 'studio.sim8'

export const SIM8_METHODS = {
  base: [
    'sim8.config.get',
    'sim8.config.set',
    'sim8.profile',
    'sim8.catalog.categories',
    'sim8.catalog.apps',
    'sim8.buy.prefixes',
    'sim8.buy.create',
    'sim8.buy.deferred',
    'sim8.records.list',
    'sim8.records.remove',
    'sim8.records.clear',
    'sim8.sms.read',
  ],
  orders: ['sim8.orders.list', 'sim8.orders.apis', 'sim8.orders.one'],
  renewals: ['sim8.orders.changeToken', 'sim8.orders.renewText', 'sim8.orders.renewIds'],
  filtering: ['sim8.filter.apps', 'sim8.filter.create', 'sim8.filter.detail'],
  expiry: ['sim8.expiry.list', 'sim8.expiry.refresh', 'sim8.expiry.dismiss'],
} as const

export type Sim8MethodGroup = keyof typeof SIM8_METHODS

export function supportsSim8Methods(
  methods: readonly string[],
  group: Sim8MethodGroup = 'base',
): boolean {
  const available = new Set(methods)
  return SIM8_METHODS[group].every((method) => available.has(method))
}
