import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export async function verifySdkDependencies(from = import.meta.url): Promise<void> {
  try {
    const sdk = createRequire(createRequire(from).resolve('cloakbrowser'))
    for (const dependency of ['mmdb-lib', 'socks-proxy-agent']) {
      await import(pathToFileURL(sdk.resolve(dependency)).href)
    }
  } catch {
    throw new Error('BROWSER_RUNTIME_DEPENDENCY_MISSING')
  }
}
