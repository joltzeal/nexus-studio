/**
 * Diagnostics go to stderr and are scrubbed before they leave the plugin.
 * Secrets are registered by the vault, so an accidentally interpolated value
 * is still removed; field names that describe secrets are dropped outright.
 */
const secretFieldPattern =
  /pass|secret|token|cookie|code|credential|apikey|api_key|authorization|key$/i

export class Redactor {
  private readonly values = new Set<string>()

  add(value: string | null | undefined): void {
    // Very short values would shred unrelated text without adding safety.
    if (typeof value === 'string' && value.length >= 4) this.values.add(value)
  }

  scrub(text: string): string {
    let output = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1[REDACTED]@')
    for (const value of this.values) {
      output = output.split(value).join('[REDACTED]')
    }
    return output
  }

  scrubValue(value: unknown, depth = 0): unknown {
    if (depth > 4) return '[REDACTED]'
    if (typeof value === 'string') return this.scrub(value)
    if (Array.isArray(value)) {
      return value.map((entry) => this.scrubValue(entry, depth + 1))
    }
    if (typeof value === 'object' && value !== null) {
      const output: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        output[key] = secretFieldPattern.test(key)
          ? '[REDACTED]'
          : this.scrubValue(entry, depth + 1)
      }
      return output
    }
    return value
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export function createLogger(
  write: (line: string) => void,
  redactor: Redactor,
  now: () => Date = () => new Date(),
): Logger {
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      msg: redactor.scrub(message),
    }
    if (fields !== undefined) record.fields = redactor.scrubValue(fields)
    write(`${JSON.stringify(record)}\n`)
  }
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  }
}
