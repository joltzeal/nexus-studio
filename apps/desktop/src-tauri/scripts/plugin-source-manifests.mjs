import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? '')
const plugins = []
const problems = []
const entries = await readdir(root, { withFileTypes: true })

for (const entry of entries
  .filter((item) => item.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name))) {
  const directory = join(root, entry.name)
  const manifestPath = join(directory, 'nexus.plugin.ts')
  const sourceEntry = join(directory, 'src', 'index.ts')

  try {
    const manifestModule = await import(pathToFileURL(manifestPath).href)
    if (!manifestModule.default || typeof manifestModule.default !== 'object') {
      throw new Error('nexus.plugin.ts must have a default manifest export')
    }

    plugins.push({ directory, entry: sourceEntry, manifest: manifestModule.default })
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(manifestPath))
      continue
    problems.push({
      directory,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

process.stdout.write(`${JSON.stringify({ plugins, problems })}\n`)
