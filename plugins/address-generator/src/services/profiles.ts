import { randomUUID } from 'node:crypto'

import type { AddressRecord, ProfileRecord } from '../domain/address.js'
import type { CountryCode } from './catalog.js'
import { pickName } from './names.js'
import { createUsernameAllocator } from './username.js'

export interface BuildProfileOptions {
  country: CountryCode
  random?: () => number
  idFactory?: () => string
}

/**
 * Attaches an identity to each address. Usernames are allocated across the
 * whole batch so two rows never share a handle, and names are drawn from the
 * country's pool so the identity matches the address it belongs to.
 */
export function buildProfiles(
  addresses: readonly AddressRecord[],
  { country, random = Math.random, idFactory = randomUUID }: BuildProfileOptions,
): ProfileRecord[] {
  const allocate = createUsernameAllocator(random)
  return addresses.map((address) => {
    const { firstName, lastName } = pickName(country, random)
    return {
      ...address,
      id: idFactory(),
      firstName,
      lastName,
      username: allocate(firstName, lastName),
    }
  })
}
