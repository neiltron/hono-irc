import { tcp } from 'tcp-hono'
import { describe, expect, it } from 'vite-plus/test'
import { createServer } from './server.ts'
import type { ServerOptions } from './server.ts'
import { connect } from './test-utils.ts'

const setup = (config?: ServerOptions) => {
  const server = createServer(config)
  const handler = tcp.socket(server.app, server.options)
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Registration', () => {
  it('Should welcome a client after NICK and USER', async () => {
    const { handler } = setup({ name: 'irc.example', network: 'ExampleNet' })
    const client = connect(handler)
    await client.send('NICK alice', 'USER alice 0 * :Alice A')
    expect(await client.waitFor(/ 001 /)).toMatch(
      /^:irc\.example 001 alice :Welcome to the ExampleNet Network, alice!~alice@\w+\.user$/
    )
    expect(await client.waitFor(/ 005 /)).toContain('CASEMAPPING=ascii')
    await client.waitFor(/ 376 /)
  })

  it('Should reject a command before the registration', async () => {
    const { handler } = setup()
    const client = connect(handler)
    await client.send('JOIN #hono')
    expect(await client.waitFor(/ 451 /)).toContain('You have not registered')
  })

  it('Should reject a nickname that is in use or invalid', async () => {
    const { handler, register } = setup()
    await register('alice')
    const client = connect(handler)
    await client.send('NICK Alice')
    expect(await client.waitFor(/ 433 /)).toContain('433 * Alice :Nickname is already in use')
    await client.send('NICK 1abc')
    expect(await client.waitFor(/ 432 /)).toContain('Erroneous nickname')
    await client.send('NICK bob', 'USER bob 0 * :Bob')
    await client.waitFor(/ 001 bob /)
  })

  it('Should suspend the registration during the capability negotiation', async () => {
    const { handler } = setup()
    const client = connect(handler)
    await client.send('CAP LS 302', 'NICK alice', 'USER alice 0 * :Alice A')
    expect(await client.waitFor(/ CAP /)).toMatch(/ CAP \* LS :.*server-time/)
    await client.send('CAP REQ :server-time no-such-capability')
    expect(await client.waitFor(/ CAP /)).toContain('CAP alice NAK :server-time no-such-capability')
    await client.send('CAP REQ :server-time echo-message')
    expect(await client.waitFor(/ CAP /)).toContain('CAP alice ACK :server-time echo-message')
    await sleep(20)
    expect(client.lines.some((line) => line.includes(' 001 '))).toBe(false)
    await client.send('CAP END')
    expect(await client.waitFor(/ 001 /)).toMatch(/^@time=\d{4}-\d\d-\d\dT[\d:.]+Z :/)
  })

  it('Should reply to an unknown command and to missing parameters', async () => {
    const { register } = setup()
    const client = await register('alice')
    await client.send('BOGUS', 'PRIVMSG #hono', 'PING')
    expect(await client.waitFor(/ 421 /)).toContain('421 alice BOGUS :Unknown command')
    expect(await client.waitFor(/ 461 /)).toContain('461 alice PRIVMSG :Not enough parameters')
    expect(await client.waitFor(/ 461 /)).toContain('461 alice PING :Not enough parameters')
  })
})

