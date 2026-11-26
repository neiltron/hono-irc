// A smoke test with a real IRC client library, irc-framework, against a running server.
//
//   PORT=6701 node src/node.ts &
//   node scripts/e2e.mjs [host] [port]
//
// It exits with 1 on the first failure or timeout.
import assert from 'node:assert/strict'
import IRC from 'irc-framework'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? process.env.PORT ?? 6667)
// A command may wait in the queue of `throttle()` for a while.
const TIMEOUT = 15_000

const log = (who, ...args) => console.log(`[${who}]`, ...args)

const fail = (error) => {
  console.error('FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
}
process.on('unhandledRejection', fail)
// The whole run must not take long, whatever hangs.
setTimeout(() => fail(new Error('the run took too long')), 120_000).unref()

/**
 * The server disconnects a client that floods it, so the clients pace themselves, as irssi and
 * WeeChat do, with the default budget of the server: 10 tokens, one back every 2 seconds, and
 * NICK, JOIN, and PART take more. One token is kept spare. irc-framework does not do this itself.
 */
const throttle = (bot) => {
  const write = bot.connection.write.bind(bot.connection)
  const costs = { NICK: 3, JOIN: 2, PART: 2 }
  const queue = []
  let tokens = 10
  let at = Date.now()
  let registered = false
  let timer
  // The server fills the bucket again once the client has registered.
  bot.on('registered', () => {
    registered = true
    tokens = 10
    at = Date.now()
  })
  const pump = () => {
    timer = undefined
    while (queue.length) {
      tokens = Math.min(10, tokens + (Date.now() - at) / 2000)
      at = Date.now()
      const [data, callback] = queue[0]
      const cost = registered ? (costs[data.split(' ')[0].toUpperCase()] ?? 1) : 1
      if (tokens - cost < 1) {
        timer = setTimeout(pump, (cost + 1 - tokens) * 2000)
        return
      }
      tokens -= cost
      queue.shift()
      write(data, callback)
    }
  }
  bot.connection.write = (data, callback) => {
    queue.push([data, callback])
    if (!timer) {
      pump()
    }
    return true
  }
}

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
    throttle(bot)
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

const alice = await connect('alice')
const bob = await connect('bob')

await step('registration and ISUPPORT', async () => {
  assert.ok(alice.network.cap.enabled.includes('echo-message'))
  assert.ok(alice.network.cap.enabled.includes('cap-notify'))
  assert.equal(alice.network.supports('TARGMAX'), 'PRIVMSG:4,NOTICE:4,KICK:4,NAMES:1,WHO:1,WHOIS:1')
  assert.equal(alice.network.supports('AWAYLEN'), '300')
  assert.equal(alice.network.supports('CASEMAPPING'), 'ascii')
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

await step('a client that floods is disconnected', async () => {
  const mallory = await connect('mallory')
  const error = line(mallory, /^ERROR /)
  // Past the throttle, straight to the socket.
  for (let i = 0; i < 12; i++) {
    mallory.connection.transport.writeLine(`PRIVMSG alice :${i}`)
  }
  assert.match(await error, /\(Excess Flood\)$/)
})

alice.quit()
console.log('PASS')
setTimeout(() => process.exit(0), 300)
