import { z } from 'zod'
import { createConfigurationTransfer } from '@nexus/plugin-sdk/configuration'
import { ProxySaveInputSchema } from './domain/schemas.js'
import { validateProxy } from './domain/proxies.js'
import type { PrivateStore } from './store/private-store.js'
import { invalidRequest } from './domain/errors.js'

const proxySchema = ProxySaveInputSchema.extend({
  id: z.string().trim().min(1).max(128),
  password: z.string().max(512),
}).transform((row) => {
  validateProxy({ ...row, enabled: true })
  return row
})
const schema = z
  .strictObject({
    proxies: z.array(proxySchema).max(1000),
    defaultProxyId: z.string().min(1).max(128).nullable(),
  })
  .refine(
    (input) =>
      new Set(input.proxies.map((row) => row.id)).size === input.proxies.length &&
      (input.defaultProxyId === null ||
        input.proxies.some((row) => row.id === input.defaultProxyId)),
  )

export function configurationTransfer(
  store: PrivateStore,
  canImport: () => boolean = () => true,
) {
  return createConfigurationTransfer({
    schema,
    invalid: invalidRequest,
    async read() {
      const { proxies, defaultProxyId } = await store.read()
      return { proxies, defaultProxyId }
    },
    async apply(input) {
      if (!canImport()) throw invalidRequest('采集任务运行中，请完成后再导入配置')
      await store.mutate((document) => {
        for (const proxy of input.proxies) {
          const index = document.proxies.findIndex((row) => row.id === proxy.id)
          if (index < 0) document.proxies.push(proxy)
          else document.proxies[index] = proxy
        }
        document.defaultProxyId = input.defaultProxyId
      })
    },
  })
}