describe('Channels', () => {
  it('Should deliver a message to the other members', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    const carol = await register('carol')

    await alice.send('JOIN #hono')
    expect(await alice.waitFor(/ JOIN /)).toMatch(/^:alice!~alice@\S+ JOIN #hono$/)
    // The first member is the operator.
    expect(await alice.waitFor(/ 353 /)).toContain('353 alice = #hono @alice')
    await bob.send('JOIN #hono')
    expect(await bob.waitFor(/ 353 /)).toContain('353 bob = #hono :@alice bob')
    expect(await alice.waitFor(/ JOIN /)).toMatch(/^:bob!~bob@\S+ JOIN #hono$/)

    await alice.send('PRIVMSG #hono :Hello World')
    expect(await bob.waitFor(/ PRIVMSG /)).toMatch(/^:alice!~alice@\S+ PRIVMSG #hono :Hello World$/)

    // Not a member, and the channel has the `n` mode.
    await carol.send('PRIVMSG #hono :Let me in')
    expect(await carol.waitFor(/ 404 /)).toContain('Cannot send to channel')
    await sleep(20)
    expect(alice.lines.some((line) => line.includes('Hello World'))).toBe(false)
    expect(bob.lines.some((line) => line.includes('Let me in'))).toBe(false)
  })

  it('Should echo a message to the sender with echo-message', async () => {
    const { register } = setup()
    const alice = await register('alice', ['echo-message'])
    await register('bob')
    await alice.send('JOIN #hono', 'PRIVMSG #hono :Hi', 'PRIVMSG bob :psst')
    expect(await alice.waitFor(/ PRIVMSG /)).toMatch(/^:alice!\S+ PRIVMSG #hono Hi$/)
    expect(await alice.waitFor(/ PRIVMSG /)).toMatch(/^:alice!\S+ PRIVMSG bob psst$/)
  })

  it('Should deliver a private message and tell that the user is away', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    await bob.send('AWAY :lunch')
    await bob.waitFor(/ 306 /)
    await alice.send('PRIVMSG bob :Are you there?', 'PRIVMSG nobody :Hello?')
    expect(await bob.waitFor(/ PRIVMSG /)).toMatch(/^:alice!\S+ PRIVMSG bob :Are you there\?$/)
    expect(await alice.waitFor(/ 301 /)).toContain('301 alice bob lunch')
    expect(await alice.waitFor(/ 401 /)).toContain('401 alice nobody :No such nick/channel')
  })

  it('Should let only an operator change the topic', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    await alice.send('JOIN #hono')
    await bob.send('JOIN #hono', 'TOPIC #hono :Mine')
    expect(await bob.waitFor(/ 482 /)).toContain("You're not channel operator")

    await alice.send('TOPIC #hono :Hono beyond HTTP')
    expect(await bob.waitFor(/ TOPIC /)).toMatch(/^:alice!\S+ TOPIC #hono :Hono beyond HTTP$/)
    await bob.send('TOPIC #hono')
    expect(await bob.waitFor(/ 332 /)).toContain('332 bob #hono :Hono beyond HTTP')

    // An empty topic clears it.
    await alice.send('TOPIC #hono :')
    expect(await bob.waitFor(/ TOPIC /)).toMatch(/ TOPIC #hono :$/)
    await bob.send('TOPIC #hono')
    expect(await bob.waitFor(/ 331 /)).toContain('No topic is set')
  })

  it('Should change the modes and kick a member', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    await alice.send('JOIN #hono')
    await bob.send('JOIN #hono')
    await bob.waitFor(/ 366 /)

    await alice.send('MODE #hono +mv bob')
    expect(await bob.waitFor(/ MODE /)).toMatch(/^:alice!\S+ MODE #hono \+mv bob$/)
    await bob.send('MODE #hono', 'NAMES #hono', 'KICK #hono alice')
    expect(await bob.waitFor(/ 324 /)).toContain('324 bob #hono +mnt')
    expect(await bob.waitFor(/ 353 /)).toContain(':@alice +bob')
    expect(await bob.waitFor(/ 482 /)).toContain("You're not channel operator")

    await alice.send('KICK #hono bob :Bye')
    expect(await bob.waitFor(/ KICK /)).toMatch(/^:alice!\S+ KICK #hono bob Bye$/)
    await bob.send('PRIVMSG #hono :Still here?')
    expect(await bob.waitFor(/ 404 /)).toContain('Cannot send to channel')
  })

  it('Should remove a channel when the last member leaves', async () => {
    const { server, register } = setup()
    const alice = await register('alice')
    await alice.send('JOIN #a,#b')
    await alice.waitFor(/ 366 alice #b /)
    expect([...server.channels.keys()]).toEqual(['#a', '#b'])
    await alice.send('PART #a :Bye', 'JOIN 0')
    expect(await alice.waitFor(/ PART /)).toMatch(/ PART #a Bye$/)
    expect(await alice.waitFor(/ PART /)).toMatch(/ PART #b$/)
    expect(server.channels.size).toBe(0)
  })
})

describe('Disconnection', () => {
  it('Should tell the others that a client has quit', async () => {
    const { server, register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    await alice.send('JOIN #hono')
    await bob.send('JOIN #hono')
    await alice.waitFor(/:bob\S+ JOIN /)

    await bob.send('QUIT :See you')
    expect(await bob.all()).toContainEqual(
      expect.stringMatching(/^ERROR :Closing Link: .*\(Quit: See you\)$/)
    )
    expect(await alice.waitFor(/ QUIT /)).toMatch(/^:bob!\S+ QUIT :Quit: See you$/)
    await bob.closed
    expect(server.clients.size).toBe(1)
  })

  it('Should tell the others that a connection is lost, and free the nickname', async () => {
    const { server, register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    await alice.send('JOIN #hono')
    await bob.send('JOIN #hono')
    await alice.waitFor(/:bob\S+ JOIN /)

    await bob.drop()
    expect(await alice.waitFor(/ QUIT /)).toMatch(/^:bob!\S+ QUIT :Connection closed$/)
    await bob.closed
    expect(server.clients.size).toBe(1)
    await register('bob')
  })

  it('Should ping a silent client and disconnect it if it does not answer', async () => {
    const { server, register } = setup({ name: 'irc.example', pingInterval: 30 })
    const alice = await register('alice')
    const bob = await register('bob')
    await alice.send('JOIN #hono')
    await bob.send('JOIN #hono')
    await bob.waitFor(/ 366 /)

    await sleep(40)
    server.tick()
    expect(await alice.waitFor(/^PING/)).toBe('PING :irc.example')
    expect(await bob.waitFor(/^PING/)).toBe('PING :irc.example')
    await alice.send('PONG :irc.example')

    await sleep(40)
    server.tick()
    expect(await bob.all()).toContainEqual(expect.stringMatching(/\(Ping timeout\)$/))
    expect(await alice.waitFor(/ QUIT /)).toMatch(/^:bob!\S+ QUIT :Ping timeout$/)
    expect(server.clients.size).toBe(1)
  })
})
