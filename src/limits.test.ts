import { describe, expect, it, vi } from 'vite-plus/test'
import { Accounts } from './accounts.ts'
import { parse } from './protocol.ts'
import { createServer } from './server.ts'
import type { ServerOptions } from './server.ts'
import { memoryStore } from './store.ts'
import type { Store } from './store.ts'
import { connect, setup as serverSetup, strip, transcript } from './test-utils.ts'

// The limits against the abuse of resources: the bytes of the history, the length of a response,
// the connections of an address, the cost of a multiline batch, the targets of JOIN, and the
// failures of the database.

type TestClient = ReturnType<typeof connect>

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const setup = (config: ServerOptions = {}) => {
  const store = (config.database || memoryStore()) as Store
  const env = serverSetup({
    name: 'irc.example',
    ...config,
    database: store,
    accounts: { iterations: 10, ...config.accounts },
  })
  return { ...env, store }
}

const exchange = async (client: TestClient, ...lines: string[]) =>
  (await transcript(client, ...lines)).map(strip)

describe('The bytes of the history', () => {
  it('Should relay the client-only tags whole, and store a bounded copy', async () => {
    const { register, store } = setup()
    const alice = await register('alice', ['message-tags'])
    const bob = await register('bob', ['message-tags'])
    const channels = '#a,#b,#c,#d'
    await transcript(alice, `JOIN ${channels}`)
    await transcript(bob, `JOIN ${channels}`)
    // The worst case for the old JSON: control characters, which took 6 bytes each.
    const value = '\x01'.repeat(4090)
    for (let i = 0; i < 10; i++) {
      await bob.send(`@+t=${value} PRIVMSG ${channels} :${'\x01'.repeat(400)}`)
    }
    await transcript(bob, 'PING x')
    const relayed = alice.lines.filter((line) => / PRIVMSG /.test(line))
    expect(relayed).toHaveLength(40)
    expect(parse(relayed[0])!.tags!['+t']).toBe(value)
    const rows = store.query<{ tags: string | null; size: number }>(
      'SELECT tags, size FROM history'
    )
    expect(rows).toHaveLength(40)
    // About 600 bytes a message, where it was about 25 KB.
    for (const { tags, size } of rows) {
      expect(tags).toBe(null)
      expect(size).toBeLessThan(700)
    }
  })
})

describe('The length of a response', () => {
  const channels = async (config: ServerOptions, count: number) => {
    const env = setup(config)
    const op = await env.register('op')
    for (let i = 0; i < count; i += 10) {
      const names = Array.from({ length: Math.min(10, count - i) }, (_, k) => `#c${i + k}`)
      await transcript(op, `JOIN ${names.join(',')}`)
    }
    return env
  }

  it('Should cut LIST, and tell the client', async () => {
    const { register, store } = await channels({ maxListEntries: 5 }, 8)
    const plain = await register('plain')
    const lines = await exchange(plain, 'LIST')
    expect(lines.filter((line) => line.startsWith('322 '))).toHaveLength(5)
    expect(lines.slice(-2)).toEqual([
      'NOTICE plain :The list is cut to 5 channels',
      '323 plain :End of /LIST',
    ])
    const modern = await register('modern', ['standard-replies'])
    expect((await exchange(modern, 'LIST')).at(-2)).toBe(
      'WARN LIST TRUNCATED :The list is cut to 5 channels'
    )
    // A full list is not cut, with the permanent channels that are empty after those in use.
    store.query(
      `INSERT INTO channels (folded, name, created, founder, modes, lists, used)
       VALUES ('#stored', '#Stored', 0, 'x', 'Pnt', '[]', 0)`
    )
    const wide = setup({ maxListEntries: 2, database: store })
    const guest = await wide.register('guest')
    await transcript(guest, 'JOIN #live')
    expect(await exchange(guest, 'LIST')).toEqual([
      '321 guest Channel :Users  Name',
      '322 guest #live 1 :',
      '322 guest #Stored 0 :',
      '323 guest :End of /LIST',
    ])
  })

  it('Should read a bounded number of stored channels for LIST', async () => {
    const { register, store, state } = setup({ maxListEntries: 20 })
    const guest = await register('guest')
    store.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        store.query(
          `INSERT INTO channels (folded, name, created, founder, modes, lists, used)
           VALUES (?, ?, 0, 'x', 'Pnt', '[]', 0)`,
          `#s${i}`,
          `#s${i}`
        )
      }
    })
    const listed = vi.spyOn(state()!.channelStore!, 'listed')
    const lines = await exchange(guest, 'LIST')
    expect(lines.filter((line) => line.startsWith('322 '))).toHaveLength(20)
    expect(listed.mock.results[0].value).toHaveLength(21)
  })

  it('Should not send a response over maxReplyBytes, and disconnect the client', async () => {
    const { register } = await channels({ maxReplyBytes: 1500 }, 50)
    const guest = await register('guest')
    // Short enough.
    expect((await exchange(guest, 'MOTD')).at(-1)).toMatch(/^376 /)
    await guest.send('LIST')
    expect((await guest.all()).at(-1)).toMatch(/^ERROR :Closing Link: \S+ \(Reply too long\)$/)
  })

  it('Should give its bound of the send buffer to tcp-hono', () => {
    expect(createServer({ database: false }).options.maxBufferedBytes).toBe(1024 * 1024)
    expect(createServer({ database: false, maxBufferedBytes: 4096 }).options.maxBufferedBytes).toBe(
      4096
    )
  })
})

