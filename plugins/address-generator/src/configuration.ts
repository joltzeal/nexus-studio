import { z } from 'zod'
import {
  createConfigurationTransfer,
  withConfigurationSecrets,
} from '@nexus/plugin-sdk/configuration'
import type { PrivateStore } from './store/private-store.js'
import type { SecretVault } from './store/secret-vault.js'
import { invalidRequest } from './domain/errors.js'

const schema = z.strictObject({
  apiKey: z
    .string()
    .trim()
    .min(10)
    .max(512)
    .refine((value) => !/\s/.test(value))
    .nullable(),
})

export function configurationTransfer(store: PrivateStore, vault: SecretVault) {
  return createConfigurationTransfer({
    schema,
    invalid: invalidRequest,
    async read() {
      const { maps } = await store.read()
      return {
        apiKey: maps.apiKeyRef === null ? null : await vault.resolve(maps.apiKeyRef),
      }
    },
    async apply(input) {
      await withConfigurationSecrets(vault, async (staged) => {
        await store.mutate(async (document) => {
          const ref =
            input.apiKey === null
              ? null
              : (await staged.put('google-maps-key', input.apiKey)).ref
          if (document.maps.apiKeyRef !== null) await staged.drop(document.maps.apiKeyRef)
          document.maps.apiKeyRef = ref
        })
      })
    },
  })
}
