import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { History, encodeTime } from './history.ts'
import { parse } from './protocol.ts'
import type { ServerOptions } from './server.ts'
import type { Chat } from './state.ts'
import { memoryStore } from './store.ts'
import type { Store } from './store.ts'
import { connect, isupport, setup as serverSetup, transcript } from './test-utils.ts'

// draft/chathistory: the stored messages, the CHATHISTORY command, and their rules. draft/read-marker
// and replayOnJoin are at the end.

type TestClient = ReturnType<typeof connect>

const FULL = ['batch', 'server-time', 'message-tags', 'draft/chathistory', 'echo-message']

/** A server with a database that the test can read, and clients logged in to accounts. */
const setup = (config: ServerOptions = {}) => {
  const store = (config.database || memoryStore()) as Store
  const env = serverSetup({
    name: 'irc.example',
    ...config,
    database: store,
    accounts: { iterations: 10, ...config.accounts },
  })
  const user = (nick: string, capabilities: string[] = FULL, account: string | null = nick) =>
    env.user(nick, capabilities, account)
  return { ...env, store, user }
}

/** The lines without the time and the batch references, which change. */
const norm = (line: string) =>
  line
    .replace(/@[0-9a-f]{8}\.user/g, '@host')
    .replace(/(BATCH [+-])\w+/, '$1B')
    .replace(/batch=\w+/, 'batch=B')

/** Send the lines, and return the replies with their tags, normalized. */
const exchange = async (client: TestClient, ...lines: string[]) =>
  (await transcript(client, ...lines)).map(norm)

const tags = (line: string) => parse(line)?.tags ?? {}

/** Send messages to a target and return their msgids and times, from the echoes. */
const say = async (client: TestClient, target: string, ...texts: string[]) => {
  const sent: { msgid: string; time: string; text: string }[] = []
  for (const text of texts) {
    const lines = await transcript(client, `PRIVMSG ${target} :${text}`)
    const echo = lines.find((line) => / PRIVMSG /.test(line))!
    sent.push({ msgid: tags(echo).msgid, time: tags(echo).time, text })
  }
  return sent
}

/** The texts of the PRIVMSGs and NOTICEs among the lines. */
const texts = (lines: string[]) =>
  lines.filter((line) => / (PRIVMSG|NOTICE) /.test(line)).map((line) => parse(line)!.params[1])

/** A channel `#a` with alice and bob in it, and ten messages from alice. */
const channel = async (config: ServerOptions = {}) => {
  const env = setup(config)
  const alice = await env.user('alice')
  const bob = await env.user('bob')
  await transcript(alice, 'JOIN #a')
  await transcript(bob, 'JOIN #a')
  const sent = await say(alice, '#a', ...Array.from({ length: 10 }, (_, i) => `m${i}`))
  return { ...env, alice, bob, sent }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Advertising', () => {
  it('Should advertise draft/chathistory, draft/read-marker, CHATHISTORY, and MSGREFTYPES', async () => {
    const { user } = setup({ history: { limit: 50 } })
    const alice = await user('alice')
    const ls = alice.lines.filter((line) => / CAP \* LS /.test(line)).join(' ')
    expect(ls).toMatch(/ draft\/chathistory( |$)/)
    expect(ls).toMatch(/ draft\/read-marker( |$)/)
    expect(ls).not.toMatch(/event-playback/)
    expect(isupport(alice.lines)).toEqual(
      expect.arrayContaining(['CHATHISTORY=50', 'MSGREFTYPES=msgid,timestamp'])
    )
  })

  it('Should have none of it without a database', async () => {
    const { register, handler } = serverSetup({ database: false })
    const raw = connect(handler)
    await raw.send('CAP LS 302')
    const ls = await raw.waitFor(/ CAP \* LS (?!\* )/)
    expect(ls).not.toMatch(/chathistory|read-marker/)
    const alice = await register('alice', ['batch', 'message-tags'])
    const tokens = isupport(alice.lines)
    expect(tokens).toContain('CHANMODES=beI,k,l,imnst')
    expect(tokens.some((token) => /^(CHATHISTORY|MSGREFTYPES)/.test(token))).toBe(false)
    expect(alice.lines.find((line) => / 004 /.test(line))).toMatch(/ Ibeiklmnostv Ibeklov$/)
    const lines = (
      await transcript(
        alice,
        'JOIN #a',
        'MODE #a +P',
        'PRIVMSG #a :hello',
        'CHATHISTORY LATEST #a * 10',
        'MARKREAD #a',
        'PART #a',
        'LIST'
      )
    ).map((line) => line.replace(/^\S+ /, ''))
    expect(lines).toEqual(
      expect.arrayContaining([
        '472 alice P :is unknown mode char to me',
        '421 alice CHATHISTORY :Unknown command',
        '421 alice MARKREAD :Unknown command',
      ])
    )
    expect(lines.filter((line) => / 322 /.test(line))).toEqual([])
  })
})

