export const PROTOCOL_VERSION = 1 as const
export const SUPPORTED_METHODS = ['runtime.health', 'runtime.describe'] as const

export type JsonRpcId = string | number
export type JsonRpcErrorCode = -32700 | -32600 | -32601

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown> | unknown[]
}

export interface RuntimeHealth {
  status: 'ok'
  protocolVersion: typeof PROTOCOL_VERSION
  runtime: 'node'
  nodeVersion: string
  browser: 'not-connected'
}

export interface RuntimeDescription {
  protocolVersion: typeof PROTOCOL_VERSION
  supportedMethods: typeof SUPPORTED_METHODS
  browser: 'not-connected'
}

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: { code: JsonRpcErrorCode; message: string }
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: RuntimeHealth | RuntimeDescription }
  | JsonRpcError

export function protocolError(
  code: JsonRpcErrorCode,
  message: string,
  id: JsonRpcId | null = null,
): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is JsonRpcId {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  )
}

export function handleRequest(
  input: unknown,
  nodeVersion: string,
): JsonRpcResponse | undefined {
  if (!isRecord(input)) return protocolError(-32600, 'Invalid Request')

  const hasId = Object.hasOwn(input, 'id')
  const id = isId(input.id) ? input.id : null
  if (
    input.jsonrpc !== '2.0' ||
    typeof input.method !== 'string' ||
    (hasId && id === null) ||
    (Object.hasOwn(input, 'params') &&
      !isRecord(input.params) &&
      !Array.isArray(input.params))
  ) {
    return protocolError(-32600, 'Invalid Request', id)
  }

  // Only a valid request without an id is a notification; even unknown methods are silent.
  if (!hasId) return undefined
  if (id === null) return protocolError(-32600, 'Invalid Request')

  switch (input.method) {
    case 'runtime.health':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          status: 'ok',
          protocolVersion: PROTOCOL_VERSION,
          runtime: 'node',
          nodeVersion,
          browser: 'not-connected',
        },
      }
    case 'runtime.describe':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          supportedMethods: SUPPORTED_METHODS,
          browser: 'not-connected',
        },
      }
    default:
      return protocolError(-32601, 'Method not found', id)
  }
}

export function handleLine(
  line: string,
  nodeVersion: string,
): JsonRpcResponse | undefined {
  let input: unknown
  try {
    input = JSON.parse(line)
  } catch {
    return protocolError(-32700, 'Parse error')
  }
  return handleRequest(input, nodeVersion)
}
