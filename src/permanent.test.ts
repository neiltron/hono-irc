import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { parse } from './protocol.ts'
import type { ServerOptions } from './server.ts'
import { memoryStore, nodeStore } from './store.ts'
import type { Store } from './store.ts'
import { connect, setup as serverSetup, transcript } from './test-utils.ts'

// The permanent channels (+P): what is stored, the founder, the restore, and the limits.

type TestClient = ReturnType<typeof connect>

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const setup = (config: ServerOptions = {}) => {
  const store = (config.database || memoryStore()) as Store
  const env = serverSetup({ name: 'irc.example', ...config, database: store })
  const rows = () =>
    store.query<{ folded: string }>('SELECT folded FROM channels').map((row) => row.folded)
  return { ...env, store, rows }
}

/** The replies without the tags and the source. */
const exchange = async (client: TestClient, ...lines: string[]) =>
  (await transcript(client, ...lines)).map((line) =>
    line.replace(/^(@\S+ )?:\S+ /, '').replace(/@[0-9a-f]{8}\.user/g, '@host')
  )

const quit = async (...clients: TestClient[]) => {
  for (const client of clients) {
    await client.send('QUIT')
    await client.all()
  }
}

describe('A channel of an account', () => {
  it('Should be permanent, with its founder as the operator', async () => {
    const { user, register, rows } = setup()
    const alice = await user('alice')
    expect(await exchange(alice, 'JOIN #a', 'MODE #a')).toEqual([
      'JOIN #a',
      '353 alice = #a @alice',
      '366 alice #a :End of /NAMES list',
      '324 alice #a +Pnt',
      expect.stringMatching(/^329 alice #a \d+$/),
    ])
    const guest = await register('guest')
    expect((await exchange(guest, 'JOIN #b', 'MODE #b'))[3]).toBe('324 guest #b +nt')
    expect(rows()).toEqual(['#a'])
  })

  it('Should not be permanent by default with persistChannels off', async () => {
    const { user, rows } = setup({ persistChannels: false })
    const alice = await user('alice')
    expect((await exchange(alice, 'JOIN #a', 'MODE #a'))[3]).toBe('324 alice #a +nt')
    expect(await exchange(alice, 'MODE #a +P', 'MODE #a')).toEqual([
      'MODE #a +P',
      '324 alice #a +Pnt',
      expect.stringMatching(/^329 /),
    ])
    expect(rows()).toEqual(['#a'])
  })
})

describe('Restoring a permanent channel', () => {
  it('Should keep its state when it is empty, and op only the founder', async () => {
    const { user, register, rows, server } = setup()
    const alice = await user('alice')
    await transcript(
      alice,
      'JOIN #Chan',
      'TOPIC #Chan :Kept topic',
      'MODE #Chan +kl-n secret 5',
      'MODE #Chan +bbeI bad!*@* worse!*@* good!*@* friend!*@*',
      'MODE #Chan +m'
    )
    await quit(alice)
    expect(server.channels.size).toBe(0)
    expect(rows()).toEqual(['#chan'])

    // The first to arrive is not made an operator, and needs the key.
    const bob = await register('bob')
    expect(await exchange(bob, 'JOIN #chan')).toEqual(['475 bob #Chan :Cannot join channel (+k)'])
    const joined = await exchange(bob, 'JOIN #chan secret', 'MODE #chan', 'MODE #chan b')
    expect(joined).toEqual([
      'JOIN #Chan',
      '332 bob #Chan :Kept topic',
      expect.stringMatching(/^333 bob #Chan alice!~alice@host \d+$/),
      '353 bob = #Chan bob',
      '366 bob #Chan :End of /NAMES list',
      '324 bob #Chan +Pklmt secret 5',
      expect.stringMatching(/^329 bob #Chan \d+$/),
      expect.stringMatching(/^367 bob #Chan bad!\*@\* alice!~alice@host \d+$/),
      expect.stringMatching(/^367 bob #Chan worse!\*@\* alice!~alice@host \d+$/),
      '368 bob #Chan :End of channel ban list',
    ])
    expect(await exchange(bob, 'PRIVMSG #chan :hi')).toEqual([
      '404 bob #Chan :Cannot send to channel',
    ])
    // The founder is an operator whenever it joins.
    const founder = await user('alice')
    expect(await exchange(founder, 'JOIN #chan secret', 'MODE #chan e', 'MODE #chan I')).toEqual([
      'JOIN #Chan',
      '332 alice #Chan :Kept topic',
      expect.stringMatching(/^333 /),
      '353 alice = #Chan :bob @alice',
      '366 alice #Chan :End of /NAMES list',
      expect.stringMatching(/^348 alice #Chan good!\*@\* alice!~alice@host \d+$/),
      '349 alice #Chan :End of channel exception list',
      expect.stringMatching(/^346 alice #Chan friend!\*@\* alice!~alice@host \d+$/),
      '347 alice #Chan :End of Channel Invite Exception List',
    ])
    // The changes are stored as they happen.
    await transcript(founder, 'MODE #chan -k+o-b * bob bad!*@*', 'TOPIC #chan :New topic')
    await quit(bob, founder)
    const carol = await register('carol')
    expect(await exchange(carol, 'JOIN #chan', 'MODE #chan', 'MODE #chan b')).toEqual([
      'JOIN #Chan',
      '332 carol #Chan :New topic',
      expect.stringMatching(/^333 carol #Chan alice!~alice@host \d+$/),
      '353 carol = #Chan carol',
      '366 carol #Chan :End of /NAMES list',
      '324 carol #Chan +Plmt 5',
      expect.stringMatching(/^329 /),
      expect.stringMatching(/^367 carol #Chan worse!\*@\* /),
      '368 carol #Chan :End of channel ban list',
    ])
  })

  it('Should survive a restart, with its history, from a database file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hono-irc-'))
    directories.push(directory)
    const file = join(directory, 'irc.sqlite')
    const caps = ['batch', 'server-time', 'message-tags', 'echo-message']

    let db = new DatabaseSync(file)
    const first = setup({ database: nodeStore(db) })
    const alice = await first.user('alice', caps)
    await transcript(
      alice,
      'JOIN #a',
      'TOPIC #a :Before the restart',
      'MODE #a +k key',
      'MODE #a +b bad!*@*'
    )
    const sent = await transcript(alice, 'PRIVMSG #a :one', 'PRIVMSG #a :two')
    const created = parse((await transcript(alice, 'MODE #a')).find((line) => / 329 /.test(line))!)!
    await quit(alice)
    db.close()

    db = new DatabaseSync(file)
    const second = setup({ database: nodeStore(db) })
    const bob = await second.register('bob')
    expect(await exchange(bob, 'JOIN #a', 'JOIN #a key')).toEqual([
      '475 bob #a :Cannot join channel (+k)',
      'JOIN #a',
      '332 bob #a :Before the restart',
      expect.stringMatching(/^333 /),
      '353 bob = #a bob',
      '366 bob #a :End of /NAMES list',
    ])
    const founder = await second.user('alice', caps)
    const lines = await transcript(founder, 'JOIN #a key', 'MODE #a')
    expect(lines.map((line) => line.replace(/^(@\S+ )?:\S+ /, ''))).toEqual(
      expect.arrayContaining([
        '353 alice = #a :bob @alice',
        '324 alice #a +Pknt key',
        `329 alice #a ${created.params.at(-1)}`,
      ])
    )
    expect(second.store.query('SELECT count(*) AS n FROM history')).toEqual([{ n: sent.length }])
    db.close()
  })
})

describe('The mode P', () => {
  it('Should be set and cleared by the founder only, from inside', async () => {
    const { user, register, rows } = setup()
    const alice = await user('alice')
    const bob = await user('bob')
    const guest = await register('guest')
    await transcript(alice, 'JOIN #a')
    await transcript(bob, 'JOIN #a')
    await transcript(guest, 'JOIN #a')
    await transcript(alice, 'MODE #a +o bob')
    expect(await exchange(bob, 'MODE #a -P')).toEqual([
      "482 bob #a :You're not the channel founder",
    ])
    expect(await exchange(guest, 'MODE #a -P')).toEqual([
      "482 guest #a :You're not the channel founder",
    ])
    await transcript(alice, 'PART #a')
    expect(await exchange(alice, 'MODE #a -P')).toEqual([
      "442 alice #a :You're not on that channel",
    ])
    await transcript(alice, 'JOIN #a')
    expect(await exchange(alice, 'MODE #a -P')).toEqual(['MODE #a -P'])
    expect(rows()).toEqual([])
    // A channel that is not permanent is not stored, and goes when it is empty.
    await quit(alice, bob, guest)
    const carol = await register('carol')
    expect((await exchange(carol, 'JOIN #a'))[1]).toBe('353 carol = #a @carol')
    // A channel without a founder can not be permanent.
    expect(await exchange(carol, 'MODE #a +P')).toEqual([
      "482 carol #a :You're not the channel founder",
    ])
  })

  it('Should be limited for each account, and on the server', async () => {
    const { user, rows } = setup({ permanentChannels: { maxPerAccount: 2, maxChannels: 3 } })
    const alice = await user('alice')
    const bob = await user('bob')
    await transcript(alice, 'JOIN #a1,#a2,#a3')
    expect(rows().sort()).toEqual(['#a1', '#a2'])
    expect((await exchange(alice, 'MODE #a3'))[0]).toBe('324 alice #a3 +nt')
    expect(await exchange(alice, 'MODE #a3 +P')).toEqual([
      '405 alice #a3 :Too many permanent channels',
    ])
    await transcript(bob, 'JOIN #b1,#b2')
    expect(rows().sort()).toEqual(['#a1', '#a2', '#b1'])
    // Making one ordinary makes room.
    await transcript(alice, 'MODE #a1 -P')
    expect(await exchange(bob, 'MODE #b2 +P')).toEqual(['MODE #b2 +P'])
  })
})

describe('An empty permanent channel', () => {
  it('Should be listed, and show its topic and modes, unless it is secret', async () => {
    const { user, register } = setup()
    const alice = await user('alice')
    await transcript(alice, 'JOIN #open,#hidden', 'TOPIC #open :Open topic', 'MODE #hidden +s')
    await transcript(alice, 'PART #open,#hidden')
    const bob = await register('bob')
    expect(
      await exchange(bob, 'LIST', 'TOPIC #open', 'MODE #open', 'TOPIC #hidden', 'MODE #hidden')
    ).toEqual([
      '321 bob Channel :Users  Name',
      '322 bob #open 0 :Open topic',
      '323 bob :End of /LIST',
      '332 bob #open :Open topic',
      expect.stringMatching(/^333 bob #open /),
      '324 bob #open +Pnt',
      expect.stringMatching(/^329 bob #open \d+$/),
      '403 bob #hidden :No such channel',
      '403 bob #hidden :No such channel',
    ])
  })

  it('Should be purged with its history when nobody has joined it for long', async () => {
    const { user, rows, store, server, state } = setup({ permanentChannels: { expire: 30 } })
    const alice = await user('alice')
    await transcript(alice, 'JOIN #a,#b', 'PRIVMSG #a :one', 'PRIVMSG #b :two')
    await transcript(alice, 'PART #a')
    await sleep(50)
    server.tick()
    // #b has a member, so it is in use.
    expect(rows()).toEqual(['#b'])
    expect(store.query('SELECT text FROM history')).toEqual([{ text: 'two' }])
    await transcript(alice, 'PART #b')
    state()!.expire(Date.now() + 1000)
    expect(rows()).toEqual([])
    expect(store.query('SELECT * FROM history')).toEqual([])
  })
})
