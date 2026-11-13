import { writeFile } from 'node:fs/promises'
import manifest from '../dist/nexus.plugin.js'

await writeFile(
  new URL('../dist/nexus.plugin.json', import.meta.url),
  `${JSON.stringify(manifest, null, 2)}\n`,
)
