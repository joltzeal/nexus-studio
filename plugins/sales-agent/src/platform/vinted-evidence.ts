import type { BrowserSnapshot } from '../services/models.js'

export type Balance = {
  currency: string
  available: string | null
  pending: string | null
}

// Finite label sets match observed UI only. They never produce a selector or
// change the browser's language, region, fingerprint, or currency.
const labels = {
  title: [
    'title',
    'item title',
    'titre',
    'titel',
    'título',
    'titolo',
    'tytuł',
    'název',
    'názov',
    'pavadinimas',
    'otsikko',
    'naslov',
    'cím',
    'titlu',
    'τίτλος',
  ],
  description: [
    'description',
    'item description',
    'beschreibung',
    'descripción',
    'descrizione',
    'beschrijving',
    'descrição',
    'opis',
    'popis',
    'aprašymas',
    'beskrivning',
    'beskrivelse',
    'kuvaus',
    'leírás',
    'descriere',
    'περιγραφή',
  ],
  price: [
    'price',
    'item price',
    'prix',
    'preis',
    'precio',
    'prezzo',
    'prijs',
    'preço',
    'cena',
    'kaina',
    'pris',
    'hinta',
    'cijena',
    'ár',
    'preț',
    'τιμή',
  ],
  currency: [
    'currency',
    'balance currency',
    'devise',
    'währung',
    'moneda',
    'valuta',
    'moeda',
    'waluta',
    'měna',
    'mena',
    'valiuta',
    'valuutta',
    'pénznem',
    'monedă',
    'νόμισμα',
  ],
  wallet: [
    'balance',
    'wallet',
    'vinted balance',
    'vinted wallet',
    'solde',
    'solde vinted',
    'portefeuille',
    'portefeuille vinted',
    'geldbeutel',
    'vinted-guthaben',
    'guthaben',
    'saldo',
    'saldo vinted',
    'portafoglio',
    'portemonnee',
    'carteira',
    'portfel',
    'peněženka',
    'peňaženka',
    'piniginė',
    'saldo på vinted',
    'saldó',
    'egyenleg',
    'πορτοφόλι',
  ],
  available: [
    'available balance',
    'available',
    'solde disponible',
    'disponible',
    'verfügbares guthaben',
    'verfügbar',
    'saldo disponible',
    'saldo disponibile',
    'beschikbaar saldo',
    'saldo disponível',
    'dostępne środki',
    'tillgängligt saldo',
    'tilgængelig saldo',
    'käytettävissä oleva saldo',
    'disponibil',
    'elérhető egyenleg',
  ],
  pending: [
    'pending balance',
    'pending',
    'solde en attente',
    'en attente',
    'ausstehendes guthaben',
    'ausstehend',
    'saldo pendiente',
    'saldo in sospeso',
    'saldo in behandeling',
    'saldo pendente',
    'środki oczekujące',
    'väntande saldo',
    'afventende saldo',
    'odottava saldo',
    'sold în așteptare',
    'függőben lévő egyenleg',
  ],
  search: [
    'search',
    'rechercher',
    'recherche',
    'suchen',
    'suche',
    'buscar',
    'cerca',
    'zoeken',
    'pesquisar',
    'szukaj',
    'hledat',
    'hľadať',
    'sök',
    'søg',
    'hae',
    'keresés',
    'caută',
    'αναζήτηση',
  ],
  publish: [
    'upload',
    'upload item',
    'publish',
    'publish item',
    'list item',
    'list for sale',
    'publier',
    "publier l'article",
    'publier l’article',
    'mettre en ligne',
    'hochladen',
    'artikel hochladen',
    'veröffentlichen',
    'subir',
    'subir artículo',
    'publicar',
    'carica',
    'carica articolo',
    'pubblica',
    'uploaden',
    'plaatsen',
    'artikel plaatsen',
    'publicar artigo',
    'wystaw',
    'wystaw przedmiot',
    'nahrát',
    'nahrať',
    'įkelti',
    'ladda upp',
    'upload vare',
    'julkaise',
    'objavi',
    'feltöltés',
    'publică',
    'δημοσίευση',
  ],
  send: [
    'send',
    'send message',
    'envoyer',
    'envoyer le message',
    'senden',
    'nachricht senden',
    'enviar',
    'enviar mensaje',
    'invia',
    'invia messaggio',
    'verzenden',
    'bericht verzenden',
    'enviar mensagem',
    'wyślij',
    'wyślij wiadomość',
    'odeslat',
    'odoslať',
    'siųsti',
    'skicka',
    'send besked',
    'lähetä',
    'pošalji',
    'küldés',
    'trimite',
    'αποστολή',
  ],
} as const

