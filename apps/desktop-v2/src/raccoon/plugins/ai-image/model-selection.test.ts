import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTIONS,
  NO_MODEL,
  modelOptions,
  modelPair,
  modelValue,
  providerCatalog,
  resolveModel,
} from './model-selection'
import { makeProvider } from './scene-plan.test-data'

describe('provider and model identity', () => {
  it('does not infer first-provider choices from old documents', () => {
    const result = providerCatalog({ items: [makeProvider()], storageDurable: true })
    expect(result.modelConfigVersion).toBe(1)
    expect(result.selections).toEqual(EMPTY_SELECTIONS)
    expect(
      resolveModel(result.items, 'image', modelValue(result.selections.image)),
    ).toBeNull()
    expect(modelOptions(result.items, 'image', NO_MODEL)[0]?.value).toBe(NO_MODEL)
  })

  it('restores two independent saved pairs including punctuation in IDs or model names', () => {
    const image = makeProvider({ id: 'image:"provider', imageModel: 'image/v2:pro' })
    const vision = makeProvider({ id: 'vision-provider' })
    const selections = {
      image: { providerId: image.id, model: image.imageModel },
      vision: { providerId: vision.id, model: 'vision-model' },
    }
    const catalog = providerCatalog({
      items: [image, vision],
      storageDurable: true,
      modelConfigVersion: 2,
      selections,
    })
    expect(catalog.selections).toEqual(selections)
    expect(modelPair(modelValue(selections.image))).toEqual(selections.image)
    expect(
      resolveModel(catalog.items, 'image', modelValue(selections.image))?.provider.id,
    ).toBe(image.id)
    expect(
      resolveModel(catalog.items, 'vision', modelValue(selections.vision))?.provider.id,
    ).toBe(vision.id)
  })

  it.each([
    { providers: [makeProvider({ imageModel: 'changed' })] },
    { providers: [makeProvider({ hasApiKey: false })] },
    { providers: [makeProvider({ id: 'replacement' })] },
    { providers: [] },
  ])(
    'never replaces a stale selection with another configured model',
    ({ providers }) => {
      const value = modelValue({ providerId: 'vision-provider', model: 'image-model' })
      expect(resolveModel(providers, 'image', value)).toBeNull()
      expect(modelOptions(providers, 'image', value)).toContainEqual({
        value,
        label: '上次选择已失效，请重新选择',
      })
    },
  )

  it('supports role-specific providers and excludes empty models', () => {
    const vision = makeProvider({ imageModel: '' })
    const image = makeProvider({ id: 'image', visionModel: '' })
    expect(modelOptions([vision, image], 'vision', NO_MODEL)).toHaveLength(2)
    expect(modelOptions([vision, image], 'image', NO_MODEL)).toHaveLength(2)
    expect(
      resolveModel(
        [image],
        'vision',
        modelValue({ providerId: image.id, model: image.imageModel }),
      ),
    ).toBeNull()
  })

  it.each([null, [], 'x', { image: {} }, { image: { providerId: 'a', model: '' } }])(
    'ignores malformed saved pairs without inferring a model: %j',
    (selections) => {
      expect(
        providerCatalog({ items: [], storageDurable: true, selections }).selections,
      ).toEqual(EMPTY_SELECTIONS)
    },
  )
})
