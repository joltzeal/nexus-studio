import type { EndpointRecord } from '../domain/schemas.js'

const BUILTIN_NAMES = new Set([
  'DIRECT',
  'REJECT',
  'GLOBAL',
  'REJECT-DROP',
  'PASS',
  'COMPATIBLE',
])

function text(value: unknown): string {
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean).join(' ') : ''
}

/** Readable Clash node names built from saved geolocation and IP score. */
export function nodeLabel(row: EndpointRecord): string {
  const geo = row.geo
  if (geo === null || geo.status !== 'ok') return row.name

  const code = text(geo.countryCode).toUpperCase()
  const validCode = code.length === 2 && /^[A-Z]{2}$/.test(code)
  const country = text(geo.country) || (validCode ? code : '')
  if (country === '') return row.name

  const flag = validCode
    ? [...code]
        .map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0)))
        .join('')
    : ''
  const parts = [`${flag} ${country}`.trim()]
  const region = text(geo.region)
  if (region !== '') parts.push(region)
  const risk = row.riskScore
  const score =
    typeof risk === 'number' && Number.isInteger(risk) && risk >= 0 && risk <= 100
      ? `${100 - risk}/100`
      : '—'
  parts.push(`IP ${score}`)
  return parts.join(' · ')
}

/** Allocates unique names, preserving naturally distinct labels. */
export function nodeNames(rows: EndpointRecord[], groupName: string): string[] {
  const bases = rows.map(nodeLabel)
  const reserved = new Set([...BUILTIN_NAMES, groupName])
  const used = new Set(reserved)
  const unavailable = new Set([...bases, ...reserved])
  const suffixes = new Map<string, number>()
  const names: string[] = []

  for (const base of bases) {
    let name = base
    if (used.has(name)) {
      let suffix = (suffixes.get(base) ?? 1) + 1
      name = `${base} #${suffix}`
      while (used.has(name) || unavailable.has(name)) {
        suffix += 1
        name = `${base} #${suffix}`
      }
      suffixes.set(base, suffix)
    }
    used.add(name)
    names.push(name)
  }
  return names
}
