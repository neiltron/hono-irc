// A smoke test with a real IRC client library, irc-framework, against a running server.
//
//   PORT=6701 node src/node.ts &
//   node scripts/e2e.mjs [host] [port]
//
// It exits with 1 on the first failure or timeout.
import assert from 'node:assert/strict'
import { connect as connectSocket } from 'node:net'
import IRC from 'irc-framework'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? process.env.PORT ?? 6667)
// A client that sends a burst is slowed down by the flood control of the server, so a reply may
// take a few seconds.
const TIMEOUT = 15_000

const log = (who, ...args) => console.log(`[${who}]`, ...args)

const fail = (error) => {
  console.error('FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
}
process.on('unhandledRejection', fail)
// The whole run must not take long, whatever hangs.
setTimeout(() => fail(new Error('the run took too long')), 120_000).unref()

/** Wait for an event of the client that matches, or fail after a while. */
const once = (bot, event, match = () => true) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.removeListener(event, handler)
      reject(new Error(`timeout waiting for ${event} on ${bot.user.nick}`))
    }, TIMEOUT)
    const handler = (e) => {
      if (match(e)) {
        clearTimeout(timer)
        bot.removeListener(event, handler)
        resolve(e)
      }
    }
    bot.on(event, handler)
  })

/** Wait for a line from the server that matches the pattern. */
const line = (bot, pattern) =>
  once(bot, 'raw', (e) => e.from_server && pattern.test(e.line.trimEnd())).then((e) =>
    e.line.trimEnd()
  )

const connect = (nick, caps = ['echo-message']) =>
  new Promise((resolve, reject) => {
    const bot = new IRC.Client()
    for (const cap of caps) {
      bot.requestCap(cap)
    }
    bot.connect({ host, port, nick, username: nick, gecos: `${nick} real`, auto_reconnect: false })
    const timer = setTimeout(() => reject(new Error(`${nick} did not register`)), TIMEOUT)
    bot.on('registered', (e) => {
      clearTimeout(timer)
      log(nick, 'registered as', e.nick, 'caps:', [...bot.network.cap.enabled].join(','))
      resolve(bot)
    })
    bot.on('irc error', (e) => log(nick, 'irc error', e.error, e.reason ?? ''))
    bot.on(
      'raw',
      (e) => e.from_server && e.line.startsWith('ERROR ') && log(nick, e.line.trimEnd())
    )
  })

const step = async (name, fn) => {
  try {
    await fn()
  } catch (error) {
    fail(new Error(`${name}: ${error.message}`))
  }
  log('ok', name)
}

const users = (event) => event.users.map((u) => u.modes.join('') + u.nick).sort()

/** A message with tags, which irc-framework sends as it is with `raw()`. */
const tagged = (tags, command, ...params) =>
  Object.assign(new IRC.Message(command, ...params), { tags })

/**
 * A client on a plain socket, for what irc-framework does not speak, such as draft/multiline, or
 * bytes that are not UTF-8.
 */
const rawClient = async (nick, caps) => {
  const socket = connectSocket({ host, port })
  const lines = []
  let waiters = []
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (data) => {
    buffer += data
    const parts = buffer.split('\r\n')
    buffer = parts.pop()
    lines.push(...parts)
    for (const waiter of waiters) {
      waiter()
    }
  })
  const send = (...messages) => socket.write(messages.map((m) => m + '\r\n').join(''))
  let cursor = 0
  /** Wait for the next line that matches. The lines before it are skipped. */
  const waitFor = (pattern) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w !== check)
        reject(new Error(`timeout waiting for ${pattern} on ${nick}:\n${lines.join('\n')}`))
      }, TIMEOUT)
      const check = () => {
        while (cursor < lines.length) {
          const line = lines[cursor++]
          if (pattern.test(line)) {
            clearTimeout(timer)
            waiters = waiters.filter((w) => w !== check)
            resolve(line)
            return
          }
        }
      }
      waiters.push(check)
      check()
    })
  await new Promise((resolve) => socket.once('connect', resolve))
  send(
    'CAP LS 302',
    `CAP REQ :${caps.join(' ')}`,
    'CAP END',
    `NICK ${nick}`,
    `USER ${nick} 0 * :${nick}`
  )
  await waitFor(/ 376 /)
  return { socket, send, waitFor }
}

