export function hasImageWork(
  status: Record<string, unknown> | null | undefined,
): boolean {
  return ['running', 'queued', 'activeGenerations'].some((key) => {
    const count = status?.[key]
    return typeof count === 'number' && Number.isSafeInteger(count) && count > 0
  })
}
