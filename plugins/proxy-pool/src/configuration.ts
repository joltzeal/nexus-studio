import { z } from 'zod'
import {
  createConfigurationTransfer,
  withConfigurationSecrets,
} from '@nexus/plugin-sdk/configuration'
import { ProxyInputSchema } from './domain/schemas.js'
import { upsertEndpoint } from './services/inventory.js'
import type { PrivateStore } from './store/private-store.js'
import type { SecretVault } from './store/secret-vault.js'
import { invalidRequest } from './domain/errors.js'

const schema = z.strictObject({
  defaultProxy: ProxyInputSchema.omit({ groupId: true })
    .extend({
      password: z.string().max(512),
    })
    .nullable(),
  risk: z.strictObject({
    enabled: z.boolean(),
    cacheSeconds: z.number().int().min(0).max(86400),
    apiKey: z.string().max(512).nullable(),
  }),
})

export function configurationTransfer(store: PrivateStore, vault: SecretVault) {
  return createConfigurationTransfer({
    schema,
    invalid: invalidRequest,
    async read() {
      const document = await store.read()
      const row = document.endpoints.find(
        (entry) => entry.id === document.config.defaultEndpointId && !entry.deleted,
      )
      if (document.config.defaultEndpointId !== null && !row)
        throw invalidRequest('默认代理不存在，请先修改插件配置')
      return {
        defaultProxy: row
          ? {
              name: row.name,
              schemes: row.schemes,
              host: row.host,
              port: row.port,
              username: row.username,
              password: row.secretRef === null ? '' : await vault.resolve(row.secretRef),
              enabled: row.enabled,
              udp: row.udp,
            }
          : null,
        risk: {
          enabled: document.config.risk.enabled,
          cacheSeconds: document.config.risk.cacheSeconds,
          apiKey:
            document.config.risk.apiKeyRef === null
              ? null
              : await vault.resolve(document.config.risk.apiKeyRef),
        },
      }
    },
    async apply(input) {
      await withConfigurationSecrets(vault, async (staged) => {
        await store.mutate(async (document) => {
          let defaultEndpointId: number | null = null
          if (input.defaultProxy !== null) {
            const outcome = await upsertEndpoint(
              document,
              { ...input.defaultProxy, groupId: null },
              {
                vault: { ...vault, ...staged },
                now: () => new Date().toISOString(),
              },
            )
            defaultEndpointId = outcome.row.id
          }
          const apiKeyRef =
            input.risk.apiKey === null
              ? null
              : (await staged.put('proxycheck-api-key', input.risk.apiKey)).ref
          if (document.config.risk.apiKeyRef !== null)
            await staged.drop(document.config.risk.apiKeyRef)
          document.config = {
            defaultEndpointId,
            risk: {
              enabled: input.risk.enabled,
              cacheSeconds: input.risk.cacheSeconds,
              apiKeyRef,
            },
          }
        })
      })
    },
  })
}
