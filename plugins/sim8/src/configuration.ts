import { z } from 'zod'
import {
  createConfigurationTransfer,
  withConfigurationSecrets,
} from '@nexus/plugin-sdk/configuration'
import { normalizeBaseUrl, normalizeToken } from './services/client.js'
import type { PrivateStore } from './store/private-store.js'
import type { SecretVault } from './store/secret-vault.js'
import { invalidRequest } from './domain/errors.js'

const schema = z.strictObject({
  baseUrl: z.string().min(1).max(2048).transform(normalizeBaseUrl),
  token: z
    .string()
    .min(1)
    .max(2048)
    .transform(normalizeToken)
    .refine((value) => value !== '')
    .nullable(),
})

export function configurationTransfer(store: PrivateStore, vault: SecretVault) {
  return createConfigurationTransfer({
    schema,
    invalid: invalidRequest,
    async read() {
      const { config } = await store.read()
      return {
        baseUrl: config.baseUrl,
        token: config.tokenRef === null ? null : await vault.resolve(config.tokenRef),
      }
    },
    async apply(input) {
      await withConfigurationSecrets(vault, async (staged) => {
        await store.mutate(async (document) => {
          const ref =
            input.token === null ? null : (await staged.put('api-token', input.token)).ref
          if (document.config.tokenRef !== null)
            await staged.drop(document.config.tokenRef)
          document.config = {
            baseUrl: input.baseUrl,
            tokenRef: ref,
            profile: null,
            profileAt: null,
          }
        })
      })
    },
  })
}
