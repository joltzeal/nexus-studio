import { spawn } from 'node:child_process'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'

let directory: string
let guard: string
const valid = JSON.stringify({
  schemaVersion: 1,
  storageState: { cookies: [], origins: [] },
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nexus-state-validation-'))
  guard = join(directory, 'no-sdk.mjs')
  await writeFile(
    guard,
    `import {registerHooks} from 'node:module';
     registerHooks({resolve(specifier,context,next){
       if(specifier==='cloakbrowser') throw new Error('SDK imported during validation');
       return next(specifier,context);
     }});`,
  )
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function validate(paths: string[]) {
  const runner = fileURLToPath(new URL('../dist/profile-runner.js', import.meta.url))
  const child = spawn(process.execPath, [
    '--import',
    guard,
    runner,
    'validate-state',
    ...paths,
  ])
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString()
  })
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  const timer = setTimeout(() => child.kill(), 2_000)
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { exit, stdout, stderr }
  } finally {
    clearTimeout(timer)
    child.stdin.destroy()
  }
}

it('validates every complete state before emitting one success JSON without loading the SDK or reading stdin', async () => {
  const paths = [join(directory, 'first.json'), join(directory, 'second.json')]
  await Promise.all(paths.map((path) => writeFile(path, valid)))
  expect(await validate(paths)).toEqual({
    exit: 0,
    stdout: '{"valid":true}\n',
    stderr: '',
  })
})

it.each([
  { schemaVersion: 1, storageState: {} },
  {
    schemaVersion: 1,
    storageState: {
      cookies: [],
      origins: [{ origin: 'https://example.test', localStorage: 'invalid' }],
    },
  },
  'invalid-json',
])(
  'rejects invalid state after a valid file without partial success or data in errors',
  async (state) => {
    const first = join(directory, 'first.json')
    const second = join(directory, 'secret-name.json')
    await writeFile(first, valid)
    await writeFile(second, typeof state === 'string' ? state : JSON.stringify(state))
    expect(await validate([first, second])).toEqual({
      exit: 1,
      stdout: '',
      stderr: 'PORTABLE_STATE_INVALID\n',
    })
  },
)

it('rejects a sparse oversized file before reading its contents', async () => {
  const path = join(directory, 'oversized.json')
  const file = await open(path, 'w')
  try {
    await file.truncate(128 * 1024 * 1024 + 1)
  } finally {
    await file.close()
  }
  expect(await validate([path])).toEqual({
    exit: 1,
    stdout: '',
    stderr: 'PORTABLE_STATE_TOO_LARGE\n',
  })
})

it.each([
  { paths: [] },
  { paths: ['relative.json'] },
  { paths: Array<string>(101).fill('/unused.json') },
])('rejects invalid path arguments before opening files (%j)', async ({ paths }) => {
  expect(await validate(paths)).toEqual({
    exit: 1,
    stdout: '',
    stderr: 'PORTABLE_STATE_INVALID_ARGUMENTS\n',
  })
})

it('redacts file read errors', async () => {
  expect(await validate([join(directory, 'missing-secret-name.json')])).toEqual({
    exit: 1,
    stdout: '',
    stderr: 'PORTABLE_STATE_READ_FAILED\n',
  })
})
