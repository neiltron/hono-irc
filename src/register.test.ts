import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { ServerOptions } from './server.ts'
import { nodeStore } from './store.ts'
import { connect, setup as serverSetup, transcript } from './test-utils.ts'

// Account registration (draft/account-registration), and the storage of the accounts.

// A low iteration count, so the tests are fast. The flood control is off.
const setup = (config: ServerOptions = {}) =>
  serverSetup({ name: 'irc.example', ...config, accounts: { iterations: 10, ...config.accounts } })

/** Hide what changes from run to run: the host of a mask, the time, and the message IDs. */
const norm = (line: string) =>
  line
    .replace(/@[0-9a-f]{8}\.user/g, '@host')
    .replace(/time=[^; ]+/g, 'time=T')
    .replace(/msgid=[^; ]+/g, 'msgid=ID')

const exchange = async (client: ReturnType<typeof connect>, ...lines: string[]) =>
  (await transcript(client, ...lines)).map(norm)

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('The capabilities', () => {
  it('Should advertise account registration as it behaves, with sasl', async () => {
    const { handler } = setup({ accounts: { minPasswordLength: 10, maxPasswordLength: 100 } })
    const client = connect(handler)
    const [ls] = await exchange(client, 'CAP LS 302')
    expect(ls).toContain(
      ' draft/account-registration=before-connect,min-password-length=10,max-password-length=100 '
    )
    expect(ls).toMatch(/ sasl=PLAIN /)
    expect(ls).toMatch(/[ :]account-notify account-tag /)
  })

  it('Should not advertise registration when it is closed, and refuse it', async () => {
    const { register } = setup({ accounts: { registration: 'closed' } })
    const alice = await register('alice')
    const [ls] = await exchange(alice, 'CAP LS 302')
    expect(ls).not.toContain('draft/account-registration')
    expect(ls).toContain('sasl=PLAIN')
    expect(await exchange(alice, 'CAP REQ draft/account-registration')).toEqual([
      ':irc.example CAP alice NAK draft/account-registration',
    ])
    expect(await exchange(alice, 'REGISTER * * password1')).toEqual([
      ':irc.example FAIL REGISTER TEMPORARILY_UNAVAILABLE * :Account registration is disabled',
    ])
  })

  it('Should have no accounts without a database', async () => {
    const { register, server } = setup({ database: false })
    const { accounts } = server
    expect(accounts).toBeUndefined()
    const alice = await register('alice')
    const [ls] = await exchange(alice, 'CAP LS 302')
    expect(ls).not.toMatch(/sasl|draft\/account-registration/)
    expect(
      await exchange(
        alice,
        'CAP REQ sasl',
        'AUTHENTICATE PLAIN',
        'REGISTER * * password1',
        'VERIFY * 123'
      )
    ).toEqual([
      ':irc.example CAP alice NAK sasl',
      ':irc.example 904 alice :SASL authentication failed',
      ':irc.example FAIL REGISTER TEMPORARILY_UNAVAILABLE * :Account registration is disabled',
      ':irc.example FAIL VERIFY TEMPORARILY_UNAVAILABLE alice :Account registration is disabled',
    ])
  })
})

