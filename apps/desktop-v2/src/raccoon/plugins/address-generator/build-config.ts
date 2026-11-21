export function mapsBuildKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim()
  return key.length >= 10 && key.length <= 512 && !/\s/.test(key) ? key : null
}
