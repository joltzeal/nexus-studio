import { parseProxyUrl } from '../domain/credentials.js'
import { invalidRequest } from '../domain/errors.js'
import {
  MAX_BATCH,
  ProxyInputSchema,
  normalizeHost,
  type DecodoInput,
  type ImportInput,
  type ProxyInput,
} from '../domain/schemas.js'

/** Parses a newline-separated URL list atomically: one bad line saves nothing. */
export function parseImportInput(input: ImportInput): ProxyInput[] {
  const lines = input.proxyUrls
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length < 1 || lines.length > MAX_BATCH) {
    throw invalidRequest('请提供 1 至 1000 条代理 URL，每行一条')
  }
  return lines.map((line, index) => {
    try {
      const parsed = parseProxyUrl(line)
      const candidate = ProxyInputSchema.safeParse({
        name: `proxy-${parsed.port}`,
        schemes: [parsed.scheme],
        host: normalizeHost(parsed.host),
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
        groupId: input.groupId,
      })
      if (!candidate.success) throw new Error('invalid row')
      return candidate.data
    } catch {
      // The offending value is never echoed: it may contain a password.
      throw invalidRequest(`第 ${index + 1} 行代理 URL 无效；未保存任何记录`)
    }
  })
}

/** A provider strategy builds endpoint records, never a port/protocol product. */
export function decodoInputs(input: DecodoInput): ProxyInput[] {
  const rows: ProxyInput[] = []
  for (let port = input.startPort; port <= input.endPort; port += 1) {
    rows.push({
      name: `decodo-${port}`,
      schemes: [...input.schemes],
      host: input.host,
      port,
      username: input.username,
      password: input.password,
      enabled: true,
      udp: input.udp,
      groupId: input.groupId,
    })
  }
  return rows
}
