import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { hashPassword } from './accounts.ts'
import { chunks, mechanisms } from './commands/sasl.ts'
import type { ServerOptions } from './server.ts'
import { connect, setup as serverSetup, transcript } from './test-utils.ts'

// SASL (sasl-3.1, sasl-3.2) with PLAIN, the state of a client that is logged in (account-notify,
// account-tag, extended-join, WHOX, WHOIS, extended-monitor), and the reserved nicknames.

type TestClient = ReturnType<typeof connect>

// A low iteration count, so the tests are fast. The flood control is off.
const setup = (config: ServerOptions = {}) => {
  const result = serverSetup({
    name: 'irc.example',
    ...config,
    accounts: { iterations: 10, ...config.accounts },
  })
  /** Store an account, as REGISTER would. */
  const account = async (name: string, password = 'password1') =>
    result.server.accounts!.create(name, await hashPassword(password, 10), 'test')
  return { ...result, account }
}

const norm = (line: string) =>
  line
    .replace(/@[0-9a-f]{8}\.user/g, '@host')
    .replace(/time=[^; ]+/g, 'time=T')
    .replace(/msgid=[^; ]+/g, 'msgid=ID')

const exchange = async (client: TestClient, ...lines: string[]) =>
  (await transcript(client, ...lines)).map(norm)

/** The response of PLAIN in base64. */
const plain = (authcid: string, password: string, authzid = authcid) =>
  Buffer.from(`${authzid}\0${authcid}\0${password}`).toString('base64')

/** Connect, ask for sasl, and send NICK and USER, without ending the negotiation. */
const unregistered = async (handler: Parameters<typeof connect>[0], nick: string) => {
  const client = connect(handler)
  await exchange(client, 'CAP LS 302', 'CAP REQ sasl', `NICK ${nick}`, `USER ${nick} 0 * :${nick}`)
  return client
}

/** Log a registered client in with SASL. */
const login = (client: TestClient, name: string, password = 'password1') =>
  exchange(client, 'CAP REQ sasl', 'AUTHENTICATE PLAIN', `AUTHENTICATE ${plain(name, password)}`)

