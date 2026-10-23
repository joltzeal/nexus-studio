import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export async function verifySdkDependencies(from = import.meta.url): Promise<void> {
  try {
    const runtime = createRequire(from)
    const sdk = createRequire(runtime.resolve('cloakbrowser'))
    await import(pathToFileURL(sdk.resolve('playwright-core')).href)
    for (const dependency of ['undici', 'socks']) {
      await import(pathToFileURL(runtime.resolve(dependency)).href)
    }
  } catch {
    throw new Error('BROWSER_RUNTIME_DEPENDENCY_MISSING')
  }
}
