import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici'
import { SocksClient } from 'socks'
import { connect as connectTls } from 'node:tls'
import type { Socket } from 'node:net'

const proxy = process.env.NEXUS_NETWORK_PROXY

if (proxy) {
  const url = new URL(proxy)
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    setGlobalDispatcher(new ProxyAgent(proxy))
  } else if (url.protocol === 'socks5:') {
    const port = Number(url.port)
    if (!url.hostname || !port || url.username || url.password) {
      throw new Error('Invalid application proxy')
    }
    setGlobalDispatcher(
      new Agent({
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
      }),
    )
  } else {
    throw new Error('Unsupported application proxy')
  }
}
