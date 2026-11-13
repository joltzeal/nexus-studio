import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { expect, it } from 'vitest'
import { AutomationActor } from './automation.js'

const configuredBinary = process.env.NEXUS_TEST_AUTOMATION_BROWSER_BINARY
const binary = configuredBinary ?? chromium.executablePath()

async function controlledPage(
  html: string,
  run: (page: Page, actor: AutomationActor) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    executablePath: binary,
    proxy: { server: 'http://127.0.0.1:9' },
  })
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.route('**/*', async (route) => {
      expect(new URL(route.request().url()).origin).toBe('https://www.vinted.fr')
      await route.fulfill({ contentType: 'text/html', body: html })
    })
    const actor = new AutomationActor(context)
    await actor.execute({
      operation: 'navigate',
      origin: 'https://www.vinted.fr',
      input: { url: 'https://www.vinted.fr/items/new' },
      timeoutMs: 5000,
    })
    await run(page, actor)
    await actor.release()
  } finally {
    await browser.close()
  }
}

async function withPhoto(run: (file: string, size: number) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-automation-upload-'))
  try {
    const file = join(directory, 'photo.png')
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ZkAAAAASUVORK5CYII=',
      'base64',
    )
    await writeFile(file, image)
    await run(file, image.length)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it.skipIf(!configuredBinary && !existsSync(binary))(
  'restores a blank reconciliation page with the native initialization flag without replacing result evidence',
  async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: binary,
      proxy: { server: 'http://127.0.0.1:9' },
    })
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      const page = await context.newPage()
      const requests: string[] = []
      await page.route('**/*', async (route) => {
        expect(new URL(route.request().url()).origin).toBe('https://www.vinted.fr')
        expect(route.request().method()).toBe('GET')
        requests.push(route.request().url())
        await route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>Controlled recovery</title><p>Read-only recovery</p>',
        })
      })
      const actor = new AutomationActor(context)
      const initialize = {
        operation: 'navigate',
        origin: 'https://www.vinted.fr',
        input: { url: 'https://www.vinted.fr/', initializeOrigin: true },
        timeoutMs: 5000,
      }
      await expect(
        actor.execute({
          operation: 'snapshot',
          origin: initialize.origin,
          input: {},
        }),
      ).rejects.toThrow('AUTOMATION_ORIGIN_MISMATCH')
      await expect(actor.execute(initialize)).resolves.toEqual({
        url: 'https://www.vinted.fr/',
      })
      await actor.execute(initialize)
      expect(requests).toEqual(['https://www.vinted.fr/'])
      await actor.execute({
        operation: 'navigate',
        origin: initialize.origin,
        input: { url: 'https://www.vinted.fr/items/123' },
      })
      await expect(actor.execute(initialize)).rejects.toThrow('AUTOMATION_RECONCILE_PAGE')
      expect(page.url()).toBe('https://www.vinted.fr/items/123')
      expect(requests).toHaveLength(2)
      await actor.release()
    } finally {
      await browser.close()
    }
  },
)

it.skipIf(!configuredBinary && !existsSync(binary))(
  'still uploads directly to an observed file input',
  async () => {
    await withPhoto(async (file, size) => {
      await controlledPage(
        `<!doctype html><label>Photos<input type="file" multiple
 onchange="document.querySelector('output').textContent=this.files[0].name+':'+this.files[0].size"></label><output></output>`,
        async (page, actor) => {
          const snapshot = (await actor.execute({
            operation: 'snapshot',
            origin: 'https://www.vinted.fr',
            input: {},
          })) as { controls: { index: number; type: string }[] }
          const input = snapshot.controls.find((control) => control.type === 'file')
          if (!input) throw new Error('Expected an observed file input')
          await expect(
            actor.execute({
              operation: 'upload',
              origin: 'https://www.vinted.fr',
              input: { target: { index: input.index }, files: [file] },
              timeoutMs: 2000,
            }),
          ).resolves.toEqual({ completed: true })
          expect(await page.locator('output').textContent()).toBe(`photo.png:${size}`)
        },
      )
    })
  },
)