describe('The connections of an address', () => {
  const from = (server: ReturnType<typeof setup>['server'], ip: string) =>
    connect((socket) => server.connect(socket, { ip }))
  const refused = async (client: TestClient) => (await client.all())[0]

  it('Should count the connections of an IPv6 /64 together, and those of a /48', async () => {
    const { server } = setup({ maxConnectionsPerIp: 3, maxConnectionsPerNetwork: 5 })
    for (let i = 1; i <= 3; i++) {
      from(server, `2001:db8:0:1::${i}`)
    }
    expect(await refused(from(server, '2001:db8:0:1::99'))).toBe(
      'ERROR :Closing Link: * (Too many connections from your address)'
    )
    from(server, '2001:db8:0:2::1')
    from(server, '2001:db8:0:3::1')
    expect(await refused(from(server, '2001:db8:0:4::1'))).toBe(
      'ERROR :Closing Link: * (Too many connections from your network)'
    )
    // Another /48.
    const other = from(server, '2001:db8:1::1')
    await other.send('NICK other', 'USER o 0 * :O')
    await other.waitFor(/ 001 other /)
    expect(server.clients.size).toBe(6)
  })

  it('Should limit the rate of new connections from an address', async () => {
    const { server, state } = setup({ connectionRate: { burst: 3, interval: 60_000 } })
    for (let i = 0; i < 3; i++) {
      const client = from(server, '192.0.2.7')
      await client.send('QUIT')
      await client.all()
    }
    expect(await refused(from(server, '192.0.2.7'))).toBe(
      'ERROR :Closing Link: * (Too many connections from your address, try again later)'
    )
    // Another address is not affected, and the refused ones are not counted.
    const other = from(server, '192.0.2.8')
    await other.send('NICK other', 'USER o 0 * :O')
    await other.waitFor(/ 001 other /)
    expect([...state()!.addresses.values()]).toEqual([1])
  })

  it('Should bound the derivations of keys on the whole server', () => {
    const accounts = new Accounts(memoryStore()!, (name) => name, {
      throttle: { burst: 10, interval: 60_000 },
      derivations: { concurrent: 2, burst: 3, interval: 60_000 },
    })
    const first = accounts.admit('a')!
    const second = accounts.admit('b')!
    // Two at a time, whatever the address, and the address is not charged for it.
    expect(accounts.admit('c')).toBe(undefined)
    first()
    first()
    expect(accounts.admit('c')).toBeTypeOf('function')
    second()
    // Three in all, then none.
    expect(accounts.admit('d')).toBe(undefined)
    // An address that is over its own limit does not use the tokens of the server.
    const lone = new Accounts(memoryStore()!, (name) => name, {
      throttle: { burst: 1, interval: 60_000 },
      derivations: { burst: 2, interval: 60_000 },
    })
    lone.admit('a')!()
    expect(lone.admit('a')).toBe(undefined)
    expect(lone.admit('a')).toBe(undefined)
    expect(lone.admit('b')).toBeTypeOf('function')
  })
})

