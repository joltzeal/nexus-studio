/** A short, pronounceable English word — a window name is display data. */
const WORDS = [
  'amber',
  'aspen',
  'birch',
  'bloom',
  'breeze',
  'cedar',
  'clover',
  'cobalt',
  'comet',
  'coral',
  'cove',
  'crane',
  'dawn',
  'dune',
  'ember',
  'fern',
  'flint',
  'frost',
  'gale',
  'glade',
  'glacier',
  'harbor',
  'hazel',
  'heron',
  'indigo',
  'ivory',
  'jade',
  'juniper',
  'kestrel',
  'lagoon',
  'larch',
  'linen',
  'lumen',
  'maple',
  'meadow',
  'mesa',
  'mist',
  'nectar',
  'nimbus',
  'oak',
  'onyx',
  'opal',
  'orchid',
  'otter',
  'pebble',
  'pine',
  'plume',
  'quartz',
  'raven',
  'reef',
  'ridge',
  'river',
  'sage',
  'shore',
  'slate',
  'sparrow',
  'spruce',
  'summit',
  'thistle',
  'tide',
  'topaz',
  'vale',
  'velvet',
  'willow',
  'wren',
  'zephyr',
] as const

/**
 * The window name is optional: an empty field becomes one English word. A
 * duplicate gets a numeric suffix so two windows never look identical.
 */
export function randomWindowName(taken: readonly string[] = []): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()))
  const pool = WORDS.filter((word) => !used.has(word))
  const candidates = pool.length > 0 ? pool : WORDS
  const word = candidates[Math.floor(Math.random() * candidates.length)] ?? 'window'
  if (!used.has(word)) return word
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${word}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return `${word}-${Date.now() % 1000}`
}

/** The seed is a 31-bit positive integer; 0 is reserved as "unset". */
export function randomFingerprintSeed(): number {
  return 1 + Math.floor(Math.random() * 2_147_483_646)
}
