import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import type { BrowserContext, Route } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'
import {
  AutomationActor,
  automationCommandLoop,
  parseAutomationRequest,
  validateCdpEndpoint,
} from './automation.js'

const origin = 'https://www.vinted.fr'
const request = (operation: string, input = {}, extra = {}) => ({
  operation,
  origin,
  input,
  ...extra,
})

function browserEvaluate(
  script: unknown,
  globals: Record<string, unknown>,
  ...args: unknown[]
): unknown {
  if (typeof script !== 'function' && typeof script !== 'string')
    throw new TypeError('Expected a function or expression')
  const value = runInNewContext(
    typeof script === 'function' ? `(${script.toString()})` : script,
    globals,
  ) as unknown
  // Playwright invokes function arguments, but only evaluates string expressions.
  return typeof script === 'function'
    ? (value as (...values: unknown[]) => unknown)(...args)
    : value
}

function fixture() {
  let url = `${origin}/`
  const selectedOption = { value: 'M', label: 'Medium' }
  const optionHandle = {
    asElement: (): unknown => selectedOption,
    jsonValue: async (): Promise<unknown> => selectedOption,
    dispose: vi.fn(async () => {}),
  }
  const locator = {
    nth: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    selectOption: vi.fn(async () => ['one']),
    setInputFiles: vi.fn(async () => {}),
    evaluate: vi.fn(async (script: unknown): Promise<unknown> =>
      String(script).includes('AUTOMATION_SUBMIT_REQUIRED')
        ? false
        : String(script).includes('AUTOMATION_TARGET_SCOPE')
          ? true
          : String(script).includes('AUTOMATION_UPLOAD_TARGET')
            ? 'input'
            : 'field value',
    ),
    evaluateHandle: vi.fn<(...args: unknown[]) => Promise<typeof optionHandle>>(
      async () => optionHandle,
    ),
  }
  const page = {
    url: () => url,
    isClosed: () => false,
    goto: vi.fn(async (next: string) => {
      url = next
    }),
    evaluate: vi.fn(async () => ({ text: 'page', controls: [] })),
    locator: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByPlaceholder: vi.fn(() => locator),
    getByTestId: vi.fn(() => locator),
    close: vi.fn(),
    route: vi.fn(async () => {}),
    unroute: vi.fn(async () => {}),
  }
  const context = {
    pages: () => [page],
    newPage: vi.fn(async () => page),
    close: vi.fn(),
    route: vi.fn(async () => {}),
    unroute: vi.fn(async () => {}),
  }
  return {
    page,
    context,
    locator,
    optionHandle,
    actor: new AutomationActor(context as unknown as BrowserContext),
  }
}

