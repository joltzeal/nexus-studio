import type { ProductPublication } from '@nexus/plugin-contracts/products'

export function compareProductPublicationRecency(
  left: ProductPublication,
  right: ProductPublication,
): number {
  const wholeSeconds = (value: string) => Date.parse(value.replace(/\.\d+Z$/, 'Z'))
  let difference = wholeSeconds(left.publishedAt) - wholeSeconds(right.publishedAt)
  if (difference === 0) {
    // Compare ISO fractions directly; Date.parse can misread long fractions.
    const fraction = (value: string) =>
      (value.match(/\.(\d+)Z$/)?.[1] ?? '').replace(/0+$/, '')
    const leftFraction = fraction(left.publishedAt)
    const rightFraction = fraction(right.publishedAt)
    difference =
      leftFraction === rightFraction ? 0 : leftFraction > rightFraction ? 1 : -1
  }
  if (difference !== 0) return difference
  return left.id === right.id ? 0 : left.id > right.id ? 1 : -1
}