describe('The cost of a multiline batch', () => {
  const CAPS = ['batch', 'draft/multiline', 'message-tags']
  const tags = Array.from({ length: 600 }, (_, i) => `+k${i}=v`)
    .join(';')
    .slice(0, 4000)

  it('Should charge a batch that fails what its lines cost', async () => {
    const { register } = setup({ flood: { burst: 10, interval: 20 } })
    const alice = await register('alice', CAPS)
    await sleep(250)
    // 101 lines of 4 KB fail the batch: they cost about 800 tokens, 16 seconds at this rate.
    const lines = ['BATCH +r draft/multiline alice']
    for (let i = 0; i < 101; i++) {
      lines.push(`@batch=r;${tags} PRIVMSG alice :`)
    }
    const start = Date.now()
    await alice.send(...lines, 'PING after')
    await alice.waitFor(/ FAIL BATCH MULTILINE_MAX_LINES /)
    await sleep(500)
    expect(alice.lines.some((line) => / PONG \S+ after$/.test(line))).toBe(false)
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('Should charge a batch that times out', async () => {
    const env = setup({ flood: { burst: 10, interval: 20 }, multiline: { timeout: 50 } })
    const alice = await env.register('alice', CAPS)
    await sleep(250)
    const lines = ['BATCH +r draft/multiline alice']
    for (let i = 0; i < 50; i++) {
      lines.push(`@batch=r;${tags} PRIVMSG alice :`)
    }
    await transcript(alice, ...lines)
    await sleep(100)
    env.server.tick()
    await alice.waitFor(/ FAIL BATCH TIMEOUT r /)
    // About 400 tokens are owed.
    const start = Date.now()
    await alice.send('PING after')
    await sleep(500)
    expect(alice.lines.some((line) => / PONG \S+ after$/.test(line))).toBe(false)
    expect(Date.now() - start).toBeLessThan(5000)
  })
})

describe('The targets of JOIN', () => {
  it('Should join a channel once, and at most TARGMAX channels', async () => {
    const { register, user, state } = setup()
    const founder = await user('founder')
    await transcript(founder, 'JOIN #p', 'MODE #p +k key', 'PART #p')
    const guest = await register('guest')
    const restore = vi.spyOn(state()!, 'restore')
    const lines = await exchange(guest, `JOIN ${Array(100).fill('#p').join(',')}`)
    expect(lines).toEqual(['475 guest #p :Cannot join channel (+k)'])
    expect(restore).toHaveBeenCalledTimes(1)
    const names = Array.from({ length: 12 }, (_, i) => `#j${i}`)
    const joined = await exchange(guest, `JOIN ${names.join(',')},#J0,#j1`)
    expect(joined.filter((line) => line.startsWith('JOIN '))).toHaveLength(10)
    expect(joined.at(-1)).toBe('407 guest #j10 :Too many targets')
  })

  it('Should give the first key to the first channel, whatever is repeated', async () => {
    const { register } = setup()
    const op = await register('op')
    await transcript(op, 'JOIN #a,#b', 'MODE #a +k ka', 'MODE #b +k kb')
    const guest = await register('guest')
    const lines = await exchange(guest, 'JOIN #a,#a,#b ka,x,kb')
    expect(lines.filter((line) => line.startsWith('JOIN '))).toEqual(['JOIN #a', 'JOIN #b'])
  })
})

describe('A database that fails', () => {
  /** A store whose writes throw while `broken` is set. */
  const failing = () => {
    const store = memoryStore()!
    const state = { broken: false }
    const wrapped: Store = {
      query: (sql, ...params) => {
        if (state.broken && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
          throw new Error('SQLITE_FULL')
        }
        return store.query(sql, ...params)
      },
      transaction: (fn) => store.transaction(fn),
    }
    return { store: wrapped, state }
  }

  it('Should keep serving from memory, and log once', async () => {
    const { store, state } = failing()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { user } = setup({ database: store })
    const caps = ['draft/read-marker', 'echo-message']
    const alice = await user('alice', caps)
    const bob = await user('bob', caps)
    await transcript(alice, 'JOIN #a')
    await transcript(bob, 'JOIN #a')
    state.broken = true
    try {
      // The messages are delivered, the changes are made and told, and a JOIN completes, with
      // the read marker that it could not read either.
      expect(await exchange(alice, 'PRIVMSG #a :one', 'PRIVMSG bob :two')).toEqual([
        'PRIVMSG #a one',
        'PRIVMSG bob two',
      ])
      expect(await exchange(alice, 'TOPIC #a :new', 'MODE #a +b x!*@*')).toEqual([
        'TOPIC #a new',
        'MODE #a +b x!*@*',
      ])
      expect(await bob.waitFor(/ MODE #a /)).toMatch(/ MODE #a \+b /)
      expect(await exchange(bob, 'PART #a', 'JOIN #a')).toEqual([
        'PART #a',
        'JOIN #a',
        '332 bob #a new',
        expect.stringMatching(/^333 bob #a /),
        'MARKREAD #a *',
        '353 bob = #a :@alice bob',
        '366 bob #a :End of /NAMES list',
      ])
      // A new channel of an account is ordinary, as it can not be stored.
      expect(await exchange(alice, 'JOIN #new', 'MODE #new')).toContain('324 alice #new +nt')
      // Making it permanent fails, and changes nothing.
      expect(await exchange(alice, 'MODE #new +P', 'MODE #new')).toEqual([
        '400 alice MODE :The channel could not be stored, try again later',
        '324 alice #new +nt',
        expect.stringMatching(/^329 /),
      ])
      expect((await exchange(alice, 'MARKREAD #a timestamp=2026-01-01T00:00:00.000Z'))[0]).toMatch(
        / INTERNAL_ERROR /
      )
    } finally {
      state.broken = false
    }
    expect(errors).toHaveBeenCalledTimes(1)
    // It works again.
    await exchange(alice, 'PRIVMSG #a :three')
    expect(await exchange(bob, 'CHATHISTORY LATEST #a * 10')).toEqual(['PRIVMSG #a three'])
    errors.mockRestore()
  })

  it('Should complete a JOIN whose hook throws', async () => {
    const { register, state } = setup()
    const alice = await register('alice')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    state()!.onJoin.push(() => {
      throw new Error('hook')
    })
    expect(await exchange(alice, 'JOIN #a')).toEqual([
      'JOIN #a',
      '353 alice = #a @alice',
      '366 alice #a :End of /NAMES list',
    ])
    errors.mockRestore()
  })

  it('Should not keep the target of a first message that could not be stored', async () => {
    const { store, state } = failing()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = setup({ database: store })
    const alice = await env.register('alice')
    await transcript(alice, 'JOIN #b')
    state.broken = true
    await transcript(alice, 'PRIVMSG #b :lost')
    const channel = env.state()!.channels.get('#b')!
    expect(channel.history).toBe(undefined)
    state.broken = false
    await transcript(alice, 'PRIVMSG #b :kept')
    expect(store.query('SELECT text FROM history WHERE target = ?', channel.history!)).toEqual([
      { text: 'kept' },
    ])
    errors.mockRestore()
  })
})