it
  .skipIf(!configuredBinary && !existsSync(binary))
  .each([
    'display:none',
    'position:absolute;width:0;height:0;padding:0;border:0;opacity:0',
  ])(
  'uploads host-resolved photos via an observed opener with a %s input',
  async (style) => {
    await withPhoto(async (file, size) => {
      await controlledPage(
        `<!doctype html><form>
<input id="photos" type="file" accept="image/*" multiple style="${style}"
 onchange="document.querySelector('output').textContent=Array.from(this.files).map(file=>file.name+':'+file.size).join(',')">
<button type="button" onclick="document.querySelector('#photos').click()">Add photos</button>
<output></output>
</form>`,
        async (page, actor) => {
          const snapshot = (await actor.execute({
            operation: 'snapshot',
            origin: 'https://www.vinted.fr',
            input: {},
          })) as {
            controls: { index: number; role: string; name: string; type: string }[]
          }
          expect(snapshot.controls.some((control) => control.type === 'file')).toBe(false)
          const opener = snapshot.controls.find(
            (control) => control.name === 'Add photos',
          )
          expect(opener?.role).toBe('button')
          if (!opener) throw new Error('Expected an observed photo opener')
          await expect(
            actor.execute({
              operation: 'upload',
              origin: 'https://www.vinted.fr',
              input: { target: { index: opener.index }, files: [file] },
              timeoutMs: 2000,
            }),
          ).resolves.toEqual({ completed: true })
          expect(await page.locator('output').textContent()).toBe(`photo.png:${size}`)
        },
      )
    })
  },
)

it.skipIf(!configuredBinary && !existsSync(binary))(
  'does not turn upload into an ordinary click on a final publishing control',
  async () => {
    await withPhoto(async (file) => {
      await controlledPage(
        `<!doctype html><button type="button" onclick="document.body.dataset.committed='true'">Upload</button>`,
        async (page, actor) => {
          await expect(
            actor.execute({
              operation: 'upload',
              origin: 'https://www.vinted.fr',
              input: { target: { role: 'button', name: 'Upload' }, files: [file] },
            }),
          ).rejects.toThrow('AUTOMATION_SUBMIT_REQUIRED')
          expect(await page.locator('body').getAttribute('data-committed')).toBeNull()
        },
      )
    })
  },
)

it.skipIf(!configuredBinary && !existsSync(binary))(
  'rejects a chooser from a child frame without supplying its files',
  async () => {
    await withPhoto(async (file) => {
      await controlledPage(
        `<!doctype html><iframe srcdoc="<input type=file>"></iframe>
<button type="button" onclick="document.querySelector('iframe').contentDocument.querySelector('input').click()">Add photos</button>`,
        async (page, actor) => {
          await page
            .frameLocator('iframe')
            .locator('input')
            .waitFor({ state: 'attached' })
          await expect(
            actor.execute({
              operation: 'upload',
              origin: 'https://www.vinted.fr',
              input: { target: { role: 'button', name: 'Add photos' }, files: [file] },
              timeoutMs: 2000,
            }),
          ).rejects.toThrow('AUTOMATION_TARGET_SCOPE')
          expect(await page.frameLocator('iframe').locator('input').inputValue()).toBe('')
        },
      )
    })
  },
)

