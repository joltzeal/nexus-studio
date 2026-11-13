import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runtimeWindow } from '../fixtures/runtime-window.js'

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
    export async function launchPersistentContext(options) {
      if (process.env.NEXUS_TEST_SDK_FAILURE)
        throw new Error('mmdb-lib is required for geoip');
      if (options.browserVersion!=='155.0.8059.39.2' ||
          options.launchOptions.executablePath!==${JSON.stringify(binary)} ||
          process.env.CLOAKBROWSER_BINARY_PATH!==${JSON.stringify(binary)} ||
          !options.args.includes('--fingerprint=123456789'))
        throw new Error('Unexpected window binding');
      if (options.proxy && (
          options.proxy!=='http://synthetic-user:do-not-log@proxy.example:8080' ||
          process.argv.some(arg=>arg.includes('do-not-log'))))
        throw new Error('Unexpected resolved proxy');
      const context=new EventEmitter();
      let closeTimer;
      let rejectNavigation;
      let pageUrl='about:blank';
      const page={
        url:()=>pageUrl,
        isClosed:()=>false,
        async goto(url) {
          if (url.startsWith('chrome://')) return;
          if (process.env.NEXUS_TEST_AUTOMATION) {pageUrl=url;return;}
          return new Promise((_,reject)=>{rejectNavigation=reject});
        },
        async evaluate(script){
          if(String(script).includes('maxChars'))return{
            url:pageUrl,title:'Fixture',text:'Fixture page',controls:[]
          };
          return [];
        },
        async route(){},
        async unroute(){},
        async close(){}
      };
      context.pages=()=>[page];
      context.newPage=async()=>page;
      context.route=async()=>{};
      context.unroute=async()=>{};
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
      if (!options.headless && !process.env.NEXUS_TEST_AUTOMATION)
        closeTimer=setTimeout(()=>context.close(),50);
      return context;
    }
  `,
  )
  const cdp = join(directory, 'cdp.mjs')
  await writeFile(
    cdp,
    `
    import {EventEmitter} from 'node:events';
    export const chromium={
      async connectOverCDP(endpoint,options) {
        if(endpoint!=='ws://127.0.0.1:9000/devtools/browser/fixture' || options.timeout!==30000)
          throw new Error('Unexpected CDP attach');
        let url='about:blank';
        const page={
          url:()=>url,isClosed:()=>false,route:async()=>{},unroute:async()=>{},
          goto:async next=>{url=next},
          evaluate:async()=>({url,title:'Vendor',text:'Existing vendor page',controls:[]}),
          close:async()=>{throw new Error('Unexpected page.close')}
        };
        const context={
          pages:()=>[page],newPage:async()=>{throw new Error('Unexpected context')},
          route:async()=>{},unroute:async()=>{}
        };
        const browser=new EventEmitter();
        browser.contexts=()=>[context];
        browser.close=async()=>{process.stderr.write('UNEXPECTED_BROWSER_CLOSE\\n')};
        if(process.env.NEXUS_TEST_CDP_DISCONNECT)
          setTimeout(()=>browser.emit('disconnected'),30);
        return browser;
      }
    };
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
        if(specifier==='playwright-core')return{
          url:${JSON.stringify(pathToFileURL(cdp).href)},shortCircuit:true
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
  payload: unknown = runtimeWindow({
    binary_path: binary,
    settings: { ...runtimeWindow().settings, startUrl },
  }),
  automationCommands: Record<string, unknown>[] = [],
) {
  const runner = fileURLToPath(new URL('./profile-runner.ts', import.meta.url))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOAKBROWSER_CACHE_DIR: directory,
    CLOAKBROWSER_LICENSE_KEY: activated ? 'synthetic-runner-key' : '',
    ...(sdkFailure ? { NEXUS_TEST_SDK_FAILURE: '1' } : {}),
    ...(automationCommands.length ? { NEXUS_TEST_AUTOMATION: '1' } : {}),
    ...(action === 'automation-cdp' && !automationCommands.length
      ? { NEXUS_TEST_CDP_DISCONNECT: '1' }
      : {}),
  }
  delete env.CLOAKBROWSER_VERSION
  if (requestedVersion !== undefined) env.CLOAKBROWSER_VERSION = requestedVersion
  const child = spawn(process.execPath, ['--import', preload, runner, action, target], {
    env,
  })
  let stdout = ''
  let stderr = ''
  let sent = false
  let stopped = false
  let nextCommand = 0
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString()
    if (automationCommands.length && !sent && stdout.includes('NEXUS_READY\n')) {
      sent = true
      // Wait for each receipt before dispatching the next window operation.
      child.stdin.write(`${JSON.stringify(automationCommands[nextCommand++])}\n`)
    }
    if (sent && !stopped) {
      const completed = stdout
        .split('\n')
        .filter((line) => line.startsWith('NEXUS_AUTOMATION ')).length
      if (completed >= automationCommands.length) {
        stopped = true
        child.stdin.end('stop\n')
      } else if (completed >= nextCommand && nextCommand < automationCommands.length) {
        child.stdin.write(`${JSON.stringify(automationCommands[nextCommand++])}\n`)
      }
    }
  })
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  child.stdin.on('error', () => {})
  child.stdin.write(
    `${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`,
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
  it('executes commands inside the original builtin persistent context and preserves stop/proxy', async () => {
    const result = await run(
      'launch',
      '',
      false,
      false,
      undefined,
      true,
      undefined,
      runtimeWindow({
        binary_path: binary,
        proxy_mode: 'plugin',
        proxy: 'http://synthetic-user:do-not-log@proxy.example:8080',
        proxy_plugin: 'opaque/plugin-ref:v2',
        settings: { ...runtimeWindow().settings, startUrl: '', geoip: false },
      }),
      [
        {
          requestId: 'navigate',
          operation: 'navigate',
          origin: 'https://www.vinted.fr',
          input: { url: 'https://www.vinted.fr/items/new' },
        },
        {
          requestId: 'snapshot',
          operation: 'snapshot',
          origin: 'https://www.vinted.fr',
          input: {},
        },
      ],
    )
    expect(result).toMatchObject({ exit: 0, stderr: '', timedOut: false })
    expect(result.stdout).toContain('NEXUS_READY\n')
    const receipts = result.stdout
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line.slice('NEXUS_AUTOMATION '.length)) as unknown)
    expect(receipts).toEqual([
      {
        requestId: 'navigate',
        ok: true,
        result: { url: 'https://www.vinted.fr/items/new' },
      },
      {
        requestId: 'snapshot',
        ok: true,
        result: {
          url: 'https://www.vinted.fr/items/new',
          title: 'Fixture',
          text: 'Fixture page',
          controls: [],
        },
      },
    ])
    expect(result.stdout + result.stderr).not.toContain('do-not-log')
  })

  it('attaches the packaged CDP action to the existing context without closing its browser', async () => {
    const result = await run(
      'automation-cdp',
      '',
      false,
      false,
      undefined,
      false,
      undefined,
      { endpoint: 'ws://127.0.0.1:9000/devtools/browser/fixture' },
      [
        {
          requestId: 'navigate',
          operation: 'navigate',
          origin: 'https://www.vinted.fr',
          input: { url: 'https://www.vinted.fr/inbox/123' },
        },
        {
          requestId: 'snapshot',
          operation: 'snapshot',
          origin: 'https://www.vinted.fr',
          input: {},
        },
        { requestId: 'release', control: 'release' },
      ],
    )
    expect(result).toMatchObject({ exit: 0, stderr: '', timedOut: false })
    expect(result.stdout).toContain('Existing vendor page')
    expect(result.stdout).toContain('"released":true')
  })

  it('exits on external disconnect without closing a page or vendor browser', async () => {
    const result = await run(
      'automation-cdp',
      '',
      false,
      false,
      undefined,
      false,
      undefined,
      { endpoint: 'ws://127.0.0.1:9000/devtools/browser/fixture' },
    )
    expect(result).toEqual({
      exit: 0,
      stderr: '',
      stdout: 'NEXUS_READY\n',
      timedOut: false,
    })
  })

  it('receives a resolved plugin proxy with credentials and a numeric pinned endpoint through stdin', async () => {
    const record = runtimeWindow({
      binary_path: binary,
      proxy_mode: 'plugin',
      proxy: 'http://synthetic-user:do-not-log@proxy.example:8080',
      proxy_plugin: 'opaque/plugin-ref:v2',
      proxy_endpoint: 37,
      settings: { ...runtimeWindow().settings, geoip: false },
    })
    const result = await run(
      'launch',
      '',
      false,
      false,
      undefined,
      true,
      undefined,
      record,
    )
    expect(result).toEqual({
      exit: 0,
      stdout: 'NEXUS_READY\n',
      stderr: '',
      timedOut: false,
    })
  })

  it.each(['launch', 'snapshot'])(
    'rejects a string proxy endpoint from stdin before %s without compatibility coercion',
    async (action) => {
      const record = {
        ...runtimeWindow({
          binary_path: binary,
          proxy_mode: 'plugin',
          proxy: 'http://synthetic-user:do-not-log@proxy.example:8080',
          proxy_plugin: 'opaque/plugin-ref:v2',
          settings: { ...runtimeWindow().settings, geoip: false },
        }),
        proxy_endpoint: '37',
      }
      const result = await run(
        action,
        '',
        false,
        false,
        undefined,
        true,
        undefined,
        record,
      )
      expect(result).toEqual({
        exit: 1,
        stdout: '',
        stderr: 'PROFILE_RECORD_INVALID\n',
        timedOut: false,
      })
    },
  )

  it.each(['launch', 'snapshot'])(
    'rejects a schema 1 stdin record before %s without waiting for EOF',
    async (action) => {
      const record = {
        schema_version: 1,
        id: 'profile',
        binding: { profile_id: 'profile', channel_version: '155.0.8059.39.2' },
        binary_path: binary,
        proxy: 'http://account:do-not-log@proxy.example:8080',
      }
      const result = await run(
        action,
        '',
        false,
        false,
        undefined,
        true,
        undefined,
        record,
      )
      expect(result).toEqual({
        exit: 1,
        stdout: '',
        stderr: 'PROFILE_RECORD_INVALID\n',
        timedOut: false,
      })
    },
  )

  it.each(['launch', 'snapshot'])(
    'redacts malformed stdin JSON and closes input before %s',
    async (action) => {
      const result = await run(
        action,
        '',
        false,
        false,
        undefined,
        true,
        undefined,
        '{"proxy":"http://account:do-not-log@proxy.example:8080",',
      )
      expect(result).toEqual({
        exit: 1,
        stdout: '',
        stderr: 'PROFILE_RECORD_INVALID\n',
        timedOut: false,
      })
    },
  )

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
