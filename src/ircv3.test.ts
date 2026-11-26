import type { Connection } from 'tcp-hono'
import { describe, expect, it } from 'vite-plus/test'
import { parse } from './protocol.ts'
import { createServer } from './server.ts'
import type { ServerOptions } from './server.ts'
import { Client, Server, fail, msg } from './state.ts'
import { connect } from './test-utils.ts'

// The IRCv3 extensions around message tags: message-tags, message-ids, batch, labeled-response,
// and standard-replies.

const setup = (config?: ServerOptions) => {
  const server = createServer({ name: 'irc.example', flood: false, ...config })
  const handler = server.connect
  /** Connect a client and complete the registration. */
  const register = async (nick: string, capabilities: string[] = []) => {
    const client = connect(handler)
    if (capabilities.length) {
      await client.send('CAP LS 302', `CAP REQ :${capabilities.join(' ')}`, 'CAP END')
    }
    await client.send(`NICK ${nick}`, `USER ${nick} 0 * :${nick} the user`)
    await client.waitFor(/ 376 /)
    return client
  }
  return { server, handler, register }
}

type TestClient = ReturnType<typeof connect>

let sentinel = 0

/**
 * Send the lines, and return what the client gets in reply, with the tags. A PING follows them,
 * and the lines up to its PONG are returned.
 */
const exchange = async (client: TestClient, ...lines: string[]) => {
  const token = `sentinel${++sentinel}`
  const start = client.lines.length
  await client.send(...lines, `PING ${token}`)
  await client.waitFor(new RegExp(` PONG \\S+ ${token}$`))
  return client.lines.slice(start).filter((line) => !line.endsWith(` PONG irc.example ${token}`))
}

/** The lines that the client has received since the mark, without its PINGs. */
const since = (client: TestClient, mark: number) => client.lines.slice(mark)

/** Hide what changes from run to run: the time, the message IDs, and the user@host of a mask. */
const norm = (line: string) =>
  line
    .replace(/time=[^; ]+/g, 'time=T')
    .replace(/msgid=[^; ]+/g, 'msgid=ID')
    .replace(/![^ !@]+@[^ ]+\.user/g, '')

const tagsOf = (line: string) => parse(line)?.tags ?? {}

/** Join a channel and wait for its names. */
const join = async (client: TestClient, channel: string) => {
  await exchange(client, `JOIN ${channel}`)
}

describe('Registries of the IRCv3 extensions', () => {
  it('Should advertise the capabilities and the ISUPPORT tokens', async () => {
    const { register, handler } = setup()
    const client = connect(handler)
    await client.send('CAP LS 302')
    const ls = await client.waitFor(/ CAP /)
    for (const cap of ['message-tags', 'batch', 'labeled-response', 'standard-replies']) {
      expect(ls).toMatch(new RegExp(`[ :]${cap}( |$)`))
    }
    const alice = await register('alice')
    const tokens = alice.lines.filter((line) => / 005 /.test(line)).join(' ')
    expect(tokens).toContain(' CLIENTTAGDENY= ')
  })

  it('Should not enforce the order of the capabilities that depend on batch', async () => {
    const { register } = setup()
    const alice = await register('alice')
    expect(await exchange(alice, 'CAP REQ :labeled-response')).toEqual([
      ':irc.example CAP alice ACK labeled-response',
    ])
    // Without batch, labeled-response is not used yet.
    expect(await exchange(alice, '@label=a PONG x')).toEqual([])
    await exchange(alice, 'CAP REQ batch')
    expect(await exchange(alice, '@label=b PONG x')).toEqual(['@label=b :irc.example ACK'])
  })
})

