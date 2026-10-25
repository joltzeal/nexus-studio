import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let directory: string
let preload: string
let binary: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nexus-profile-runner-'))
  binary = join(
    directory,
    'chromium-155.0.8059.39.2-pro',
    process.platform === 'darwin'
      ? 'Chromium.app/Contents/MacOS/Chromium'
      : process.platform === 'win32'
        ? 'chrome.exe'
        : 'chrome',
  )
  await mkdir(dirname(binary), { recursive: true })
  await writeFile(
    binary,
    `#!${process.execPath}\nconsole.log('CloakBrowser 155.0.8059.39.2')\n`,
    {
      mode: 0o700,
    },
  )
  const sdk = join(directory, 'sdk.mjs')
  await writeFile(
    sdk,
    `
    import {EventEmitter} from 'node:events';
    export const ensureBinary=(key,version,channel)=>{
      if(key!=='synthetic-runner-key' || version!==process.env.CLOAKBROWSER_VERSION || channel!=='stable')
        throw new Error('Unexpected preparation request');
      return ${JSON.stringify(binary)};
    };
    export const validateLicense=()=>{};
    export const buildLaunchOptions=async()=>({});
    export async function launchPersistentContext(options) {
      if (process.env.NEXUS_TEST_SDK_FAILURE)
        throw new Error('mmdb-lib is required for geoip');
      const context=new EventEmitter();
      let closeTimer;
      let rejectNavigation;
      const page={
        async goto(url) {
          if (url.startsWith('chrome://')) return;
          return new Promise((_,reject)=>{rejectNavigation=reject});
        },
        async evaluate(){return []},
        async route(){},
        async close(){}
      };
      context.pages=()=>[page];
      context.newPage=async()=>page;
      context.route=async()=>{};
      context.setOffline=async()=>{};
      context.storageState=async()=>({
        cookies:[{
          name:'large-synthetic-session', value:'x'.repeat(2*1024*1024),
          domain:'example.test',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'
        }],origins:[]
      });
      let closed=false;
      context.close=async()=>{
        if(closed)return;
        closed=true;
        clearTimeout(closeTimer);
        rejectNavigation?.(new Error('Target closed'));
        context.emit('close');
      };
      if (!options.headless) closeTimer=setTimeout(()=>context.close(),50);
      return context;
    }
  `,
  )
  preload = join(directory, 'preload.mjs')
  await writeFile(
    preload,
    `
    import {registerHooks} from 'node:module';
    registerHooks({
      resolve(specifier,context,nextResolve) {
        if(specifier==='cloakbrowser')return{
          url:${JSON.stringify(pathToFileURL(sdk).href)},shortCircuit:true
        };
        if(specifier.startsWith('.') && specifier.endsWith('.js') &&
          context.parentURL?.startsWith(${JSON.stringify(new URL('./', import.meta.url).href)})) {
          return nextResolve(specifier.slice(0,-3)+'.ts',context);
        }
        return nextResolve(specifier,context);
      }
    });
  `,
  )
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function run(
  action: string,
  startUrl: string,
  closeStdin: boolean,
  sdkFailure = false,
  target = join(directory, 'user-data'),
  activated = true,
  requestedVersion?: string,
) {
  const runner = fileURLToPath(new URL('./profile-runner.ts', import.meta.url))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOAKBROWSER_CACHE_DIR: directory,
    CLOAKBROWSER_LICENSE_KEY: activated ? 'synthetic-runner-key' : '',
    ...(sdkFailure ? { NEXUS_TEST_SDK_FAILURE: '1' } : {}),
  }
  delete env.CLOAKBROWSER_VERSION
  if (requestedVersion !== undefined) env.CLOAKBROWSER_VERSION = requestedVersion
  const child = spawn(process.execPath, ['--import', preload, runner, action, target], {
    env,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString()
  })
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  child.stdin.on('error', () => {})
  child.stdin.write(
    `${JSON.stringify({
      schema_version: 1,
      id: 'profile',
      binary_path: binary,
      binding: { profile_id: 'profile', channel_version: '155.0.8059.39.2' },
      proxy: null,
      settings: {
        geoip: true,
        timezone: '',
        locale: '',
        viewport: 'default',
        fingerprintSeed: null,
        startUrl,
      },
    })}\n`,
  )
  if (closeStdin) child.stdin.end()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 2_000)
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { exit, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
    child.stdin.destroy()
  }
}

describe('profile runner subprocess', () => {
  it('routes a requested download revision to the exact SDK request and exits without stdin', async () => {
    const result = await run(
      'download',
      '',
      false,
      false,
      directory,
      true,
      '155.0.8059.39.2',
    )
    expect(result).toMatchObject({ exit: 0, timedOut: false, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({
      binary_path: binary,
      version: '155.0.8059.39.2',
    })
  })

  it('rejects an explicitly empty download version instead of downloading latest', async () => {
    const result = await run('download', '', false, false, directory, true, '')
    expect(result).toMatchObject({ exit: 1, timedOut: false, stdout: '' })
    expect(result.stderr).toContain('"code":"VERSION"')
    expect(result.stderr).not.toContain('synthetic-runner-key')
  })

  it('returns an actionable preparation failure without an activation code', async () => {
    const result = await run('prepare', '', false, false, directory, false)
    expect(result).toMatchObject({ exit: 1, timedOut: false, stdout: '' })
    expect(result.stderr).toContain('"code":"ACTIVATION"')
    expect(result.stderr).not.toContain('synthetic-runner-key')
  })

  it('probes the actual binary display version without launching a context or waiting for stdin', async () => {
    await writeFile(
      binary,
      `#!${process.execPath}\nconsole.log('Chromium 155.0.8059.39')\n`,
    )
    const result = await run('version', '', false, true, binary)
    expect(result).toMatchObject({ exit: 0, timedOut: false, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({
      version: '155.0.8059.39',
      binary_path: binary,
    })
  })

  it('rejects a missing binary instead of returning an unverified version', async () => {
    const result = await run('version', '', false, false, join(directory, 'missing'))
    expect(result).toMatchObject({ exit: 1, timedOut: false, stdout: '' })
  })

  it('exits with the SDK error instead of hanging on open stdin after GeoIP startup failure', async () => {
    const result = await run('launch', '', false, true)
    expect(result.timedOut).toBe(false)
    expect(result.exit).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('mmdb-lib is required for geoip\n')
  })

  it('exits after the browser closes even while stdin and start-page navigation are pending', async () => {
    const result = await run('launch', 'https://pending.example?secret=do-not-log', false)
    expect(result.timedOut).toBe(false)
    expect(result.exit).toBe(0)
    expect(result.stdout).toBe('NEXUS_READY\n')
    expect(result.stderr).not.toContain('do-not-log')
  })

  it.each([true, false])(
    'returns exactly one complete snapshot JSON larger than 1 MiB and closes input (EOF=%s)',
    async (closeStdin) => {
      const result = await run('snapshot', 'https://never.example', closeStdin)
      expect(result).toMatchObject({ exit: 0, timedOut: false, stderr: '' })
      expect(result.stdout.endsWith('\n')).toBe(true)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      const state = JSON.parse(result.stdout) as {
        schemaVersion: number
        storageState: { cookies: { value: string }[] }
      }
      expect(state.schemaVersion).toBe(1)
      expect(state.storageState.cookies[0]!.value.length).toBe(2 * 1024 * 1024)
    },
  )
})
