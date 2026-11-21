export async function transferSelection<T extends { key: string }>(
  entries: readonly T[],
  isActive: () => boolean,
  isSelected: (key: string) => boolean,
  transfer: (entry: T) => Promise<void>,
): Promise<void> {
  for (const entry of entries) {
    if (!isActive()) return
    if (isSelected(entry.key)) await transfer(entry)
  }
}
