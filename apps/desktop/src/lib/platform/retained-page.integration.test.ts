import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer, transformWithOxc, type ViteDevServer } from 'vite'

const requireRuntime = createRequire(
  new URL('../../../../../packages/browser-runtime/package.json', import.meta.url),
)
const { chromium } = requireRuntime(
  'playwright-core',
) as typeof import('../../../../../packages/browser-runtime/node_modules/playwright-core')
const binary =
  process.env.NEXUS_TEST_AUTOMATION_BROWSER_BINARY ?? chromium.executablePath()
const hasBrowser = existsSync(binary)
let server: ViteDevServer

beforeAll(async () => {
  if (!hasBrowser) return
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    resolve: { alias: { '@': fileURLToPath(new URL('../..', import.meta.url)) } },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'retained-page-test',
        configureServer(instance) {
          instance.middlewares.use((request, response, next) => {
            if (request.url !== '/__retained-page') return next()
            response.setHeader('Content-Type', 'text/html')
            response.end(
              '<div id="root"></div><script type="module" src="/@id/retained-page-test"></script>',
            )
          })
        },
        resolveId(id) {
          if (id === 'retained-page-test') return '\0retained-page-test'
        },
        async load(id) {
          if (id !== '\0retained-page-test') return
          const source = `
            import React, { useEffect, useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { createPortal } from 'react-dom';
            import { Tabs } from '/src/components/ui/tabs.tsx';
            import { RetainedPage } from '/src/components/retained-page.tsx';
            window.pageEffects = { accounts: 0, agent: 0 };
            function Page({ name }) {
              const [query, setQuery] = useState('');
              const [page, setPage] = useState(1);
              const [dialog, setDialog] = useState(false);
              useEffect(() => {
                window.pageEffects[name]++;
                return () => { window.pageEffects[name]--; };
              }, []);
              return <section>
                <input aria-label={name + ' filter'} value={query} onChange={e => setQuery(e.target.value)} />
                <button onClick={() => setPage(p => p + 1)}>{name} page {page}</button>
                <button onClick={() => setDialog(true)}>{name} dialog</button>
                {dialog && createPortal(<div role="dialog">{name} content</div>, document.body)}
                <div data-testid={name + '-scroll'} style={{ height: 100, overflow: 'auto' }}>
                  <div style={{ height: 1000 }}>scrollable content</div>
                </div>
              </section>;
            }
            function App() {
              const [active, setActive] = useState('accounts');
              const [visited, setVisited] = useState(['accounts']);
              function open(value) {
                setActive(value); setVisited(p => Array.from(new Set([...p, value])));
              }
              return <Tabs value={active}>
                <button onClick={() => open('agent')}>Execute history</button>
                <button onClick={() => open('accounts')}>Back to accounts</button>
                {['accounts', 'agent'].map(value =>
                  <RetainedPage key={value} value={value} activePage={active} visitedPages={visited}>
                    <Page name={value} />
                  </RetainedPage>)}
              </Tabs>;
            }
            createRoot(document.getElementById('root')).render(<App />);
          `
          return (await transformWithOxc(source, 'retained-page-test.tsx')).code
        },
      },
    ],
  })
  await server.listen()
}, 30_000)

afterAll(async () => {
  await server?.close()
})

it.skipIf(!hasBrowser)(
  'preserves source filters, paging and scroll on return while suspending hidden effects and portals',
  async () => {
    const browser = await chromium.launch({ executablePath: binary, headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(`${server.resolvedUrls!.local[0]}__retained-page`)
      await page.getByRole('textbox', { name: 'accounts filter' }).fill('blocked')
      await page.getByRole('button', { name: 'accounts page 1' }).click()
      await page.getByTestId('accounts-scroll').evaluate((node) => {
        node.scrollTop = 240
      })
      await page.getByRole('button', { name: 'accounts dialog', exact: true }).click()
      await page.getByRole('button', { name: 'Execute history' }).click()
      await page.getByRole('textbox', { name: 'agent filter' }).waitFor()
      expect(await page.getByRole('dialog').count()).toBe(0)
      await page.waitForFunction(
        () =>
          (window as unknown as { pageEffects: { accounts: number } }).pageEffects
            .accounts === 0,
      )
      await page.getByRole('button', { name: 'Back to accounts' }).click()
      expect(
        await page.getByRole('textbox', { name: 'accounts filter' }).inputValue(),
      ).toBe('blocked')
      expect(await page.getByRole('button', { name: 'accounts page 2' }).count()).toBe(1)
      expect(
        await page.getByTestId('accounts-scroll').evaluate((node) => node.scrollTop),
      ).toBe(240)
      expect(await page.getByRole('dialog').textContent()).toBe('accounts content')
    } finally {
      await browser.close()
    }
  },
  30_000,
)