const LOGGED_IN = (nick: string, account = nick) => [
  `:irc.example 900 ${nick} ${nick}!~${nick}@host ${account} :You are now logged in as ${account}`,
  `:irc.example 903 ${nick} :SASL authentication successful`,
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AUTHENTICATE PLAIN', () => {
  it('Should log in before the registration, as in the example of sasl-3.1', async () => {
    const { handler, account } = setup()
    await account('alice')
    const client = await unregistered(handler, 'alice')
    expect(await exchange(client, 'AUTHENTICATE PLAIN')).toEqual([':irc.example AUTHENTICATE +'])
    expect(await exchange(client, `AUTHENTICATE ${plain('alice', 'password1')}`)).toEqual(
      LOGGED_IN('alice')
    )
    const welcome = await exchange(client, 'CAP END', 'WHOIS alice')
    expect(welcome[0]).toBe(
      ':irc.example 001 alice :Welcome to the HonoIRC Network, alice!~alice@host'
    )
    expect(welcome).toContain(':irc.example 330 alice alice alice :is logged in as')
  })

  it('Should take the mechanism in any case, an empty authzid, and the name in any case', async () => {
    const { handler, account } = setup()
    await account('Alice')
    const client = await unregistered(handler, 'alice')
    await exchange(client, 'AUTHENTICATE plain')
    expect(await exchange(client, `AUTHENTICATE ${plain('ALICE', 'password1', '')}`)).toEqual(
      LOGGED_IN('alice', 'Alice')
    )
  })

  it('Should fail with wrong credentials, and let the client try again', async () => {
    const { handler, account } = setup({ accounts: { maxFailures: 10 } })
    await account('alice')
    await account('bob')
    const client = await unregistered(handler, 'alice')
    for (const response of [
      plain('alice', 'wrong password'),
      plain('nobody', 'password1'),
      // Another authorization identity: a client can only act as itself.
      plain('alice', 'password1', 'bob'),
      // Not three parts, an empty password, and not UTF-8.
      Buffer.from('alice\0password1').toString('base64'),
      plain('alice', ''),
      Buffer.from([0, 0x61, 0, 0xff]).toString('base64'),
    ]) {
      expect(await exchange(client, 'AUTHENTICATE PLAIN', `AUTHENTICATE ${response}`)).toEqual([
        ':irc.example AUTHENTICATE +',
        ':irc.example 904 alice :SASL authentication failed',
      ])
    }
    expect(
      await exchange(client, 'AUTHENTICATE PLAIN', `AUTHENTICATE ${plain('alice', 'password1')}`)
    ).toEqual([':irc.example AUTHENTICATE +', ...LOGGED_IN('alice')])
  })

  it('Should list the mechanisms for an unknown one, and keep the state', async () => {
    const { handler, account } = setup()
    await account('alice')
    const client = await unregistered(handler, 'alice')
    expect(await exchange(client, 'AUTHENTICATE SCRAM-SHA-256', 'AUTHENTICATE EXTERNAL')).toEqual([
      ':irc.example 908 alice PLAIN :are available SASL mechanisms',
      ':irc.example 904 alice :SASL authentication failed',
      ':irc.example 908 alice PLAIN :are available SASL mechanisms',
      ':irc.example 904 alice :SASL authentication failed',
    ])
    expect(await login(client, 'alice')).toEqual([
      ':irc.example CAP alice ACK sasl',
      ':irc.example AUTHENTICATE +',
      ...LOGGED_IN('alice'),
    ])
  })

  it('Should abort with *', async () => {
    const { handler, account } = setup()
    await account('alice')
    const client = await unregistered(handler, 'alice')
    expect(await exchange(client, 'AUTHENTICATE PLAIN', 'AUTHENTICATE *')).toEqual([
      ':irc.example AUTHENTICATE +',
      ':irc.example 906 alice :SASL authentication aborted',
    ])
    // The response that follows is taken as a mechanism, which it is not.
    expect(await exchange(client, `AUTHENTICATE ${plain('alice', 'password1')}`)).toEqual([
      ':irc.example 908 alice PLAIN :are available SASL mechanisms',
      ':irc.example 904 alice :SASL authentication failed',
    ])
  })

  it('Should take a response in chunks of 400 bytes', async () => {
    const { handler, account } = setup()
    // 1 + 5 + 1 + 293 = 300 bytes, which are 400 bytes of base64: a chunk, and then `+`.
    const exact = 'p'.repeat(293)
    await account('alice', exact)
    const client = await unregistered(handler, 'alice')
    const response = plain('alice', exact, '')
    expect(response).toHaveLength(400)
    expect(await exchange(client, 'AUTHENTICATE PLAIN', `AUTHENTICATE ${response}`)).toEqual([
      ':irc.example AUTHENTICATE +',
    ])
    expect(await exchange(client, 'AUTHENTICATE +')).toEqual(LOGGED_IN('alice'))

    // Two chunks, the last one shorter.
    const longer = 'q'.repeat(299)
    await account('bob', longer)
    const bob = await unregistered(handler, 'bob')
    const two = plain('bob', longer)
    expect(two.length).toBeGreaterThan(400)
    expect(
      await exchange(
        bob,
        'AUTHENTICATE PLAIN',
        `AUTHENTICATE ${two.slice(0, 400)}`,
        `AUTHENTICATE ${two.slice(400)}`
      )
    ).toEqual([':irc.example AUTHENTICATE +', ...LOGGED_IN('bob')])
  })

  it('Should refuse a chunk over 400 bytes, a response too long, or one that is not base64', async () => {
    const { handler, account } = setup({ accounts: { maxFailures: 10 } })
    await account('alice')
    const client = await unregistered(handler, 'alice')
    const tooLong = ':irc.example 905 alice :SASL message too long'
    const failed = ':irc.example 904 alice :SASL authentication failed'
    expect(await exchange(client, 'AUTHENTICATE PLAIN', `AUTHENTICATE ${'A'.repeat(401)}`)).toEqual(
      [':irc.example AUTHENTICATE +', tooLong]
    )
    // PLAIN takes at most 30 + 1 + 30 + 1 + 300 bytes, which are 484 bytes of base64.
    const chunk = 'A'.repeat(400)
    expect(
      await exchange(client, 'AUTHENTICATE PLAIN', `AUTHENTICATE ${chunk}`, `AUTHENTICATE ${chunk}`)
    ).toEqual([':irc.example AUTHENTICATE +', tooLong])
    expect(await exchange(client, 'AUTHENTICATE PLAIN', 'AUTHENTICATE ab!d')).toEqual([
      ':irc.example AUTHENTICATE +',
      failed,
    ])
    expect(await exchange(client, 'AUTHENTICATE PLAIN', 'AUTHENTICATE abc')).toEqual([
      ':irc.example AUTHENTICATE +',
      failed,
    ])
    expect(await exchange(client, 'AUTHENTICATE PLAIN', 'AUTHENTICATE +')).toEqual([
      ':irc.example AUTHENTICATE +',
      failed,
    ])
  })

  it('Should need the capability and a parameter', async () => {
    const { handler } = setup()
    const client = connect(handler)
    expect(await exchange(client, 'NICK alice', 'AUTHENTICATE', 'AUTHENTICATE PLAIN')).toEqual([
      ':irc.example 461 alice AUTHENTICATE :Not enough parameters',
      ':irc.example 904 alice :SASL authentication failed',
    ])
  })

  it('Should refuse a client that has logged in, with ERR_SASLALREADY', async () => {
    const { handler, account } = setup()
    await account('alice')
    const client = await unregistered(handler, 'alice')
    await login(client, 'alice')
    expect(await exchange(client, 'AUTHENTICATE PLAIN')).toEqual([
      ':irc.example 907 alice :You have already authenticated using SASL',
    ])
  })

  it('Should disconnect a connection after three failures', async () => {
    const { handler, register, account } = setup()
    await account('alice')
    const bob = await register('bob')
    const client = await unregistered(handler, 'carol')
    await exchange(client, 'CAP END', 'JOIN #a')
    await exchange(bob, 'JOIN #a')
    const wrong = `AUTHENTICATE ${plain('alice', 'wrong password')}`
    await exchange(client, 'AUTHENTICATE PLAIN', wrong, 'AUTHENTICATE PLAIN', wrong)
    await client.send('AUTHENTICATE PLAIN', wrong)
    const lines = (await client.all()).map(norm)
    expect(lines.slice(-3)).toEqual([
      ':irc.example AUTHENTICATE +',
      ':irc.example 904 carol :SASL authentication failed',
      expect.stringMatching(/^ERROR :Closing Link: \S+ \(Too many SASL authentication failures\)$/),
    ])
    expect(norm(await bob.waitFor(/ QUIT /))).toBe(
      ':carol!~carol@host QUIT :Too many SASL authentication failures'
    )
  })

  it('Should abort an exchange when the registration completes, and register without it', async () => {
    const { handler, account } = setup()
    await account('alice')
    const client = await unregistered(handler, 'bob')
    const lines = await exchange(client, 'AUTHENTICATE PLAIN', 'CAP END', 'WHOIS bob')
    expect(lines.slice(0, 3)).toEqual([
      ':irc.example AUTHENTICATE +',
      ':irc.example 906 bob :SASL authentication aborted',
      ':irc.example 001 bob :Welcome to the HonoIRC Network, bob!~bob@host',
    ])
    expect(lines.join('\n')).not.toContain(' 330 ')
    // The response that follows is then taken as a mechanism.
    expect(await exchange(client, `AUTHENTICATE ${plain('alice', 'password1')}`)).toEqual([
      ':irc.example 908 bob PLAIN :are available SASL mechanisms',
      ':irc.example 904 bob :SASL authentication failed',
    ])
  })

  it('Should log in after the registration, as sasl-3.2 allows', async () => {
    const { register, account } = setup()
    const alice = await register('alice', ['account-notify'])
    // Created after alice registered, as with a client that registers the account itself.
    await account('alice')
    const bob = await register('bob', ['account-notify'])
    await exchange(alice, 'JOIN #a')
    await exchange(bob, 'JOIN #a')
    expect(await login(alice, 'alice')).toEqual([
      ':irc.example CAP alice ACK sasl',
      ':irc.example AUTHENTICATE +',
      ...LOGGED_IN('alice'),
      // account-notify includes the client itself.
      ':alice!~alice@host ACCOUNT alice',
    ])
    expect(norm(await bob.waitFor(/ ACCOUNT /))).toBe(':alice!~alice@host ACCOUNT alice')
  })

  it('Should label the responses', async () => {
    const { register, account } = setup()
    const alice = await register('alice', ['labeled-response', 'batch', 'sasl'])
    // Created after alice registered, as with a client that registers the account itself.
    await account('alice')
    const response = plain('alice', 'p'.repeat(293), '')
    await account('alice2', 'p'.repeat(293))
    expect(await exchange(alice, '@label=a1 AUTHENTICATE PLAIN')).toEqual([
      '@label=a1 :irc.example AUTHENTICATE +',
    ])
    // A chunk that waits for more gets an ACK.
    expect(await exchange(alice, `@label=a2 AUTHENTICATE ${response}`)).toEqual([
      '@label=a2 :irc.example ACK',
    ])
    expect(await exchange(alice, '@label=a3 AUTHENTICATE +')).toEqual([
      '@label=a3 :irc.example 904 alice :SASL authentication failed',
    ])
    await exchange(alice, 'AUTHENTICATE PLAIN')
    expect(await exchange(alice, `@label=a4 AUTHENTICATE ${plain('alice', 'password1')}`)).toEqual([
      '@label=a4 :irc.example BATCH +1 labeled-response',
      ...LOGGED_IN('alice').map((line) => `@batch=1 ${line}`),
      ':irc.example BATCH -1',
    ])
  })

  it('Should derive a key only for a well-formed response to an account, and throttle it', async () => {
    const { handler, account } = setup({
      accounts: { maxFailures: 10, throttle: { burst: 2, interval: 60_000 } },
    })
    await account('alice')
    const derive = vi.spyOn(crypto.subtle, 'deriveBits')
    const client = await unregistered(handler, 'alice')
    for (const response of [plain('nobody', 'password1'), plain('alice', 'x', 'bob'), 'abc']) {
      await exchange(client, 'AUTHENTICATE PLAIN', `AUTHENTICATE ${response}`)
    }
    expect(derive).not.toHaveBeenCalled()
    const wrong = `AUTHENTICATE ${plain('alice', 'wrong password')}`
    await exchange(client, 'AUTHENTICATE PLAIN', wrong, 'AUTHENTICATE PLAIN', wrong)
    expect(derive).toHaveBeenCalledTimes(2)
    expect(await exchange(client, 'AUTHENTICATE PLAIN', wrong)).toEqual([
      ':irc.example AUTHENTICATE +',
      ':irc.example 904 alice :SASL authentication failed: too many attempts from your address, try again later',
    ])
    expect(derive).toHaveBeenCalledTimes(2)
  })

  it('Should do nothing for a connection that closes during the derivation', async () => {
    const { handler, account, state } = setup()
    await account('alice')
    const client = await unregistered(handler, 'alice')
    await exchange(client, 'AUTHENTICATE PLAIN')
    const server = state()
    const prepare = server.prepare.get('AUTHENTICATE')!
    server.prepare.set('AUTHENTICATE', async (target, message) => {
      target.connection.close()
      return prepare(target, message)
    })
    const [target] = server.clients.values()
    await client.send(`AUTHENTICATE ${plain('alice', 'password1')}`)
    expect((await client.all()).join('\n')).not.toMatch(/ 90\d /)
    expect(target.account).toBeUndefined()
  })
})

