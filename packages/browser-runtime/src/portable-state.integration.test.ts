import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { launchPersistentContext } from 'cloakbrowser'
import type { BrowserContext } from 'playwright-core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { restorePortableState } from './portable-state.js'
import {
  parseBrowserVersion,
  snapshotProfile,
  type NativeProfile,
} from './profile-runtime.js'

const binary = process.env.NEXUS_TEST_BROWSER_BINARY
const cache = process.env.NEXUS_TEST_BROWSER_CACHE
const licenseKey = process.env.NEXUS_TEST_LICENSE_KEY
const enabled = Boolean(binary && cache && licenseKey)

beforeEach(() => {
  if (!enabled) return
  vi.stubEnv('CLOAKBROWSER_CACHE_DIR', cache)
  vi.stubEnv('CLOAKBROWSER_LICENSE_KEY', licenseKey)
  vi.stubEnv('CLOAKBROWSER_AUTO_UPDATE', 'false')
})
afterEach(() => vi.unstubAllEnvs())

it.skipIf(!enabled)(
  'keeps a copied profile offline until normal CLI launch replaces its stale cookies',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-offline-restore-'))
    const source = join(directory, 'source')
    const target = join(directory, 'target', 'user-data')
    const requests: { path: string; cookie: string }[] = []
    const server = createServer((request, response) => {
      requests.push({ path: request.url!, cookie: request.headers.cookie ?? '' })
      response.end('<html></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Listener missing')
    const origin = `http://127.0.0.1:${address.port}`
    let context: BrowserContext | undefined
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<number | null> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const originalBinary = process.env.CLOAKBROWSER_BINARY_PATH
    try {
      process.env.CLOAKBROWSER_BINARY_PATH = binary
      const version = parseBrowserVersion(
        (await promisify(execFile)(binary!, ['--version'])).stdout,
      )
      context = await launchPersistentContext({
        userDataDir: source,
        headless: true,
        browserVersion: version,
      })
      await context.addCookies([
        { name: 'stale', value: 'must-not-send', domain: '127.0.0.1', path: '/' },
      ])
      await context.close()
      context = undefined
      await cp(source, target, { recursive: true })
      await writeFile(
        join(directory, 'target', 'portable-state.json'),
        JSON.stringify({
          schemaVersion: 1,
          storageState: {
            cookies: [
              {
                name: 'session',
                value: 'restored',
                domain: '127.0.0.1',
                path: '/',
                expires: -1,
                httpOnly: true,
                secure: false,
                sameSite: 'Lax',
              },
            ],
            origins: [],
          },
        }),
      )
      const sdk = pathToFileURL(
        createRequire(import.meta.url).resolve('cloakbrowser'),
      ).href
      const wrapper = join(directory, 'startup-sdk.mjs')
      await writeFile(
        wrapper,
        `import * as sdk from ${JSON.stringify(sdk)};
         export const {ensureBinary,validateLicense,buildLaunchOptions}=sdk;
         export async function launchPersistentContext(options) {
           const context=await sdk.launchPersistentContext(options);
           // Exercise a restored tab request before runtime gets the context.
           const page=context.pages()[0] ?? await context.newPage();
           await page.goto(${JSON.stringify(`${origin}/before-restore`)},{timeout:2000})
             .catch(()=>{});
           return context;
         }`,
      )
      const preload = join(directory, 'startup-preload.mjs')
      await writeFile(
        preload,
        `import {registerHooks} from 'node:module';
         registerHooks({resolve(specifier,context,next){
           if(specifier==='cloakbrowser')
             return {url:${JSON.stringify(pathToFileURL(wrapper).href)},shortCircuit:true};
           return next(specifier,context);
         }});`,
      )
      child = spawn(process.execPath, [
        '--import',
        preload,
        fileURLToPath(new URL('../dist/profile-runner.js', import.meta.url)),
        'launch',
        target,
      ])
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (data: Buffer) => (stdout += data.toString()))
      child.stderr!.on('data', (data: Buffer) => (stderr += data.toString()))
      child.stdin!.on('error', () => {})
      exited = new Promise((resolve, reject) => {
        child!.once('error', reject)
        child!.once('close', resolve)
      })
      timer = setTimeout(() => child!.kill(), 20_000)
      child.stdin!.write(
        `${JSON.stringify({
          schema_version: 1,
          id: 'synthetic',
          binary_path: binary!,
          binding: { profile_id: 'synthetic', channel_version: version },
          proxy: null,
          settings: { geoip: true, startUrl: `${origin}/after-restore` },
        })}\n`,
      )
      await expect
        .poll(() => requests, { timeout: 10_000 })
        .toContainEqual({ path: '/after-restore', cookie: 'session=restored' })
      expect(requests.some((request) => request.path === '/before-restore')).toBe(false)
      expect(requests.some((request) => request.cookie.includes('stale='))).toBe(false)
      expect(stdout).toBe('NEXUS_READY\n')
      expect(stderr).toBe('')
      child.stdin!.end('stop\n')
      expect(await exited).toBe(0)
      await expect(
        readFile(join(directory, 'target', 'portable-state.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (child && child.exitCode === null) child.kill()
      await exited
      clearTimeout(timer)
      if (context) await context.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
      if (originalBinary === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH
      else process.env.CLOAKBROWSER_BINARY_PATH = originalBinary
    }
  },
  30_000,
)

it.skipIf(!enabled).each(['empty', 'copied'])(
  'snapshots a closed persistent profile through the CLI and restores into %s user data without HTTP traffic',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-portable-browser-'))
    const source = join(directory, 'source', 'user-data')
    const target = join(directory, 'target', 'user-data')
    const version = parseBrowserVersion(
      (await promisify(execFile)(binary!, ['--version'])).stdout,
    )
    const record: NativeProfile = {
      schema_version: 1,
      id: 'source',
      binary_path: binary!,
      binding: { profile_id: 'source', channel_version: version },
      proxy: null,
      proxy_plugin: 'unused-offline-plugin',
      settings: {
        platform: '',
        note: '',
        geoip: true,
        timezone: '',
        locale: '',
        viewport: 'default',
        fingerprintSeed: null,
        startUrl: 'https://must-not-be-contacted.example',
      },
    }
    const originalBinary = process.env.CLOAKBROWSER_BINARY_PATH
    process.env.CLOAKBROWSER_BINARY_PATH = binary
    let context: BrowserContext | undefined
    let connections = 0
    const server = createServer((_request, response) => {
      connections++
      response.end('unexpected external request')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Listener missing')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      context = await launchPersistentContext({
        userDataDir: source,
        headless: true,
        geoip: false,
        browserVersion: version,
        contextOptions: { serviceWorkers: 'block' },
      })
      await context.route('**/*', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
      )
      await context.addCookies([
        {
          name: 'session',
          value: 'synthetic-session',
          domain: '127.0.0.1',
          path: '/',
          expires: 1_900_000_000,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ])
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(origin)
      await page.evaluate(`(async () => {
        localStorage.setItem('account', 'synthetic-account');
        const request = indexedDB.open('auth', 3);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('values');
          store.createIndex('byId', 'id', {unique:false});
        };
        const db = await new Promise((resolve,reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const tx = db.transaction('values', 'readwrite');
        const store = tx.objectStore('values');
        store.put(0,'zero'); store.put(false,'false'); store.put(null,'null');
        store.put(Infinity,0); store.put('empty-key','');
        store.put(NaN,'nan'); store.put(-0,'negative-zero');
        const cycle={}; cycle.self=cycle; store.put(cycle,'cycle');
        store.put({
          id:'typed',
          expires:new Date('2030-01-01T00:00:00Z'),
          bytes:new Uint8Array([0,127,255]),
          bigint:123456789123456789n,
          map:new Map([['session','synthetic-token']])
        }, 'typed');
        await new Promise((resolve,reject) => {
          tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
        });
        db.close();
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle('state.bin', {create:true});
        const writable = await file.createWritable();
        await writable.write(new Uint8Array([0,1,255]));
        await writable.close();
      })()`)
      await context.close()
      context = undefined

      const runner = fileURLToPath(new URL('../dist/profile-runner.js', import.meta.url))
      const child = spawn(process.execPath, [runner, 'snapshot', source], {
        env: process.env,
        stdio: 'pipe',
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      // The snapshot must finish without waiting for EOF or a stop command.
      child.stdin.write(`${JSON.stringify(record)}\n`)
      const timer = setTimeout(() => child.kill(), 30_000)
      let exit: number | null
      try {
        exit = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', resolve)
        })
      } finally {
        clearTimeout(timer)
        child.stdin.destroy()
      }
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
      const lines = stdout.trim().split('\n')
      expect(lines).toHaveLength(1)
      const state = JSON.parse(lines[0]!) as {
        schemaVersion: number
        storageState: { cookies: unknown[]; origins: { origin: string }[] }
      }
      expect(state.schemaVersion).toBe(1)
      expect(state.storageState.origins.map((entry) => entry.origin)).toContain(origin)
      expect(state.storageState.cookies).toEqual([
        expect.objectContaining({ name: 'session', value: 'synthetic-session' }),
      ])
      if (mode === 'empty') {
        const pendingRoot = join(directory, 'pending')
        await mkdir(pendingRoot)
        const pending = join(pendingRoot, 'portable-state.json')
        await writeFile(pending, lines[0]!)
        const recaptured = await snapshotProfile(join(pendingRoot, 'user-data'), record)
        expect(recaptured.storageState.cookies).toEqual([
          expect.objectContaining({ name: 'session', value: 'synthetic-session' }),
        ])
        expect(recaptured.storageState.origins).toEqual([
          expect.objectContaining({
            origin,
            localStorage: [{ name: 'account', value: 'synthetic-account' }],
          }),
        ])
        expect(await readFile(pending, 'utf8')).toBe(lines[0])
      }

      if (mode === 'copied') await cp(source, target, { recursive: true })
      context = await launchPersistentContext({
        userDataDir: target,
        headless: true,
        geoip: false,
        browserVersion: version,
      })
      await context.addCookies([
        {
          name: 'stale-machine-cookie',
          value: 'must-be-cleared',
          domain: '127.0.0.1',
          path: '/',
        },
      ])
      const path = join(directory, 'target', 'portable-state.json')
      await writeFile(path, lines[0]!)
      await restorePortableState(context, target)
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(connections).toBe(0)
      expect(await context.cookies(origin)).toEqual([
        expect.objectContaining({ name: 'session', value: 'synthetic-session' }),
      ])
      const restored = context.pages()[0] ?? (await context.newPage())
      await restored.route('**/*', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
      )
      await restored.goto(origin)
      const values = await restored.evaluate(`(async () => {
        const db = await new Promise((resolve,reject) => {
          const req=indexedDB.open('auth');
          req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
        });
        const store=db.transaction('values').objectStore('values');
        const get = key => new Promise((resolve,reject) => {
          const req=store.get(key);
          req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
        });
        const [zero, falsy, nil, typed] = await Promise.all(
          ['zero','false','null','typed'].map(get)
        );
        const [infinity,emptyKey,nan,negativeZero,cycle] = await Promise.all(
          [0,'','nan','negative-zero','cycle'].map(get)
        );
        const version=db.version;
        const indexes=[...store.indexNames];
        db.close();
        const root=await navigator.storage.getDirectory();
        const file=await (await root.getFileHandle('state.bin')).getFile();
        return {
          local:localStorage.getItem('account'), version, indexes, zero, falsy, nil,
          infinity,emptyKey,nan:Number.isNaN(nan),negativeZero:Object.is(negativeZero,-0),
          cyclic:cycle.self === cycle,bigint:typed.bigint.toString(),
          date:typed.expires.toISOString(), bytes:[...typed.bytes],
          token:typed.map.get('session'), file:[...new Uint8Array(await file.arrayBuffer())]
        };
      })()`)
      expect(values).toEqual({
        local: 'synthetic-account',
        version: 3,
        indexes: ['byId'],
        zero: 0,
        falsy: false,
        nil: null,
        infinity: Infinity,
        emptyKey: 'empty-key',
        nan: true,
        negativeZero: true,
        cyclic: true,
        bigint: '123456789123456789',
        date: '2030-01-01T00:00:00.000Z',
        bytes: [0, 127, 255],
        token: 'synthetic-token',
        file: [0, 1, 255],
      })
      expect(connections).toBe(0)
      if (mode === 'empty') {
        await restored.evaluate(`(async () => {
          const db=await new Promise((resolve,reject)=>{
            const req=indexedDB.open('auth');
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
          });
          const tx=db.transaction('values','readwrite');
          tx.objectStore('values').put(new Blob(['unsupported']), 'blob');
          await new Promise((resolve,reject)=>{
            tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
          });
          db.close();
        })()`)
        await context.close()
        context = undefined
        await expect(snapshotProfile(target, record)).rejects.toThrow(
          'PORTABLE_STATE_INDEXED_DB_UNSUPPORTED',
        )
        expect(connections).toBe(0)
      }
    } finally {
      if (context) await context.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
      if (originalBinary === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH
      else process.env.CLOAKBROWSER_BINARY_PATH = originalBinary
    }
  },
  60_000,
)