describe('bounded browser tools', () => {
  it.each([
    request('evaluate', { script: 'document.cookie' }),
    request('navigate', { url: 'http://www.vinted.fr/' }),
    request('navigate', { url: 'https://www.vinted.fr.evil.test/' }),
    request('navigate', { url: 'https://user:pass@www.vinted.fr/' }),
    request('navigate', { url: 'https://www.vinted.fr:8443/' }),
    request('navigate', { url: `${origin}/\n` }),
    request('navigate', { url: ` ${origin}/` }),
    request('navigate', { url: `${origin}/${'x'.repeat(4096)}` }),
    request('navigate', { url: `${origin}/`, initializeOrigin: false }),
    request('navigate', { url: `${origin}/items/new`, initializeOrigin: true }),
    request('navigate', { url: `${origin}/?next=publish`, initializeOrigin: true }),
    request('navigate', { url: `${origin}/#publish`, initializeOrigin: true }),
    request('snapshot', {}, { origin: 'https://api.vinted.fr' }),
    request('snapshot', { maxChars: 100_001 }),
    request('snapshot', {}, { timeoutMs: 120_001 }),
    request('click', { target: { css: 'button', label: 'Publish' } }),
    request('click', { target: { index: -1 } }),
    request('click', { target: { css: 'button', script: 'evil' } }),
    request('fill', {
      target: { css: 'iframe >> internal:control=enter-frame >> css=input' },
      value: 'secret',
    }),
    request('upload', { target: { css: 'input' }, files: ['relative.png'] }),
    request('upload', { target: { css: 'input' }, files: ['https://evil/x'] }),
    request('request', { path: '//evil.test/', method: 'GET' }),
    request('request', { path: '/api/x', method: 'POST' }),
    request('request', { path: '/\\evil.test', method: 'GET' }),
    request('request', { path: '/api/%2f%2fevil.test', method: 'GET' }),
    request('snapshot', {}, { script: 'document.cookie' }),
    request('submit', { target: { css: 'button' } }),
    request('submit', { target: { css: 'button' }, operationId: 'random' }),
  ])('rejects out of scope or unbounded input %#', (value) => {
    expect(() => parseAutomationRequest(value)).toThrow(/AUTOMATION_/)
  })

  it('pins one exact origin and retains the existing profile context and page', async () => {
    const { actor, page, context } = fixture()
    await actor.execute(request('navigate', { url: `${origin}/items/new` }))
    await expect(
      actor.execute(request('snapshot', {}, { origin: 'https://www.vinted.de' })),
    ).rejects.toThrow('AUTOMATION_ORIGIN_MISMATCH')
    expect(page.goto).toHaveBeenCalledTimes(1)
    expect(context.newPage).not.toHaveBeenCalled()
    await actor.dispose()
    expect(context.close).not.toHaveBeenCalled()
    expect(page.close).not.toHaveBeenCalled()
  })

  it('opens listing and message pages in the same profile and pinned origin', async () => {
    const { actor, context, page } = fixture()
    await actor.execute(request('navigate', { url: `${origin}/items/new` }))
    await actor.execute(request('navigate', { url: `${origin}/inbox/123` }))
    expect(page.goto).toHaveBeenLastCalledWith(`${origin}/inbox/123`, expect.any(Object))
    expect(context.newPage).not.toHaveBeenCalled()
    await expect(
      actor.execute(
        request('navigate', {
          url: 'https://www.vinted.de/inbox/123',
        }),
      ),
    ).rejects.toThrow('AUTOMATION_ORIGIN_MISMATCH')
  })

  it('initializes only a blank reconciliation page and preserves existing result evidence', async () => {
    const { actor, page } = fixture()
    await page.goto('about:blank')
    page.goto.mockClear()
    const initialize = request('navigate', {
      url: `${origin}/`,
      initializeOrigin: true,
    })
    await expect(actor.execute(initialize)).resolves.toEqual({ url: `${origin}/` })
    expect(page.goto).toHaveBeenCalledTimes(1)
    await expect(actor.execute(initialize)).resolves.toEqual({ url: `${origin}/` })
    expect(page.goto).toHaveBeenCalledTimes(1)
    await actor.execute(request('navigate', { url: `${origin}/items/123` }))
    await expect(actor.execute(initialize)).rejects.toThrow('AUTOMATION_RECONCILE_PAGE')
    expect(page.url()).toBe(`${origin}/items/123`)
    expect(page.goto).toHaveBeenCalledTimes(2)
  })

  it('requires the submit tool for actual submit or destructive DOM controls', async () => {
    const { actor, locator } = fixture()
    locator.evaluate.mockResolvedValueOnce(true)
    await expect(
      actor.execute(request('click', { target: { css: 'button' } })),
    ).rejects.toThrow('AUTOMATION_SUBMIT_REQUIRED')
    expect(locator.click).not.toHaveBeenCalled()
  })

  it('invokes locator guards with the element and origin before ordinary actions', async () => {
    const { actor, locator } = fixture()
    const element = {
      tagName: 'INPUT',
      type: 'text',
      innerText: '',
      value: '',
      closest: () => element,
      getAttribute: () => null,
    }
    locator.evaluate.mockImplementation(
      async (script) =>
        browserEvaluate(script, { location: { origin } }, element, origin) as boolean,
    )
    await expect(
      actor.execute(request('click', { target: { css: 'input' } })),
    ).resolves.toEqual({ completed: true })
    await expect(
      actor.execute(
        request('fill', { target: { css: 'input' }, value: 'Prepared title' }),
      ),
    ).resolves.toEqual({ completed: true })
  })

  it.each([
    ['submit', 'Continue'],
    ['image', 'Continue'],
    ['button', 'Publish'],
    ['button', 'Send message'],
    ['button', 'Delete'],
    ['button', 'Remove account'],
    ['button', 'Confirmer / supprimer'],
    ['button', 'Envoyer'],
    ['button', 'Veröffentlichen'],
    ['button', 'Löschen'],
  ])('checks the actual DOM for final action %s/%s', async (type, text) => {
    const { actor, locator } = fixture()
    const element = {
      type,
      innerText: text,
      value: '',
      closest: () => element,
      getAttribute: () => null,
    }
    locator.evaluate.mockImplementation(
      async (script) =>
        browserEvaluate(script, { location: { origin } }, element, origin) as boolean,
    )
    await expect(
      actor.execute(request('click', { target: { css: 'button' } })),
    ).rejects.toThrow('AUTOMATION_SUBMIT_REQUIRED')
    expect(locator.click).not.toHaveBeenCalled()
  })

  it.each([
    'Upload',
    'Upload item',
    'Publish',
    'Publish item',
    'List item',
    'List for sale',
    'Publier',
    "Publier l'article",
    'Publier l’article',
    'Mettre en ligne',
    'Hochladen',
    'Artikel hochladen',
    'Veröffentlichen',
    'Subir',
    'Subir artículo',
    'Publicar',
    'Carica',
    'Carica articolo',
    'Pubblica',
    'Uploaden',
    'Plaatsen',
    'Artikel plaatsen',
    'Publicar artigo',
    'Wystaw',
    'Wystaw przedmiot',
    'Nahrát',
    'Nahrať',
    'Įkelti',
    'Ladda upp',
    'Upload vare',
    'Julkaise',
    'Objavi',
    'Feltöltés',
    'Publică',
    'Δημοσίευση',
    'Send',
    'Send message',
    'Envoyer',
    'Envoyer le message',
    'Senden',
    'Nachricht senden',
    'Enviar',
    'Enviar mensaje',
    'Invia',
    'Invia messaggio',
    'Verzenden',
    'Bericht verzenden',
    'Enviar mensagem',
    'Wyślij',
    'Wyślij wiadomość',
    'Odeslat',
    'Odoslať',
    'Siųsti',
    'Skicka',
    'Send besked',
    'Lähetä',
    'Pošalji',
    'Küldés',
    'Trimite',
    'Αποστολή',
    '  ＵＰＬＯＡＤ　ＩＴＥＭ * ',
  ])('requires submit for the supported final label %s', async (text) => {
    for (const [tagName, role] of [
      ['BUTTON', 'button'],
      ['DIV', 'button'],
      ['A', 'link'],
      ['DIV', 'link'],
    ]) {
      const { actor, locator } = fixture()
      const element = {
        tagName,
        type: tagName === 'BUTTON' ? 'button' : '',
        innerText: text,
        value: '',
        closest: () => element,
        getAttribute: (key: string) => (key === 'role' ? role : null),
      }
      locator.evaluate.mockImplementation(
        async (script) =>
          browserEvaluate(script, { location: { origin } }, element, origin) as boolean,
      )
      await expect(
        actor.execute(request('click', { target: { role, name: text } })),
      ).rejects.toThrow('AUTOMATION_SUBMIT_REQUIRED')
      expect(locator.click).not.toHaveBeenCalled()
    }
  })

  it('allows an explicit submit only once per stable gateway operation UUID', async () => {
    const { actor, locator } = fixture()
    const input = {
      target: { role: 'button', name: 'Publish' },
      operationId: 'bedf79f6-dd3f-49b0-9638-24d6ad280cd3',
    }
    await expect(actor.execute(request('submit', input))).resolves.toEqual({
      completed: true,
      operationId: input.operationId,
    })
    await expect(actor.execute(request('submit', input))).rejects.toThrow(
      'AUTOMATION_SUBMIT_REPLAY',
    )
    expect(locator.click).toHaveBeenCalledTimes(1)
  })

  it('bounds submit replay tracking to each successfully released lease', async () => {
    const { actor } = fixture()
    for (let cycle = 0; cycle < 300; cycle++) {
      const input = {
        target: { role: 'button', name: 'Publish' },
        operationId: `00000000-0000-4000-8000-${cycle.toString(16).padStart(12, '0')}`,
      }
      await expect(actor.execute(request('submit', input))).resolves.toEqual({
        completed: true,
        operationId: input.operationId,
      })
      await expect(actor.execute(request('submit', input))).rejects.toThrow(
        'AUTOMATION_SUBMIT_REPLAY',
      )
      await actor.release()
    }
  })

  it('keeps submit replay protection when release is rejected during pending work', async () => {
    const { actor, locator } = fixture()
    let settle!: () => void
    locator.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    const input = {
      target: { role: 'button', name: 'Publish' },
      operationId: '00000000-0000-4000-8000-000000000123',
    }
    await expect(
      actor.execute(request('submit', input, { timeoutMs: 20 })),
    ).rejects.toThrow('AUTOMATION_TIMEOUT')
    await expect(actor.release()).rejects.toThrow('AUTOMATION_BUSY')
    settle()
    await actor.whenIdle()
    await expect(actor.execute(request('submit', input))).rejects.toThrow(
      'AUTOMATION_SUBMIT_REPLAY',
    )
    await actor.release()
  })

  it('uses fixed tools for selectors, values, uploads and field reads', async () => {
    const { actor, locator, optionHandle, page } = fixture()
    await actor.execute(request('click', { target: { role: 'button', name: 'Save' } }))
    await actor.execute(request('fill', { target: { label: 'Title' }, value: 'Coat' }))
    await actor.execute(request('select', { target: { testId: 'size' }, value: 'M' }))
    await actor.execute(
      request('upload', { target: { css: 'input[type=file]' }, files: ['/tmp/a.png'] }),
    )
    expect(locator.fill).toHaveBeenCalledWith('Coat', expect.any(Object))
    expect(locator.selectOption).toHaveBeenCalledWith(
      optionHandle.asElement(),
      expect.any(Object),
    )
    expect(optionHandle.dispose).toHaveBeenCalled()
    expect(locator.setInputFiles).toHaveBeenCalledWith(['/tmp/a.png'], expect.any(Object))
    expect(
      await actor.execute(
        request('readFields', { fields: { title: { placeholder: 'Title' } } }),
      ),
    ).toEqual({ title: 'field value' })
    expect(page.getByRole).toHaveBeenCalledWith('button', {
      name: 'Save',
      exact: true,
    })
  })

  it.each([
    ['Good', [{ value: '2', label: 'Good' }], '2'],
    ['2', [{ value: '2', label: 'Good' }], '2'],
    [
      'Good',
      [
        { value: '2', label: 'Good' },
        { value: '3', label: 'Good' },
      ],
      'OPTION_AMBIGUOUS',
    ],
    [
      'Good',
      [
        { value: '2', label: 'Good' },
        { value: 'Good', label: 'Other' },
      ],
      'OPTION_AMBIGUOUS',
    ],
    [
      '2',
      [
        { value: '2', label: 'Good' },
        { value: '2', label: 'New' },
      ],
      'OPTION_AMBIGUOUS',
    ],
    ['good', [{ value: '2', label: 'Good' }], 'OPTION_NOT_FOUND'],
    ['Good', [{ value: '2', label: 'Good', hidden: true }], 'OPTION_NOT_FOUND'],
    ['Good', [{ value: '2', label: 'Good', disabled: true }], 'OPTION_NOT_FOUND'],
  ])(
    'resolves observed select options exactly for %s/%j',
    async (source, options, expected) => {
      const { actor, locator, optionHandle } = fixture()
      let selected: unknown
      const element = {
        tagName: 'SELECT',
        options: options.map((option) => ({ ...option, closest: () => null })),
      }
      locator.evaluateHandle.mockImplementationOnce(async (...args: unknown[]) => {
        selected = browserEvaluate(
          args[0],
          {
            location: { origin },
            getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
          },
          element,
          args[1],
        )
        return {
          asElement: () => (typeof selected === 'object' && selected ? selected : null),
          jsonValue: async () => selected,
          dispose: optionHandle.dispose,
        }
      })
      if (expected.startsWith('OPTION_')) {
        await expect(
          actor.execute(
            request('select', { target: { label: 'Condition' }, value: source }),
          ),
        ).rejects.toThrow(`AUTOMATION_${expected}`)
        expect(locator.selectOption).not.toHaveBeenCalled()
      } else {
        await expect(
          actor.execute(
            request('select', { target: { label: 'Condition' }, value: source }),
          ),
        ).resolves.toEqual({ completed: true })
        expect(selected).toMatchObject({ value: expected })
        expect(locator.selectOption).toHaveBeenCalledWith(selected, expect.any(Object))
      }
      expect(optionHandle.dispose).toHaveBeenCalled()
    },
  )

  it('keeps a timed out operation quarantined until it settles', async () => {
    const { actor, locator } = fixture()
    let finish!: () => void
    locator.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    await expect(
      actor.execute(request('click', { target: { css: 'button' } }, { timeoutMs: 20 })),
    ).rejects.toThrow('AUTOMATION_TIMEOUT')
    await expect(actor.execute(request('snapshot'))).rejects.toThrow('AUTOMATION_BUSY')
    await expect(actor.dispose()).rejects.toThrow('AUTOMATION_BUSY')
    finish()
    await actor.whenIdle()
    await expect(actor.execute(request('snapshot'))).resolves.toMatchObject({
      text: 'page',
    })
  })

  it('does not use a second page when its owned page closes', async () => {
    const { actor, page, context } = fixture()
    await actor.execute(request('snapshot'))
    page.isClosed = () => true
    await expect(actor.execute(request('snapshot'))).rejects.toThrow(
      'AUTOMATION_PAGE_CLOSED',
    )
    expect(context.newPage).not.toHaveBeenCalled()
  })

  it('refuses tools when the page has left its pinned origin', async () => {
    const { actor, page, locator } = fixture()
    await actor.execute(request('snapshot'))
    page.url = () => 'https://evil.test/'
    await expect(
      actor.execute(request('fill', { target: { css: 'input' }, value: 'secret' })),
    ).rejects.toThrow('AUTOMATION_ORIGIN_MISMATCH')
    expect(locator.fill).not.toHaveBeenCalled()
  })

  it('guards owned page and popup navigation while leaving other pages alone', async () => {
    const { actor, page, context } = fixture()
    let guard!: (route: Route) => Promise<void>
    context.route.mockImplementationOnce(async (...args: unknown[]) => {
      guard = args[1] as typeof guard
    })
    await actor.execute(request('snapshot'))
    for (const belongs of [true, false]) {
      const route = {
        request: () => ({
          isNavigationRequest: () => true,
          url: () => 'https://evil.test/',
          frame: () => ({
            page: () => ({ opener: async () => (belongs ? page : null) }),
          }),
        }),
        abort: vi.fn(async () => {}),
        continue: vi.fn(async () => {}),
      }
      await guard(route as unknown as Route)
      expect(route.abort).toHaveBeenCalledTimes(belongs ? 1 : 0)
      expect(route.continue).toHaveBeenCalledTimes(belongs ? 0 : 1)
    }
    await actor.release()
    expect(context.unroute).toHaveBeenCalled()
  })

  it('does not expose Playwright error messages or entered passwords', async () => {
    const { actor, locator } = fixture()
    locator.fill.mockRejectedValueOnce(new Error('password=synthetic-secret'))
    await expect(
      actor.execute(
        request('fill', { target: { css: 'input[type=password]' }, value: 'secret' }),
      ),
    ).rejects.toThrow(/^AUTOMATION_FAILED$/)
  })

  it('refuses mutation of a target outside the pinned document', async () => {
    const { actor, locator } = fixture()
    locator.evaluate.mockResolvedValueOnce(false)
    await expect(
      actor.execute(
        request('fill', {
          target: { css: 'input' },
          value: 'secret',
        }),
      ),
    ).rejects.toThrow('AUTOMATION_TARGET_SCOPE')
    expect(locator.fill).not.toHaveBeenCalled()
  })

  it('masks password and hidden fields in the fixed DOM reader', async () => {
    const { actor, locator } = fixture()
    for (const type of ['password', 'hidden']) {
      locator.evaluate.mockImplementationOnce(
        async (script) =>
          browserEvaluate(
            script,
            { location: { origin } },
            {
              type,
              value: 'synthetic-secret',
            },
            origin,
          ) as string,
      )
      expect(
        await actor.execute(
          request('readFields', {
            fields: { value: { css: 'input' } },
          }),
        ),
      ).toEqual({ value: '[REDACTED]' })
    }
  })

  it.each([
    [6000, 6000],
    [16_384, 16_384],
    [16_385, 16_384],
  ])(
    'reads %i field characters with a bounded %i-character result',
    async (size, limit) => {
      const { actor, locator } = fixture()
      locator.evaluate.mockImplementationOnce(
        async (script) =>
          browserEvaluate(
            script,
            { location: { origin } },
            { value: 'x'.repeat(size) },
            origin,
          ) as string,
      )
      const fields = (await actor.execute(
        request('readFields', { fields: { description: { label: 'Description' } } }),
      )) as Record<string, string>
      expect(fields.description?.length).toBe(limit)
      expect(fields).toEqual({ description: 'x'.repeat(limit) })
    },
  )

  it('rejects combined field results above the bounded response frame', async () => {
    const { actor, locator } = fixture()
    locator.evaluate.mockImplementation(
      async (script) =>
        browserEvaluate(
          script,
          { location: { origin } },
          { value: 'x'.repeat(16_384) },
          origin,
        ) as string,
    )
    const fields = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [
        `description${index}`,
        { label: 'Description' },
      ]),
    )
    await expect(actor.execute(request('readFields', { fields }))).rejects.toThrow(
      'AUTOMATION_TOO_LARGE',
    )
  })

  it('invokes the snapshot script as Playwright does and masks password controls', async () => {
    const { actor, page } = fixture()
    const element = {
      tagName: 'INPUT',
      id: 'password',
      value: 'synthetic-secret',
      innerText: '',
      getAttribute: (key: string) => (key === 'type' ? 'password' : null),
      getBoundingClientRect: () => ({ width: 20, height: 20 }),
    }
    page.evaluate.mockImplementationOnce(async (...args: unknown[]) => {
      const [script, input] = args as [string, unknown]
      return browserEvaluate(
        script,
        {
          location: { origin, href: `${origin}/login` },
          document: {
            title: 'Login',
            body: { innerText: 'Fixture text' },
            querySelectorAll: () => [element],
          },
          getComputedStyle: () => ({ visibility: 'visible' }),
        },
        input,
      ) as { text: string; controls: [] }
    })
    const result = await actor.execute(request('snapshot', { maxChars: 7 }))
    expect(result).toMatchObject({
      text: 'Fixture',
      controls: [{ index: 0, type: 'password', value: '[REDACTED]' }],
    })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })

  it('can address a visible snapshot control by its bounded index', async () => {
    const { actor, locator } = fixture()
    await actor.execute(request('click', { target: { index: 2 } }))
    expect(locator.filter).toHaveBeenCalledWith({ visible: true })
    expect(locator.nth).toHaveBeenCalledWith(2)
    expect(locator.click).toHaveBeenCalledTimes(1)
  })

  it('invokes the GET script as Playwright does and masks sensitive JSON', async () => {
    const { actor, page } = fixture()
    const fetch = vi.fn(async () => ({
      url: `${origin}/api/v2/users/current`,
      status: 200,
      body: new Response('{"name":"Fixture","password":"synthetic","token":"private"}')
        .body,
    }))
    page.evaluate.mockImplementationOnce(async (...args: unknown[]) => {
      const [script, input] = args as [string, unknown]
      return (await browserEvaluate(
        script,
        {
          location: { origin },
          URL,
          fetch,
          AbortSignal,
          TextDecoder,
        },
        input,
      )) as { text: string; controls: [] }
    })
    expect(
      await actor.execute(
        request('request', {
          path: '/api/v2/users/current',
          method: 'GET',
        }),
      ),
    ).toMatchObject({
      status: 200,
      text: '{"name":"Fixture","password":"[REDACTED]","token":"[REDACTED]"}',
    })
    expect(fetch).toHaveBeenCalledWith(
      `${origin}/api/v2/users/current`,
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
      }),
    )
  })

  it('bounds the browser fetch body before returning it to the gateway', async () => {
    const { actor, page } = fixture()
    page.evaluate.mockImplementationOnce(async (...args: unknown[]) => {
      const [script, input] = args as [string, unknown]
      return (await browserEvaluate(
        script,
        {
          location: { origin },
          URL,
          AbortSignal,
          TextDecoder,
          fetch: async () => ({
            url: `${origin}/api/v2/large`,
            status: 200,
            body: new Response('x'.repeat(65_537)).body,
          }),
        },
        input,
      )) as { text: string; controls: [] }
    })
    await expect(
      actor.execute(
        request('request', {
          path: '/api/v2/large',
          method: 'GET',
        }),
      ),
    ).rejects.toThrow('AUTOMATION_FAILED')
  })

  it('sends a final settlement receipt after an earlier timeout, never overlapping actions', async () => {
    const { actor, locator } = fixture()
    let settle!: () => void
    locator.fill.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    const output = new PassThrough()
    const frames: { requestId: string; error?: { code: string } }[] = []
    let timeout!: () => void
    const timedOut = new Promise<void>((resolve) => {
      timeout = resolve
    })
    output.on('data', (bytes: Buffer) => {
      const frame = JSON.parse(
        bytes.toString().trim().slice('NEXUS_AUTOMATION '.length),
      ) as (typeof frames)[number]
      frames.push(frame)
      if (frame.error?.code === 'AUTOMATION_TIMEOUT') timeout()
    })
    async function* commands() {
      yield JSON.stringify({
        requestId: 'late',
        ...request(
          'fill',
          {
            target: { css: 'input' },
            value: 'Coat',
          },
          { timeoutMs: 20 },
        ),
      })
      await timedOut
      yield JSON.stringify({ requestId: 'blocked', ...request('snapshot') })
      await Promise.resolve()
      settle()
      await actor.whenIdle()
      await Promise.resolve()
      yield 'stop'
    }
    await automationCommandLoop(actor, commands(), output)
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: 'late',
          error: { code: 'AUTOMATION_TIMEOUT', message: 'AUTOMATION_TIMEOUT' },
        }),
        expect.objectContaining({
          requestId: 'late',
          error: { code: 'AUTOMATION_SETTLED', message: 'AUTOMATION_SETTLED' },
        }),
        expect.objectContaining({
          requestId: 'blocked',
          error: { code: 'AUTOMATION_BUSY', message: 'AUTOMATION_BUSY' },
        }),
      ]),
    )
    expect(locator.fill).toHaveBeenCalledTimes(1)
  })

  it('correlates bounded command responses while preserving stop', async () => {
    const { actor } = fixture()
    const output = new PassThrough()
    let text = ''
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString()
    })
    async function* commands() {
      yield JSON.stringify({ requestId: 'r-1', ...request('snapshot') })
      await actor.whenIdle()
      yield 'stop'
    }
    await automationCommandLoop(actor, commands(), output)
    expect(text).toContain('NEXUS_AUTOMATION ')
    expect(JSON.parse(text.trim().slice('NEXUS_AUTOMATION '.length))).toMatchObject({
      requestId: 'r-1',
      ok: true,
      result: { text: 'page' },
    })
  })
})

describe('CDP endpoint validation', () => {
  it.each([
    'ws://evil.test/devtools/browser/id',
    'http://127.0.0.1:9000',
    'ws://127.0.0.1:9000/devtools/page/id',
    'ws://user:secret@127.0.0.1:9000/devtools/browser/id',
    'ws://127.0.0.1:9000/devtools/browser/id?token=secret',
  ])('rejects an unvetted endpoint %s', (endpoint) => {
    expect(() => validateCdpEndpoint(endpoint)).toThrow('AUTOMATION_CDP_INVALID')
  })

  it('accepts only a literal loopback browser websocket', () => {
    expect(validateCdpEndpoint('ws://127.0.0.1:9000/devtools/browser/a-b')).toBe(
      'ws://127.0.0.1:9000/devtools/browser/a-b',
    )
  })
})
