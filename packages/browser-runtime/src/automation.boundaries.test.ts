import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AutomationActor, parseAutomationRequest } from './automation.js'

const origin = 'https://www.vinted.fr'
const api = 'https://api.www.vinted.fr'
const wallet = `${api}/ledger/wallet/balance`
const bank = `${api}/payments/public/api/bank_accounts`
const policy = 'vinted_account_financials'
const request = (input: Record<string, unknown>, site = origin) => ({
  operation: 'request',
  origin: site,
  input,
  timeoutMs: 5000,
})
const financial = (path = wallet) => ({ method: 'GET', path, readPolicy: policy })

describe('financial read validation', () => {
  it.each([
    financial(wallet),
    financial(bank),
    {
      method: 'GET',
      path: 'https://api.www.vinted.com/ledger/wallet/balance',
      readPolicy: policy,
    },
  ])('accepts only the explicit same-market policy target %#', (input) => {
    const site = input.path.includes('vinted.com') ? 'https://www.vinted.com' : origin
    expect(parseAutomationRequest(request(input, site)).input).toEqual(input)
  })

  it('retains relative same-origin GET with bounded query input', () => {
    const input = { method: 'GET', path: '/api/v2/wardrobe/123/items?page=1&per_page=5' }
    expect(parseAutomationRequest(request(input)).input).toEqual(input)
  })

  it.each([
    financial('https://api.www.vinted.com/ledger/wallet/balance'),
    financial('https://api.vinted.fr/ledger/wallet/balance'),
    financial('https://www.vinted.fr/ledger/wallet/balance'),
    financial('https://api.www.vinted.fr.evil.test/ledger/wallet/balance'),
    financial('http://api.www.vinted.fr/ledger/wallet/balance'),
    financial('https://api.www.vinted.fr:443/ledger/wallet/balance'),
    financial('https://api.www.vinted.fr:8443/ledger/wallet/balance'),
    financial('https://user:pass@api.www.vinted.fr/ledger/wallet/balance'),
    financial(`${wallet}?`),
    financial(`${wallet}?account=123`),
    financial(`${wallet}#`),
    financial(`${wallet}/`),
    financial(`${api}/ledger/wallet/%62alance`),
    financial(`${api}/ledger/other/../wallet/balance`),
    financial(`${api}/payments/public/api/bank_accounts/123`),
    financial('/ledger/wallet/balance'),
    financial(`${api}/other`),
    { ...financial(), method: 'POST' },
    { ...financial(), headers: { Authorization: 'synthetic-secret' } },
    { ...financial(), query: { account: 123 } },
    { ...financial(), credentials: 'omit' },
    { ...financial(), mode: 'no-cors' },
    { ...financial(), redirect: 'follow' },
    { ...financial(), readPolicy: 'arbitrary_cross_origin' },
    { method: 'GET', path: wallet },
  ])('rejects nonexact or caller-expanded financial authority %#', (input) => {
    expect(() => parseAutomationRequest(request(input))).toThrow('AUTOMATION_INVALID')
  })

  it('rejects unrecognized structured-read flags', () => {
    expect(() =>
      parseAutomationRequest({
        operation: 'readFields',
        origin,
        input: { fields: { title: { label: 'Title' } }, includeState: 'yes' },
      }),
    ).toThrow('AUTOMATION_INVALID')
  })

  it.each([
    { url: `${api}/other`, redirected: false, type: 'cors' },
    { url: bank, redirected: false, type: 'cors' },
    { url: wallet, redirected: true, type: 'cors' },
    { url: wallet, redirected: false, type: 'opaque' },
  ])('rejects unverified response evidence independently %#', async (response) => {
    const page = {
      url: () => `${origin}/`,
      isClosed: () => false,
      evaluate: async (script: (...args: unknown[]) => unknown, input: unknown) => {
        const evaluate = runInNewContext(`(${script.toString()})`, {
          location: { origin },
          URL,
          AbortSignal,
          TextDecoder,
          fetch: async () => ({
            ...response,
            status: 200,
            body: new Response('{}').body,
          }),
        }) as (input: unknown) => Promise<unknown>
        return evaluate(input)
      },
    }
    const actor = new AutomationActor({
      pages: () => [page],
      route: async () => {},
    } as unknown as BrowserContext)
    await expect(actor.execute(request(financial()))).rejects.toThrow('AUTOMATION_FAILED')
  })
})

