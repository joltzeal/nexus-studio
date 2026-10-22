import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Vite already ships rolldown, but it is not a direct dependency, so the bare
 * specifier does not resolve from the repository root. Falling back to the pnpm
 * store keeps `pnpm market:pack` working without adding another dependency.
 */
export async function loadRolldown(root) {
  const direct = await import('rolldown').catch(() => null)
  if (direct !== null) return direct
  const names = await readdir(join(root, 'node_modules/.pnpm')).catch(() => null)
  if (names === null) {
    throw new Error('找不到 rolldown，请先在仓库根目录执行 pnpm install')
  }
  const candidates = names
    .filter((name) => name.startsWith('rolldown@'))
    .sort()
    .reverse()
  for (const directory of candidates) {
    const entry = join(
      root,
      'node_modules/.pnpm',
      directory,
      'node_modules/rolldown/dist/index.mjs',
    )
    const loaded = await import(pathToFileURL(entry).href).catch(() => null)
    if (loaded !== null) return loaded
  }
  throw new Error('找不到 rolldown，请先在仓库根目录执行 pnpm install')
}

export async function bundleEntry({ root, input, external = [] }) {
  const { rolldown } = await loadRolldown(root)
  const bundle = await rolldown({
    input,
    platform: 'node',
    external: [/^node:/, ...external],
  })
  try {
    const output = await bundle.generate({ format: 'esm', minify: true })
    const chunk = output.output.find((item) => item.type === 'chunk')
    if (chunk === undefined) throw new Error(`${input} 没有产出可执行代码`)
    return chunk.code
  } finally {
    await bundle.close()
  }
}