describe('message-tags', () => {
  it('Should relay the client-only tags and drop the tags of the server from a client', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob', ['message-tags', 'server-time'])
    const carol = await register('carol')
    const tags = [
      '+example=raw+:=,escaped\\:\\s\\\\',
      '+empty=',
      'time=2020-01-01T00:00:00.000Z',
      'msgid=forged',
      'account=evil',
      'label=x',
      'unknown-tag',
    ].join(';')
    await exchange(alice, `@${tags} PRIVMSG bob,carol :hi`, `@${tags} NOTICE bob :hey`)
    const privmsg = await bob.waitFor(/ PRIVMSG /)
    const notice = await bob.waitFor(/ NOTICE /)
    expect(norm(privmsg)).toBe(
      '@time=T;msgid=ID;+example=raw+:=,escaped\\:\\s\\\\;+empty :alice PRIVMSG bob hi'
    )
    expect(tagsOf(privmsg).time).not.toBe('2020-01-01T00:00:00.000Z')
    expect(tagsOf(privmsg).msgid).not.toBe('forged')
    expect(norm(notice)).toBe(
      '@time=T;msgid=ID;+example=raw+:=,escaped\\:\\s\\\\;+empty :alice NOTICE bob hey'
    )
    // A client without message-tags gets no tags at all.
    expect(norm(await carol.waitFor(/ PRIVMSG /))).toBe(':alice PRIVMSG carol hi')
  })

  it('Should relay the client-only tags whether the sender has message-tags or not', async () => {
    const { register } = setup()
    const senders = [await register('alice', ['message-tags']), await register('bob')]
    const receivers = [await register('carol', ['message-tags']), await register('dave')]
    for (const sender of senders) {
      await exchange(sender, '@+a=1 PRIVMSG carol,dave :x')
      expect(norm(await receivers[0].waitFor(/ PRIVMSG /))).toMatch(/^@msgid=ID;\+a=1 :\w+ PRIVMSG/)
      expect(norm(await receivers[1].waitFor(/ PRIVMSG /))).toMatch(/^:\w+ PRIVMSG dave x$/)
    }
  })

  it('Should deliver TAGMSG only to the clients that have message-tags', async () => {
    const { register } = setup()
    const alice = await register('alice', ['message-tags', 'echo-message'])
    const bob = await register('bob', ['message-tags'])
    const carol = await register('carol')
    for (const client of [alice, bob, carol]) {
      await join(client, '#a')
    }
    const mark = carol.lines.length
    const echoed = await exchange(alice, '@+typing=active TAGMSG #a')
    expect(echoed.map(norm)).toEqual(['@msgid=ID;+typing=active :alice TAGMSG #a'])
    const relayed = await bob.waitFor(/ TAGMSG /)
    expect(norm(relayed)).toBe('@msgid=ID;+typing=active :alice TAGMSG #a')
    // The same ID for every recipient and the echo.
    expect(tagsOf(relayed).msgid).toBe(tagsOf(echoed[0]).msgid)
    expect(await exchange(alice, '@+typing=active TAGMSG carol')).toEqual([
      expect.stringMatching(/ TAGMSG carol$/),
    ])
    await exchange(carol, 'PING x')
    expect(since(carol, mark).filter((line) => line.includes('TAGMSG'))).toEqual([])
  })

  it('Should answer TAGMSG like PRIVMSG, but without RPL_AWAY', async () => {
    const { register } = setup()
    const alice = await register('alice', ['message-tags'])
    const bob = await register('bob', ['message-tags'])
    await exchange(bob, 'AWAY :lunch', 'JOIN #b', 'MODE #b +m')
    expect(
      (await exchange(alice, 'TAGMSG', 'TAGMSG nobody', 'TAGMSG #b', 'TAGMSG bob')).map(norm)
    ).toEqual([
      ':irc.example 411 alice :No recipient given (TAGMSG)',
      ':irc.example 401 alice nobody :No such nick/channel',
      ':irc.example 404 alice #b :Cannot send to channel',
    ])
    expect(norm(await bob.waitFor(/ TAGMSG /))).toBe('@msgid=ID :alice TAGMSG bob')
  })

  it('Should accept 4094 bytes of client tag data and reject more', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob', ['message-tags', 'server-time'])
    const value = 'x'.repeat(4094 - '+a='.length)
    expect(await exchange(alice, `@+a=${value} PRIVMSG bob :hi`)).toEqual([])
    const relayed = await bob.waitFor(/ PRIVMSG /)
    expect(tagsOf(relayed)['+a']).toBe(value)
    // The server adds its own tags in front, within its own 4094 bytes.
    const tagPart = relayed.slice(0, relayed.indexOf(' '))
    expect(tagPart).toMatch(/^@time=[^;]+;msgid=[^;]+;\+a=x+$/)
    expect(Buffer.byteLength(tagPart) + 1).toBeLessThanOrEqual(8191)
    expect(await exchange(alice, `@+a=${value}x PRIVMSG bob :hi`)).toEqual([
      ':irc.example 417 alice :Input line was too long',
    ])
    // A raw CR in a value is escaped to two bytes, which would take the tags over the limit.
    const raw = 'x'.repeat(4000) + '\r'.repeat(80)
    expect(await exchange(alice, `@+a=${raw} PRIVMSG bob :hi`)).toEqual([
      ':irc.example 417 alice :Input line was too long',
    ])
  })

  it('Should drop NUL from a tag value, which can not be escaped', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob', ['message-tags'])
    await exchange(alice, '@+a=b\0c PRIVMSG bob :hi')
    expect(norm(await bob.waitFor(/ PRIVMSG /))).toBe('@msgid=ID;+a=bc :alice PRIVMSG bob hi')
  })

  it('Should put the tags of the server before the client-only ones, and drop too many', () => {
    const server = new Server()
    const out: string[] = []
    const connection = { send: (data: string) => out.push(data), close() {}, closed: false }
    const client = new Client(server, connection as unknown as Connection)
    for (const cap of ['message-tags', 'server-time']) {
      client.capabilities.add(cap)
    }
    const message = msg('a', 'PRIVMSG', 'b', 'c')
    expect(client.format({ ...message, tags: { '+c': 'x', msgid: 'm', time: 't' } })).toBe(
      '@msgid=m;time=t;+c=x :a PRIVMSG b c'
    )
    expect(
      client.format({
        ...message,
        tags: { time: 't', '+a': 'x'.repeat(4000), '+b': 'y'.repeat(100) },
      })
    ).toBe('@time=t :a PRIVMSG b c')
  })
})

