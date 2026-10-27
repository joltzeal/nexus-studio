import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici'
import { SocksClient } from 'socks'
import { connect as connectTls } from 'node:tls'
import type { Socket } from 'node:net'

const proxy = process.env.NEXUS_NETWORK_PROXY
const MAX_REQUEST_MS = 65 * 60 * 1000

/**
 * Leave room for a caller's 60-minute AbortSignal, while bounding requests that
 * omit one. The total deadline includes queueing, headers and streamed bodies.
 */
export function requestTimeoutPolicy(
  timeoutMs = MAX_REQUEST_MS,
): Dispatcher.DispatcherComposeInterceptor {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REQUEST_MS) {
    throw new RangeError('Invalid application request deadline')
  }
  return (dispatch) => (options, handler) => {
    let controller: Dispatcher.DispatchController | undefined
    let expired: Error | undefined
    let finished = false
    const finish = () => {
      finished = true
      clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      expired = new DOMException('Application request deadline exceeded', 'TimeoutError')
      finish()
      controller?.abort(expired)
      // Undici can still be queueing without a connection/controller. Report
      // expiry now, and abort before writing if that queue entry later starts.
      handler.onResponseError?.(
        controller ?? {
          aborted: true,
          paused: false,
          reason: expired,
          abort() {},
          pause() {},
          resume() {},
        },
        expired,
      )
    }, timeoutMs)
    timer.unref()
    try {
      return dispatch(
        {
          ...options,
          // Request options override Agent defaults, including fetch versions
          // that explicitly supply their own five-minute parser timeouts.
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        },
        {
          onRequestStart(current, context) {
            controller = current
            if (expired) {
              current.abort(expired)
              return
            }
            handler.onRequestStart?.(current, context)
          },
          onResponseStart(current, status, headers, statusMessage) {
            if (!finished) {
              handler.onResponseStart?.(current, status, headers, statusMessage)
            }
          },
          onResponseData(current, chunk) {
            if (!finished) handler.onResponseData?.(current, chunk)
          },
          onResponseEnd(current, trailers) {
            if (finished) return
            finish()
            handler.onResponseEnd?.(current, trailers)
          },
          onResponseError(current, error) {
            if (finished) return
            finish()
            handler.onResponseError?.(current, error)
          },
          onRequestUpgrade(current, status, headers, socket) {
            if (finished) return
            finish()
            handler.onRequestUpgrade?.(current, status, headers, socket)
          },
        },
      )
    } catch (error) {
      finish()
      throw error
    }
  }
}

function applicationDispatcher(): Dispatcher {
  if (!proxy) return new Agent()
  const url = new URL(proxy)
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return new ProxyAgent(proxy)
  } else if (url.protocol === 'socks5:') {
    const port = Number(url.port)
    if (!url.hostname || !port || url.username || url.password) {
      throw new Error('Invalid application proxy')
    }
    return new Agent({
      connect(options, callback) {
        SocksClient.createConnection({
          proxy: { host: url.hostname, port, type: 5 },
          command: 'connect',
          destination: {
            host: options.hostname,
            // Undici leaves the port empty for a protocol's default port.
            port: Number(options.port) || (options.protocol === 'https:' ? 443 : 80),
          },
          timeout: 15_000,
        }).then(
          ({ socket }) => {
            if (options.protocol !== 'https:') {
              callback(null, socket as Socket)
              return
            }
            const secured = connectTls({
              socket,
              servername: options.servername ?? options.hostname,
            })
            secured.once('secureConnect', () => callback(null, secured))
            secured.once('error', (error) => callback(error, null))
          },
          (error: Error) => callback(error, null),
        )
      },
    })
  } else {
    throw new Error('Unsupported application proxy')
  }
}

setGlobalDispatcher(applicationDispatcher().compose(requestTimeoutPolicy()))
