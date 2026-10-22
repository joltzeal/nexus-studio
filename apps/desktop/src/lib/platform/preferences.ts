import {
  DEFAULT_PREFERENCES,
  PreferencesSchema,
  type Preferences,
} from '@nexus/contracts'

const PREVIEW_STORAGE_KEY = 'nexus.preview.preferences.v1'

export interface PreferenceRepository {
  load(): Promise<Preferences>
  save(preferences: Preferences): Promise<Preferences>
}

export function createPreviewRepository(storage: Storage): PreferenceRepository {
  return {
    async load() {
      const value = storage.getItem(PREVIEW_STORAGE_KEY)
      return value
        ? PreferencesSchema.parse(JSON.parse(value))
        : { ...DEFAULT_PREFERENCES }
    },
    async save(preferences) {
      const validated = PreferencesSchema.parse(preferences)
      storage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(validated))
      return validated
    },
  }
}

export function getPreferenceRepository(): PreferenceRepository {
  // The desktop shell uses the same demo adapter until native storage is implemented.
  return createPreviewRepository(window.localStorage)
}

export function createPreferenceWriter(repository: PreferenceRepository) {
  let tail: Promise<void> = Promise.resolve()

  return (preferences: Preferences): Promise<Preferences> => {
    const operation = tail.then(() => repository.save(preferences))
    // Recover the queue after a rejected write so the next explicit attempt can run.
    tail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }
}

export function preferenceErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    'code' in error
  ) {
    return error.message
  }
  return '暂时无法读取或保存偏好，请重试。'
}