const alice = await connect('alice', ['echo-message', 'labeled-response'])
const bob = await connect('bob')

await step('registration and ISUPPORT', async () => {
  assert.ok(alice.network.cap.enabled.includes('echo-message'))
  assert.ok(alice.network.cap.enabled.includes('cap-notify'))
  assert.equal(
    alice.network.supports('TARGMAX'),
    'PRIVMSG:4,NOTICE:4,TAGMSG:4,KICK:4,NAMES:1,WHO:1,WHOIS:1'
  )
  // irc-framework asks for message-tags and batch itself, and alice for labeled-response.
  for (const cap of ['message-tags', 'batch', 'labeled-response']) {
    assert.ok(alice.network.cap.enabled.includes(cap), cap)
  }
  assert.equal(alice.network.supports('UTF8ONLY'), true)
  assert.ok(alice.network.supportsTag('typing'), 'CLIENTTAGDENY allows every client-only tag')
  assert.equal(alice.network.supports('AWAYLEN'), '300')
  assert.equal(alice.network.supports('CASEMAPPING'), 'ascii')
  assert.deepEqual(alice.network.supports('CHANMODES'), ['beI', 'k', 'l', 'imnst'])
  for (const [token, value] of Object.entries({
    EXCEPTS: true,
    INVEX: true,
    MAXLIST: 'beI:100',
    MODES: '4',
  })) {
    assert.equal(alice.network.supports(token), value, token)
  }
  // irc-framework asks for invite-notify when the server has it.
  assert.ok(alice.network.cap.enabled.includes('invite-notify'))
})

await step('join and names', async () => {
  let names = once(alice, 'userlist')
  alice.join('#hono')
  assert.deepEqual(users(await names), ['oalice'])
  const joined = once(alice, 'join', (e) => e.nick === 'bob')
  names = once(bob, 'userlist')
  bob.join('#hono')
  await joined
  assert.deepEqual(users(await names), ['bob', 'oalice'])
})

await step('topic', async () => {
  const topic = once(bob, 'topic')
  alice.setTopic('#hono', 'Hono beyond HTTP')
  assert.equal((await topic).topic, 'Hono beyond HTTP')
})

await step('channel message, server-time, and echo-message', async () => {
  const received = once(bob, 'privmsg')
  const echoed = once(alice, 'privmsg')
  alice.say('#hono', 'hello from alice')
  const message = await received
  assert.equal(message.nick, 'alice')
  assert.equal(message.message, 'hello from alice')
  assert.ok(message.time, 'server-time')
  assert.equal((await echoed).message, 'hello from alice')
})

await step('private message', async () => {
  const received = once(alice, 'privmsg', (e) => e.target === 'alice')
  bob.say('alice', 'psst, a DM')
  assert.equal((await received).message, 'psst, a DM')
})

await step('message-tags, message-ids, and TAGMSG', async () => {
  const received = once(bob, 'privmsg', (e) => e.message === 'tagged')
  const echoed = once(alice, 'privmsg', (e) => e.message === 'tagged')
  alice.say('#hono', 'tagged', { '+example.com/reply': 'abc' })
  const [message, echo] = await Promise.all([received, echoed])
  assert.equal(message.tags['+example.com/reply'], 'abc')
  assert.match(message.tags.msgid, /^[0-9A-Z]{26}$/)
  assert.equal(echo.tags.msgid, message.tags.msgid)
  const typing = once(bob, 'tagmsg')
  alice.tagmsg('#hono', { '+typing': 'active' })
  const event = await typing
  assert.equal(event.target, '#hono')
  assert.equal(event.tags['+typing'], 'active')
  assert.ok(event.tags.msgid)
})

