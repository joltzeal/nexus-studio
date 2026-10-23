import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const { default: manifest } = await import('../dist/nexus.plugin.js')
await writeFile(
  fileURLToPath(new URL('../dist/nexus.plugin.json', import.meta.url)),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)
