import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function collectPluginResources(directory, declared = []) {
  if (
    !Array.isArray(declared) ||
    declared.length > 20 ||
    new Set(declared).size !== declared.length
  )
    throw new Error('Invalid plugin resource declaration')
  const files = []
  for (const path of declared) {
    if (
      typeof path !== 'string' ||
      !/^resources\/[a-zA-Z0-9_./-]+$/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Invalid package resource path')
    let current = directory
    const segments = path.split('/')
    for (const [index, part] of segments.entries()) {
      current = join(current, part)
      const info = await lstat(current)
      if (
        info.isSymbolicLink() ||
        (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())
      )
        throw new Error('Plugin resources must be regular files within the package')
    }
    const data = await readFile(current)
    if (data.length > 1024 * 1024)
      throw new Error('Plugin resource exceeds its byte budget')
    files.push({ path, data })
  }
  return files
}
