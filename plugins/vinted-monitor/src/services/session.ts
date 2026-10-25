import { CookieJar } from 'tough-cookie'
import { storefrontOrigin, stripWww } from '../domain/urls.js'

const LOCALES: Readonly<Record<string, string>> = {
  com: 'en-US',
  'co.uk': 'en-GB',
  at: 'de-AT',
  be: 'fr-BE',
  cz: 'cs-CZ',
  de: 'de-DE',
  dk: 'da-DK',
  ee: 'et-EE',
  es: 'es-ES',
  fi: 'fi-FI',
  fr: 'fr-FR',
  gr: 'el-GR',
  hr: 'hr-HR',
  hu: 'hu-HU',
  ie: 'en-IE',
  it: 'it-IT',
  lt: 'lt-LT',
  lv: 'lv-LV',
  nl: 'nl-NL',
  pl: 'pl-PL',
  pt: 'pt-PT',
  ro: 'ro-RO',
  se: 'sv-SE',
  si: 'sl-SI',
  sk: 'sk-SK',
}

/** Anonymous cookies are local to a collection and are never persisted. */
export class AnonymousSession {
  readonly origin: string
  readonly locale: string
  private readonly catalogueOrigin: string
  private readonly jar = new CookieJar()
  ready = false

  constructor(domain: string) {
    this.origin = storefrontOrigin(domain)
    this.catalogueOrigin = `https://api.${stripWww(domain)}`
    this.locale = LOCALES[stripWww(domain).replace(/^vinted\./, '')] ?? 'en-US'
  }

  clear(): void {
    this.jar.removeAllCookiesSync()
    this.ready = false
  }

  private assertOrigin(url: string): void {
    const parsed = new URL(url)
    if (
      (parsed.origin !== this.origin && parsed.origin !== this.catalogueOrigin) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('Invalid Vinted session origin')
    }
  }

  accept(url: string, response: Response): void {
    this.assertOrigin(url)
    for (const cookie of response.headers.getSetCookie()) {
      this.jar.setCookieSync(cookie, url, { ignoreError: true })
    }
  }

  cookieHeader(url: string): string {
    this.assertOrigin(url)
    if (new URL(url).origin === this.origin) return this.jar.getCookieStringSync(url)
    // Like the reference adapter, share this anonymous storefront session with
    // its catalogue sibling. Cookies from another country/site cannot enter it.
    const cookies = new Map(
      this.jar.getCookiesSync(`${this.origin}/`).map((cookie) => [cookie.key, cookie]),
    )
    for (const cookie of this.jar.getCookiesSync(url)) cookies.set(cookie.key, cookie)
    return [...cookies.values()].map((cookie) => cookie.cookieString()).join('; ')
  }
}