const configuredBinary = process.env.NEXUS_TEST_AUTOMATION_BROWSER_BINARY
const binary = configuredBinary ?? chromium.executablePath()
const form = readFileSync(
  new URL('../fixtures/automation-form.html', import.meta.url),
  'utf8',
)
type Reply = { body: string; status?: number; headers?: Record<string, string> }

describe.skipIf(!configuredBinary && !existsSync(binary))(
  'controlled browser boundaries',
  () => {
    let browser: Browser
    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: binary,
        headless: true,
        proxy: { server: 'http://127.0.0.1:9' },
      })
    })
    afterAll(async () => {
      await browser?.close()
    })

    async function controlled(
      run: (
        call: (operation: string, input: Record<string, unknown>) => Promise<unknown>,
        page: Page,
        network: { url: string; method: string; cookie: string }[],
      ) => Promise<void>,
      replies: Record<string, Reply> = {},
      html = form,
    ) {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      try {
        await context.addCookies([
          {
            name: 'fixture_session',
            value: 'controlled',
            domain: '.vinted.fr',
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
          },
        ])
        const page = await context.newPage()
        const network: { url: string; method: string; cookie: string }[] = []
        await page.route('**/*', async (route) => {
          const req = route.request()
          network.push({
            url: req.url(),
            method: req.method(),
            cookie: (await req.allHeaders()).cookie ?? '',
          })
          if (req.url() === `${origin}/items/new`) {
            await route.fulfill({ contentType: 'text/html', body: html })
            return
          }
          const reply = replies[req.url()]
          if (!reply) {
            await route.abort('blockedbyclient')
            return
          }
          await route.fulfill({
            status: reply.status ?? 200,
            body: reply.body,
            // Playwright adds permissive CORS unless an origin header is explicit.
            headers: {
              'content-type': 'text/plain;charset=utf-8',
              'access-control-allow-origin': '',
              ...reply.headers,
            },
          })
        })
        const actor = new AutomationActor(context)
        const call = (operation: string, input: Record<string, unknown>) =>
          actor.execute({ operation, origin, input, timeoutMs: 3000 })
        await call('navigate', { url: `${origin}/items/new` })
        await run(call, page, network)
        await actor.whenIdle()
        await actor.release()
      } finally {
        await context.close()
      }
    }

    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
    }

    it('uses credentialed normal CORS for both exact financial endpoints', async () => {
      await controlled(
        async (call, page, network) => {
          for (const path of [wallet, bank]) {
            await expect(call('request', financial(path))).resolves.toEqual({
              url: path,
              status: 200,
              text: '{"fixture":true,"access_token":"[REDACTED]"}',
            })
          }
          expect(network.slice(1)).toEqual([
            { url: wallet, method: 'GET', cookie: 'fixture_session=controlled' },
            { url: bank, method: 'GET', cookie: 'fixture_session=controlled' },
          ])
          expect(page.url()).toBe(`${origin}/items/new`)
        },
        {
          [wallet]: {
            headers: cors,
            body: '{"fixture":true,"access_token":"synthetic-secret"}',
          },
          [bank]: {
            headers: cors,
            body: '{"fixture":true,"access_token":"synthetic-secret"}',
          },
        },
      )
    })

    it.each([
      {},
      { 'access-control-allow-origin': '*' },
      { 'access-control-allow-origin': origin },
    ])(
      'fails closed when normal browser CORS denies a financial read %#',
      async (headers) => {
        await controlled(
          async (call) => {
            await expect(call('request', financial())).rejects.toThrow(
              'AUTOMATION_FAILED',
            )
          },
          { [wallet]: { body: '{"fixture":true}', headers } },
        )
      },
    )

    it('retains same-origin credentials, statuses and redaction', async () => {
      const path = '/api/v2/users/current'
      await controlled(
        async (call, _page, network) => {
          await expect(call('request', { method: 'GET', path })).resolves.toEqual({
            url: `${origin}${path}`,
            status: 403,
            text: '{"code":106,"message_code":"access_denied","token":"[REDACTED]"}',
          })
          expect(network[1]?.cookie).toBe('fixture_session=controlled')
        },
        {
          [`${origin}${path}`]: {
            status: 403,
            body: '{"code":106,"message_code":"access_denied","token":"synthetic-secret"}',
          },
        },
      )
    })

    it.each([wallet, `${origin}/api/redirect`])(
      'rejects a redirect without requesting its destination %s',
      async (path) => {
        await controlled(
          async (call, _page, network) => {
            const input =
              path === wallet ? financial() : { method: 'GET', path: '/api/redirect' }
            await expect(call('request', input)).rejects.toThrow('AUTOMATION_FAILED')
            expect(network.map((item) => item.url)).toEqual([`${origin}/items/new`, path])
          },
          {
            [path]: {
              status: 302,
              body: '',
              headers: { ...cors, location: `${origin}/redirect-destination` },
            },
          },
        )
      },
    )

    it.each([
      ['x'.repeat(65_536), true],
      ['x'.repeat(65_537), false],
      ['\u00e9'.repeat(32_768), true],
      ['\u00e9'.repeat(32_769), false],
    ])('enforces 65,536 response bytes across encodings %#', async (body, accepted) => {
      await controlled(
        async (call) => {
          const result = call('request', financial())
          if (accepted)
            await expect(result).resolves.toEqual({
              url: wallet,
              status: 200,
              text: body,
            })
          else await expect(result).rejects.toThrow('AUTOMATION_FAILED')
        },
        { [wallet]: { body, headers: cors } },
      )
    })

    it('observes stable native/custom values, candidates and validation state', async () => {
      await controlled(async (call) => {
        const fields = (await call('readFields', {
          includeState: true,
          fields: {
            category: { label: 'Category' },
            brand: { role: 'combobox', name: 'Brand' },
            price: { label: 'Price' },
            disabled: { label: 'Disabled title' },
            password: { label: 'Password' },
            hidden: { css: '#hidden-token' },
          },
        })) as Record<string, unknown>
        expect(fields.category).toMatchObject({
          tag: 'select',
          name: 'Category',
          fieldName: 'catalog_id',
          id: 'category',
          testId: 'category',
          value: '999001',
          enabled: true,
          required: true,
          loading: false,
          optionsTruncated: false,
          selectedOptions: [
            {
              label: 'Page-only category',
              value: '999001',
              selected: true,
              enabled: true,
            },
          ],
          options: [
            { label: 'Choose', value: '', selected: false, enabled: true },
            {
              label: 'Page-only category',
              value: '999001',
              selected: true,
              enabled: true,
            },
            {
              label: 'Unavailable category',
              value: '999002',
              selected: false,
              enabled: false,
            },
            {
              label: 'Grouped category',
              value: '999003',
              selected: false,
              enabled: false,
            },
          ],
        })
        expect(fields.brand).toMatchObject({
          name: 'Brand',
          fieldName: 'brand_id',
          value: 'brand-1',
          expanded: true,
          selectedOptions: [
            { label: 'First brand', value: 'brand-1', selected: true, enabled: true },
          ],
          options: [
            { label: 'First brand', value: 'brand-1', selected: true, enabled: true },
            { label: 'Second brand', value: 'brand-2', selected: false, enabled: true },
            {
              label: 'Unavailable brand',
              value: 'brand-disabled',
              selected: false,
              enabled: false,
            },
          ],
        })
        expect(fields.price).toMatchObject({
          invalid: true,
          errors: ['Enter a valid price'],
        })
        expect(fields.disabled).toMatchObject({ enabled: false })
        expect(fields.password).toMatchObject({ value: '[REDACTED]', options: [] })
        expect(fields.hidden).toMatchObject({ value: '[REDACTED]', options: [] })
        expect(JSON.stringify(fields)).not.toContain('synthetic-secret')
        const snapshot = await call('snapshot', { maxChars: 1000 })
        expect(snapshot).toMatchObject({
          controls: expect.arrayContaining([
            expect.objectContaining({ fieldName: 'catalog_id', value: '999001' }),
            expect.objectContaining({
              role: 'combobox',
              name: 'Brand',
              value: 'brand-1',
              options: expect.arrayContaining([
                expect.objectContaining({ label: 'Second brand', value: 'brand-2' }),
              ]),
            }),
          ]),
        })
      })
    })

    describe('review regressions', () => {
      it.each(['PASSWORD', 'PaSsWoRd', 'HIDDEN', 'HiDdEn'])(
        'redacts mixed-case sensitive input types: %s',
        async (type) => {
          await controlled(
            async (call) => {
              const fields = { credential: { css: '#protected-field' } }
              await expect(call('readFields', { fields })).resolves.toEqual({
                credential: '[REDACTED]',
              })
              const structured = await call('readFields', {
                includeState: true,
                fields,
              })
              expect(structured).toMatchObject({
                credential: {
                  type: type.toLowerCase(),
                  value: '[REDACTED]',
                  options: [],
                  selectedOptions: [],
                  errors: [],
                  upload: null,
                },
              })
              expect(JSON.stringify(structured)).not.toContain('fixture-sensitive-value')
              expect(JSON.stringify(await call('snapshot', {}))).not.toContain(
                'fixture-sensitive-value',
              )
            },
            {},
            `<!doctype html><input id="protected-field" type="${type}" value="fixture-sensitive-value">`,
          )
        },
      )

      it('omits credential-derived names from complete structured observations', async () => {
        await controlled(
          async (call) => {
            const structured = await call('readFields', {
              includeState: true,
              fields: { credential: { css: '#protected-field' } },
            })
            expect(structured).toMatchObject({
              credential: { name: '', value: '[REDACTED]' },
            })
            expect(JSON.stringify(structured)).not.toContain('fixture-sensitive-text')
            expect(JSON.stringify(await call('snapshot', {}))).not.toContain(
              'fixture-sensitive-text',
            )
          },
          {},
          '<!doctype html><textarea id="protected-field" name="access_token">fixture-sensitive-text</textarea>',
        )
      })

      it('retains an explicit safe label while redacting credential text', async () => {
        await controlled(
          async (call) => {
            const structured = await call('readFields', {
              includeState: true,
              fields: { credential: { label: 'Access credential' } },
            })
            expect(structured).toMatchObject({
              credential: { name: 'Access credential', value: '[REDACTED]' },
            })
            expect(JSON.stringify(structured)).not.toContain('fixture-sensitive-text')
          },
          {},
          '<!doctype html><label for="protected-field">Access credential</label><textarea id="protected-field" name="access_token">fixture-sensitive-text</textarea>',
        )
      })

      it.each(['conflicting', 'multiple'])(
        'does not confirm %s selected state from the control value',
        async (state) => {
          await controlled(
            async (call, page) => {
              await expect(
                call('select', {
                  target: { role: 'combobox', name: 'Choice' },
                  value: '2',
                }),
              ).rejects.toThrow('AUTOMATION_SELECTION_UNCONFIRMED')
              expect(await page.locator('body').getAttribute('data-clicks')).toBe('1')
              expect(
                await page.locator('[role=option][aria-selected=true]').count(),
              ).toBe(state === 'multiple' ? 2 : 1)
            },
            {},
            `<!doctype html><button id="choice" type="button" role="combobox"
aria-label="Choice" aria-controls="choices" aria-expanded="true"
data-value="${state === 'multiple' ? '1' : '2'}">One</button>
<div id="choices" role="listbox"><div role="option" data-value="1" aria-selected="true">One</div>
<div role="option" data-value="2" aria-selected="false"
onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1);document.querySelector('#choice').dataset.value='2';${state === 'multiple' ? "this.setAttribute('aria-selected','true')" : ''}">Two</div></div>`,
          )
        },
      )

      it('confirms an explicit value when a closed popup retains hidden stale options', async () => {
        await controlled(
          async (call, page) => {
            await expect(
              call('select', {
                target: { role: 'combobox', name: 'Choice' },
                value: '2',
              }),
            ).resolves.toEqual({ completed: true })
            expect(await page.locator('#choices').isVisible()).toBe(false)
            expect(
              await page
                .locator('[role=option][aria-selected=true]')
                .getAttribute('data-value'),
            ).toBe('1')
          },
          {},
          `<!doctype html><button id="choice" type="button" role="combobox"
aria-label="Choice" aria-controls="choices" aria-expanded="true" data-value="1">One</button>
<div id="choices" role="listbox"><div role="option" data-value="1" aria-selected="true">One</div>
<div role="option" data-value="2" aria-selected="false"
onclick="document.querySelector('#choice').dataset.value='2';document.querySelector('#choice').setAttribute('aria-expanded','false');document.querySelector('#choices').hidden=true">Two</div></div>`,
        )
      })

      it.each(['option', 'wrapper'])(
        'rejects a loading %s before clicking its custom option',
        async (busy) => {
          await controlled(
            async (call, page) => {
              await expect(
                call('select', {
                  target: { role: 'listbox', name: 'Choice' },
                  value: '2',
                }),
              ).rejects.toThrow('AUTOMATION_CONTROL_NOT_READY')
              expect(await page.locator('body').getAttribute('data-clicked')).toBeNull()
            },
            {},
            `<!doctype html><div role="listbox" aria-label="Choice">
<div ${busy === 'wrapper' ? 'aria-busy="true"' : ''}>
<div role="option" data-value="2" aria-selected="false" ${busy === 'option' ? 'aria-busy="true"' : ''}
onclick="document.body.dataset.clicked='true';this.setAttribute('aria-selected','true')">Two</div></div></div>`,
          )
        },
      )

      it.each([
        ['ARIA checkbox', '<div id="child" role="checkbox">Two</div>'],
        ['ARIA radio', '<div id="child" role="radio">Two</div>'],
        ['ARIA switch', '<div id="child" role="switch">Two</div>'],
        ['ARIA combobox', '<div id="child" role="combobox">Two</div>'],
        ['focusable checkbox', '<div id="child" role="checkbox" tabindex="0">Two</div>'],
        ['focusable content', '<span id="child" tabindex="0">Two</span>'],
        ['editable content', '<span id="child" contenteditable="true">Two</span>'],
        ['implicit editable content', '<span id="child" contenteditable>Two</span>'],
      ])('rejects a nested %s before any click', async (_name, child) => {
        await controlled(
          async (call, page) => {
            await page.locator('#child').evaluate((element) => {
              element.addEventListener('click', () => {
                document.body.dataset.childClicked = 'true'
              })
            })
            await expect(
              call('select', {
                target: { role: 'listbox', name: 'Choice' },
                value: '2',
              }),
            ).rejects.toThrow('AUTOMATION_FORM_CHANGED')
            expect(await page.locator('body').getAttribute('data-clicked')).toBeNull()
            expect(
              await page.locator('body').getAttribute('data-child-clicked'),
            ).toBeNull()
          },
          {},
          `<!doctype html><div role="listbox" aria-label="Choice">
<div role="option" data-value="2" aria-selected="false"
onclick="document.body.dataset.clicked='true';this.setAttribute('aria-selected','true')">${child}</div></div>`,
        )
      })

      it('allows noninteractive descriptive option descendants', async () => {
        await controlled(
          async (call) => {
            await expect(
              call('select', {
                target: { role: 'listbox', name: 'Choice' },
                value: '2',
              }),
            ).resolves.toEqual({ completed: true })
          },
          {},
          `<!doctype html><div role="listbox" aria-label="Choice">
<div role="option" data-value="2" aria-selected="false"
onclick="this.setAttribute('aria-selected','true')"><span role="img">Two</span><span contenteditable="false">Description</span></div></div>`,
        )
      })
    })

    it('keeps old field-string reads while bounding structured values and options', async () => {
      await controlled(async (call, page) => {
        await page.evaluate(() => {
          const select = document.querySelector<HTMLSelectElement>('#category')!
          select.replaceChildren(
            ...Array.from({ length: 105 }, (_, i) => {
              const option = document.createElement('option')
              option.value = String(i)
              option.textContent = `Choice ${i}`
              option.selected = i === 104
              return option
            }),
          )
          const input = document.createElement('textarea')
          input.id = 'long-copy'
          input.value = 'x'.repeat(16_385)
          document.body.append(input)
        })
        await expect(
          call('readFields', { fields: { category: { label: 'Category' } } }),
        ).resolves.toEqual({ category: '104' })
        const fields = (await call('readFields', {
          includeState: true,
          fields: { category: { label: 'Category' }, copy: { css: '#long-copy' } },
        })) as {
          category: {
            options: unknown[]
            optionsTruncated: boolean
            selectedOptions: unknown[]
          }
          copy: { value: string }
        }
        expect(fields.category.options).toHaveLength(100)
        expect(fields.category.optionsTruncated).toBe(true)
        expect(fields.category.selectedOptions).toEqual([
          { label: 'Choice 104', value: '104', selected: true, enabled: true },
        ])
        expect(fields.copy.value).toHaveLength(16_384)
      })
    })

    it.each(['Second brand', 'brand-2'])(
      'selects an actual custom option by exact label or value %s',
      async (value) => {
        await controlled(async (call, page) => {
          await expect(
            call('select', { target: { role: 'combobox', name: 'Brand' }, value }),
          ).resolves.toEqual({ completed: true })
          expect(await page.locator('#brand').getAttribute('data-value')).toBe('brand-2')
          expect(await page.locator('body').getAttribute('data-committed')).toBeNull()
        })
      },
    )

    it('reads a custom selected identity without inventing a native button value', async () => {
      await controlled(async (call, page) => {
        await page.locator('#brand').evaluate((element) => {
          element.removeAttribute('data-value')
        })
        await expect(
          call('readFields', {
            includeState: true,
            fields: { brand: { role: 'combobox', name: 'Brand' } },
          }),
        ).resolves.toMatchObject({ brand: { value: 'brand-1' } })
      })
    })

    it('observes loading from the explicitly related custom option list', async () => {
      await controlled(async (call, page) => {
        await page.locator('#brand-options').evaluate((element) => {
          element.setAttribute('aria-busy', 'true')
        })
        await expect(
          call('readFields', {
            includeState: true,
            fields: { brand: { role: 'combobox', name: 'Brand' } },
          }),
        ).resolves.toMatchObject({ brand: { loading: true } })
      })
    })

    it('bounds observed upload records and error evidence independently of DOM size', async () => {
      await controlled(async (call, page) => {
        await page.locator('#photo-upload').evaluate((element) => {
          const input = element.querySelector<HTMLInputElement>('input[type=file]')!
          const files = new DataTransfer()
          for (let i = 0; i < 22; i++) {
            files.items.add(
              new File(['fixture'], `photo-${i}.png`, { type: 'image/png' }),
            )
            const preview = document.createElement('img')
            preview.alt = `Preview ${i}`
            preview.width = 10
            preview.height = 10
            const progress = document.createElement('progress')
            element.append(preview, progress)
          }
          input.files = files.files
          for (let i = 0; i < 12; i++) {
            for (const role of ['alert', 'status']) {
              const message = document.createElement('p')
              message.setAttribute('role', role)
              message.textContent = `${i}: ${'x'.repeat(600)}`
              element.append(message)
            }
          }
        })
        const fields = (await call('readFields', {
          includeState: true,
          fields: { photos: { label: 'Photos' } },
        })) as {
          photos: {
            errors: string[]
            upload: {
              fileCount: number
              files: unknown[]
              filesTruncated: boolean
              previews: unknown[]
              previewsTruncated: boolean
              progress: unknown[]
              progressTruncated: boolean
              statuses: string[]
            }
          }
        }
        expect(fields.photos.errors).toHaveLength(10)
        expect(fields.photos.errors.every((error) => error.length <= 512)).toBe(true)
        expect(fields.photos.upload).toMatchObject({
          fileCount: 22,
          filesTruncated: true,
          previewsTruncated: true,
          progressTruncated: true,
        })
        expect(fields.photos.upload.files).toHaveLength(20)
        expect(fields.photos.upload.previews).toHaveLength(20)
        expect(fields.photos.upload.progress).toHaveLength(20)
        expect(fields.photos.upload.statuses).toHaveLength(10)
      })
    })

    it('does not associate a different input transfer through an ambiguous group', async () => {
      await controlled(async (call, page) => {
        await page.locator('#photo-upload').evaluate((element) => {
          const other = document.createElement('input')
          other.type = 'file'
          element.append(other)
        })
        await expect(
          call('readFields', {
            includeState: true,
            fields: { photos: { label: 'Photos' } },
          }),
        ).resolves.toMatchObject({
          photos: { upload: { statuses: [], progress: [], previews: [] } },
        })
      })
    })

    it('confirms a custom label selection when the popup closes with an explicit value', async () => {
      await controlled(
        async (call, page) => {
          await expect(
            call('select', {
              target: { role: 'combobox', name: 'Choice' },
              value: 'Two',
            }),
          ).resolves.toEqual({ completed: true })
          expect(await page.locator('#choice').getAttribute('data-value')).toBe('2')
        },
        {},
        `<!doctype html><button id="choice" type="button" role="combobox"
aria-label="Choice" aria-controls="choices" aria-expanded="true" data-value="1">One</button>
<div role="listbox" id="choices"><div role="option" data-value="2" aria-selected="false"
onclick="document.querySelector('#choice').dataset.value='2';document.querySelector('#choice').setAttribute('aria-expanded','false');document.querySelector('#choices').remove()">Two</div></div>`,
      )
    })

    it('checks delayed selected-state changes without a fixed sleep or repeat click', async () => {
      await controlled(
        async (call, page) => {
          await expect(
            call('select', { target: { role: 'listbox', name: 'Choice' }, value: 'Two' }),
          ).resolves.toEqual({ completed: true })
          expect(await page.locator('body').getAttribute('data-clicks')).toBe('1')
        },
        {},
        `<!doctype html><div role="listbox" aria-label="Choice"><div role="option"
onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1);setTimeout(()=>this.setAttribute('aria-selected','true'),30)">Two</div></div>`,
      )
    })

    it.each([
      [
        'listbox',
        '<div role="listbox" aria-label="Choice">',
        '</div>',
        { role: 'listbox', name: 'Choice' },
      ],
      [
        'button',
        '<button type="button" aria-label="Choice" aria-haspopup="listbox" aria-controls="choices">Choose</button><div role="listbox" id="choices">',
        '</div>',
        { role: 'button', name: 'Choice' },
      ],
    ])(
      'supports a scoped observed %s without page-wide text matching',
      async (_name, start, end, target) => {
        await controlled(
          async (call) => {
            await expect(call('select', { target, value: '2' })).resolves.toEqual({
              completed: true,
            })
          },
          {},
          `<!doctype html>${start}<div role="option" data-value="2" aria-selected="false"
onclick="this.setAttribute('aria-selected','true')">Two</div>${end}`,
        )
      },
    )

    it.each([
      [
        'unknown',
        '<button type="button" aria-label="Choice">Two</button>',
        'FORM_CHANGED',
      ],
      [
        'unrelated',
        '<div role="combobox" aria-label="Choice">Choose</div><div role="listbox"><div role="option">Two</div></div>',
        'FORM_CHANGED',
      ],
      [
        'ambiguous lists',
        '<div role="combobox" aria-label="Choice" aria-controls="a b">Choose</div><div role="listbox" id="a"><div role="option">Two</div></div><div role="listbox" id="b"><div role="option">Two</div></div>',
        'FORM_CHANGED',
      ],
      [
        'duplicate root IDs',
        '<div role="combobox" aria-label="Choice" aria-controls="a">Choose</div><div role="listbox" id="a"><div role="option">Two</div></div><div role="listbox" id="a"><div role="option">Two</div></div>',
        'FORM_CHANGED',
      ],
      [
        'multi-select',
        '<div role="listbox" aria-label="Choice" aria-multiselectable="true"><div role="option">Two</div></div>',
        'FORM_CHANGED',
      ],
      [
        'duplicate options',
        '<div role="listbox" aria-label="Choice"><div role="option" data-value="1">Two</div><div role="option" data-value="2">Two</div></div>',
        'OPTION_AMBIGUOUS',
      ],
      [
        'value-label collision',
        '<div role="listbox" aria-label="Choice"><div role="option" data-value="1">Two</div><div role="option" data-value="Two">Other</div></div>',
        'OPTION_AMBIGUOUS',
      ],
      [
        'hidden',
        '<div role="listbox" aria-label="Choice"><div role="option" hidden>Two</div></div>',
        'OPTION_NOT_FOUND',
      ],
      [
        'disabled option',
        '<div role="listbox" aria-label="Choice"><div role="option" aria-disabled="true">Two</div></div>',
        'OPTION_NOT_FOUND',
      ],
      [
        'disabled control',
        '<div role="listbox" aria-label="Choice" aria-disabled="true"><div role="option">Two</div></div>',
        'CONTROL_NOT_READY',
      ],
      [
        'loading',
        '<div role="listbox" aria-label="Choice" aria-busy="true"><div role="option">Two</div></div>',
        'CONTROL_NOT_READY',
      ],
      [
        'final control',
        '<div role="listbox" aria-label="Choice"><button type="submit" role="option">Two</button></div>',
        'SUBMIT_REQUIRED',
      ],
      [
        'nested final control',
        '<div role="listbox" aria-label="Choice"><div role="option"><button type="submit">Two</button></div></div>',
        'FORM_CHANGED',
      ],
      [
        'navigation option',
        '<div role="listbox" aria-label="Choice"><a role="option" href="/items/new?commit=1">Two</a></div>',
        'FORM_CHANGED',
      ],
      [
        'native input option',
        '<div role="listbox" aria-label="Choice"><input role="option" type="checkbox" aria-label="Two"></div>',
        'FORM_CHANGED',
      ],
    ])(
      'rejects unsafe or unsupported custom structure: %s',
      async (_name, html, error) => {
        await controlled(
          async (call, page) => {
            await expect(
              call('select', { target: { css: '#choice' }, value: 'Two' }),
            ).rejects.toThrow(`AUTOMATION_${error}`)
            expect(await page.locator('body').getAttribute('data-clicked')).toBeNull()
          },
          {},
          `<!doctype html><style>[role=listbox] { min-height: 20px }</style>
${html.replace('aria-label="Choice"', 'id="choice" aria-label="Choice"')}
<script>document.addEventListener('click',()=>document.body.dataset.clicked='true')</script>`,
        )
      },
    )

    it('does not report a custom selection when the page never confirms the effect', async () => {
      await controlled(
        async (call, page) => {
          await expect(
            call('select', { target: { role: 'listbox', name: 'Choice' }, value: 'Two' }),
          ).rejects.toThrow('AUTOMATION_SELECTION_UNCONFIRMED')
          expect(await page.locator('body').getAttribute('data-clicked')).toBe('1')
        },
        {},
        `<!doctype html><div role="listbox" aria-label="Choice">
<div role="option" onclick="document.body.dataset.clicked=String(Number(document.body.dataset.clicked||0)+1)">Two</div></div>`,
      )
    })

    it('reports actual file, preview and transfer evidence without inferring upload success', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'raccoon-observation-'))
      const file = join(directory, 'photo.png')
      const image = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ZkAAAAASUVORK5CYII=',
        'base64',
      )
      try {
        await writeFile(file, image)
        await controlled(async (call, page) => {
          await call('upload', { target: { label: 'Photos' }, files: [file] })
          await page.waitForFunction(() => {
            const image = document.querySelector<HTMLImageElement>('#preview')
            return image?.complete && image.naturalWidth > 0
          })
          const observe = () =>
            call('readFields', {
              includeState: true,
              fields: { photos: { css: '#photo-upload' } },
            })
          const pending = await observe()
          expect(pending).toMatchObject({
            photos: {
              loading: true,
              upload: {
                fileCount: 1,
                files: [{ name: 'photo.png', size: image.length, type: 'image/png' }],
                previews: [{ name: 'Uploaded preview', loaded: true }],
                progress: [{ value: null, max: 100, text: '' }],
                statuses: ['Transferring'],
              },
            },
          })
          expect(JSON.stringify(pending)).not.toMatch(/fakepath|completed|success/)
          const inputState = await call('readFields', {
            includeState: true,
            fields: { photos: { label: 'Photos' } },
          })
          expect(inputState).toMatchObject({
            photos: {
              name: 'Photos',
              value: '',
              loading: true,
              upload: {
                previews: [{ name: 'Uploaded preview', loaded: true }],
                statuses: ['Transferring'],
              },
            },
          })
          expect(await call('snapshot', {})).toMatchObject({
            controls: expect.arrayContaining([
              expect.objectContaining({
                name: 'Photos',
                upload: expect.objectContaining({ statuses: ['Transferring'] }),
              }),
            ]),
          })
          await page.getByRole('button', { name: 'Finish transfer' }).click()
          expect(await observe()).toMatchObject({
            photos: {
              loading: false,
              upload: {
                fileCount: 1,
                progress: [{ value: 100, max: 100, text: '' }],
                statuses: ['Transfer stored'],
              },
            },
          })
        })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  },
)