it.skipIf(!configuredBinary && !existsSync(binary))(
  'fails a photo opener without a chooser and can perform a later scoped upload',
  async () => {
    await withPhoto(async (file, size) => {
      await controlledPage(
        `<!doctype html><input id="photos" type="file" hidden
 onchange="document.querySelector('output').textContent=this.files[0].name+':'+this.files[0].size">
<button type="button">Add photos</button><output></output>`,
        async (page, actor) => {
          await expect(
            actor.execute({
              operation: 'upload',
              origin: 'https://www.vinted.fr',
              input: { target: { role: 'button', name: 'Add photos' }, files: [file] },
              timeoutMs: 100,
            }),
          ).rejects.toThrow(/AUTOMATION_(?:FAILED|TIMEOUT)/)
          await actor.whenIdle()
          await page.getByRole('button', { name: 'Add photos' }).evaluate((button) => {
            button.addEventListener('click', () => {
              document.querySelector<HTMLInputElement>('#photos')!.click()
            })
          })
          await expect(
            actor.execute({
              operation: 'upload',
              origin: 'https://www.vinted.fr',
              input: { target: { role: 'button', name: 'Add photos' }, files: [file] },
              timeoutMs: 2000,
            }),
          ).resolves.toEqual({ completed: true })
          expect(await page.locator('output').textContent()).toBe(`photo.png:${size}`)
        },
      )
    })
  },
)

it.skipIf(!configuredBinary && !existsSync(binary))(
  'blocks ordinary clicks on observed final buttons and links before any page side effect',
  async () => {
    await controlledPage(
      `<!doctype html><meta charset="utf-8"><form>
<button type="button" onclick="document.body.dataset.committed='Upload'">Upload</button>
<div role="button" tabindex="0" onclick="document.body.dataset.committed='List item'"><span>List item</span></div>
<a href="#listed" onclick="document.body.dataset.committed='Hochladen'">Hochladen</a>
<div role="link" tabindex="0" onclick="document.body.dataset.committed='Send'"><span>Wyślij wiadomość</span></div>
<button type="button" onclick="document.body.dataset.committed='Greek'">Δημοσίευση</button>
</form>`,
      async (page, actor) => {
        for (const css of ['button', '[role=button] span', 'a', '[role=link] span']) {
          await expect(
            actor.execute({
              operation: 'click',
              origin: 'https://www.vinted.fr',
              input: { target: { css, index: 0 } },
            }),
          ).rejects.toThrow('AUTOMATION_SUBMIT_REQUIRED')
          expect(await page.locator('body').getAttribute('data-committed')).toBeNull()
        }
        await expect(
          actor.execute({
            operation: 'click',
            origin: 'https://www.vinted.fr',
            input: { target: { role: 'button', name: 'Δημοσίευση' } },
          }),
        ).rejects.toThrow('AUTOMATION_SUBMIT_REQUIRED')
        await expect(
          actor.execute({
            operation: 'submit',
            origin: 'https://www.vinted.fr',
            input: {
              target: { role: 'button', name: 'Upload' },
              operationId: '00000000-0000-4000-8000-000000000124',
            },
          }),
        ).resolves.toMatchObject({ completed: true })
        expect(await page.locator('body').getAttribute('data-committed')).toBe('Upload')
      },
    )
  },
)

it.skipIf(!configuredBinary && !existsSync(binary))(
  'runs fixed functions and reads a complete 6000-character description in intercepted Chromium',
  async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: binary,
      proxy: { server: 'http://127.0.0.1:9' },
    })
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      const page = await context.newPage()
      const requests: string[] = []
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        expect(url.origin).toBe('https://www.vinted.fr')
        requests.push(url.pathname)
        if (url.pathname === '/api/v2/users/current') {
          await route.fulfill({
            json: { login: 'fixture', access_token: 'synthetic-secret' },
          })
          return
        }
        await route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><title>Controlled listing</title>