describe('The mechanisms', () => {
  it('Should send a challenge in chunks of 400 bytes', () => {
    expect(chunks(new Uint8Array())).toEqual(['+'])
    expect(chunks(new Uint8Array(300))).toEqual(['A'.repeat(400), '+'])
    expect(chunks(new Uint8Array(301))).toEqual(['A'.repeat(400), 'AA=='])
  })

  it('Should run a mechanism with a challenge', async () => {
    // A mechanism of two steps: the client sends its name, gets a challenge, and echoes it.
    mechanisms.set('X-ECHO', {
      maxResponse: () => 600,
      step: (server, client, response) => {
        const text = new TextDecoder().decode(response)
        if (text === 'alice') {
          return { challenge: new Uint8Array(300).fill(0x41) }
        }
        return text === 'A'.repeat(300) ? { account: 'alice' } : { fail: 'no' }
      },
    })
    try {
      const { handler } = setup()
      const client = await unregistered(handler, 'alice')
      const [ls] = await exchange(client, 'CAP LS 302')
      expect(ls).toContain(' sasl=PLAIN,X-ECHO ')
      const echo = Buffer.from('A'.repeat(300)).toString('base64')
      expect(
        await exchange(client, 'AUTHENTICATE X-ECHO', `AUTHENTICATE ${btoa('alice')}`)
      ).toEqual([
        ':irc.example AUTHENTICATE +',
        `:irc.example AUTHENTICATE ${echo}`,
        ':irc.example AUTHENTICATE +',
      ])
      expect(echo).toHaveLength(400)
      expect(await exchange(client, `AUTHENTICATE ${echo}`, 'AUTHENTICATE +')).toEqual(
        LOGGED_IN('alice')
      )
    } finally {
      mechanisms.delete('X-ECHO')
    }
  })
})

