import { DurableObject } from 'cloudflare:workers'
import { createServer } from './server.ts'
import type { ServerOptions } from './server.ts'
import { sqlStore } from './store.ts'
import { fromWebSocket, negotiate } from './websocket.ts'

type Env = {
  NETWORK: DurableObjectNamespace<Network>
}

// The Worker shows the name too, so it is set here rather than left to the default.
const options = { name: 'irc.hono.local', network: 'HonoIRC' } satisfies ServerOptions

// What the Worker connects to when TCP does not give the address of the client.
const UNKNOWN = 'irc:6667'

/**
 * The key of the cloaks, which is made once and kept in the storage of the object, so a client
 * keeps its cloak, and a ban on it holds, across restarts and deploys. The synchronous KV API of
 * a SQLite-backed object lets the constructor read it before the server is made.
 */
const cloakSecret = (storage: DurableObjectStorage): string => {
  const stored = storage.kv.get<string>('cloakSecret')
  if (stored) {
    return stored
  }
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  storage.kv.put('cloakSecret', secret)
  return secret
}

/**
 * The address of the client from `host:port`, as in `remoteAddress` of a socket: `192.0.2.1:4242`
 * or `[2001:db8::1]:4242`. Anything else, such as `irc:6667`, is unknown.
 */
const parseAddress = (address = ''): string | undefined => {
  const v6 = /^\[([\da-f:.]+)\]:\d{1,5}$/i.exec(address)?.[1]
  if (v6 && v6.split(':').length > 2) {
    return v6.toLowerCase()
  }
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(address)?.[1]
  if (v4 && v4.split('.').every((octet) => Number(octet) <= 255)) {
    return v4
  }
}

/**
 * The IRC server. All the connections are held by one Durable Object, so it can write
 * a message from a client to the sockets of the others.
 *
 * The users and the channels are in memory. A channel disappears when the last member leaves,
 * so they do not need to be stored while the object has a connection. The accounts are stored in
 * the SQLite database of the object, whose API is synchronous, as the handlers are.
 */
export class Network extends DurableObject<Env> {
  #server: ReturnType<typeof createServer>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#server = createServer({
      ...options,
      cloakSecret: cloakSecret(ctx.storage),
      database: sqlStore(ctx.storage),
    })
    setInterval(this.#server.tick, 30_000)
  }

  /**
   * A TCP client, piped from the Worker. The object does not see the client, so the Worker
   * connects to the address of the client, which arrives here as `localAddress`. Only the Worker
   * sets it, so the bytes from the client can not forge it.
   */
  async connect(socket: Socket): Promise<void> {
    const { localAddress } = await socket.opened
    return this.#server.connect(socket, { ip: parseAddress(localAddress), secure: false })
  }

  /**
   * A WebSocket client, forwarded by the Worker. It is accepted with `accept()`, not with the
   * hibernation API: the state of the server is only in memory, and a hibernated object would
   * lose it. The connection keeps the object in memory, as a TCP connection does.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Upgrade Required\n', { status: 426, headers: { Upgrade: 'websocket' } })
    }
    const protocol = negotiate(request.headers.get('Sec-WebSocket-Protocol'))
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()
    // On Cloudflare, `CF-Connecting-IP` and the scheme of the URL are what the client used, and
    // `X-Forwarded-Proto` adds nothing to the URL. Under `cf dev`, both come from the headers of
    // the request, so a local client can claim any address and `https`.
    void this.#server.connect(fromWebSocket(server, { protocol }), {
      ip: request.headers.get('CF-Connecting-IP') ?? undefined,
      secure: new URL(request.url).protocol === 'https:',
    })
    return new Response(null, {
      status: 101,
      webSocket: client,
      // Without a subprotocol that both support, the connection goes on without the header, as
      // the spec allows. The client then decides whether to keep it.
      headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : {},
    })
  }
}

const describe = (url: URL) =>
  [
    `${options.name} (${options.network}): an IRC server on Cloudflare Workers`,
    '',
    `WebSocket: ${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/`,
    '  The IRCv3 WebSocket transport, with the subprotocol text.ircv3.net or binary.ircv3.net',
    `TCP: ${url.hostname}, port 6667, without TLS`,
    '',
  ].join('\n')

export default {
  // The Worker only connects the client to the Durable Object, and tells it the client's address.
  async connect(socket: Socket, env: Env): Promise<void> {
    const { remoteAddress } = await socket.opened
    const network = env.NETWORK.getByName('default').connect(remoteAddress ?? UNKNOWN, {
      allowHalfOpen: true,
    })
    try {
      await network.opened
      await Promise.all([
        socket.readable.pipeTo(network.writable),
        network.readable.pipeTo(socket.writable),
      ])
    } finally {
      await Promise.allSettled([socket.close(), network.close()])
    }
  },

  /**
   * `/` upgrades to a WebSocket, or describes the server.
   *
   * Any `Origin` is allowed. Web clients such as gamja are served from their own origins, and the
   * check would protect only ambient credentials, which this server has none of: it reads no
   * cookies and no HTTP authentication, and the address of the client grants nothing. So a page
   * on another origin can do nothing that its own server could not do by connecting directly,
   * except connect from the addresses of its visitors, as with any public IRC server. If the
   * address ever grants something, e.g. an exemption from a limit, check `Origin` here.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/') {
      return new Response('Not Found\n', { status: 404 })
    }
    if (request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return env.NETWORK.getByName('default').fetch(request)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    return new Response(describe(url), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  },
}