describe('REGISTER', () => {
  it('Should register an account named after the nickname, and log the client in', async () => {
    const { register, server } = setup()
    const { accounts } = server
    const alice = await register('alice', ['account-notify'])
    const bob = await register('bob', ['account-notify'])
    const carol = await register('carol')
    for (const client of [alice, bob, carol]) {
      await exchange(client, 'JOIN #a')
    }
    expect(await exchange(alice, 'REGISTER * someone@example.com :correct horse')).toEqual([
      ':irc.example REGISTER SUCCESS alice :Account successfully registered',
      ':irc.example 900 alice alice!~alice@host alice :You are now logged in as alice',
      ':alice!~alice@host ACCOUNT alice',
    ])
    expect(norm(await bob.waitFor(/ ACCOUNT /))).toBe(':alice!~alice@host ACCOUNT alice')
    expect((await exchange(carol, 'PING x')).join('\n')).not.toContain('ACCOUNT')

    // Only a hash, with its parameters, and not the email, which is not stored.
    const stored = accounts!.store.query('SELECT * FROM accounts')
    expect(stored).toEqual([
      expect.objectContaining({ folded: 'alice', name: 'alice', algorithm: 'pbkdf2-sha256' }),
    ])
    expect(stored[0].iterations).toBe(10)
    const everything = JSON.stringify(
      accounts!.store
        .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .flatMap(({ name }) => accounts!.store.query(`SELECT * FROM ${name}`))
    )
    expect(everything).not.toMatch(/correct horse|example\.com/)
  })

  it('Should keep the case of the nickname, and fold the name like nicknames', async () => {
    const { register, server } = setup()
    const alice = await register('AliCe')
    expect((await exchange(alice, 'REGISTER aLICE * password1'))[0]).toBe(
      ':irc.example REGISTER SUCCESS AliCe :Account successfully registered'
    )
    expect(server.accounts!.get('ALICE')?.name).toBe('AliCe')
  })

  it('Should work before the registration, once the client has a nickname', async () => {
    const { handler } = setup()
    const client = connect(handler)
    expect(
      await exchange(
        client,
        'CAP LS 302',
        'CAP REQ draft/account-registration',
        'REGISTER * * password1'
      )
    ).toEqual([
      expect.stringContaining('CAP * LS * '),
      expect.stringContaining('CAP * LS '),
      ':irc.example CAP * ACK draft/account-registration',
      ':irc.example FAIL REGISTER NEED_NICK * :You must choose a nickname first',
    ])
    expect(await exchange(client, 'NICK dave', 'REGISTER * * password1')).toEqual([
      ':irc.example REGISTER SUCCESS dave :Account successfully registered',
      // No username yet.
      ':irc.example 900 dave dave!*@host dave :You are now logged in as dave',
    ])
    // The reserved nickname is its own.
    const welcome = await exchange(client, 'USER dave 0 * :Dave', 'CAP END', 'WHOIS dave')
    expect(welcome[0]).toMatch(/ 001 dave /)
    expect(welcome).toContain(':irc.example 330 dave dave dave :is logged in as')
  })

  it('Should refuse what the spec refuses', async () => {
    const { register, handler } = setup()
    const alice = await register('alice')
    const longname = await register('longname1')
    expect(
      await exchange(
        alice,
        'REGISTER * *',
        'REGISTER bad@name * password1',
        'REGISTER bob * password1',
        'REGISTER * * short',
        `REGISTER * * :${'x'.repeat(301)}`,
        'REGISTER * * :nul\0in password'
      )
    ).toEqual([
      ':irc.example 461 alice REGISTER :Not enough parameters',
      ':irc.example FAIL REGISTER BAD_ACCOUNT_NAME bad@name :An account name must be a valid nickname',
      ':irc.example FAIL REGISTER ACCOUNT_NAME_MUST_BE_NICK bob :The account name must be your current nickname',
      ':irc.example FAIL REGISTER WEAK_PASSWORD alice :The password must have at least 8 bytes and not be the account name',
      ':irc.example FAIL REGISTER UNACCEPTABLE_PASSWORD alice :The password must have at most 300 bytes and no NUL',
      ':irc.example FAIL REGISTER UNACCEPTABLE_PASSWORD alice :The password must have at most 300 bytes and no NUL',
    ])
    expect((await exchange(longname, 'REGISTER * * LONGNAME1'))[0]).toContain(' WEAK_PASSWORD ')

    expect((await exchange(alice, 'REGISTER * * password1'))[0]).toContain(' SUCCESS ')
    expect(await exchange(alice, 'REGISTER * * password1', 'VERIFY * code')).toEqual([
      ':irc.example FAIL REGISTER ALREADY_AUTHENTICATED alice :You are already logged in',
      ':irc.example FAIL VERIFY ALREADY_AUTHENTICATED alice :You are already logged in',
    ])
    // A client that has the name of an account as its nickname, before the registration.
    await alice.send('QUIT')
    await alice.all()
    const other = connect(handler)
    expect(await exchange(other, 'NICK Alice', 'REGISTER * * password2')).toEqual([
      ':irc.example FAIL REGISTER ACCOUNT_EXISTS Alice :Account already exists',
    ])
  })

  it('Should answer VERIFY, as nothing is ever pending verification', async () => {
    const { register } = setup()
    const alice = await register('alice')
    expect(await exchange(alice, 'VERIFY *', 'VERIFY * 123', 'VERIFY bob 123')).toEqual([
      ':irc.example 461 alice VERIFY :Not enough parameters',
      ':irc.example FAIL VERIFY INVALID_CODE alice :No verification is pending',
      ':irc.example FAIL VERIFY INVALID_CODE bob :No verification is pending',
    ])
  })

  it('Should limit the accounts of an address and of the server', async () => {
    const { register } = setup({ accounts: { maxPerAddress: 1, maxAccounts: 2 } })
    const a = await register('a', [], '192.0.2.1')
    const b = await register('b', [], '192.0.2.1')
    const c = await register('c', [], '192.0.2.2')
    const d = await register('d', [], '192.0.2.3')
    expect((await exchange(a, 'REGISTER * * password1'))[0]).toContain(' SUCCESS ')
    expect(await exchange(b, 'REGISTER * * password1')).toEqual([
      ':irc.example FAIL REGISTER TEMPORARILY_UNAVAILABLE b :Too many accounts have been registered, try again later',
    ])
    expect((await exchange(c, 'REGISTER * * password1'))[0]).toContain(' SUCCESS ')
    expect((await exchange(d, 'REGISTER * * password1'))[0]).toContain(' TEMPORARILY_UNAVAILABLE ')
  })

  it('Should count the IPv6 addresses of a /64 together', async () => {
    const { register } = setup({ accounts: { maxPerAddress: 1 } })
    const a = await register('a', [], '2001:db8::1')
    const b = await register('b', [], '2001:db8::2')
    const c = await register('c', [], '2001:db8:0:1::1')
    expect((await exchange(a, 'REGISTER * * password1'))[0]).toContain(' SUCCESS ')
    expect((await exchange(b, 'REGISTER * * password1'))[0]).toContain(' TEMPORARILY_UNAVAILABLE ')
    expect((await exchange(c, 'REGISTER * * password1'))[0]).toContain(' SUCCESS ')
  })

  it('Should throttle the derivations of an address, and derive only for a valid one', async () => {
    const { register } = setup({ accounts: { throttle: { burst: 1, interval: 60_000 } } })
    const derive = vi.spyOn(crypto.subtle, 'deriveBits')
    const a = await register('a', [], '192.0.2.1')
    const b = await register('b', [], '192.0.2.1')
    await exchange(a, 'REGISTER * * short', 'REGISTER x * password1')
    expect(derive).not.toHaveBeenCalled()
    expect((await exchange(a, 'REGISTER * * password1'))[0]).toContain(' SUCCESS ')
    expect(derive).toHaveBeenCalledTimes(1)
    expect(await exchange(b, 'REGISTER * * password1')).toEqual([
      ':irc.example FAIL REGISTER TEMPORARILY_UNAVAILABLE b :Too many attempts from your address, try again later',
    ])
    expect(derive).toHaveBeenCalledTimes(1)
  })

  it('Should label the response', async () => {
    const { register } = setup()
    const alice = await register('alice', ['labeled-response', 'batch'])
    expect(await exchange(alice, '@label=r1 REGISTER * * short')).toEqual([
      '@label=r1 :irc.example FAIL REGISTER WEAK_PASSWORD alice :The password must have at least 8 bytes and not be the account name',
    ])
    expect(await exchange(alice, '@label=r2 REGISTER * * password1')).toEqual([
      '@label=r2 :irc.example BATCH +1 labeled-response',
      '@batch=1 :irc.example REGISTER SUCCESS alice :Account successfully registered',
      '@batch=1 :irc.example 900 alice alice!~alice@host alice :You are now logged in as alice',
      ':irc.example BATCH -1',
    ])
  })

  it('Should do nothing for a connection that closes while the password is hashed', async () => {
    const { register, server: created, state } = setup()
    const { accounts } = created
    const alice = await register('alice')
    const server = state()
    const hash = server.prepare.get('REGISTER')!
    server.prepare.set('REGISTER', async (client, message) => {
      client.connection.close()
      return hash(client, message)
    })
    await alice.send('REGISTER * * password1')
    const lines = await alice.all()
    expect(lines.join('\n')).not.toMatch(/SUCCESS|FAIL/)
    expect(accounts!.get('alice')).toBeUndefined()
  })

  it('Should refuse the registration if hashing fails, without logging the password', async () => {
    const { register, server, state } = setup()
    const { accounts } = server
    const alice = await register('alice')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValue(new Error('no crypto'))
    expect(await exchange(alice, 'REGISTER * * password1')).toEqual([
      ':irc.example FAIL REGISTER TEMPORARILY_UNAVAILABLE alice :Account registration failed, try again',
    ])
    expect(error).toHaveBeenCalledTimes(1)
    const logged = error.mock.calls
      .flat()
      .map((arg) => (arg instanceof Error ? arg.stack : String(arg)))
    expect(logged.join('\n')).not.toContain('password1')
    expect(accounts!.get('alice')).toBeUndefined()
    expect(state().clients.size).toBe(1)
  })
})

describe('Persistence', () => {
  it('Should keep the accounts in a database file across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hono-irc-'))
    directories.push(directory)
    const file = join(directory, 'irc.sqlite')

    let db = new DatabaseSync(file)
    const first = setup({ database: nodeStore(db) })
    const alice = await first.register('alice')
    expect((await exchange(alice, 'REGISTER * * password1'))[0]).toContain(' SUCCESS ')
    await alice.end()
    db.close()

    db = new DatabaseSync(file)
    const second = setup({ database: nodeStore(db) })
    const client = connect(second.handler)
    const login = Buffer.from('alice\0alice\0password1').toString('base64')
    expect(
      await exchange(
        client,
        'CAP REQ sasl',
        'NICK alice',
        'USER alice 0 * :Alice',
        'AUTHENTICATE PLAIN',
        `AUTHENTICATE ${login}`
      )
    ).toEqual([
      ':irc.example CAP * ACK sasl',
      ':irc.example AUTHENTICATE +',
      ':irc.example 900 alice alice!~alice@host alice :You are now logged in as alice',
      ':irc.example 903 alice :SASL authentication successful',
    ])
    db.close()
  })
})