describe('A client that is logged in', () => {
  it('Should be shown by the capabilities that each client has', async () => {
    const { register, account } = setup()
    const alice = await register('alice')
    // Created after alice registered, as with a client that registers the account itself.
    await account('alice')
    await exchange(alice, 'JOIN #a')
    // Every combination of account-notify, account-tag, and extended-join.
    const names = ['account-notify', 'account-tag', 'extended-join']
    const observers: { caps: string[]; client: TestClient; mark: number }[] = []
    for (let i = 0; i < 8; i++) {
      const caps = names.filter((_, bit) => i & (1 << bit))
      const client = await register(`observer${i}`, caps)
      await exchange(client, 'JOIN #a')
      observers.push({ caps, client, mark: client.lines.length })
    }
    await login(alice, 'alice')
    await exchange(alice, 'PRIVMSG #a :hello', 'PART #a', 'JOIN #a')
    for (const { caps, client, mark } of observers) {
      await exchange(client, 'PING x')
      const lines = client.lines
        .slice(mark)
        .map(norm)
        .filter((line) => line.includes(':alice!'))
      const tag = caps.includes('account-tag') ? '@account=alice ' : ''
      expect(lines, caps.join(',')).toEqual([
        // Sent before the account was set, so without the tag.
        ...(caps.includes('account-notify') ? [':alice!~alice@host ACCOUNT alice'] : []),
        `${tag}:alice!~alice@host PRIVMSG #a hello`,
        `${tag}:alice!~alice@host PART #a`,
        caps.includes('extended-join')
          ? `${tag}:alice!~alice@host JOIN #a alice :alice the user`
          : `${tag}:alice!~alice@host JOIN #a`,
      ])
    }
  })

  it('Should send the account in the extended JOIN, or `*` without one', async () => {
    const { register } = setup()
    const bob = await register('bob', ['extended-join'])
    await exchange(bob, 'JOIN #a')
    const carol = await register('carol')
    await exchange(carol, 'JOIN #a')
    expect(norm(await bob.waitFor(/ JOIN /))).toBe(':carol!~carol@host JOIN #a * :carol the user')
  })

  it('Should show the account in WHOX and WHOIS', async () => {
    const { register, account } = setup()
    const alice = await register('alice')
    // Created after alice registered, as with a client that registers the account itself.
    await account('alice')
    const bob = await register('bob')
    expect(await exchange(bob, 'WHO alice %na')).toEqual([
      ':irc.example 354 bob alice 0',
      ':irc.example 315 bob alice :End of /WHO list',
    ])
    expect((await exchange(bob, 'WHOIS alice')).join('\n')).not.toContain(' 330 ')
    await login(alice, 'alice')
    expect(await exchange(bob, 'WHO alice %na')).toEqual([
      ':irc.example 354 bob alice alice',
      ':irc.example 315 bob alice :End of /WHO list',
    ])
    expect(await exchange(bob, 'WHOIS alice')).toContain(
      ':irc.example 330 bob alice alice :is logged in as'
    )
  })

  it('Should tell the clients that monitor it with extended-monitor and account-notify', async () => {
    const { register, account } = setup()
    const alice = await register('alice')
    // Created after alice registered, as with a client that registers the account itself.
    await account('alice')
    const watchers = [
      await register('w1', ['extended-monitor', 'account-notify']),
      await register('w2', ['account-notify']),
      await register('w3', ['extended-monitor']),
    ]
    const marks: number[] = []
    for (const watcher of watchers) {
      await exchange(watcher, 'MONITOR + alice')
      marks.push(watcher.lines.length)
    }
    await login(alice, 'alice')
    const got = await Promise.all(
      watchers.map(async (watcher, i) => {
        await exchange(watcher, 'PING x')
        return watcher.lines.slice(marks[i]).filter((line) => line.includes(' ACCOUNT '))
      })
    )
    expect(got.map((lines) => lines.map(norm))).toEqual([
      [':alice!~alice@host ACCOUNT alice'],
      [],
      [],
    ])
  })

  it('Should tag every message from it with account-tag, but not a forged tag', async () => {
    const { register, account } = setup()
    const alice = await register('alice', ['account-tag', 'echo-message', 'message-tags'])
    // Created after alice registered, as with a client that registers the account itself.
    await account('alice')
    const bob = await register('bob', ['account-tag', 'message-tags'])
    expect(await exchange(alice, '@account=forged PRIVMSG bob :before')).toEqual([
      '@msgid=ID :alice!~alice@host PRIVMSG bob before',
    ])
    expect(norm(await bob.waitFor(/ PRIVMSG /))).toBe(
      '@msgid=ID :alice!~alice@host PRIVMSG bob before'
    )
    await login(alice, 'alice')
    expect(await exchange(alice, '@account=forged;+x=1 TAGMSG bob')).toEqual([
      '@msgid=ID;account=alice;+x=1 :alice!~alice@host TAGMSG bob',
    ])
    expect(norm(await bob.waitFor(/ TAGMSG /))).toBe(
      '@msgid=ID;account=alice;+x=1 :alice!~alice@host TAGMSG bob'
    )
    await exchange(alice, 'JOIN #a')
    await exchange(bob, 'JOIN #a')
    await alice.send('NICK alice2', 'QUIT :bye')
    expect(norm(await bob.waitFor(/ NICK /))).toBe('@account=alice :alice!~alice@host NICK alice2')
    expect(norm(await bob.waitFor(/ QUIT /))).toBe(
      '@account=alice :alice2!~alice@host QUIT :Quit: bye'
    )
  })
})

