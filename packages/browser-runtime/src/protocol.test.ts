import { describe, expect, it } from 'vitest'
import { handleLine, handleRequest, SUPPORTED_METHODS } from './index.js'

const nodeVersion = '24.18.0'

describe('runtime protocol', () => {
  it.each(['health-1', 0, -1, 42, ''])('preserves a valid request id: %j', (id) => {
    expect(
      handleRequest({ jsonrpc: '2.0', id, method: 'runtime.health' }, nodeVersion),
    ).toEqual({
      jsonrpc: '2.0',
      id,
      result: {
        status: 'ok',
        protocolVersion: 1,
        runtime: 'node',
        nodeVersion,
        browser: 'not-connected',
      },
    })
  })

  it('describes only the two supported methods and no connected browser', () => {
    expect(
      handleRequest({ jsonrpc: '2.0', id: 1, method: 'runtime.describe' }, nodeVersion),
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        supportedMethods: SUPPORTED_METHODS,
        browser: 'not-connected',
      },
    })
    expect(SUPPORTED_METHODS).toEqual(['runtime.health', 'runtime.describe'])
  })

  it.each(['{', '', 'undefined', '{"jsonrpc":"2.0",}'])(
    'returns a structured parse error for malformed JSON: %s',
    (line) => {
      expect(handleLine(line, nodeVersion)).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      })
    },
  )

  it.each([
    null,
    [],
    [{ jsonrpc: '2.0', id: 1, method: 'runtime.health' }],
    true,
    1,
    'runtime.health',
    {},
    { jsonrpc: '2.0' },
    { jsonrpc: '2.0', method: 1 },
    { jsonrpc: '2.0', method: 'runtime.health', id: null },
    { jsonrpc: '2.0', method: 'runtime.health', id: 0.5 },
    { jsonrpc: '2.0', method: 'runtime.health', id: Number.MAX_SAFE_INTEGER + 1 },
    { jsonrpc: '2.0', method: 'runtime.health', id: false },
    { jsonrpc: '2.0', method: 'runtime.health', id: {} },
    { jsonrpc: '2.0', method: 'runtime.health', params: null },
    { jsonrpc: '2.0', method: 'runtime.health', params: 'invalid' },
  ])('rejects an invalid envelope: %j', (input) => {
    expect(handleRequest(input, nodeVersion)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    })
  })

  it('retains a recoverable id on an invalid envelope', () => {
    expect(
      handleRequest(
        { jsonrpc: '1.0', id: 'bad-version', method: 'runtime.health' },
        nodeVersion,
      ),
    ).toEqual({
      jsonrpc: '2.0',
      id: 'bad-version',
      error: { code: -32600, message: 'Invalid Request' },
    })
  })

  it('returns method-not-found without echoing the method or input data', () => {
    expect(
      handleRequest({ jsonrpc: '2.0', id: 3, method: 'browser.launch' }, nodeVersion),
    ).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32601, message: 'Method not found' },
    })
  })

  it.each(['runtime.health', 'runtime.describe', 'browser.launch'])(
    'does not reply to a valid notification for %s',
    (method) => {
      expect(handleRequest({ jsonrpc: '2.0', method }, nodeVersion)).toBeUndefined()
    },
  )

  it('parses valid JSON before handling the request', () => {
    expect(
      handleLine('{"jsonrpc":"2.0","id":7,"method":"runtime.health"}', nodeVersion),
    ).toMatchObject({ id: 7, result: { status: 'ok' } })
  })
})