describe('CHATHISTORY of a channel', () => {
  it('Should play back the latest messages with their time and msgid, in a batch', async () => {
    const { bob, sent } = await channel()
    const lines = await exchange(bob, 'CHATHISTORY LATEST #a * 3')
    expect(lines).toEqual([
      expect.stringMatching(/^@time=\S+ :irc\.example BATCH \+B chathistory #a$/),
      ...sent
        .slice(-3)
        .map(
          ({ msgid, time, text }) =>
            `@batch=B;time=${time};msgid=${msgid} :alice!~alice@host PRIVMSG #a ${text}`
        ),
      expect.stringMatching(/^@time=\S+ :irc\.example BATCH -B$/),
    ])
    // All of them: the end of the history is marked.
    const all = await exchange(bob, 'CHATHISTORY LATEST #a * 100')
    expect(all[0]).toMatch(
      /^@time=\S+;draft\/chathistory-end :irc\.example BATCH \+B chathistory #a$/
    )
    expect(texts(all)).toEqual(sent.map(({ text }) => text))
  })

  it('Should take msgid and timestamp references, with exclusive bounds', async () => {
    const { bob, sent } = await channel()
    const m = sent.map(({ msgid }) => `msgid=${msgid}`)
    const t = sent.map(({ time }) => `timestamp=${time}`)
    const get = async (line: string) => texts(await exchange(bob, line))
    const range = (from: number, to: number) => sent.slice(from, to).map(({ text }) => text)

    expect(await get(`CHATHISTORY BEFORE #a ${m[5]} 3`)).toEqual(range(2, 5))
    expect(await get(`CHATHISTORY BEFORE #a ${m[1]} 3`)).toEqual(range(0, 1))
    expect(await get(`CHATHISTORY AFTER #a ${m[5]} 3`)).toEqual(range(6, 9))
    expect(await get(`CHATHISTORY AFTER #a ${m[8]} 3`)).toEqual(range(9, 10))
    expect(await get(`CHATHISTORY LATEST #a ${m[6]} 10`)).toEqual(range(7, 10))
    expect(await get(`CHATHISTORY LATEST #a ${m[2]} 3`)).toEqual(range(7, 10))
    // Around: half before, and the message itself and the rest after.
    expect(await get(`CHATHISTORY AROUND #a ${m[5]} 4`)).toEqual(range(3, 7))
    expect(await get(`CHATHISTORY AROUND #a ${m[0]} 4`)).toEqual(range(0, 4))
    // Between, both excluded, counted from the first one, forward or backward.
    expect(await get(`CHATHISTORY BETWEEN #a ${m[2]} ${m[7]} 10`)).toEqual(range(3, 7))
    expect(await get(`CHATHISTORY BETWEEN #a ${m[2]} ${m[7]} 2`)).toEqual(range(3, 5))
    expect(await get(`CHATHISTORY BETWEEN #a ${m[7]} ${m[2]} 2`)).toEqual(range(5, 7))
    expect(await get(`CHATHISTORY BETWEEN #a ${m[3]} ${m[4]} 10`)).toEqual([])

    // A timestamp excludes the messages of that millisecond: the times are those of the msgids.
    const distinct = (i: number) => sent.filter(({ time }) => time === sent[i].time).length === 1
    const i = [4, 5, 6].find(distinct)
    if (i !== undefined) {
      expect(await get(`CHATHISTORY BEFORE #a ${t[i]} 2`)).toEqual(
        sent
          .filter(({ time }) => time < sent[i].time)
          .slice(-2)
          .map(({ text }) => text)
      )
      expect(await get(`CHATHISTORY AFTER #a ${t[i]} 2`)).toEqual(
        sent
          .filter(({ time }) => time > sent[i].time)
          .slice(0, 2)
          .map(({ text }) => text)
      )
    }
    // Timestamps around all of them, and a mix of both types.
    const early = 'timestamp=2000-01-01T00:00:00.000Z'
    const late = 'timestamp=2999-01-01T00:00:00.000Z'
    expect(await get(`CHATHISTORY AFTER #a ${early} 2`)).toEqual(range(0, 2))
    expect(await get(`CHATHISTORY BEFORE #a ${late} 2`)).toEqual(range(8, 10))
    expect(await get(`CHATHISTORY BETWEEN #a ${late} ${m[7]} 10`)).toEqual(range(8, 10))
    expect(await get(`CHATHISTORY BETWEEN #a ${early} ${late} 100`)).toEqual(range(0, 10))
    expect(await get(`CHATHISTORY LATEST #a ${late} 10`)).toEqual([])
    // A msgid that is not stored is still a position in the order.
    const missing = encodeTime(Date.parse(sent[5].time)) + '0'.repeat(16)
    expect((await get(`CHATHISTORY AFTER #a msgid=${missing} 100`)).length).toBeGreaterThan(3)
  })

  it('Should limit a request, and mark the end of the history only when it is reached', async () => {
    const { bob, sent } = await channel({ history: { limit: 4 } })
    const page = await exchange(bob, 'CHATHISTORY LATEST #a * 1000')
    expect(texts(page)).toEqual(['m6', 'm7', 'm8', 'm9'])
    expect(page[0]).not.toContain('chathistory-end')
    const last = await exchange(bob, `CHATHISTORY BEFORE #a msgid=${sent[2].msgid} 4`)
    expect(texts(last)).toEqual(['m0', 'm1'])
    expect(last[0]).toContain('draft/chathistory-end')
    const exact = await exchange(bob, `CHATHISTORY AFTER #a msgid=${sent[5].msgid} 4`)
    expect(texts(exact)).toEqual(['m6', 'm7', 'm8', 'm9'])
    expect(exact[0]).toContain('draft/chathistory-end')
  })

  it('Should send an empty batch when there is nothing, and plain lines without batch', async () => {
    const { user, alice, bob } = await channel()
    expect(
      await exchange(bob, 'CHATHISTORY BEFORE #a timestamp=2000-01-01T00:00:00.000Z 5')
    ).toEqual([
      expect.stringMatching(/;draft\/chathistory-end :irc\.example BATCH \+B chathistory #a$/),
      expect.stringMatching(/ BATCH -B$/),
    ])
    // In a channel that is not permanent, carol reads the history from when she joined.
    await transcript(alice, 'MODE #a -P')
    const carol = await user('carol', ['draft/chathistory'])
    await transcript(carol, 'JOIN #a')
    expect(await exchange(carol, 'CHATHISTORY LATEST #a * 10')).toEqual([])
    await transcript(bob, 'PRIVMSG #a :after carol')
    expect(await exchange(carol, 'CHATHISTORY LATEST #a * 10')).toEqual([
      ':bob!~bob@host PRIVMSG #a :after carol',
    ])
  })

  it('Should answer with a label, on the batch', async () => {
    const { bob } = await channel()
    await transcript(bob, 'CAP REQ labeled-response')
    const lines = await exchange(bob, '@label=h1 CHATHISTORY LATEST #a * 2')
    expect(lines[0]).toMatch(/^@\S*label=h1\S* :irc\.example BATCH \+B chathistory #a$/)
    expect(lines).toHaveLength(4)
    expect(await exchange(bob, '@label=h2 CHATHISTORY LATEST #nope * 2')).toEqual([
      expect.stringMatching(/^@\S*label=h2\S* :irc\.example FAIL CHATHISTORY INVALID_TARGET /),
    ])
    expect(
      await exchange(
        bob,
        '@label=h3 CHATHISTORY TARGETS timestamp=2000-01-01T00:00:00.000Z timestamp=2999-01-01T00:00:00.000Z 5'
      )
    ).toEqual([
      expect.stringMatching(
        /^@\S*draft\/chathistory-end;label=h3 :irc\.example BATCH \+B draft\/chathistory-targets$/
      ),
      expect.stringMatching(/^@time=\S+;batch=B :irc\.example CHATHISTORY TARGETS #a \S+Z$/),
      expect.stringMatching(/ BATCH -B$/),
    ])
  })

  it('Should replay the tags of the sender as they were, and the client-only tags', async () => {
    const { user } = setup()
    const alice = await user('alice', [...FULL, 'account-tag'])
    await transcript(alice, 'JOIN #a', 'MODE alice +B', '@+example/x=1 PRIVMSG #a :tagged')
    // alice is no longer a bot.
    await transcript(alice, 'MODE alice -B')
    const lines = await exchange(alice, 'CHATHISTORY LATEST #a * 1')
    expect(lines[1]).toMatch(
      /^@batch=B;time=\S+;msgid=\S+;bot;account=alice;\+example\/x=1 :alice!~alice@host PRIVMSG #a tagged$/
    )
    expect(lines[1]).not.toContain('verbatim')
  })
})

describe('Errors of CHATHISTORY', () => {
  it('Should send every FAIL code of the spec', async () => {
    const { bob, user } = await channel()
    const fails = async (...lines: string[]) =>
      (await exchange(bob, ...lines)).map((line) => line.replace(/^@\S+ :irc\.example /, ''))
    expect(
      await fails(
        'CHATHISTORY',
        'CHATHISTORY FOO #a * 10',
        'CHATHISTORY LATEST #a *',
        'CHATHISTORY LATEST #a * 10 extra',
        'CHATHISTORY BETWEEN #a * 10',
        'CHATHISTORY BEFORE #a timestamp=yesterday 10',
        'CHATHISTORY BEFORE #a msgid=nope 10',
        'CHATHISTORY BEFORE #a * 10',
        'CHATHISTORY LATEST #a * 0',
        'CHATHISTORY LATEST #a * ten',
        'CHATHISTORY TARGETS msgid=01M8CTS92XHX1JXN1QWNG4VDYF timestamp=2000-01-01T00:00:00.000Z 1',
        'CHATHISTORY LATEST #a seq=12 10',
        'CHATHISTORY LATEST #nope * 10',
        'CHATHISTORY LATEST nobody * 10'
      )
    ).toEqual([
      'FAIL CHATHISTORY INVALID_PARAMS * :Insufficient parameters',
      'FAIL CHATHISTORY INVALID_PARAMS FOO :Unknown command',
      'FAIL CHATHISTORY INVALID_PARAMS LATEST :Insufficient parameters',
      'FAIL CHATHISTORY INVALID_PARAMS LATEST :Too many parameters',
      'FAIL CHATHISTORY INVALID_PARAMS BETWEEN :Insufficient parameters',
      'FAIL CHATHISTORY INVALID_PARAMS BEFORE timestamp=yesterday :Invalid message reference',
      'FAIL CHATHISTORY INVALID_PARAMS BEFORE msgid=nope :Invalid message reference',
      'FAIL CHATHISTORY INVALID_PARAMS BEFORE * :Invalid message reference',
      'FAIL CHATHISTORY INVALID_PARAMS LATEST 0 :Invalid limit',
      'FAIL CHATHISTORY INVALID_PARAMS LATEST ten :Invalid limit',
      'FAIL CHATHISTORY INVALID_PARAMS TARGETS msgid=01M8CTS92XHX1JXN1QWNG4VDYF :Invalid message reference',
      'FAIL CHATHISTORY INVALID_MSGREFTYPE LATEST #a seq=12 :Unknown message reference type',
      'FAIL CHATHISTORY INVALID_TARGET LATEST #nope :Messages could not be retrieved',
      'FAIL CHATHISTORY INVALID_TARGET LATEST nobody :Messages could not be retrieved',
    ])
    // A channel that the client is not in, and a nickname when it is not logged in.
    const guest = await user('guest', FULL, null)
    expect(
      (await exchange(guest, 'CHATHISTORY LATEST #a * 10', 'CHATHISTORY LATEST alice * 10')).map(
        (line) => line.replace(/^@\S+ :irc\.example /, '')
      )
    ).toEqual([
      'FAIL CHATHISTORY INVALID_TARGET LATEST #a :Messages could not be retrieved',
      'FAIL CHATHISTORY INVALID_TARGET LATEST alice :Messages could not be retrieved',
    ])
  })

  it('Should fail with MESSAGE_ERROR when the database does', async () => {
    const { bob, store } = await channel()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const query = store.query.bind(store)
    vi.spyOn(store, 'query').mockImplementation((sql, ...params) => {
      if (/FROM history/.test(sql)) {
        throw new Error('disk on fire')
      }
      return query(sql, ...params)
    })
    expect(
      await exchange(
        bob,
        'CHATHISTORY LATEST #a * 10',
        'CHATHISTORY TARGETS timestamp=2000-01-01T00:00:00.000Z timestamp=2999-01-01T00:00:00.000Z 5'
      )
    ).toEqual([
      expect.stringMatching(
        / FAIL CHATHISTORY MESSAGE_ERROR LATEST #a :Messages could not be retrieved$/
      ),
      expect.stringMatching(
        / FAIL CHATHISTORY MESSAGE_ERROR TARGETS \* :Messages could not be retrieved$/
      ),
    ])
    // The messages are still delivered.
    await transcript(bob, 'PRIVMSG #a :still here')
  })
})

describe('Access to the history of a channel', () => {
  it('Should refuse a member who is banned, unless it has voice', async () => {
    const { alice, bob } = await channel()
    await transcript(alice, 'MODE #a +b bob!*@*')
    expect(await exchange(bob, 'CHATHISTORY LATEST #a * 1')).toEqual([
      expect.stringMatching(/ FAIL CHATHISTORY INVALID_TARGET LATEST #a /),
    ])
    await transcript(alice, 'MODE #a +v bob')
    expect(texts(await exchange(bob, 'CHATHISTORY LATEST #a * 1'))).toEqual(['m9'])
  })

  it('Should store only the messages that were allowed, and not TAGMSG', async () => {
    const { alice, bob, user } = await channel()
    await transcript(alice, 'MODE #a +m')
    await transcript(
      bob,
      'PRIVMSG #a :muted',
      'NOTICE #a :muted notice',
      '@+typing=active TAGMSG #a'
    )
    await transcript(alice, 'MODE #a -m', 'NOTICE #a :a notice')
    const outsider = await user('carol')
    await transcript(outsider, 'PRIVMSG #a :from outside')
    expect(texts(await exchange(bob, 'CHATHISTORY LATEST #a * 3'))).toEqual([
      'm8',
      'm9',
      'a notice',
    ])
  })

  it('Should delete the history of an ordinary channel with the channel', async () => {
    const { alice, bob, store, state } = await channel()
    const count = () => store.query<{ n: number }>('SELECT count(*) AS n FROM history')[0].n
    expect(count()).toBe(10)
    await transcript(alice, 'MODE #a -P')
    await transcript(alice, 'PART #a')
    await transcript(bob, 'PART #a')
    // A new channel of the same name starts empty, and the old history goes a little at a time.
    await transcript(bob, 'JOIN #a')
    expect(texts(await exchange(bob, 'CHATHISTORY LATEST #a * 10'))).toEqual([])
    expect(count()).toBe(10)
    state()!.expire()
    expect(count()).toBe(0)
    expect(store.query('SELECT * FROM targets')).toEqual([])
  })
})

describe('Direct messages', () => {
  it('Should store them by the pair of accounts, for every connection and nickname', async () => {
    const { user } = setup()
    const alice = await user('alice')
    const bob = await user('bob')
    await say(alice, 'bob', 'hi bob')
    await say(bob, 'alice', 'hi alice')
    await transcript(bob, 'NICK robert')
    await say(alice, 'robert', 'nice nick')
    // A second connection of bob's account, with another nickname.
    const phone = await user('bobphone', FULL, 'bob')
    expect(await exchange(phone, 'CHATHISTORY LATEST alice * 10')).toEqual([
      expect.stringMatching(/;draft\/chathistory-end :irc\.example BATCH \+B chathistory alice$/),
      expect.stringMatching(/ :alice!~alice@host PRIVMSG bob :hi bob$/),
      expect.stringMatching(/ :bob!~bob@host PRIVMSG alice :hi alice$/),
      expect.stringMatching(/ :alice!~alice@host PRIVMSG robert :nice nick$/),
      expect.stringMatching(/ BATCH -B$/),
    ])
    // alice asks with bob's current nickname, or the name of his account.
    expect(texts(await exchange(alice, 'CHATHISTORY LATEST robert * 10'))).toHaveLength(3)
    expect(texts(await exchange(alice, 'CHATHISTORY LATEST bob * 10'))).toHaveLength(3)
    await bob.send('QUIT')
    await phone.send('QUIT')
    await bob.all()
    await phone.all()
    expect(texts(await exchange(alice, 'CHATHISTORY LATEST bob * 10'))).toHaveLength(3)
  })

  it('Should not store them unless both ends are logged in', async () => {
    const { user, store } = setup()
    const alice = await user('alice')
    const guest = await user('guest', FULL, null)
    await say(alice, 'guest', 'to a guest')
    await say(guest, 'alice', 'from a guest')
    expect(store.query('SELECT * FROM history')).toEqual([])
    expect(texts(await exchange(alice, 'CHATHISTORY LATEST guest * 10'))).toEqual([])
  })

  it('Should list the channels and the correspondents with TARGETS', async () => {
    const { user } = setup()
    const alice = await user('alice')
    await user('bob')
    const carol = await user('carol')
    await transcript(alice, 'JOIN #a,#b,#c')
    const before = new Date().toISOString()
    // Each in its own millisecond, so their order is known.
    await sleep(3)
    await say(alice, '#a', 'in a')
    await sleep(3)
    await say(carol, 'alice', 'from carol')
    await sleep(3)
    await say(alice, 'bob', 'to bob')
    await sleep(3)
    await say(alice, '#b', 'in b')
    const after = new Date(Date.now() + 1000).toISOString()
    const targets = async (from: string, to: string, limit = 10) =>
      (await exchange(alice, `CHATHISTORY TARGETS timestamp=${from} timestamp=${to} ${limit}`))
        .filter((line) => / CHATHISTORY TARGETS /.test(line))
        .map((line) => parse(line)!.params[1])
    const early = '2000-01-01T00:00:00.000Z'
    expect(await targets(early, after)).toEqual(['#a', 'carol', 'bob', '#b'])
    expect(await targets(before, after, 2)).toEqual(['#a', 'carol'])
    expect(await targets(after, before, 2)).toEqual(['bob', '#b'])
    expect(await targets(early, before)).toEqual([])
    // Without an account: only the channels.
    const guest = await user('guest', FULL, null)
    await transcript(guest, 'JOIN #a')
    await say(guest, '#a', 'guest in a')
    expect(
      (
        await exchange(guest, `CHATHISTORY TARGETS timestamp=${early} timestamp=${after} 10`)
      ).filter((line) => / CHATHISTORY TARGETS /.test(line))
    ).toEqual([expect.stringMatching(/ CHATHISTORY TARGETS #a \S+Z$/)])
  })
})

describe('Multiline messages', () => {
  it('Should store one message and replay it as one batch, or as its lines', async () => {
    const { user, store } = setup()
    const alice = await user('alice', [...FULL, 'draft/multiline'])
    await transcript(alice, 'JOIN #a')
    const echo = await transcript(
      alice,
      '@+example/x=1 BATCH +m draft/multiline #a',
      '@batch=m PRIVMSG #a hello',
      '@batch=m PRIVMSG #a :',
      '@batch=m PRIVMSG #a :how is ',
      '@batch=m;draft/multiline-concat PRIVMSG #a :everyone?',
      'BATCH -m'
    )
    const { msgid, time } = tags(echo[0])
    expect(store.query('SELECT count(*) AS n FROM history')).toEqual([{ n: 1 }])

    const capable = await exchange(alice, 'CHATHISTORY LATEST #a * 10')
    expect(capable.slice(1, -1)).toEqual([
      `@batch=B;time=${time};msgid=${msgid};+example/x=1 :alice!~alice@host BATCH +${capable[1].split('+')[2]}`,
      ...capable.slice(2, -2),
      `@batch=B;time=${time} :alice!~alice@host BATCH -${capable[1].split('+')[2].split(' ')[0]}`,
    ])
    const inner = capable.slice(2, -2).map((line) => line.replace(/^@batch=\w+;/, '@'))
    expect(inner).toEqual([
      `@time=${time} :alice!~alice@host PRIVMSG #a hello`,
      `@time=${time} :alice!~alice@host PRIVMSG #a :`,
      `@time=${time} :alice!~alice@host PRIVMSG #a :how is `,
      `@time=${time};draft/multiline-concat :alice!~alice@host PRIVMSG #a everyone?`,
    ])
    // The inner batch is nested in the chathistory one.
    expect(capable[1]).toMatch(/BATCH \+\w+ draft\/multiline #a$/)

    const plain = await user('bob', ['batch', 'server-time', 'message-tags', 'draft/chathistory'])
    await transcript(alice, 'MODE #a +P')
    await transcript(plain, 'JOIN #a')
    expect(await exchange(plain, 'CHATHISTORY LATEST #a * 10')).toEqual([
      expect.stringMatching(/ BATCH \+B chathistory #a$/),
      `@batch=B;time=${time};msgid=${msgid};+example/x=1 :alice!~alice@host PRIVMSG #a hello`,
      `@batch=B;time=${time} :alice!~alice@host PRIVMSG #a :how is `,
      `@batch=B;time=${time} :alice!~alice@host PRIVMSG #a everyone?`,
      expect.stringMatching(/ BATCH -B$/),
    ])
    const bare = await user('carol', [])
    await transcript(bare, 'JOIN #a')
    expect(await exchange(bare, 'CHATHISTORY LATEST #a * 10')).toEqual([
      ':alice!~alice@host PRIVMSG #a hello',
      ':alice!~alice@host PRIVMSG #a :how is ',
      ':alice!~alice@host PRIVMSG #a everyone?',
    ])
  })

  it('Should fit a multiline message of the max size in a row', async () => {
    const { user, store } = setup()
    const alice = await user('alice', [...FULL, 'draft/multiline'])
    await transcript(alice, 'JOIN #a')
    // The worst case for JSON: control characters, which take 6 bytes each, in 100 lines of 4096
    // bytes, with client-only tags of 4094 bytes.
    // 4096 bytes in all, with the 99 line feeds.
    const lines = [`@+t=${'\x01'.repeat(2000)} BATCH +m draft/multiline #a`]
    for (let i = 0; i < 100; i++) {
      lines.push(`@batch=m PRIVMSG #a :${'\x02'.repeat(i ? 39 : 136)}`)
    }
    expect((await transcript(alice, ...lines, 'BATCH -m'))[0]).toMatch(/ BATCH \+/)
    const [row] = store.query<{ size: number }>(
      'SELECT length(CAST(lines AS BLOB)) + length(CAST(tags AS BLOB)) AS size FROM history'
    )
    expect(row.size).toBeGreaterThan(4000 * 6)
    expect(row.size).toBeLessThan(2_000_000)
  })
})

describe('Retention', () => {
  const chat = (
    i: number,
    time: number,
    msgid = encodeTime(time) + String(i).padStart(16, '0')
  ): Chat => ({
    msgid,
    time,
    command: 'PRIVMSG',
    source: 'a!b@c',
    target: '#a',
    text: `m${i}`,
    tags: {},
  })
  const texts = (history: History, target: number) =>
    history.page(target, 'ASC', '', '~', 1000).map(({ text }) => text)

  it('Should keep the newest messages of a target', () => {
    const history = new History(serverStore(), { maxMessages: 3 })
    const target = history.createTarget(true)
    const other = history.createTarget(true)
    const now = Date.now()
    for (let i = 0; i < 6; i++) {
      history.add(target, chat(i, now + i), now)
    }
    history.add(other, chat(9, now), now)
    expect(texts(history, target)).toEqual(['m3', 'm4', 'm5'])
    expect(texts(history, other)).toEqual(['m9'])
    // After a restart, the count is read again.
    const again = new History(history.store, { maxMessages: 3 })
    again.add(target, chat(6, now + 6), now)
    expect(texts(again, target)).toEqual(['m4', 'm5', 'm6'])
  })

  it('Should get under a limit that was lowered a few rows at a time', () => {
    const store = serverStore()
    const history = new History(store, { maxMessages: 10 })
    const target = history.createTarget(true)
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      history.add(target, chat(i, now + i), now)
    }
    const lowered = new History(store, { maxMessages: 3 })
    lowered.add(target, chat(10, now + 10), now)
    expect(texts(lowered, target)).toHaveLength(8)
    lowered.add(target, chat(11, now + 11), now)
    lowered.add(target, chat(12, now + 12), now)
    expect(texts(lowered, target)).toEqual(['m9', 'm10', 'm11', 'm12'])
    lowered.add(target, chat(13, now + 13), now)
    expect(texts(lowered, target)).toEqual(['m11', 'm12', 'm13'])
  })

  it('Should delete the old messages a few at a time, and the rest with sweep()', () => {
    const history = new History(serverStore(), { maxAge: 1000 })
    const target = history.createTarget(true)
    const now = Date.now()
    for (let i = 0; i < 6; i++) {
      history.add(target, chat(i, now - 5000 + i), now - 5000)
    }
    // Each message deletes two of the old ones of its target.
    history.add(target, chat(6, now), now)
    expect(texts(history, target)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6'])
    expect(history.sweep(now, 2)).toBe(2)
    expect(texts(history, target)).toEqual(['m4', 'm5', 'm6'])
    expect(history.sweep(now)).toBe(2)
    expect(texts(history, target)).toEqual(['m6'])
  })

  it('Should keep at most maxRows messages on the server', () => {
    const history = new History(serverStore(), { maxRows: 4 })
    const a = history.createTarget(true)
    const b = history.createTarget(true)
    const now = Date.now()
    for (let i = 0; i < 8; i++) {
      history.add(i % 2 ? a : b, chat(i, now + i), now)
    }
    expect(
      [...texts(history, a), ...texts(history, b)].sort((x, y) => x!.localeCompare(y!))
    ).toEqual(['m4', 'm5', 'm6', 'm7'])
  })

  it('Should delete the history of a channel that ended a little at a time', () => {
    const history = new History(serverStore())
    const target = history.createTarget(false)
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      history.add(target, chat(i, now + i), now)
    }
    history.setEnding(target, 1)
    expect(history.sweep(now, 3)).toBe(3)
    expect(texts(history, target)).toEqual(['m3', 'm4'])
    expect(history.sweep(now, 3)).toBe(2)
    expect(history.store.query('SELECT * FROM targets')).toEqual([])
  })

  it('Should delete the history of the ordinary channels after a restart', () => {
    const store = serverStore()
    const history = new History(store)
    const ordinary = history.createTarget(false)
    const permanent = history.createTarget(true)
    history.add(ordinary, chat(0, Date.now()))
    history.add(permanent, chat(1, Date.now()))
    const restarted = new History(store)
    restarted.sweep()
    expect(texts(restarted, ordinary)).toEqual([])
    expect(texts(restarted, permanent)).toEqual(['m1'])
  })
})

describe('Query plans', () => {
  it('Should use the indexes', async () => {
    const { store } = setup()
    const plan = (sql: string, ...params: (string | number)[]) =>
      store
        .query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
        .map(({ detail }) => detail)
        .join('; ')
    const columns = 'msgid, time, command, source, account, bot, recipient, text, lines, tags'
    const page = (order: string) =>
      `SELECT ${columns} FROM history WHERE target = ? AND msgid >= ? AND msgid < ? ORDER BY msgid ${order} LIMIT ?`
    const plans = {
      'LATEST, BEFORE, AROUND, BETWEEN (backward)': plan(page('DESC'), 1, '', '~', 10),
      'AFTER, AROUND, BETWEEN (forward)': plan(page('ASC'), 1, '', '~', 10),
      'TARGETS: the latest message of a target': plan(
        'SELECT time FROM history WHERE target = ? AND msgid >= ? ORDER BY msgid DESC LIMIT 1',
        1,
        ''
      ),
      'TARGETS: the correspondents (low)': plan('SELECT id, high FROM targets WHERE low = ?', 'a'),
      'TARGETS: the correspondents (high)': plan(
        'SELECT id, low FROM targets WHERE high = ? AND low != high',
        'a'
      ),
      'the target of two accounts': plan(
        'SELECT id FROM targets WHERE low = ? AND high = ?',
        'a',
        'b'
      ),
      'the oldest of a target': plan(
        'SELECT id FROM history WHERE target = ? AND msgid < ? ORDER BY msgid LIMIT ?',
        1,
        0,
        2
      ),
      'the oldest of a target over the limit': plan(
        'SELECT id FROM history WHERE target = ? ORDER BY msgid LIMIT ?',
        1,
        1
      ),
      'the count of a target, once': plan('SELECT count(*) FROM history WHERE target = ?', 1),
      'the rows of a doomed target': plan('SELECT id FROM history WHERE target = ? LIMIT ?', 1, 10),
      'the sweep of the oldest': plan(
        'SELECT id FROM (SELECT id, time FROM history ORDER BY id LIMIT ?) WHERE time < ?',
        10,
        0
      ),
      'a read marker': plan(
        'SELECT at FROM read_markers WHERE account = ? AND target = ?',
        'a',
        '#a'
      ),
      'the oldest of the server': plan(
        'SELECT id FROM history WHERE id <= ? ORDER BY id LIMIT ?',
        1,
        2
      ),
      'a doomed target': plan('SELECT id FROM targets WHERE ending = 1 LIMIT 1'),
      'the channels of a founder': plan('SELECT count(*) FROM channels WHERE founder = ?', 'a'),
      'the unused channels': plan(
        'SELECT folded FROM channels WHERE used < ? ORDER BY used LIMIT ?',
        0,
        10
      ),
    }
    console.log(
      Object.entries(plans)
        .map(([name, detail]) => `${name}: ${detail}`)
        .join('\n')
    )
    for (const [name, detail] of Object.entries(plans)) {
      // The sweep reads the first rows of the table in the order of their ids, which is the order
      // of the table itself, and stops at the limit.
      if (name === 'the sweep of the oldest') {
        expect(detail).toBe('CO-ROUTINE (subquery-1); SCAN history; SCAN (subquery-1)')
        continue
      }
      expect(detail, name).toMatch(/USING (COVERING )?INDEX|USING (INTEGER )?PRIMARY KEY/)
      expect(detail, name).not.toMatch(/TEMP B-TREE/)
    }
  })
})

describe('draft/read-marker', () => {
  const MARKER = ['draft/read-marker', 'labeled-response', 'batch']

  it('Should get and set a marker that only moves forward, on every connection', async () => {
    const { user } = setup()
    const alice = await user('alice', MARKER)
    const phone = await user('phone', MARKER, 'alice')
    await transcript(alice, 'JOIN #a')
    const strip = (lines: string[]) => lines.map((line) => line.replace(/^@\S+ /, '@ '))
    expect(strip(await exchange(alice, '@label=1 MARKREAD #a'))).toEqual([
      '@ :irc.example MARKREAD #a *',
    ])
    expect(
      await exchange(alice, '@label=2 MARKREAD #a timestamp=2020-01-01T00:00:00.000Z')
    ).toEqual([
      expect.stringMatching(
        /^@\S*label=2\S* :irc\.example MARKREAD #a timestamp=2020-01-01T00:00:00\.000Z$/
      ),
    ])
    expect(await phone.waitFor(/ MARKREAD /)).toMatch(
      / MARKREAD #a timestamp=2020-01-01T00:00:00\.000Z$/
    )
    // An older one gets the stored one back, and the others are not told.
    expect(await exchange(phone, 'MARKREAD #a timestamp=2019-01-01T00:00:00.000Z')).toEqual([
      expect.stringMatching(/ MARKREAD #a timestamp=2020-01-01T00:00:00\.000Z$/),
    ])
    // Not past the time of the server.
    const future = await exchange(phone, 'MARKREAD #a timestamp=2999-01-01T00:00:00.000Z')
    expect(Date.parse(parse(future[0])!.params[1].slice(10))).toBeLessThanOrEqual(Date.now())
    // A direct conversation, by the account of the nickname.
    await transcript(alice, 'MARKREAD phone timestamp=2021-01-01T00:00:00.000Z')
    expect(await exchange(phone, 'MARKREAD alice')).toEqual([
      expect.stringMatching(/ MARKREAD alice timestamp=2021-01-01T00:00:00\.000Z$/),
    ])
  })

  it('Should send the marker of a channel on JOIN, before the end of the names', async () => {
    const { user } = setup()
    const alice = await user('alice', MARKER)
    await transcript(alice, 'JOIN #a', 'MARKREAD #a timestamp=2020-01-01T00:00:00.000Z', 'PART #a')
    const join = (await exchange(alice, 'JOIN #a')).map((line) => line.replace(/^@\S+ /, ''))
    expect(join).toEqual([
      ':alice!~alice@host JOIN #a',
      ':irc.example MARKREAD #a timestamp=2020-01-01T00:00:00.000Z',
      ':irc.example 353 alice = #a @alice',
      ':irc.example 366 alice #a :End of /NAMES list',
    ])
    const plain = await user('bob', [])
    expect((await exchange(plain, 'JOIN #a')).some((line) => / MARKREAD /.test(line))).toBe(false)
  })

  it('Should send the errors of the spec', async () => {
    const { user } = setup()
    const alice = await user('alice', MARKER)
    const guest = await user('guest', MARKER, null)
    await transcript(alice, 'JOIN #a')
    const fails = async (client: TestClient, ...lines: string[]) =>
      (await exchange(client, ...lines)).map((line) => line.replace(/^@\S+ /, ''))
    expect(
      await fails(
        alice,
        'MARKREAD',
        'MARKREAD #nope',
        'MARKREAD nobody',
        'MARKREAD #a 2020-01-01T00:00:00.000Z',
        'MARKREAD #a *'
      )
    ).toEqual([
      ':irc.example FAIL MARKREAD NEED_MORE_PARAMS :Missing parameters',
      ':irc.example FAIL MARKREAD INVALID_PARAMS #nope :Invalid target',
      ':irc.example FAIL MARKREAD INVALID_PARAMS nobody :Invalid target',
      ':irc.example FAIL MARKREAD INVALID_PARAMS 2020-01-01T00:00:00.000Z :Invalid timestamp',
      ':irc.example FAIL MARKREAD INVALID_PARAMS * :Invalid timestamp',
    ])
    expect(
      await fails(guest, 'MARKREAD #a', 'MARKREAD #a timestamp=2020-01-01T00:00:00.000Z')
    ).toEqual([
      ':irc.example MARKREAD #a *',
      ':irc.example FAIL MARKREAD INTERNAL_ERROR #a :You must be logged in to an account',
    ])
  })
})

describe('replayOnJoin', () => {
  it('Should send the last messages to a client without draft/chathistory', async () => {
    const { user } = setup({ replayOnJoin: 2 })
    const alice = await user('alice')
    await transcript(alice, 'JOIN #a')
    await say(alice, '#a', 'one', 'two', 'three')
    const bob = await user('bob', ['batch', 'server-time'])
    const lines = await exchange(bob, 'JOIN #a')
    expect(lines.map((line) => line.replace(/time=[^; ]+/, 'time=T'))).toEqual([
      '@time=T :bob!~bob@host JOIN #a',
      '@time=T :irc.example BATCH +B chathistory #a',
      '@batch=B;time=T :alice!~alice@host PRIVMSG #a two',
      '@batch=B;time=T :alice!~alice@host PRIVMSG #a three',
      '@time=T :irc.example BATCH -B',
      '@time=T :irc.example 353 bob = #a :@alice bob',
      '@time=T :irc.example 366 bob #a :End of /NAMES list',
    ])
    const carol = await user('carol')
    expect(texts(await exchange(carol, 'JOIN #a'))).toEqual([])
  })
})

/** A store with the schema, for the tests of `History` alone. */
const serverStore = () => {
  const { store } = setup()
  return store
}
