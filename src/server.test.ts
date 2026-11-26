import { describe, expect, it } from 'vite-plus/test'
import { createServer } from './server.ts'
import { connect, exchange, isupport, setup } from './test-utils.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The length of a line in bytes, with its CRLF and without its tags. */
const bytes = (line: string) => Buffer.byteLength(line.replace(/^@\S+ /, '')) + 2

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
    expect(await client.waitFor(/ 412 /)).toContain('412 alice :No text to send')
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

describe('Outbound messages', () => {
  it('Should send the replies of each channel after its JOIN', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const start = alice.lines.length
    await alice.send('JOIN #a,#b')
    await alice.waitFor(/ 366 alice #b /)
    expect(alice.lines.slice(start).map((line) => line.replace(/^:\S+ /, ''))).toEqual([
      'JOIN #a',
      '353 alice = #a @alice',
      '366 alice #a :End of /NAMES list',
      'JOIN #b',
      '353 alice = #b @alice',
      '366 alice #b :End of /NAMES list',
    ])
  })

  it('Should send a tag only to a client that has its capability', async () => {
    const { register } = setup()
    const alice = await register('alice', ['server-time', 'echo-message'])
    const bob = await register('bob')
    await alice.send('JOIN #hono')
    await bob.send('JOIN #hono')
    await bob.waitFor(/ 366 /)
    expect(await alice.waitFor(/:bob\S+ JOIN /)).toMatch(/^@time=\S+ :bob!\S+ JOIN #hono$/)
    // The messages from alice, who has server-time, are relayed to bob without the tag.
    await alice.send('PRIVMSG #hono :Hello', 'PRIVMSG bob :psst')
    expect(await alice.waitFor(/ PRIVMSG #hono /)).toMatch(/^@time=\S+ :alice!\S+ PRIVMSG/)
    expect(await bob.waitFor(/ PRIVMSG #hono /)).toMatch(/^:alice!\S+ PRIVMSG #hono Hello$/)
    expect(await bob.waitFor(/ PRIVMSG bob /)).toMatch(/^:alice!\S+ PRIVMSG bob psst$/)
    expect(bob.lines.filter((line) => line.startsWith('@'))).toEqual([])
  })
})

describe('Advertised features', () => {
  it('Should advertise each ISUPPORT token once, in lines that fit', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const lines = alice.lines.filter((line) => / 005 /.test(line))
    const tokens = isupport(alice.lines)
    const keys = tokens.map((token) => token.split('=')[0])
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual(
      [
        'AWAYLEN',
        'BOT',
        'CASEMAPPING',
        'CHANLIMIT',
        'CHANMODES',
        'CHANNELLEN',
        'CHANTYPES',
        'CLIENTTAGDENY',
        'EXCEPTS',
        'INVEX',
        'KEYLEN',
        'KICKLEN',
        'MAXLIST',
        'MODES',
        'MONITOR',
        'NAMELEN',
        'NETWORK',
        'NICKLEN',
        'PREFIX',
        'TARGMAX',
        'TOPICLEN',
        'UTF8ONLY',
        'WHOX',
      ].sort()
    )
    expect(tokens).toContain('TARGMAX=PRIVMSG:4,NOTICE:4,TAGMSG:4,KICK:4,NAMES:1,WHO:1,WHOIS:1')
    for (const line of lines) {
      expect(Buffer.byteLength(line) + 2).toBeLessThanOrEqual(512)
      expect(line.split(' ').slice(3, -5).length).toBeLessThanOrEqual(13)
    }
    expect(alice.lines.find((line) => / 004 /.test(line))).toMatch(
      / 004 alice irc\.hono\.local \S+ Bi Ibeiklmnostv Ibeklov$/
    )
  })

  it('Should list each capability once in CAP LS, in lines that fit', async () => {
    const { handler } = setup()
    const client = connect(handler)
    await client.send('CAP LS 302', 'CAP LS', 'PING :done')
    await client.waitFor(/ PONG /)
    const lines = client.lines.filter((line) => / CAP \* LS /.test(line))
    const caps = (version: string[]) =>
      version.flatMap((line) => line.slice(line.indexOf(' :') + 2).split(' '))
    const latest = caps(lines.slice(0, -1)).map((cap) => cap.split('=')[0])
    expect(new Set(latest).size).toBe(latest.length)
    expect([...latest].sort()).toEqual([
      'account-notify',
      'account-tag',
      'away-notify',
      'batch',
      'cap-notify',
      'draft/account-registration',
      'draft/multiline',
      'echo-message',
      'extended-join',
      'extended-monitor',
      'invite-notify',
      'labeled-response',
      'message-tags',
      'multi-prefix',
      'no-implicit-names',
      'sasl',
      'server-time',
      'setname',
      'standard-replies',
      'userhost-in-names',
    ])
    // CAP LS without a version: the names, in one line.
    expect(caps(lines.slice(-1))).toEqual(latest)
    for (const line of lines) {
      expect(Buffer.byteLength(line) + 2).toBeLessThanOrEqual(512)
    }
  })
})

describe('Registries', () => {
  it('Should list the values of the capabilities with CAP LS 302 only', async () => {
    const { server, handler } = setup()
    server.capabilities.set('sasl', 'PLAIN,EXTERNAL')
    const client = connect(handler)
    await client.send('CAP LS')
    const names = await client.waitFor(/ CAP /)
    expect(names).toMatch(/ CAP \* LS :.*\bsasl\b/)
    expect(names).not.toContain('sasl=')
    await client.send('CAP LS 302')
    expect(await client.waitFor(/ CAP /)).toMatch(/ CAP \* LS :.* sasl=PLAIN,EXTERNAL /)
    await client.send('CAP REQ :sasl', 'CAP REQ :sasl=PLAIN')
    expect(await client.waitFor(/ CAP /)).toContain('CAP * ACK sasl')
    expect(await client.waitFor(/ CAP /)).toContain('CAP * NAK sasl=PLAIN')
  })

  it('Should split a long CAP LS 302 reply into lines', async () => {
    const { server, handler } = setup()
    const fakes = Array.from({ length: 40 }, (_, i) => `draft/fake-capability-${i}`)
    for (const name of fakes) {
      server.capabilities.set(name, 'some,values')
    }
    const client = connect(handler)
    await client.send('CAP LS 302', 'PING :done')
    await client.waitFor(/ PONG /)
    const lines = client.lines.filter((line) => / CAP /.test(line))
    expect(lines.length).toBeGreaterThan(1)
    lines.forEach((line, i) => {
      expect(line.length).toBeLessThanOrEqual(512)
      if (i < lines.length - 1) {
        expect(line).toMatch(/^:\S+ CAP \* LS \* :/)
      } else {
        expect(line).toMatch(/^:\S+ CAP \* LS :/)
      }
    })
    const tokens = lines.flatMap((line) => line.slice(line.indexOf(' :') + 2).split(' '))
    expect(tokens).toEqual(expect.arrayContaining(fakes.map((name) => `${name}=some,values`)))
    expect(tokens).toContain('server-time')
    expect(tokens.length).toBe(server.capabilities.size)
  })

  it('Should split the ISUPPORT tokens into lines of 13', async () => {
    const { server, register } = setup()
    // The first 12 tokens of the server and 10 more, so the lines split at a known place.
    for (const key of [...server.isupport.keys()].slice(12)) {
      server.isupport.delete(key)
    }
    for (let i = 0; i < 10; i++) {
      server.isupport.set(`FAKE${i}`, i % 2 ? true : String(i))
    }
    const client = await register('alice')
    const lines = client.lines.filter((line) => / 005 /.test(line))
    const tokens = lines.map((line) => line.split(' ').slice(3, -5))
    expect(tokens.flat()).toHaveLength(server.isupport.size)
    expect(tokens.slice(0, -1).map((list) => list.length)).toEqual(Array(lines.length - 1).fill(13))
    expect(tokens.at(-1)!.length).toBeLessThanOrEqual(13)
    expect(lines[0]).toMatch(/ 005 alice CASEMAPPING=ascii /)
    expect(lines.at(-1)).toMatch(/ FAKE9 :are supported by this server$/)
    expect(tokens.flat().slice(-10)).toEqual(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? `FAKE${i}` : `FAKE${i}=${i}`))
    )
  })
})

describe('Connection', () => {
  it('Should give the information of the connection to the client', async () => {
    const { server } = setup()
    const alice = connect((socket) => server.connect(socket, { ip: '192.0.2.1', secure: true }))
    const bob = connect(server.connect)
    await alice.send('NICK alice', 'USER alice 0 * :Alice')
    await bob.send('NICK bob', 'USER bob 0 * :Bob')
    // The host is a cloak of the address, and a client without an address gets a random one.
    expect(await alice.waitFor(/ 001 /)).toMatch(/alice!~alice@[\da-f]{8}(\.[\da-f]{8}){2}\.ip4$/)
    expect(await bob.waitFor(/ 001 /)).toMatch(/bob!~bob@[\da-f]{8}\.user$/)
    const [first, second] = server.clients.values()
    expect([first.nick, first.ip, first.secure]).toEqual(['alice', '192.0.2.1', true])
    expect([second.nick, second.ip, second.secure]).toEqual(['bob', undefined, false])
  })
})

describe('Parameters', () => {
  it('Should reply with the numeric of each missing parameter', async () => {
    const { register } = setup()
    const alice = await register('alice')
    expect(
      await exchange(
        alice,
        'NICK',
        'PRIVMSG',
        'PRIVMSG alice',
        'PRIVMSG alice :',
        'NOTICE',
        'PING :',
        'CAP',
        'CAP REQ',
        'NAMES',
        'JOIN',
        'KICK #hono',
        'MODE',
        'ISON',
        'USERHOST'
      )
    ).toEqual([
      '431 alice :No nickname given',
      '411 alice :No recipient given (PRIVMSG)',
      '412 alice :No text to send',
      '412 alice :No text to send',
      '409 alice :No origin specified',
      '461 alice CAP :Not enough parameters',
      '461 alice CAP :Not enough parameters',
      '366 alice * :End of /NAMES list',
      '461 alice JOIN :Not enough parameters',
      '461 alice KICK :Not enough parameters',
      '461 alice MODE :Not enough parameters',
      '461 alice ISON :Not enough parameters',
      '461 alice USERHOST :Not enough parameters',
    ])
  })

  it('Should ignore the parameters that a command does not use', async () => {
    const { handler } = setup()
    const client = connect(handler)
    // The old form of USER, and a NICK with more than one parameter.
    await client.send('NICK alice extra', 'USER alice host server :Alice A')
    await client.waitFor(/ 001 alice /)
    expect(await exchange(client, 'PRIVMSG alice hello world', 'PING a b')).toEqual([
      'PRIVMSG alice hello',
      'PONG irc.hono.local a',
    ])
  })

  it('Should send back a parameter with a space as one word', async () => {
    const { register } = setup()
    const alice = await register('alice')
    expect(await exchange(alice, 'WHOIS :x y', 'NAMES :a b', 'CAP :x y')).toEqual([
      '401 alice x :No such nick/channel',
      '318 alice x :End of /WHOIS list',
      '366 alice a :End of /NAMES list',
      '410 alice X :Invalid CAP command',
    ])
  })
})

describe('Registration rules', () => {
  it('Should reject PASS and USER after the registration', async () => {
    const { register } = setup()
    const alice = await register('alice')
    expect(await exchange(alice, 'PASS secret', 'USER a 0 * :A')).toEqual([
      '462 alice :You may not reregister',
      '462 alice :You may not reregister',
    ])
  })

  it('Should enable cap-notify with CAP LS 302 and not let it be disabled', async () => {
    const { handler } = setup()
    const old = connect(handler)
    await old.send('CAP LS')
    await old.waitFor(/ CAP \* LS /)
    expect(await exchange(old, 'CAP LIST', 'CAP REQ :-cap-notify')).toEqual([
      'CAP * LIST :',
      'CAP * ACK -cap-notify',
    ])
    const client = connect(handler)
    await client.send('CAP LS 302')
    await client.waitFor(/ CAP \* LS /)
    expect(await exchange(client, 'CAP LIST', 'CAP REQ :-cap-notify', 'CAP REQ :')).toEqual([
      'CAP * LIST cap-notify',
      'CAP * NAK -cap-notify',
      'CAP * ACK :',
    ])
  })

  it('Should disconnect a client that does not register in time, whatever it sends', async () => {
    const { server, handler } = setup({ pingInterval: 100 })
    const client = connect(handler)
    await client.send('NICK alice')
    for (let i = 0; i < 4; i++) {
      await sleep(40)
      // The connection may be closed by now.
      await client.send('PING :keepalive', 'CAP LS').catch(() => {})
      server.tick()
    }
    expect(await client.all()).toContainEqual(expect.stringMatching(/\(Registration timeout\)$/))
    expect(server.clients.size).toBe(0)
  })

  it('Should not let the line terminator of a QUIT reason end the ERROR line', async () => {
    const { register } = setup()
    const alice = await register('alice')
    await alice.send('QUIT :bye\rPRIVMSG #x :injected')
    expect((await alice.all()).at(-1)).toMatch(
      /^ERROR :Closing Link: \S+ \(Quit: bye PRIVMSG #x :injected\)$/
    )
  })
})

describe('Targets', () => {
  it('Should drop repeated targets and send ERR_TOOMANYTARGETS over the limit', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    expect(await exchange(alice, 'PRIVMSG bob,BOB,bob,a,b,c,d :hi')).toEqual([
      '401 alice a :No such nick/channel',
      '401 alice b :No such nick/channel',
      '401 alice c :No such nick/channel',
      '407 alice d :Too many targets',
    ])
    expect(bob.lines.filter((line) => / PRIVMSG /.test(line))).toHaveLength(1)
  })

  it('Should not let one line flood the members of a channel', async () => {
    const { server, register } = setup()
    const members = await Promise.all(['v1', 'v2', 'v3'].map((nick) => register(nick)))
    for (const member of members) {
      await exchange(member, 'JOIN #r')
    }
    const mallory = await register('mallory')
    await exchange(mallory, 'JOIN #r')
    const targets = Array(60).fill('#r').join(',')
    expect(await exchange(mallory, `PRIVMSG ${targets} :${'A'.repeat(100)}`)).toEqual([])
    await exchange(members[0])
    const received = members.map(
      (member) => member.lines.filter((line) => / PRIVMSG #r /.test(line)).length
    )
    expect(received).toEqual([1, 1, 1])
    expect(server.clients.size).toBe(4)
  })

  it('Should take one target for NAMES, WHO, and WHOIS, and up to four for KICK', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const others = await Promise.all(['b', 'c', 'd', 'e', 'f'].map((nick) => register(nick)))
    await exchange(alice, 'JOIN #a')
    for (const other of others) {
      await exchange(other, 'JOIN #a')
    }
    const lines = await exchange(alice, 'NAMES #a,#b', 'WHO #a,#b', 'WHOIS e,f')
    expect(lines.filter((line) => !/^3(5[23]|1[1279]) /.test(line))).toEqual([
      '366 alice #a :End of /NAMES list',
      '407 alice #b :Too many targets',
      '407 alice #b :Too many targets',
      '315 alice #a,#b :End of /WHO list',
      '407 alice f :Too many targets',
      '318 alice e,f :End of /WHOIS list',
    ])
    expect(await exchange(alice, 'KICK #a b,C,c,nobody,d,e :Bye')).toEqual([
      'KICK #a b Bye',
      'KICK #a c Bye',
      "441 alice nobody #a :They aren't on that channel",
      'KICK #a d Bye',
      '407 alice e :Too many targets',
    ])
    expect(await others[0].waitFor(/ KICK /)).toMatch(/^:alice!\S+ KICK #a b Bye$/)
  })

  it('Should advertise the limits', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const tokens = alice.lines.filter((line) => / 005 /.test(line)).join(' ')
    expect(tokens).toContain(' TARGMAX=PRIVMSG:4,NOTICE:4,TAGMSG:4,KICK:4,NAMES:1,WHO:1,WHOIS:1 ')
    expect(tokens).toContain(' AWAYLEN=300 ')
    expect(tokens).toContain(' KICKLEN=300 ')
    expect(tokens).toContain(' CHANNELLEN=50 ')
  })
})

describe('Line length', () => {
  it('Should reply ERR_INPUTTOOLONG to a line that is too long and keep the connection', async () => {
    const { handler, register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    expect(await exchange(alice, `PRIVMSG bob :${'a'.repeat(500)}`)).toEqual([
      '417 alice :Input line was too long',
    ])
    // 4096 bytes of tags and 510 bytes of the rest are accepted.
    const tags = '@+a=' + 'x'.repeat(4091) + ' '
    const text = 'b'.repeat(510 - 'PRIVMSG bob :'.length)
    expect(await exchange(alice, tags + 'PRIVMSG bob :' + text)).toEqual([])
    expect(await bob.waitFor(/ PRIVMSG /)).toMatch(/ PRIVMSG bob b+$/)
    // A client that has not registered gets it too.
    const client = connect(handler)
    expect(await exchange(client, 'x'.repeat(600))).toEqual(['417 * :Input line was too long'])
  })

  it('Should keep every line to others within 512 bytes', async () => {
    const { register } = setup()
    const alice = await register('a'.repeat(30))
    const bob = await register('bob')
    const channel = '#' + '\u{1F600}'.repeat(12)
    await exchange(alice, `JOIN ${channel}`)
    await exchange(bob, `JOIN ${channel}`)
    // The message is cut on a character boundary.
    await exchange(alice, `PRIVMSG ${channel} :${'é'.repeat(220)}`)
    const relayed = await bob.waitFor(/ PRIVMSG /)
    expect(bytes(relayed)).toBeLessThanOrEqual(512)
    expect(bytes(relayed)).toBeGreaterThan(505)
    expect(relayed).toMatch(/ PRIVMSG \S+ é+$/)
    expect(relayed).not.toContain('�')
  })

  it('Should measure the lengths in bytes', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    expect(
      await exchange(alice, `JOIN #${'\u{1F600}'.repeat(13)}`, `JOIN #${'\u{1F600}'.repeat(12)}x`)
    ).toEqual([
      `403 alice #${'\u{1F600}'.repeat(13)} :No such channel`,
      `JOIN #${'\u{1F600}'.repeat(12)}x`,
      `353 alice = #${'\u{1F600}'.repeat(12)}x @alice`,
      `366 alice #${'\u{1F600}'.repeat(12)}x :End of /NAMES list`,
    ])
    await exchange(alice, 'JOIN #a')
    await exchange(bob, 'JOIN #a')
    await exchange(alice, `TOPIC #a :${'é'.repeat(240)}`, `KICK #a bob :${'é'.repeat(240)}`)
    expect(await bob.waitFor(/ TOPIC /)).toMatch(/ TOPIC #a é{195}$/)
    expect(await bob.waitFor(/ KICK /)).toMatch(/ KICK #a bob é{150}$/)
    await exchange(alice, `AWAY :${'é'.repeat(240)}`)
    expect((await exchange(bob, 'WHOIS alice')).find((line) => line.startsWith('301 '))).toMatch(
      /^301 bob alice é{150}$/
    )
  })

  it('Should split NAMES and WHOIS by bytes', async () => {
    const { register } = setup()
    const channel = '#' + '\u{1F600}'.repeat(12)
    const users = []
    for (let i = 0; i < 30; i++) {
      const user = await register(`u${'n'.repeat(27)}${String(i).padStart(2, '0')}`)
      await exchange(user, `JOIN ${channel}`)
      users.push(user)
    }
    const carol = await register('carol')
    for (let i = 0; i < 50; i++) {
      await carol.send(`JOIN #${'c'.repeat(45)}${String(i).padStart(3, '0')}`)
    }
    await exchange(carol)
    const dave = await register('d'.repeat(30), ['userhost-in-names', 'multi-prefix'])
    const names = (await exchange(dave, `NAMES ${channel}`)).filter((line) =>
      line.startsWith('353 ')
    )
    const whois = (await exchange(dave, 'WHOIS carol')).filter((line) => line.startsWith('319 '))
    expect(names.length).toBeGreaterThan(1)
    expect(whois.length).toBeGreaterThan(1)
    for (const line of [...names, ...whois]) {
      expect(bytes(`:irc.hono.local ${line}`)).toBeLessThanOrEqual(512)
    }
    const entries = names.flatMap((line) => line.slice(line.indexOf(' :') + 2).split(' '))
    expect(entries).toHaveLength(30)
    const channels = whois.flatMap((line) => line.slice(line.indexOf(' :') + 2).split(' '))
    expect(channels).toHaveLength(50)
  })
})

describe('Channel names', () => {
  it('Should fold ASCII letters only', async () => {
    const { server, register } = setup()
    const alice = await register('alice')
    await exchange(alice, 'JOIN #Ä', 'JOIN #ä', 'JOIN #HONO', 'JOIN #hono')
    expect([...server.channels.keys()]).toEqual(['#Ä', '#ä', '#hono'])
  })

  it('Should reject format characters', async () => {
    const { register } = setup()
    const alice = await register('alice')
    expect(await exchange(alice, 'JOIN #a‎b', 'JOIN #a‮b', 'JOIN #a​b')).toEqual([
      '403 alice #a‎b :No such channel',
      '403 alice #a‮b :No such channel',
      '403 alice #a​b :No such channel',
    ])
  })
})

describe('Queries', () => {
  it('Should show all the prefixes in WHO and WHOIS with multi-prefix', async () => {
    const { register } = setup()
    const alice = await register('alice', ['multi-prefix'])
    const bob = await register('bob')
    await exchange(alice, 'JOIN #a', 'MODE #a +v alice')
    await exchange(bob, 'JOIN #a')
    const lines = await exchange(alice, 'WHO #a', 'WHOIS alice')
    expect(lines).toContain(
      '352 alice #a ~alice ' +
        lines[0].split(' ')[4] +
        ' irc.hono.local alice H@+ :0 alice the user'
    )
    expect(lines).toContain('319 alice alice @+#a')
    // Without it, only the highest.
    expect((await exchange(bob, 'WHO #a')).find((line) => / alice H/.test(line))).toContain(' H@ ')
  })

  it('Should leave out the clients that have not registered', async () => {
    const { handler, register } = setup()
    const ghost = connect(handler)
    await exchange(ghost, 'NICK ghost')
    const alice = await register('alice')
    expect(await exchange(alice, 'WHO ghost', 'LUSERS')).toEqual([
      '315 alice ghost :End of /WHO list',
      '251 alice :There are 1 users and 0 invisible on 1 servers',
      '253 alice 1 :unknown connection(s)',
      '254 alice 0 :channels formed',
      '255 alice :I have 1 clients and 0 servers',
    ])
  })

  it('Should hide an invisible user from those outside its channel', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    const carol = await register('carol')
    expect(
      await exchange(alice, 'MODE alice +iw', 'MODE alice +i', 'MODE Alice', 'JOIN #a')
    ).toEqual([
      'MODE alice +i',
      '501 alice :Unknown MODE flag',
      '221 alice +i',
      'JOIN #a',
      '353 alice = #a @alice',
      '366 alice #a :End of /NAMES list',
    ])
    await exchange(bob, 'JOIN #a')
    // carol is outside the channel, and bob is in it.
    expect(await exchange(carol, 'NAMES #a', 'WHO #a', 'LUSERS')).toEqual([
      '353 carol = #a bob',
      '366 carol #a :End of /NAMES list',
      expect.stringMatching(/^352 carol #a ~bob /),
      '315 carol #a :End of /WHO list',
      '251 carol :There are 2 users and 1 invisible on 1 servers',
      '254 carol 1 :channels formed',
      '255 carol :I have 3 clients and 0 servers',
    ])
    expect(await exchange(bob, 'NAMES #a')).toEqual([
      '353 bob = #a :@alice bob',
      '366 bob #a :End of /NAMES list',
    ])
  })

  it('Should tell a user that does not exist from another user in MODE', async () => {
    const { register } = setup()
    const alice = await register('alice')
    await register('bob')
    expect(await exchange(alice, 'MODE bob +i', 'MODE nobody', 'MODE #nowhere')).toEqual([
      "502 alice :Can't change mode for other users",
      '401 alice nobody :No such nick/channel',
      '403 alice #nowhere :No such channel',
    ])
  })

  it('Should answer ISON and USERHOST', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    await exchange(bob, 'AWAY :lunch')
    const lines = await exchange(
      alice,
      'ISON Bob nobody alice',
      'ISON :bob alice',
      'USERHOST bob alice x'
    )
    expect(lines[0]).toBe('303 alice :bob alice')
    expect(lines[1]).toBe('303 alice :bob alice')
    expect(lines[2]).toMatch(/^302 alice :bob=-~bob@\w+\.user alice=\+~alice@\w+\.user$/)
  })

  it('Should measure the idle time from the last message', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    await exchange(alice, 'PRIVMSG bob :hi')
    await sleep(1100)
    await exchange(alice, 'PING x', 'PONG x', 'LUSERS')
    const idle = (await exchange(bob, 'WHOIS alice')).find((line) => line.startsWith('317 '))
    expect(idle).toMatch(/^317 bob alice 1 \d+ :seconds idle, signon time$/)
  })
})

describe('Channel rules', () => {
  it('Should echo a message from outside a channel without the n mode', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob', ['echo-message'])
    await exchange(alice, 'JOIN #a', 'MODE #a -n')
    expect(await exchange(bob, 'PRIVMSG #a :hi')).toEqual(['PRIVMSG #a hi'])
    expect(await alice.waitFor(/ PRIVMSG /)).toMatch(/^:bob!\S+ PRIVMSG #a hi$/)
  })

  it('Should reply ERR_NOTONCHANNEL to a KICK from outside', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    await exchange(alice, 'JOIN #a')
    expect(await exchange(bob, 'KICK #a alice')).toEqual(["442 bob #a :You're not on that channel"])
  })

  it('Should tell the others of an AWAY only when it changes', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob', ['away-notify'])
    await exchange(alice, 'JOIN #a')
    await exchange(bob, 'JOIN #a')
    await exchange(alice, 'AWAY', 'AWAY :lunch', 'AWAY :lunch', 'AWAY', 'AWAY')
    await exchange(bob)
    expect(
      bob.lines
        .filter((line) => / AWAY( |$)/.test(line))
        .map((line) => line.split(' ').slice(1).join(' '))
    ).toEqual(['AWAY lunch', 'AWAY'])
  })

  it('Should limit the number of channels on the server', async () => {
    const { register } = setup({ maxChannels: 2 })
    const alice = await register('alice')
    const lines = await exchange(alice, 'JOIN #a,#b,#c')
    expect(lines.at(-1)).toBe('471 alice #c :Cannot join channel (too many channels)')
  })
})

