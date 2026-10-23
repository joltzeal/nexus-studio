import type { BrowserContext } from 'playwright-core'
import { withinProfileDeadline } from './profile-deadline.js'
import { captureIndexedDB } from './indexeddb-capture.js'

function storedOrigins(groups: unknown): string[] {
  if (!Array.isArray(groups)) throw new Error('PORTABLE_STATE_ORIGINS_INVALID')
  const origins = new Set<string>()
  for (const group of groups) {
    if (
      typeof group !== 'object' ||
      group === null ||
      !('origins' in group) ||
      !Array.isArray(group.origins)
    ) {
      throw new Error('PORTABLE_STATE_ORIGINS_INVALID')
    }
    for (const entry of group.origins as unknown[]) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('origin' in entry) ||
        typeof entry.origin !== 'string' ||
        ('usage' in entry &&
          (typeof entry.usage !== 'number' ||
            !Number.isFinite(entry.usage) ||
            entry.usage < 0))
      ) {
        throw new Error('PORTABLE_STATE_ORIGINS_INVALID')
      }
      if ('isPartitioned' in entry && entry.isPartitioned) {
        if (!('usage' in entry) || Number(entry.usage) > 0) {
          throw new Error('PORTABLE_STATE_PARTITIONED_STORAGE_UNSUPPORTED')
        }
        continue
      }
      const url = new URL(entry.origin)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('PORTABLE_STATE_ORIGIN_UNSUPPORTED')
      }
      origins.add(url.origin)
    }
  }
  return [...origins]
}

export async function initializeStoredOrigins(
  context: BrowserContext,
): Promise<Map<string, unknown[]>> {
  const databases = new Map<string, unknown[]>()
  const page = await context.newPage()
  try {
    // Playwright tracks only origins visited by this context, including persistent
    // contexts. Ask Chromium's local site-data UI for the persisted origins first.
    // Its completion event includes storage-only sites; the initial response does not.
    await page.goto('chrome://settings/content/all', {
      timeout: 10_000,
      waitUntil: 'domcontentloaded',
    })
    const groups: unknown = await withinProfileDeadline(
      page.evaluate(`(async () => {
        const cr = await import('chrome://resources/js/cr.js');
        return new Promise((resolve, reject) => {
          cr.addWebUiListener('onStorageListFetched', resolve);
          cr.sendWithPromise('getAllSites').catch(reject);
        });
      })()`),
      10_000,
      'PORTABLE_STATE_ORIGINS_TIMEOUT',
    )
    // A page-level route takes precedence over the context's network-blocking route.
    // Visiting synthetic documents registers origins without executing website code.
    await page.route('**/*', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
    )
    for (const origin of storedOrigins(groups)) {
      await page.goto(origin, { timeout: 10_000, waitUntil: 'domcontentloaded' })
      databases.set(origin, await captureIndexedDB(page))
    }
    return databases
  } finally {
    await page.close()
  }
}
