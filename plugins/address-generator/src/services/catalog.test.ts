import { describe, expect, it } from 'vitest'
import { CITIES, citiesOf, findCity } from './catalog.js'

describe('city navigation catalog', () => {
  it('offers major US cities across the east, central and west coasts for map selection', () => {
    expect(citiesOf('US').map((city) => city.id)).toEqual(
      expect.arrayContaining([
        'new-york',
        'los-angeles',
        'chicago',
        'houston',
        'phoenix',
        'philadelphia',
        'san-antonio',
        'san-diego',
        'dallas',
        'san-jose',
        'austin',
        'san-francisco',
        'seattle',
        'boston',
        'miami',
        'denver',
        'washington-dc',
        'atlanta',
        'las-vegas',
        'portland',
        'nashville',
      ]),
    )
  })

  it('keeps valid distinct centers and the existing European destinations', () => {
    expect(new Set(CITIES.map((city) => city.id)).size).toBe(CITIES.length)
    for (const city of CITIES) {
      expect(Number.isFinite(city.latitude)).toBe(true)
      expect(Number.isFinite(city.longitude)).toBe(true)
      expect(Math.abs(city.latitude)).toBeLessThanOrEqual(90)
      expect(Math.abs(city.longitude)).toBeLessThanOrEqual(180)
      expect(findCity(city.id)).toEqual(city)
    }
    expect(findCity('paris')).toMatchObject({ country: 'FR', latitude: 48.8566 })
    expect(findCity('seattle')).toMatchObject({ country: 'US', longitude: -122.3321 })
    expect(findCity('miami')).toMatchObject({ country: 'US', latitude: 25.7617 })
  })
})
