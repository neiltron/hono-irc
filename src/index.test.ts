import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { ConnectionInfo, ServerOptions } from './server.ts'

// The Worker runs on Node.js here: the runtime module and the server are replaced, so the tests
// see what the Worker and the object hand over to the server.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

const connections: ConnectionInfo[] = []
const servers: ServerOptions[] = []
vi.mock('./server.ts', () => ({
  createServer: (options: ServerOptions) => {
    servers.push(options)
    return {
      connect: async (_socket: unknown, info: ConnectionInfo) => {
        connections.push(info)
      },
      tick: () => {},
    }
  },
}))

const { Network, default: worker } = await import('./index.ts')

type Env = ConstructorParameters<typeof Network>[1]

/** The state of an object, with the synchronous KV API of the storage in a Map. */
const state = (kv = new Map<string, unknown>()) =>
  ({
    storage: { kv: { get: (key: string) => kv.get(key), put: kv.set.bind(kv) } },
  }) as unknown as DurableObjectState

/** A socket whose streams are already closed. */
const socket = (info: { remoteAddress?: string; localAddress?: string }) =>
  ({
    opened: Promise.resolve(info),
    readable: new ReadableStream({ start: (controller) => controller.close() }),
    writable: new WritableStream(),
    close: async () => {},
  }) as unknown as Socket

/** An environment whose object records what the Worker sends to it. */
const environment = () => {
  const addresses: string[] = []
  const requests: Request[] = []
  const stub = {
    connect: (address: string) => {
      addresses.push(address)
      return socket({ localAddress: address })
    },
    fetch: async (request: Request) => {
      requests.push(request)
      return new Response('forwarded')
    },
  }
  const env = { NETWORK: { getByName: () => stub } } as unknown as Env
  return { env, addresses, requests }
}

beforeEach(() => {
  vi.useFakeTimers()
  connections.length = 0
  servers.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('The address of a TCP client', () => {
  it('Should be passed from the Worker to the object', async () => {
    const { env, addresses } = environment()
    await worker.connect(socket({ remoteAddress: '[2001:db8::1]:50000' }), env)
    await worker.connect(socket({}), env)
    expect(addresses).toEqual(['[2001:db8::1]:50000', 'irc:6667'])
  })

  it.each([
    ['192.0.2.1:4242', '192.0.2.1'],
    ['[2001:DB8::1]:4242', '2001:db8::1'],
    ['[::1]:1', '::1'],
    ['[::ffff:192.0.2.1]:4242', '::ffff:192.0.2.1'],
    ['irc:6667', undefined],
    ['192.0.2.256:4242', undefined],
    ['192.0.2.1', undefined],
    ['[2001:db8::1]', undefined],
    ['[1]:4242', undefined],
    ['[2001:db8::1%eth0]:4242', undefined],
    ['192.0.2.1:4242\r\nNICK x', undefined],
    [undefined, undefined],
  ])('Should read %s as %s in the object', async (localAddress, ip) => {
    const network = new Network(state(), {} as Env)
    await network.connect(socket({ localAddress }))
    expect(connections).toEqual([{ ip, secure: false }])
  })
})

describe('The key of the cloaks', () => {
  it('Should be made once and kept in the storage of the object', () => {
    const kv = new Map<string, unknown>()
    new Network(state(kv), {} as Env)
    new Network(state(kv), {} as Env)
    new Network(state(), {} as Env)
    const [first, again, other] = servers.map((options) => options.cloakSecret)
    expect(first).toMatch(/^[\da-f]{64}$/)
    expect(again).toBe(first)
    expect(other).not.toBe(first)
    expect([...kv]).toEqual([['cloakSecret', first]])
    expect(servers[0].name).toBe('irc.hono.local')
  })
})

describe('The database', () => {
  it('Should be the SQLite database of the object', () => {
    const queries: unknown[][] = []
    const storage = {
      kv: { get: () => 'secret', put: () => {} },
      sql: {
        exec: (...args: unknown[]) => {
          queries.push(args)
          return { toArray: () => [{ ok: 1 }] }
        },
      },
      transactionSync: (fn: () => unknown) => fn(),
    }
    new Network({ storage } as unknown as DurableObjectState, {} as Env)
    const database = servers[0].database
    expect(database).toBeTruthy()
    expect(database && database.transaction(() => database.query('SELECT ?', 1))).toEqual([
      { ok: 1 },
    ])
    expect(queries).toEqual([['SELECT ?', 1]])
  })
})

describe('The HTTP requests to the Worker', () => {
  it('Should forward a WebSocket upgrade to the object', async () => {
    const { env, requests } = environment()
    const request = new Request('https://irc.example/', { headers: { Upgrade: 'websocket' } })
    expect(await (await worker.fetch(request, env)).text()).toBe('forwarded')
    expect(requests).toEqual([request])
  })

  it('Should describe the server', async () => {
    const { env, requests } = environment()
    const res = await worker.fetch(new Request('https://irc.example/'), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    const text = await res.text()
    expect(text).toContain('irc.hono.local')
    expect(text).toContain('wss://irc.example/')
    expect(text).toContain('text.ircv3.net')
    expect(await (await worker.fetch(new Request('http://localhost:5173/'), env)).text()).toContain(
      'ws://localhost:5173/'
    )
    expect(requests).toEqual([])
  })

  it('Should reject the other requests', async () => {
    const { env, requests } = environment()
    expect((await worker.fetch(new Request('https://irc.example/irc'), env)).status).toBe(404)
    const post = await worker.fetch(new Request('https://irc.example/', { method: 'POST' }), env)
    expect(post.status).toBe(405)
    expect(post.headers.get('Allow')).toBe('GET, HEAD')
    expect(requests).toEqual([])
  })

  it('Should accept only a WebSocket upgrade in the object', async () => {
    const network = new Network(state(), {} as Env)
    const res = await network.fetch(new Request('https://irc.example/'))
    expect(res.status).toBe(426)
    expect(res.headers.get('Upgrade')).toBe('websocket')
  })
})