describe('Flood control', () => {
  /** Connect a client that registers with NICK and USER only, which take 2 tokens. */
  const registered = async (handler: ReturnType<typeof setup>['handler'], nick: string) => {
    const client = connect(handler)
    await client.send(`NICK ${nick}`, `USER ${nick} 0 * :${nick}`)
    await client.waitFor(/ 376 /)
    return client
  }
  const pongs = (client: ReturnType<typeof connect>) =>
    client.lines.filter((line) => / PONG /.test(line)).map((line) => line.split(' ').at(-1))

  it('Should delay a client that sends too much, and handle all of it in order', async () => {
    const { server, handler } = setup({ flood: { burst: 3, interval: 20 } })
    const alice = await registered(handler, 'alice')
    const bob = await registered(handler, 'bob')
    await bob.send('JOIN #a')
    await bob.waitFor(/ 366 /)
    await alice.send('JOIN #a')
    await bob.waitFor(/:alice\S+ JOIN /)
    await sleep(60)
    const start = Date.now()
    await alice.send(...Array.from({ length: 10 }, (_, i) => `PRIVMSG #a :${i}`))
    await bob.waitFor(/ PRIVMSG #a 9$/)
    // 3 at once, and then one every 20 ms.
    expect(Date.now() - start).toBeGreaterThanOrEqual(120)
    const received = bob.lines.filter((line) => / PRIVMSG /.test(line))
    expect(received.map((line) => line.split(' ').at(-1))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i))
    )
    expect(alice.lines.some((line) => line.startsWith('ERROR'))).toBe(false)
    expect(server.clients.size).toBe(2)
  })

  it('Should not delay the others', async () => {
    const { handler } = setup({ flood: { burst: 1, interval: 100 } })
    const alice = await registered(handler, 'alice')
    const bob = await registered(handler, 'bob')
    await sleep(110)
    await alice.send(...Array.from({ length: 6 }, (_, i) => `PING a${i}`))
    await alice.waitFor(/ PONG \S+ a0$/)
    const start = Date.now()
    await bob.send('PING b')
    await bob.waitFor(/ PONG \S+ b$/)
    expect(Date.now() - start).toBeLessThan(50)
    // alice is still waiting for hers.
    expect(pongs(alice).length).toBeLessThan(6)
    await alice.waitFor(/ PONG \S+ a5$/)
    expect(pongs(alice)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5'])
  })

  it('Should stop waiting when the connection is closed', async () => {
    const { server, handler } = setup({ pingInterval: 100, flood: { burst: 1, interval: 60_000 } })
    const client = connect(handler)
    // Before the registration, each line takes one token, so the second one waits a minute.
    await client.send('PING a', 'PING b', 'PING c')
    await client.waitFor(/ PONG \S+ a$/)
    await sleep(120)
    const start = Date.now()
    // The registration timeout closes the connection while its command waits.
    server.tick()
    await client.closed
    expect(Date.now() - start).toBeLessThan(200)
    expect(await client.all()).toEqual([
      ':irc.hono.local PONG irc.hono.local a',
      expect.stringMatching(/\(Registration timeout\)$/),
    ])
    expect(server.clients.size).toBe(0)
  })

  it('Should not time out a client whose PONG waits behind its own commands', async () => {
    const { server, handler } = setup({ pingInterval: 20, flood: { burst: 1, interval: 100 } })
    const alice = await registered(handler, 'alice')
    await sleep(110)
    // Each command waits 100 ms, which is longer than the ping timeout of 40 ms.
    await alice.send('PING a', 'PING b', 'PING c', 'PONG :irc.hono.local')
    const ticking = setInterval(server.tick, 5)
    try {
      await alice.waitFor(/ PONG \S+ c$/)
    } finally {
      clearInterval(ticking)
    }
    expect(pongs(alice)).toEqual(['a', 'b', 'c'])
    expect(alice.lines.some((line) => line.startsWith('ERROR'))).toBe(false)
    expect(server.clients.size).toBe(1)
  })

  it('Should be on by default', async () => {
    const server = createServer()
    const client = connect(server.connect)
    await client.send('NICK alice', 'USER alice 0 * :Alice')
    await client.waitFor(/ 376 /)
    // The bucket is full after the registration: 10 at once, and the 11th waits for 2 seconds.
    await client.send(...Array.from({ length: 11 }, (_, i) => `PING ${i}`))
    await client.waitFor(/ PONG \S+ 9$/)
    await sleep(100)
    expect(pongs(client)).toHaveLength(10)
    for (const { connection } of server.clients.values()) {
      connection.close()
    }
    await client.closed
  })
})

describe('Connection limits', () => {
  it('Should refuse a connection over the limit', async () => {
    const { server, handler, register } = setup({ maxConnections: 2 })
    await register('alice')
    await register('bob')
    const carol = connect(handler)
    expect(await carol.all()).toEqual(['ERROR :Closing Link: * (Too many connections)'])
    await carol.closed
    // `onClose()` of the refused connection has nothing to clean up.
    expect([...server.clients.values()].map((client) => client.nick)).toEqual(['alice', 'bob'])
  })

  it('Should refuse too many connections from one address', async () => {
    const { server } = setup({ maxConnectionsPerIp: 2 })
    const from = (ip: string) => connect((socket) => server.connect(socket, { ip }))
    const first = from('192.0.2.1')
    from('192.0.2.1')
    from('198.51.100.1')
    expect(await from('192.0.2.1').all()).toEqual([
      'ERROR :Closing Link: * (Too many connections from your address)',
    ])
    expect(server.clients.size).toBe(3)
    await first.end()
    await first.closed
    const again = from('192.0.2.1')
    await again.send('NICK again', 'USER a 0 * :A')
    await again.waitFor(/ 001 again /)
  })
})
