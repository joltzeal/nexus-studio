import { SCHEMES, type Scheme } from './model'

export function parseProxyLink(raw: string) {
  const value = raw.trim().replace(/^["'<]|["'>]$/g, '')
  if (value.length > 4096 || /\s/.test(value)) return null
  const match = /^(https?|socks5h?):\/\/(.+?)\/?$/i.exec(value)
  if (!match) return null
  const scheme = match[1].toLowerCase() as Scheme
  if (!SCHEMES.includes(scheme)) return null
  const rest = match[2]
  const at = rest.lastIndexOf('@')
  const address = at >= 0 ? rest.slice(at + 1) : rest
  const parts = /^(\[[^\]]+\]|[^:/?#]+):(\d{1,5})(?::(.*))?$/.exec(address)
  if (!parts || Number(parts[2]) < 1 || Number(parts[2]) > 65535) return null
  const credentials = at >= 0 ? rest.slice(0, at) : (parts[3] ?? '')
  const colon = credentials.indexOf(':')
  try {
    return {
      scheme,
      host: parts[1].replace(/^\[|\]$/g, ''),
      port: Number(parts[2]),
      username: decodeURIComponent(colon < 0 ? credentials : credentials.slice(0, colon)),
      password: decodeURIComponent(colon < 0 ? '' : credentials.slice(colon + 1)),
    }
  } catch {
    return null
  }
}