describe('Reserved nicknames', () => {
  it('Should keep the name of an account from the clients not logged in to it', async () => {
    const { register, account } = setup()
    await account('alice')
    const bob = await register('bob')
    expect(await exchange(bob, 'NICK alice', 'NICK ALICE')).toEqual([
      ':irc.example 433 bob alice :Nickname is reserved by a different account',
      ':irc.example 433 bob ALICE :Nickname is reserved by a different account',
    ])
    await login(bob, 'alice')
    expect(await exchange(bob, 'NICK Alice')).toEqual([':bob!~bob@host NICK Alice'])
  })

  it('Should stop the registration with a reserved nickname, and release it', async () => {
    const { handler, account } = setup()
    await account('alice')
    await account('bob')
    const client = connect(handler)
    expect(await exchange(client, 'NICK alice', 'USER alice 0 * :Alice')).toEqual([
      ':irc.example 433 * alice :Nickname is reserved by a different account',
    ])
    // Logged in to another account, it is still not its nickname.
    const other = await unregistered(handler, 'alice')
    await exchange(other, 'AUTHENTICATE PLAIN', `AUTHENTICATE ${plain('bob', 'password1')}`)
    expect(await exchange(other, 'CAP END')).toEqual([
      ':irc.example 433 * alice :Nickname is reserved by a different account',
    ])
    expect((await exchange(client, 'NICK alice_'))[0]).toMatch(/ 001 alice_ /)
    expect((await exchange(other, 'NICK bob'))[0]).toMatch(/ 001 bob /)
  })

  it('Should tell both the abort of SASL and the reserved nickname', async () => {
    const { handler, account } = setup()
    await account('alice')
    const client = await unregistered(handler, 'alice')
    expect(await exchange(client, 'AUTHENTICATE PLAIN', 'CAP END')).toEqual([
      ':irc.example AUTHENTICATE +',
      // The nickname is released before the replies are sent.
      ':irc.example 906 * :SASL authentication aborted',
      ':irc.example 433 * alice :Nickname is reserved by a different account',
    ])
  })

  it('Should not reserve the nicknames when it is turned off', async () => {
    const { register, account } = setup({ accounts: { reserveNicknames: false } })
    await account('alice')
    const bob = await register('bob')
    expect(await exchange(bob, 'NICK alice')).toEqual([':bob!~bob@host NICK alice'])
    expect((await register('carol')).lines.join('\n')).toContain(' 001 carol ')
  })
})

describe('The flood control', () => {
  it('Should charge AUTHENTICATE its cost before the registration', async () => {
    const { handler } = setup({
      flood: { burst: 4, interval: 100, costs: { AUTHENTICATE: 2 } },
    })
    const client = connect(handler)
    await exchange(client, 'CAP REQ sasl', 'AUTHENTICATE PLAIN')
    // The bucket has 4 tokens: CAP REQ, AUTHENTICATE, and PING took 4.
    const start = Date.now()
    await exchange(client, 'AUTHENTICATE *')
    // AUTHENTICATE (2) and PING (1) wait for 3 tokens.
    expect(Date.now() - start).toBeGreaterThanOrEqual(250)
  })
})
