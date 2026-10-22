import { openProfile, prepareBinary, validateBrowserLicense } from './profile-runtime.js'
import type { NativeProfile } from './profile-runtime.js'
import { createInterface } from 'node:readline'

async function main(): Promise<void> {
  const [action, userDataDir] = process.argv.slice(2)
  if (action === 'prepare') {
    process.stdout.write(
      `${JSON.stringify(
        await prepareBinary(
          process.env.CLOAKBROWSER_LICENSE_KEY,
          process.env.CLOAKBROWSER_VERSION,
        ),
      )}\n`,
    )
  } else if (action === 'validate-license') {
    const key = process.env.CLOAKBROWSER_LICENSE_KEY
    if (!key) throw new Error('License key is required')
    process.stdout.write(`${JSON.stringify(await validateBrowserLicense(key))}\n`)
  } else if (action === 'launch' && userDataDir) {
    const input = createInterface({ input: process.stdin })
    const commands = input[Symbol.asyncIterator]()
    const first = await commands.next()
    if (first.done) throw new Error('Profile configuration missing')
    await openProfile(userDataDir, JSON.parse(first.value) as NativeProfile, commands)
  } else {
    throw new Error('Unknown profile action')
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Profile runtime failed')
  process.exitCode = 1
})