await step('labeled-response and batch', async () => {
  const pong = line(alice, /^@\S*label=p1\S* \S+ PONG \S+ labeled$/)
  alice.raw(tagged({ label: 'p1' }, 'PING', 'labeled'))
  await pong
  const ack = line(alice, /^@\S*label=a1\S* \S+ ACK$/)
  alice.raw(tagged({ label: 'a1' }, 'PONG', 'x'))
  await ack
  // Several replies come in a batch, which irc-framework collects and handles at its end.
  const start = line(alice, /^@\S*label=w1\S* \S+ BATCH \+\S+ labeled-response$/)
  const batch = once(alice, 'batch end labeled-response')
  const whois = once(alice, 'whois', (e) => e.nick === 'bob')
  alice.raw(tagged({ label: 'w1' }, 'WHOIS', 'bob'))
  await start
  const commands = (await batch).commands.map((c) => c.command)
  assert.equal(commands.at(-1), '318')
  assert.equal((await whois).ident, '~bob')
  // The echo has the label, and the copy to the others does not.
  const echoed = line(alice, /^@\S*label=e1\S* :alice!\S+ PRIVMSG #hono :?labeled$/)
  const relayed = line(bob, / PRIVMSG #hono :?labeled$/)
  alice.raw(tagged({ label: 'e1' }, 'PRIVMSG', '#hono', 'labeled'))
  await echoed
  assert.ok(!(await relayed).includes('label='))
})

await step('draft/multiline from a raw client, and its fallback to irc-framework', async () => {
  const erin = await rawClient('erin', [
    'batch',
    'draft/multiline',
    'echo-message',
    'labeled-response',
    'message-tags',
  ])
  erin.send('JOIN #hono')
  await erin.waitFor(/ 366 erin #hono /)
  const received = []
  const done = new Promise((resolve) => {
    const handler = (e) => {
      if (e.nick === 'erin') {
        received.push(e)
        if (received.length === 3) {
          alice.removeListener('privmsg', handler)
          resolve()
        }
      }
    }
    alice.on('privmsg', handler)
  })
  erin.send(
    'BATCH +ml draft/multiline #hono',
    '@batch=ml PRIVMSG #hono hello',
    '@batch=ml PRIVMSG #hono :',
    '@batch=ml PRIVMSG #hono :how is ',
    '@batch=ml;draft/multiline-concat PRIVMSG #hono :everyone?',
    '@label=ml1 BATCH -ml'
  )
  const echo = await erin.waitFor(/^@\S*label=ml1\S* :erin!\S+ BATCH \+\S+ draft\/multiline #hono$/)
  await erin.waitFor(/^:erin!\S+ BATCH -/)
  await done
  // irc-framework does not have draft/multiline: the lines without the blank one, and the ID on
  // the first one, the same as the echo's.
  assert.deepEqual(
    received.map((e) => e.message),
    ['hello', 'how is ', 'everyone?']
  )
  assert.equal(received[0].tags.msgid, /msgid=([^; ]+)/.exec(echo)[1])
  assert.equal(received[1].tags.msgid, undefined)

  erin.send('BATCH +bad draft/multiline #hono', '@batch=bad PRIVMSG #other :x', 'BATCH -bad')
  await erin.waitFor(/ FAIL BATCH MULTILINE_INVALID_TARGET #hono #other :/)

  // UTF8ONLY: the line is rejected and not relayed, and the client stays.
  erin.socket.write(Buffer.from([...Buffer.from('PRIVMSG #hono :caf'), 0xe9, 13, 10]))
  await erin.waitFor(/ FAIL PRIVMSG INVALID_UTF8 :/)
  const after = once(alice, 'privmsg', (e) => e.nick === 'erin')
  erin.send('PRIVMSG #hono :café')
  assert.equal((await after).message, 'café')
  const quit = once(alice, 'quit', (e) => e.nick === 'erin')
  erin.send('QUIT')
  await quit
})

await step('mode, and multi-prefix in WHO', async () => {
  const mode = once(bob, 'mode')
  alice.raw('MODE #hono +v alice')
  assert.deepEqual((await mode).modes, [{ mode: '+v', param: 'alice' }])
  const who = await new Promise((resolve) => alice.who('#hono', resolve))
  const self = who.users.find((u) => u.nick === 'alice')
  // `H@+`: all the prefixes, as alice has multi-prefix, which irc-framework asks for.
  assert.deepEqual(self.channel_modes, ['o', 'v'])
})

await step('nick change and whois', async () => {
  const nick = once(alice, 'nick')
  bob.changeNick('robert')
  assert.equal((await nick).new_nick, 'robert')
  const whois = await new Promise((resolve) => alice.whois('robert', resolve))
  assert.equal(whois.nick, 'robert')
  assert.equal(whois.ident, '~bob')
  assert.equal(whois.real_name, 'bob real')
})

await step('ISON and USERHOST', async () => {
  const ison = line(alice, / 303 alice :/)
  alice.raw('ISON robert nobody alice')
  assert.match(await ison, / 303 alice :robert alice$/)
  const userhost = line(alice, / 302 alice /)
  alice.raw('USERHOST robert')
  assert.match(await userhost, / 302 alice :?robert=\+~bob@\S+$/)
})

await step('invite-only, INVITE, and invite-notify', async () => {
  let names = once(alice, 'userlist', (e) => e.channel === '#priv')
  alice.join('#priv')
  await names
  const mode = once(alice, 'mode', (e) => e.target === '#priv')
  alice.raw('MODE #priv +i')
  assert.deepEqual((await mode).modes, [{ mode: '+i', param: null }])
  const refused = once(bob, 'irc error', (e) => e.error === 'invite_only_channel')
  bob.join('#priv')
  assert.equal((await refused).channel, '#priv')
  const invited = once(alice, 'invited')
  const invite = once(bob, 'invite')
  alice.invite('#priv', 'robert')
  assert.deepEqual([(await invited).nick, (await invited).channel], ['robert', '#priv'])
  assert.deepEqual([(await invite).nick, (await invite).invited], ['alice', 'robert'])
  names = once(bob, 'userlist', (e) => e.channel === '#priv')
  bob.join('#priv')
  assert.deepEqual(users(await names), ['oalice', 'robert'])
})

await step('key and limit, parsed by CHANMODES', async () => {
  const modes = once(bob, 'mode', (e) => e.target === '#priv')
  alice.raw('MODE #priv -i+kl secret 5')
  assert.deepEqual((await modes).modes, [
    { mode: '-i', param: null },
    { mode: '+k', param: 'secret' },
    { mode: '+l', param: '5' },
  ])
  const parted = once(bob, 'part', (e) => e.channel === '#priv')
  bob.part('#priv')
  await parted
  const refused = once(bob, 'irc error', (e) => e.error === 'bad_channel_key')
  bob.join('#priv', 'wrong')
  assert.equal((await refused).channel, '#priv')
  const joined = once(bob, 'join', (e) => e.channel === '#priv' && e.nick === 'robert')
  bob.join('#priv', 'secret')
  await joined
  const removed = once(bob, 'mode', (e) => e.target === '#priv')
  alice.raw('MODE #priv -lk *')
  assert.deepEqual((await removed).modes, [
    { mode: '-l', param: null },
    { mode: '-k', param: '*' },
  ])
})

await step('bans, the ban list, and exceptions', async () => {
  const banned = once(bob, 'mode', (e) => e.target === '#priv')
  alice.ban('#priv', 'robert')
  assert.deepEqual((await banned).modes, [{ mode: '+b', param: 'robert!*@*' }])
  const list = await new Promise((resolve) => alice.banlist('#priv', resolve))
  assert.deepEqual(
    list.bans.map((ban) => [ban.banned, ban.banned_by.split('!')[0]]),
    [['robert!*@*', 'alice']]
  )
  // A banned member can not speak or change its nickname.
  const quiet = once(bob, 'irc error', (e) => e.error === 'cannot_send_to_channel')
  bob.say('#priv', 'can you hear me?')
  await quiet
  const nick = line(bob, / 435 robert /)
  bob.changeNick('bobby')
  await nick
  const kicked = once(bob, 'kick', (e) => e.channel === '#priv')
  alice.raw('KICK #priv robert')
  await kicked
  const refused = once(bob, 'irc error', (e) => e.error === 'banned_from_channel')
  bob.join('#priv')
  await refused
  const excepted = once(alice, 'mode', (e) => e.target === '#priv')
  alice.raw('MODE #priv +e *!~bob@*')
  await excepted
  const joined = once(bob, 'join', (e) => e.channel === '#priv' && e.nick === 'robert')
  bob.join('#priv')
  await joined
  const parted = once(bob, 'part', (e) => e.channel === '#priv')
  bob.part('#priv')
  await parted
})

await step('secret channels', async () => {
  const mode = once(alice, 'mode', (e) => e.target === '#priv')
  alice.raw('MODE #priv +s')
  await mode
  const listed = []
  const done = once(bob, 'channel list end')
  bob.on('channel list', (channels) => listed.push(...channels.map((c) => c.channel)))
  bob.list()
  await done
  assert.ok(listed.includes('#hono'), 'the public channel is listed')
  assert.ok(!listed.includes('#priv'), 'the secret channel is not')
})

await step('too many targets and a line that is too long', async () => {
  const tooMany = line(alice, / 407 alice /)
  alice.raw('PRIVMSG a,b,c,d,e :hi')
  assert.match(await tooMany, / 407 alice e :Too many targets$/)
  const tooLong = line(alice, / 417 alice /)
  alice.raw(`PRIVMSG robert :${'x'.repeat(600)}`)
  await tooLong
  // The connection is still open.
  const received = once(bob, 'privmsg', (e) => e.message === 'still here')
  alice.say('robert', 'still here')
  await received
})

await step('kick', async () => {
  const denied = line(bob, / 482 robert /)
  bob.raw('KICK #hono alice')
  await denied
  const kicked = once(bob, 'kick')
  alice.raw('KICK #hono robert :out')
  const kick = await kicked
  assert.equal(kick.kicked, 'robert')
  assert.equal(kick.message, 'out')
})

await step('echo-message from outside a channel without n', async () => {
  const mode = once(alice, 'mode')
  alice.raw('MODE #hono -n')
  await mode
  const received = once(alice, 'privmsg', (e) => e.target === '#hono')
  const echoed = once(bob, 'privmsg', (e) => e.target === '#hono')
  bob.say('#hono', 'from outside')
  assert.equal((await received).nick, 'robert')
  assert.equal((await echoed).message, 'from outside')
})

await step('invisible users are hidden from outside', async () => {
  const set = line(alice, / MODE alice :?\+i$/)
  alice.raw('MODE alice +i')
  await set
  const names = once(bob, 'userlist')
  bob.raw('NAMES #hono')
  assert.deepEqual(users(await names), [])
})

await step('away-notify', async () => {
  const names = once(bob, 'userlist')
  bob.join('#hono')
  await names
  const away = once(alice, 'away')
  bob.raw('AWAY :lunch')
  assert.equal((await away).message, 'lunch')
})

await step('quit', async () => {
  const quit = once(alice, 'quit')
  bob.quit('see ya')
  const event = await quit
  assert.equal(event.nick, 'robert')
  assert.equal(event.message, 'Quit: see ya')
})

await step('a connection that is dropped', async () => {
  const carol = await connect('carol')
  const joined = once(alice, 'join', (e) => e.nick === 'carol')
  carol.join('#hono')
  await joined
  const quit = once(alice, 'quit')
  carol.connection.transport.socket.destroy()
  assert.equal((await quit).nick, 'carol')
})

await step('a burst is delayed, and handled in full and in order', async () => {
  const dave = await connect('dave')
  const count = 14
  const received = []
  const done = new Promise((resolve) => {
    alice.on('privmsg', (e) => {
      if (e.nick === 'dave') {
        received.push(e.message)
        if (received.length === count) {
          resolve()
        }
      }
    })
  })
  const start = Date.now()
  // 10 at once, and then one every 2 seconds.
  for (let i = 0; i < count; i++) {
    dave.say('alice', `burst ${i}`)
  }
  await done
  const elapsed = Date.now() - start
  log('dave', `${count} messages in ${elapsed} ms`)
  assert.deepEqual(
    received,
    Array.from({ length: count }, (_, i) => `burst ${i}`)
  )
  assert.ok(elapsed >= 5000, `the burst was not delayed: ${elapsed} ms`)
  assert.ok(dave.connection.connected, 'dave is still connected')
})

alice.quit()
console.log('PASS')
setTimeout(() => process.exit(0), 300)