type LabelKind = keyof typeof labels
export function normalizeLabel(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s*\*$/u, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase()
}

export function hasLabel(kind: LabelKind, value: string): boolean {
  return (labels[kind] as readonly string[]).includes(normalizeLabel(value))
}

export function formLabel(
  kind: 'title' | 'description' | 'price' | 'currency',
  value: string,
): boolean {
  return hasLabel(kind, value.replace(/\s*\([^)]{1,12}\)\s*$/u, ''))
}

export function currencyEvidence(value: string): string | undefined {
  const codes = [...value.matchAll(/(?:^|[\s(])([A-Z]{3})(?=$|[\s)])/gu)].map(
    (match) => match[1]!,
  )
  if (value.includes('€')) codes.push('EUR')
  if (value.includes('£')) codes.push('GBP')
  const unique = [...new Set(codes)]
  // A bare dollar sign does not identify USD.
  return unique.length === 1 ? unique[0] : undefined
}

function amount(value: string): string | null {
  const normalized = value.trim().replace(',', '.')
  return normalized.length <= 18 &&
    /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/u.test(normalized)
    ? normalized
    : null
}

function labeledMoney(value: string): { currency: string; amount: string } | undefined {
  const currency = currencyEvidence(value)
  if (!currency) return undefined
  const number = value.replace(/\b[A-Z]{3}\b|[€£]/gu, '').trim()
  const parsed = amount(number)
  return parsed !== null ? { currency, amount: parsed } : undefined
}

export function isWalletPage(snapshot: BrowserSnapshot): boolean {
  const title = snapshot.title.replace(/\s+(?:[|–—-])\s+Vinted\s*$/iu, '')
  return (
    hasLabel('wallet', title) ||
    snapshot.text
      .split('\n')
      .slice(0, 8)
      .some((line) => hasLabel('wallet', line))
  )
}

export function observedBalance(snapshot: BrowserSnapshot): Balance | undefined {
  if (!isWalletPage(snapshot)) return undefined
  const named = (kind: 'available' | 'pending' | 'currency') =>
    snapshot.controls.filter((control) => hasLabel(kind, control.name))
  const currencyControls = named('currency')
  if (currencyControls.length > 1) return undefined
  const controlCurrency = currencyControls[0]?.value
    ? currencyEvidence(currencyControls[0].value)
    : undefined
  const readings: Partial<
    Record<'available' | 'pending', { currency: string; amount: string }>
  > = {}
  const lines = snapshot.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 500)
  for (const kind of ['available', 'pending'] as const) {
    const controls = named(kind)
    if (controls.length > 1) return undefined
    const raw = controls[0]?.value
    if (raw) {
      const parsed =
        labeledMoney(raw) ??
        (controlCurrency && amount(raw) !== null
          ? { currency: controlCurrency, amount: amount(raw)! }
          : undefined)
      if (parsed) readings[kind] = parsed
    }
    const matches: string[] = []
    for (const [index, line] of lines.entries()) {
      if (hasLabel(kind, line.replace(/:\s*$/u, ''))) {
        if (lines[index + 1]) matches.push(lines[index + 1]!)
      } else {
        const separator = line.indexOf(':')
        if (separator >= 0 && hasLabel(kind, line.slice(0, separator)))
          matches.push(line.slice(separator + 1))
      }
    }
    if (matches.length > 1) return undefined
    const textReading = matches[0] ? labeledMoney(matches[0]) : undefined
    if (
      textReading &&
      readings[kind] &&
      (textReading.currency !== readings[kind]?.currency ||
        textReading.amount !== readings[kind]?.amount)
    )
      return undefined
    if (textReading) readings[kind] = textReading
  }
  const currencies = new Set(Object.values(readings).map((reading) => reading.currency))
  if (controlCurrency) currencies.add(controlCurrency)
  if (currencies.size !== 1 || (!readings.available && !readings.pending))
    return undefined
  return {
    currency: [...currencies][0]!,
    available: readings.available?.amount ?? null,
    pending: readings.pending?.amount ?? null,
  }
}
