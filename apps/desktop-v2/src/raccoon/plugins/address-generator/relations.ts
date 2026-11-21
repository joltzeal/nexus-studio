import type { Profile, SavedProfile } from './model.ts'
import { parseProfile } from './parse.ts'

type Target = { id: string; address: { id: string } | null }
export function createAddressRelations(
  addresses: {
    save(profile: Profile): Promise<{ item: SavedProfile; storageDurable: boolean }>
  },
  accounts: {
    saveAddress(
      id: string,
      profile: Profile,
      expected: string | null,
    ): Promise<{ storageDurable: boolean }>
  },
) {
  return async (
    profile: Profile,
    target: Target,
    onSaved: (profile: SavedProfile, durable: boolean) => void,
    current: () => boolean,
  ) => {
    if (!current()) return
    const saved = await addresses.save(profile)
    if (!current()) return
    onSaved(saved.item, saved.storageDurable)
    const result = await accounts.saveAddress(
      target.id,
      parseProfile(saved.item),
      target.address?.id ?? null,
    )
    return { addressDurable: saved.storageDurable, accountDurable: result.storageDurable }
  }
}