describe('message-ids', () => {
  it('Should give one ID to each message, the same for every recipient', async () => {
    const { register } = setup()
    const alice = await register('alice', ['message-tags', 'echo-message'])
    const bob = await register('bob', ['message-tags'])
    const carol = await register('carol', ['message-tags'])
    const dave = await register('dave')
    for (const client of [alice, bob, carol, dave]) {
      await join(client, '#a')
    }
    const [echo] = await exchange(alice, 'PRIVMSG #a :one')
    const [bobs, carols] = await Promise.all([bob.waitFor(/ PRIVMSG /), carol.waitFor(/ PRIVMSG /)])
    expect(tagsOf(echo).msgid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(tagsOf(bobs).msgid).toBe(tagsOf(echo).msgid)
    expect(tagsOf(carols).msgid).toBe(tagsOf(echo).msgid)
    expect(await dave.waitFor(/ PRIVMSG /)).toMatch(/^:alice!\S+ PRIVMSG #a one$/)

    const [second] = await exchange(alice, 'PRIVMSG #a :two')
    expect(tagsOf(second).msgid).not.toBe(tagsOf(echo).msgid)
    // Each target gets a message of its own.
    const [toBob, toCarol] = await exchange(alice, 'PRIVMSG bob,carol :three')
    expect(tagsOf(toBob).msgid).not.toBe(tagsOf(toCarol).msgid)
  })

  it('Should make IDs that are unique and in the order of time', () => {
    const before = Date.now()
    const server = new Server()
    const ids = Array.from({ length: 2000 }, () => server.msgid())
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    const time = ids[0]
      .slice(0, 10)
      .split('')
      .reduce((n, c) => n * 32 + alphabet.indexOf(c), 0)
    expect(time).toBeGreaterThanOrEqual(before)
    expect(time).toBeLessThanOrEqual(Date.now())
    // Another server, as after a restart, makes other IDs in the same millisecond.
    expect(new Server().msgid().slice(10)).not.toBe(new Server().msgid().slice(10))
  })
})

describe('batch', () => {
  const client = (capabilities: string[]) => {
    const out: string[] = []
    const connection = {
      send: (data: string) => out.push(data.trimEnd()),
      close() {},
      closed: false,
    }
    const client = new Client(new Server(), connection as unknown as Connection)
    for (const cap of capabilities) {
      client.capabilities.add(cap)
    }
    const send = () =>
      client.sendBatch(
        { source: 'irc.example', type: 'example.com/type', params: ['p'], tags: { msgid: 'm' } },
        [msg('a', 'PRIVMSG', 'x', 'one'), msg('a', 'PRIVMSG', 'x', 'two')]
      )
    return { out, send }
  }

  it('Should send a batch with a reference tag that is unique for the connection', () => {
    const { out, send } = client(['batch', 'message-tags'])
    send()
    send()
    expect(out).toEqual([
      '@msgid=m :irc.example BATCH +1 example.com/type p',
      '@batch=1 :a PRIVMSG x one',
      '@batch=1 :a PRIVMSG x two',
      ':irc.example BATCH -1',
      '@msgid=m :irc.example BATCH +2 example.com/type p',
      '@batch=2 :a PRIVMSG x one',
      '@batch=2 :a PRIVMSG x two',
      ':irc.example BATCH -2',
    ])
  })

  it('Should send the messages alone to a client without batch', () => {
    const { out, send } = client(['message-tags'])
    send()
    expect(out).toEqual(['@msgid=m :a PRIVMSG x one', ':a PRIVMSG x two'])
  })
})

describe('labeled-response', () => {
  const LABELED = ['batch', 'labeled-response']

  it('Should put the label on a reply, or ACK a command without one', async () => {
    const { register } = setup()
    const alice = await register('alice', LABELED)
    expect(
      await exchange(alice, '@label=a1 PING x', '@label=a2 PONG x', '@label=a3 PRIVMSG nobody :hi')
    ).toEqual([
      '@label=a1 :irc.example PONG irc.example x',
      '@label=a2 :irc.example ACK',
      '@label=a3 :irc.example 401 alice nobody :No such nick/channel',
    ])
    expect(await exchange(alice, '@label=a4 BOGUS', '@label=a5 JOIN')).toEqual([
      '@label=a4 :irc.example 421 alice BOGUS :Unknown command',
      '@label=a5 :irc.example 461 alice JOIN :Not enough parameters',
    ])
  })

  it('Should put several replies in a labeled-response batch', async () => {
    const { register } = setup()
    const alice = await register('alice', LABELED)
    expect((await exchange(alice, '@label=j JOIN #a')).map(norm)).toEqual([
      '@label=j :irc.example BATCH +1 labeled-response',
      '@batch=1 :alice JOIN #a',
      '@batch=1 :irc.example 353 alice = #a @alice',
      '@batch=1 :irc.example 366 alice #a :End of /NAMES list',
      ':irc.example BATCH -1',
    ])
    const whois = await exchange(alice, '@label=w WHOIS alice')
    expect(whois[0]).toBe('@label=w :irc.example BATCH +2 labeled-response')
    expect(whois.slice(1, -1).every((line) => line.startsWith('@batch=2 :irc.example 3'))).toBe(
      true
    )
    expect(whois.at(-1)).toBe(':irc.example BATCH -2')
  })

  it('Should label ERR_INPUTTOOLONG when the tags of the line are whole', async () => {
    const { register } = setup()
    const alice = await register('alice', LABELED)
    expect(await exchange(alice, `@label=l PRIVMSG alice :${'x'.repeat(600)}`)).toEqual([
      '@label=l :irc.example 417 alice :Input line was too long',
    ])
    // Longer than the line can be, so it is reported before its end.
    expect(await exchange(alice, `@label=m PRIVMSG alice :${'x'.repeat(6000)}`)).toEqual([
      '@label=m :irc.example 417 alice :Input line was too long',
    ])
    // The tags themselves are too long, so the label is unknown.
    expect(await exchange(alice, `@label=n;+a=${'x'.repeat(4100)} PING x`)).toEqual([
      ':irc.example 417 alice :Input line was too long',
    ])
  })

  it('Should label ERR_NOTREGISTERED and the replies before the registration', async () => {
    const { handler } = setup()
    const client = connect(handler)
    await client.send('CAP LS 302')
    await client.waitFor(/ CAP /)
    expect(await exchange(client, '@label=c CAP REQ :batch labeled-response')).toEqual([
      ':irc.example CAP * ACK :batch labeled-response',
    ])
    expect(await exchange(client, '@label=j JOIN #a', '@label=n NICK alice')).toEqual([
      '@label=j :irc.example 451 * :You have not registered',
      '@label=n :irc.example ACK',
    ])
  })

  it('Should label the echo only, and not the copies of the others', async () => {
    const { register } = setup()
    const alice = await register('alice', [...LABELED, 'echo-message'])
    const bob = await register('bob')
    await join(alice, '#a')
    await join(bob, '#a')
    expect((await exchange(alice, '@label=e1 PRIVMSG #a :hi')).map(norm)).toEqual([
      '@label=e1 :alice PRIVMSG #a hi',
    ])
    expect(norm(await bob.waitFor(/ PRIVMSG /))).toBe(':alice PRIVMSG #a hi')
    // A message to oneself is delivered without the label, and its echo has it.
    expect((await exchange(alice, '@label=e2 PRIVMSG alice :me')).map(norm)).toEqual([
      ':alice PRIVMSG alice me',
      '@label=e2 :alice PRIVMSG alice me',
    ])
  })

  it('Should ACK a message to oneself without echo-message', async () => {
    const { register } = setup()
    const alice = await register('alice', LABELED)
    expect((await exchange(alice, '@label=s PRIVMSG alice :me')).map(norm)).toEqual([
      ':alice PRIVMSG alice me',
      '@label=s :irc.example ACK',
    ])
  })

  it('Should label the ERROR that QUIT writes itself', async () => {
    const { register } = setup()
    const alice = await register('alice', LABELED)
    await alice.send('@label=q QUIT :bye')
    expect((await alice.all()).at(-1)).toMatch(/^@label=q ERROR :Closing Link: \S+ \(Quit: bye\)$/)
  })

  it('Should not label without batch, or with a label longer than 64 bytes', async () => {
    const { register } = setup()
    const alice = await register('alice', ['labeled-response'])
    const bob = await register('bob', LABELED)
    expect(await exchange(alice, '@label=a PING x', '@label=b PONG x')).toEqual([
      ':irc.example PONG irc.example x',
    ])
    expect(await exchange(bob, `@label=${'x'.repeat(65)} PING x`)).toEqual([
      ':irc.example PONG irc.example x',
    ])
    expect(await exchange(bob, `@label=${'x'.repeat(64)} PING x`)).toEqual([
      `@label=${'x'.repeat(64)} :irc.example PONG irc.example x`,
    ])
  })

  it('Should not label what the others send during the wait of the flood control', async () => {
    const { register } = setup({ flood: { burst: 6, interval: 300 } })
    const alice = await register('alice', LABELED)
    const bob = await register('bob')
    const mark = alice.lines.length
    // The last PING waits for a token, and bob's message comes meanwhile.
    await alice.send('PING 1', 'PING 2', 'PING 3', 'PING 4', 'PING 5', 'PING 6', '@label=l PING 7')
    await alice.waitFor(/ PONG \S+ 6$/)
    await bob.send('PRIVMSG alice :meanwhile')
    await alice.waitFor(/ PONG \S+ 7$/, 2000)
    const lines = since(alice, mark).slice(-2).map(norm)
    expect(lines).toEqual([
      ':bob PRIVMSG alice meanwhile',
      '@label=l :irc.example PONG irc.example 7',
    ])
  })
})

describe('standard-replies', () => {
  it('Should build the replies', () => {
    expect(fail('BATCH', 'TIMEOUT', 'ref', 'Timed out')).toEqual([
      'FAIL',
      'BATCH',
      'TIMEOUT',
      'ref',
      'Timed out',
    ])
  })
})
