import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The TypeScript manifest stays the single source of truth. The host reads the
 * emitted JSON so it can validate a package before starting any process, and
 * compares the digest with what the process reports at handshake time.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const module = await import(join(root, 'dist/nexus.plugin.js'))
const manifest = module.default
if (manifest === null || typeof manifest !== 'object') {
  throw new Error('nexus.plugin.ts did not export a manifest object')
}
await writeFile(
  join(root, 'dist/nexus.plugin.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)