<form onsubmit="event.preventDefault();document.body.dataset.submitted='true'">
<label>Title<input name="title"></label>
<label>Description<textarea name="description"></textarea></label>
<label for="currency">Currency</label>
<select id="currency"><option>EUR</option><option>USD</option></select>
<label for="condition">Condition</label>
<select id="condition"><option value="">Choose</option><option value="2">Good</option><option value="1">New</option></select>
<label for="ambiguous">Ambiguous condition</label>
<select id="ambiguous"><option value="">Choose</option><option value="2">Good</option><option value="3">Good</option></select>
<label for="conflicting">Conflicting condition</label>
<select id="conflicting"><option value="">Choose</option><option value="2">Good</option><option value="Good">Other</option></select>
<label>Password<input type="password" value="synthetic-secret"></label>
<button type="button" onclick="document.body.dataset.prepared='true'">Preview</button>
<button type="submit">Upload</button>
</form>`,
        })
      })
      const actor = new AutomationActor(context)
      const call = (operation: string, input: Record<string, unknown>) =>
        actor.execute({
          operation,
          origin: 'https://www.vinted.fr',
          input,
          timeoutMs: 5000,
        })
      await call('navigate', { url: 'https://www.vinted.fr/items/new' })
      await expect(call('snapshot', { maxChars: 2000 })).resolves.toMatchObject({
        url: 'https://www.vinted.fr/items/new',
        title: 'Controlled listing',
        controls: expect.arrayContaining([
          expect.objectContaining({ type: 'password', value: '[REDACTED]' }),
        ]),
      })
      await call('fill', { target: { label: 'Title' }, value: 'Used blue mug' })
      const description = `${'Used blue mug. '.repeat(399)}Clean and ready`
      await call('fill', { target: { label: 'Description' }, value: description })
      await call('select', { target: { label: 'Currency' }, value: 'USD' })
      await call('select', { target: { label: 'Condition' }, value: 'Good' })
      const fields = (await call('readFields', {
        fields: {
          title: { label: 'Title' },
          description: { label: 'Description' },
          currency: { label: 'Currency' },
          condition: { label: 'Condition' },
          password: { label: 'Password' },
        },
      })) as Record<string, string>
      expect(fields.description?.length).toBe(6000)
      expect(fields).toEqual({
        title: 'Used blue mug',
        description,
        currency: 'USD',
        condition: '2',
        password: '[REDACTED]',
      })
      await call('select', { target: { label: 'Condition' }, value: '1' })
      expect(await page.getByLabel('Condition', { exact: true }).inputValue()).toBe('1')
      for (const label of ['Ambiguous condition', 'Conflicting condition']) {
        await expect(
          call('select', { target: { label }, value: 'Good' }),
        ).rejects.toThrow('AUTOMATION_OPTION_AMBIGUOUS')
        expect(await page.getByLabel(label, { exact: true }).inputValue()).toBe('')
      }
      await expect(
        call('select', { target: { label: 'Condition' }, value: 'good' }),
      ).rejects.toThrow('AUTOMATION_OPTION_NOT_FOUND')
      await call('click', { target: { role: 'button', name: 'Preview' } })
      expect(await page.locator('body').getAttribute('data-prepared')).toBe('true')
      await expect(
        call('click', { target: { role: 'button', name: 'Upload' } }),
      ).rejects.toThrow('AUTOMATION_SUBMIT_REQUIRED')
      expect(await page.locator('body').getAttribute('data-submitted')).toBeNull()
      const submit = {
        target: { role: 'button', name: 'Upload' },
        operationId: '00000000-0000-4000-8000-000000000123',
      }
      await call('submit', submit)
      expect(await page.locator('body').getAttribute('data-submitted')).toBe('true')
      await expect(call('submit', submit)).rejects.toThrow('AUTOMATION_SUBMIT_REPLAY')
      await expect(
        call('request', { method: 'GET', path: '/api/v2/users/current' }),
      ).resolves.toEqual({
        url: 'https://www.vinted.fr/api/v2/users/current',
        status: 200,
        text: '{"login":"fixture","access_token":"[REDACTED]"}',
      })
      await actor.release()
      expect(context.pages()).toEqual([page])
      expect(page.isClosed()).toBe(false)
      expect(requests).toEqual(['/items/new', '/api/v2/users/current'])
    } finally {
      await browser.close()
    }
  },
  15_000,
)
