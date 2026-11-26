import type { Connection } from 'tcp-hono'
import { describe, expect, it } from 'vite-plus/test'
import { parse } from './protocol.ts'
import type { ServerOptions } from './server.ts'
import { Client, Server, fail, msg } from './state.ts'
import { connect, setup as serverSetup, transcript } from './test-utils.ts'

// The IRCv3 extensions around message tags: message-tags, message-ids, batch, labeled-response,
// standard-replies, draft/multiline, and UTF8ONLY.

// The flood control is off, as in `setup()` of the test utilities.
const setup = (config?: ServerOptions) => serverSetup({ name: 'irc.example', ...config })

type TestClient = ReturnType<typeof connect>

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const encoder = new TextEncoder()

/** Send the lines, and return the replies with their tags and sources. */
const exchange = transcript

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

const MULTILINE = ['batch', 'draft/multiline', 'echo-message', 'labeled-response', 'message-tags']

describe('Registries of the IRCv3 extensions', () => {
  it('Should advertise the capabilities and the ISUPPORT tokens', async () => {
    const { register, handler } = setup({ multiline: { maxBytes: 10, maxLines: 3 } })
    const client = connect(handler)
    await client.send('CAP LS 302')
    const ls = await client.waitFor(/ CAP /)
    for (const cap of ['message-tags', 'batch', 'labeled-response', 'standard-replies']) {
      expect(ls).toMatch(new RegExp(`[ :]${cap}( |$)`))
    }
    expect(ls).toContain(' draft/multiline=max-bytes=10,max-lines=3')
    const alice = await register('alice')
    const tokens = alice.lines.filter((line) => / 005 /.test(line)).join(' ')
    expect(tokens).toContain(' CLIENTTAGDENY= ')
    expect(tokens).toContain(' UTF8ONLY ')
  })

  it('Should not enforce the order of the capabilities that depend on batch', async () => {
    const { register } = setup()
    const alice = await register('alice')
    expect(await exchange(alice, 'CAP REQ :labeled-response draft/multiline')).toEqual([
      ':irc.example CAP alice ACK :labeled-response draft/multiline',
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

describe('draft/multiline', () => {
  /** The lines of the example of the spec, to `target`. */
  const example = (target: string, ref = '123') => [
    `@+reply=abc BATCH +${ref} draft/multiline ${target}`,
    `@batch=${ref} PRIVMSG ${target} hello`,
    `@batch=${ref} PRIVMSG ${target} :`,
    `@batch=${ref} privmsg ${target} :how is `,
    `@batch=${ref};draft/multiline-concat PRIVMSG ${target} :everyone?`,
  ]

  it('Should deliver a batch to each client as it can take it', async () => {
    const { register } = setup()
    const alice = await register('alice', MULTILINE)
    const bob = await register('bob', ['batch', 'draft/multiline', 'message-tags'])
    const carol = await register('carol')
    const dave = await register('dave', ['message-tags', 'batch'])
    for (const client of [alice, bob, carol, dave]) {
      await join(client, '#a')
    }
    expect(await exchange(alice, ...example('#a'))).toEqual([])
    const echo = await exchange(alice, '@label=m BATCH -123')
    expect(echo.map(norm)).toEqual([
      '@msgid=ID;label=m;+reply=abc :alice BATCH +1 draft/multiline #a',
      '@batch=1 :alice PRIVMSG #a hello',
      '@batch=1 :alice PRIVMSG #a :',
      '@batch=1 :alice PRIVMSG #a :how is ',
      '@batch=1;draft/multiline-concat :alice PRIVMSG #a everyone?',
      ':alice BATCH -1',
    ])
    await bob.waitFor(/ BATCH -/)
    await carol.waitFor(/everyone/)
    await dave.waitFor(/everyone/)
    const relayed = (client: TestClient) =>
      client.lines.filter((line) => / (BATCH|PRIVMSG) /.test(line)).map(norm)
    expect(relayed(bob)).toEqual([
      '@msgid=ID;+reply=abc :alice BATCH +1 draft/multiline #a',
      '@batch=1 :alice PRIVMSG #a hello',
      '@batch=1 :alice PRIVMSG #a :',
      '@batch=1 :alice PRIVMSG #a :how is ',
      '@batch=1;draft/multiline-concat :alice PRIVMSG #a everyone?',
      ':alice BATCH -1',
    ])
    // Without the capability: no blank line, the concatenated line on its own, and the tags of the
    // batch on the first line only.
    expect(relayed(carol)).toEqual([
      ':alice PRIVMSG #a hello',
      ':alice PRIVMSG #a :how is ',
      ':alice PRIVMSG #a everyone?',
    ])
    expect(relayed(dave)).toEqual([
      '@msgid=ID;+reply=abc :alice PRIVMSG #a hello',
      ':alice PRIVMSG #a :how is ',
      ':alice PRIVMSG #a everyone?',
    ])
    // The same ID on the echo, the batch of bob, and the first line of the fallback of dave.
    const ids = [
      echo[0],
      bob.lines.find((line) => line.includes('BATCH +'))!,
      dave.lines.find((line) => / PRIVMSG #a hello/.test(line))!,
    ].map((line) => tagsOf(line).msgid)
    expect(ids[0]).toBeTruthy()
    expect(new Set(ids).size).toBe(1)
  })

  it('Should ACK the lines of a batch, and accept NOTICE', async () => {
    const { register } = setup()
    const alice = await register('alice', MULTILINE)
    const bob = await register('bob')
    expect(
      await exchange(
        alice,
        '@label=1 BATCH +n draft/multiline bob',
        '@batch=n;label=2 NOTICE bob :one',
        'BATCH -n'
      )
    ).toEqual([
      '@label=1 :irc.example ACK',
      '@label=2 :irc.example ACK',
      expect.stringMatching(/BATCH \+1/),
      expect.stringMatching(/NOTICE bob one/),
      expect.stringMatching(/BATCH -1/),
    ])
    expect(norm(await bob.waitFor(/ NOTICE /))).toBe(':alice NOTICE bob one')
  })

  it('Should check the target once for the whole message', async () => {
    const { register } = setup()
    const alice = await register('alice', MULTILINE)
    const bob = await register('bob')
    await exchange(bob, 'JOIN #n', 'AWAY :lunch')
    const batch = (target: string, command = 'PRIVMSG') => [
      `BATCH +b draft/multiline ${target}`,
      `@batch=b ${command} ${target} :one`,
      `@batch=b ${command} ${target} :two`,
      `@batch=b ${command} ${target} :three`,
      'BATCH -b',
    ]
    const errors = (lines: string[]) => lines.filter((line) => / \d{3} /.test(line))
    expect(errors(await exchange(alice, ...batch('#n')))).toEqual([
      ':irc.example 404 alice #n :Cannot send to channel',
    ])
    expect(errors(await exchange(alice, ...batch('nobody')))).toEqual([
      ':irc.example 401 alice nobody :No such nick/channel',
    ])
    expect(errors(await exchange(alice, ...batch('bob')))).toEqual([
      ':irc.example 301 alice bob lunch',
    ])
    expect(errors(await exchange(alice, ...batch('bob', 'NOTICE')))).toEqual([])
    expect(errors(await exchange(alice, ...batch('a,b,c,d,e')))).toEqual([
      ':irc.example 401 alice a :No such nick/channel',
      ':irc.example 401 alice b :No such nick/channel',
      ':irc.example 401 alice c :No such nick/channel',
      ':irc.example 401 alice d :No such nick/channel',
      ':irc.example 407 alice e :Too many targets',
    ])
    expect(bob.lines.filter((line) => / PRIVMSG /.test(line))).toHaveLength(3)
  })

  it('Should reply FAIL to a batch that breaks a rule, and ignore the rest of it', async () => {
    const { register } = setup({ multiline: { maxBytes: 10, maxLines: 3 } })
    const alice = await register('alice', MULTILINE)
    const bob = await register('bob')
    const open = (ref: string) => `BATCH +${ref} draft/multiline bob`
    const cases: [string[], string][] = [
      [
        [open('a'), '@batch=a PRIVMSG carol :hi'],
        'MULTILINE_INVALID_TARGET bob carol :Invalid multiline target',
      ],
      [
        [open('a'), '@batch=a PRIVMSG bob :hello', '@batch=a PRIVMSG bob :world'],
        'MULTILINE_MAX_BYTES 10 :Multiline batch max-bytes exceeded',
      ],
      [
        [open('a'), ...['a', 'b', 'c', 'd'].map((text) => `@batch=a PRIVMSG bob ${text}`)],
        'MULTILINE_MAX_LINES 3 :Multiline batch max-lines exceeded',
      ],
      [
        [open('a'), '@batch=a PRIVMSG bob :a ', '@batch=a;draft/multiline-concat PRIVMSG bob :'],
        'MULTILINE_INVALID :Invalid multiline batch with concatenated blank line',
      ],
      [
        [open('a'), '@batch=a PRIVMSG bob :', '@batch=a PRIVMSG bob :', 'BATCH -a'],
        'MULTILINE_INVALID :Invalid multiline batch with blank lines only',
      ],
      [[open('a'), 'BATCH -a'], 'MULTILINE_INVALID :Invalid multiline batch'],
      [
        [open('a'), '@batch=a PRIVMSG bob :one', '@batch=a NOTICE bob :two'],
        'MULTILINE_INVALID :Invalid multiline batch with PRIVMSG and NOTICE',
      ],
      [[open('a'), '@batch=a JOIN #a'], 'MULTILINE_INVALID :Invalid multiline batch with JOIN'],
      [
        [open('a'), '@batch=a BATCH +b draft/multiline bob'],
        'MULTILINE_INVALID :Invalid multiline batch: a batch can not be nested',
      ],
      [['BATCH +a draft/multiline'], 'MULTILINE_INVALID :Invalid multiline batch: no target'],
      [[open('a_b')], 'INVALID_REFTAG a_b :Invalid reference tag'],
      [
        ['BATCH +a chathistory bob'],
        'UNKNOWN_TYPE a chathistory :Unknown or unnegotiated batch type',
      ],
    ]
    for (const [lines, reply] of cases) {
      // The lines that follow the failure, and the end of the batch, are ignored.
      const replies = await exchange(alice, ...lines, '@batch=a PRIVMSG bob :late', 'BATCH -a')
      expect(replies).toEqual([`:irc.example FAIL BATCH ${reply}`])
    }
    await exchange(alice, open('a'), '@batch=a PRIVMSG bob :ok')
    expect(await exchange(alice, open('b'))).toEqual([
      ':irc.example FAIL BATCH MULTILINE_INVALID :Invalid multiline batch: another batch is open',
    ])
    // The lines of a batch that is not open are ignored.
    expect(await exchange(alice, '@batch=b PRIVMSG bob :ignored', 'BATCH -b')).toEqual([])
    const done = await exchange(alice, 'BATCH -a')
    expect(done.map(norm)).toEqual([
      '@msgid=ID :alice BATCH +1 draft/multiline bob',
      '@batch=1 :alice PRIVMSG bob ok',
      ':alice BATCH -1',
    ])
    await exchange(bob, 'PING x')
    expect(bob.lines.filter((line) => / PRIVMSG /.test(line)).map(norm)).toEqual([
      ':alice PRIVMSG bob ok',
    ])
  })

  it('Should accept a batch of exactly max-bytes and max-lines', async () => {
    const { register } = setup({ multiline: { maxBytes: 10, maxLines: 3 } })
    const alice = await register('alice', MULTILINE)
    const bob = await register('bob', ['batch', 'draft/multiline'])
    // 4 + 1 + 1 + 4 bytes, as a concatenated line has no line feed.
    await exchange(
      alice,
      'BATCH +a draft/multiline bob',
      '@batch=a PRIVMSG bob :abcd',
      '@batch=a PRIVMSG bob :e',
      '@batch=a;draft/multiline-concat PRIVMSG bob :fghi',
      'BATCH -a'
    )
    expect(await bob.waitFor(/ BATCH -/)).toMatch(/BATCH -1$/)
  })

  it('Should reject a batch from a client that has not negotiated it', async () => {
    const { register } = setup()
    const alice = await register('alice', ['draft/multiline'])
    expect(await exchange(alice, 'BATCH +a draft/multiline bob')).toEqual([
      ':irc.example FAIL BATCH UNKNOWN_TYPE a draft/multiline :Unknown or unnegotiated batch type',
    ])
  })

  it('Should fail a batch that is left open, and drop it on a disconnection', async () => {
    const { server, register } = setup({ multiline: { timeout: 10 } })
    const alice = await register('alice', MULTILINE)
    const bob = await register('bob')
    await exchange(alice, 'BATCH +t draft/multiline bob', '@batch=t PRIVMSG bob :one')
    await sleep(20)
    server.tick()
    expect(await alice.waitFor(/ FAIL /)).toBe(
      ':irc.example FAIL BATCH TIMEOUT t :Multiline batch timed out'
    )
    expect(await exchange(alice, '@batch=t PRIVMSG bob :two', 'BATCH -t')).toEqual([])

    await exchange(alice, 'BATCH +u draft/multiline bob', '@batch=u PRIVMSG bob :three')
    const client = [...server.clients.values()].find(({ nick }) => nick === 'alice')!
    expect(client.inbound?.lines).toEqual([{ text: 'three', concat: false }])
    await alice.drop()
    await alice.closed
    expect(client.inbound).toBeUndefined()
    await exchange(bob, 'PING x')
    expect(bob.lines.filter((line) => / PRIVMSG /.test(line))).toEqual([])
  })

  it('Should fail a batch that has a line too long or not UTF-8', async () => {
    const { register } = setup()
    const alice = await register('alice', MULTILINE)
    await register('bob')
    expect(
      await exchange(
        alice,
        'BATCH +a draft/multiline bob',
        `@batch=a PRIVMSG bob :${'x'.repeat(600)}`,
        'BATCH -a'
      )
    ).toEqual([
      ':irc.example 417 alice :Input line was too long',
      ':irc.example FAIL BATCH MULTILINE_INVALID :Invalid multiline batch with a line too long',
    ])
    const mark = alice.lines.length
    await alice.send('BATCH +b draft/multiline bob')
    await alice.sendBytes(
      new Uint8Array([...encoder.encode('@batch=b PRIVMSG bob :caf'), 0xe9, 13, 10])
    )
    await exchange(alice, 'BATCH -b')
    expect(since(alice, mark).filter((line) => !/ PONG /.test(line))).toEqual([
      ':irc.example FAIL PRIVMSG INVALID_UTF8 :Message rejected, your IRC software MUST use UTF-8 encoding on this network',
      ':irc.example FAIL BATCH MULTILINE_INVALID :Invalid multiline batch with a line not UTF-8',
    ])
  })

  it('Should label the batch of the echo, in a labeled-response batch with other replies', async () => {
    const { register } = setup()
    const alice = await register('alice', MULTILINE)
    const bob = await register('bob')
    await exchange(bob, 'AWAY :lunch')
    await exchange(alice, 'BATCH +a draft/multiline bob', '@batch=a PRIVMSG bob :one')
    expect((await exchange(alice, '@label=x BATCH -a')).map(norm)).toEqual([
      '@label=x :irc.example BATCH +2 labeled-response',
      '@msgid=ID;batch=2 :alice BATCH +1 draft/multiline bob',
      '@batch=1 :alice PRIVMSG bob one',
      '@batch=2 :alice BATCH -1',
      '@batch=2 :irc.example 301 alice bob lunch',
      ':irc.example BATCH -2',
    ])
    // To oneself: the delivered batch first, then the labeled echo.
    await exchange(alice, 'BATCH +b draft/multiline alice', '@batch=b PRIVMSG alice :me')
    expect((await exchange(alice, '@label=y BATCH -b')).map(norm)).toEqual([
      '@msgid=ID :alice BATCH +3 draft/multiline alice',
      '@batch=3 :alice PRIVMSG alice me',
      ':alice BATCH -3',
      '@msgid=ID;label=y :alice BATCH +4 draft/multiline alice',
      '@batch=4 :alice PRIVMSG alice me',
      ':alice BATCH -4',
    ])
  })

  it('Should charge a batch as a whole by the flood control', async () => {
    const { register } = setup({ flood: { burst: 10, interval: 100 } })
    const alice = await register('alice', MULTILINE)
    const bob = await register('bob')
    const batch = (ref: string) => [
      `BATCH +${ref} draft/multiline bob`,
      ...Array.from({ length: 30 }, (_, i) => `@batch=${ref} PRIVMSG bob :${ref}${i}`),
      `BATCH -${ref}`,
    ]
    // 30 lines are 6 tokens, so the first batch is not delayed, and the second one is.
    let start = Date.now()
    await alice.send(...batch('a'))
    await bob.waitFor(/ a29$/)
    expect(Date.now() - start).toBeLessThan(250)
    start = Date.now()
    await alice.send(...batch('b'))
    await bob.waitFor(/ b29$/, 2000)
    expect(Date.now() - start).toBeGreaterThanOrEqual(250)
  })
})

describe('UTF8ONLY', () => {
  const line = (text: string, ...bytes: number[]) =>
    new Uint8Array([...encoder.encode(text), ...bytes, 13, 10])
  const REJECTED =
    'INVALID_UTF8 :Message rejected, your IRC software MUST use UTF-8 encoding on this network'

  it('Should reject a message that is not UTF-8, and keep the client', async () => {
    const { register } = setup()
    const alice = await register('alice', ['batch', 'labeled-response'])
    const bob = await register('bob')
    const mark = alice.lines.length
    await alice.sendBytes(line('PRIVMSG bob :caf', 0xe9))
    await alice.sendBytes(line('@label=u PRIVMSG bob :', 0xff))
    await alice.sendBytes(line('@+a=', 0xff, 0x20, 0x50, 0x49, 0x4e, 0x47, 0x20, 0x61))
    await alice.sendBytes(line('BOG', 0xc0, 0x55, 0x53))
    await exchange(alice, 'PRIVMSG bob :café')
    expect(since(alice, mark).filter((line) => !/ PONG /.test(line))).toEqual([
      `:irc.example FAIL PRIVMSG ${REJECTED}`,
      `@label=u :irc.example FAIL PRIVMSG ${REJECTED}`,
      `:irc.example FAIL PING ${REJECTED}`,
      `:irc.example FAIL * ${REJECTED}`,
    ])
    expect(await bob.waitFor(/ PRIVMSG /)).toMatch(/ PRIVMSG bob café$/)
    await exchange(bob, 'PING x')
    expect(bob.lines.filter((l) => / PRIVMSG /.test(l))).toHaveLength(1)
  })

  it('Should reject a realname that is not UTF-8 before the registration', async () => {
    const { handler } = setup()
    const client = connect(handler)
    await client.send('NICK alice')
    await client.sendBytes(line('USER alice 0 * :Al', 0xef))
    expect(await client.waitFor(/ FAIL /)).toBe(`:irc.example FAIL USER ${REJECTED}`)
    await client.send('USER alice 0 * :Alice')
    await client.waitFor(/ 001 /)
  })

  it('Should let a client quit without a reason that is not UTF-8', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    await join(alice, '#a')
    await join(bob, '#a')
    await alice.sendBytes(line('QUIT :bye ', 0xff))
    expect((await alice.all()).at(-1)).toMatch(/^ERROR :Closing Link: \S+ \(Quit:\)$/)
    expect(await bob.waitFor(/ QUIT /)).toMatch(/^:alice!\S+ QUIT Quit:$/)
  })
})
