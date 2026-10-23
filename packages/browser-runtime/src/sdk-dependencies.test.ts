import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { verifySdkDependencies } from './sdk-dependencies.js'

const sdkRequire = createRequire(createRequire(import.meta.url).resolve('cloakbrowser'))

it.each(['mmdb-lib', 'socks-proxy-agent'])(
  'loads the GeoIP dependency %s from the SDK own resolution location',
  async (dependency) => {
    await expect(
      (async () => import(pathToFileURL(sdkRequire.resolve(dependency)).href))(),
    ).resolves.toBeDefined()
  },
)

it('checks the complete SDK dependency graph used by runtime staging', async () => {
  await expect(verifySdkDependencies()).resolves.toBeUndefined()
})

it('rejects a deployment that can import the SDK but omits its optional GeoIP peers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-sdk-dependencies-'))
  const sdk = join(directory, 'node_modules/cloakbrowser')
  try {
    await mkdir(sdk, { recursive: true })
    await writeFile(join(sdk, 'package.json'), '{"main":"index.js","type":"module"}')
    await writeFile(join(sdk, 'index.js'), 'export const launchPersistentContext=()=>{}')
    // Use native Node resolution without Vitest's global pnpm NODE_PATH fallback.
    const module = new URL('../dist/sdk-dependencies.js', import.meta.url).href
    const entry = pathToFileURL(join(directory, 'entry.js')).href
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {verifySdkDependencies} from ${JSON.stringify(module)};
           try { await verifySdkDependencies(${JSON.stringify(entry)}) }
           catch(error) { console.error(error.message); process.exitCode=1 }`,
        ],
        { env: { ...process.env, NODE_PATH: '' } },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: 'BROWSER_RUNTIME_DEPENDENCY_MISSING\n',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
