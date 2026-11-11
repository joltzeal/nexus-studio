import { z } from 'zod'
import { createConfigurationTransfer } from '@nexus/plugin-sdk/configuration'
import { ProviderSaveInputSchema, normalizeBaseUrl } from './domain/schemas.js'
import type { PrivateStore } from './store/private-store.js'
import { invalidRequest } from './domain/errors.js'

const providerSchema = ProviderSaveInputSchema.extend({
  id: z.string().trim().min(1).max(64),
  apiKey: z.string().max(400),
  visionModel: z.string().trim().max(120),
  imageTimeoutSeconds: z.number().int().min(60).max(3600),
  imageResponseMode: z.enum(['auto', 'stream', 'json']),
}).refine((row) => row.imageModel !== '' || row.visionModel !== '')
const selectionSchema = z
  .strictObject({
    providerId: z.string().min(1).max(64),
    model: z.string().trim().min(1).max(120),
  })
  .nullable()
const schema = z
  .strictObject({
    providers: z.array(providerSchema).max(100),
    selections: z.strictObject({ image: selectionSchema, vision: selectionSchema }),
  })
  .refine(
    (input) =>
      new Set(input.providers.map((row) => row.id)).size === input.providers.length &&
      Object.values(input.selections).every(
        (selection) =>
          selection === null ||
          input.providers.some((row) => row.id === selection.providerId),
      ),
  )

export function configurationTransfer(store: PrivateStore) {
  return createConfigurationTransfer({
    schema,
    invalid: invalidRequest,
    async read() {
      const document = await store.read()
      return {
        providers: document.providers.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          baseUrl: row.baseUrl,
          apiKey: row.apiKey,
          imageModel: row.imageModel,
          visionModel: row.visionModel,
          imageTimeoutSeconds: row.imageTimeoutSeconds,
          imageResponseMode: row.imageResponseMode,
        })),
        selections: {
          image: document.providers.some(
            (row) => row.id === document.selections.image?.providerId,
          )
            ? document.selections.image
            : null,
          vision: document.providers.some(
            (row) => row.id === document.selections.vision?.providerId,
          )
            ? document.selections.vision
            : null,
        },
      }
    },
    async apply(input) {
      await store.mutate((document) => {
        const timestamp = new Date().toISOString()
        for (const provider of input.providers) {
          const index = document.providers.findIndex((row) => row.id === provider.id)
          const row = {
            ...provider,
            baseUrl: normalizeBaseUrl(provider.baseUrl),
            createdAt: document.providers[index]?.createdAt ?? timestamp,
            updatedAt: timestamp,
          }
          if (index < 0) document.providers.push(row)
          else document.providers[index] = row
        }
        document.selections = input.selections
      })
    },
  })
}
