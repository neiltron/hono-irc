import { describe, expect, it } from 'vite-plus/test'
import { Hono, getConnection, tcp } from 'tcp-hono'
import { INPUT_TOO_LONG, byteLength, format, irc, parse, tagsLength, truncate } from './protocol.ts'
import { connect } from './test-utils.ts'

const encoder = new TextEncoder()

/** Decode chunks with a new decoder and return the arguments of the messages. */
const decodeAll = (chunks: string[]) => {
  const decode = irc().decode()
  return chunks.flatMap((chunk) => [...decode(encoder.encode(chunk))].map((m) => m.args))
}

describe('IRC', () => {
  it('Should parse a message', () => {
    expect(parse('PING')).toEqual({ command: 'PING', params: [] })
    expect(parse('privmsg #hono :Hello World')).toEqual({
      command: 'PRIVMSG',
      params: ['#hono', 'Hello World'],
    })
    expect(parse(':nick!user@host PRIVMSG #hono ::)')).toEqual({
      source: 'nick!user@host',
      command: 'PRIVMSG',
      params: ['#hono', ':)'],
    })
    expect(parse('TOPIC #hono :')).toEqual({ command: 'TOPIC', params: ['#hono', ''] })
    expect(parse('  USER  guest  0 *   :Real Name ')).toEqual({
      command: 'USER',
      params: ['guest', '0', '*', 'Real Name '],
    })
    expect(parse('')).toBeUndefined()
    expect(parse('@only=tags')).toBeUndefined()
  })

  it('Should parse message tags', () => {
    expect(
      parse('@time=2026-11-26T00:00:00.000Z;draft/flag;+a=b\\:c\\sd\\\\ :src TAGMSG #hono')
    ).toEqual({
      tags: { time: '2026-11-26T00:00:00.000Z', 'draft/flag': '', '+a': 'b;c d\\' },
      source: 'src',
      command: 'TAGMSG',
      params: ['#hono'],
    })
  })

  it('Should drop NUL from a tag value and measure the tags', () => {
    expect(format({ tags: { a: 'b\0c' }, command: 'PING', params: [] })).toBe('@a=bc PING')
    expect(tagsLength({ a: 'b c', d: '' })).toBe('a=b\\sc;d'.length)
  })

  it('Should format a message', () => {
    expect(format({ command: 'PING', params: ['token'] })).toBe('PING token')
    expect(
      format({ source: 'irc.example', command: '001', params: ['nick', 'Welcome to IRC'] })
    ).toBe(':irc.example 001 nick :Welcome to IRC')
    expect(format({ command: 'TOPIC', params: ['#hono', ''] })).toBe('TOPIC #hono :')
    expect(format({ command: 'PRIVMSG', params: ['#hono', ':)'] })).toBe('PRIVMSG #hono ::)')
    expect(
      format({ tags: { time: 'now', flag: '', a: 'b;c d\\' }, command: 'PING', params: [] })
    ).toBe('@time=now;flag;a=b\\:c\\sd\\\\ PING')
  })

  it('Should not let a parameter inject a line', () => {
    expect(format({ command: 'PRIVMSG', params: ['#hono', 'a\r\nQUIT'] })).toBe(
      'PRIVMSG #hono :a  QUIT'
    )
  })

  it('Should round-trip', () => {
    for (const line of [
      '@a=b\\:c;d :nick!user@host PRIVMSG #hono :Hello World',
      ':irc.example 353 nick = #hono :@alice +bob carol',
      'JOIN #a,#b key',
    ]) {
      expect(format(parse(line)!)).toBe(line)
    }
  })

  it('Should decode messages', () => {
    expect(decodeAll(['NICK alice\r\nUSER alice 0 * :Alice A\r\n'])).toEqual([
      ['NICK', 'alice'],
      ['USER', 'alice', '0', '*', 'Alice A'],
    ])
    expect(decodeAll(['PRIVMSG #ho', 'no :Hi\n', '\r\n'])).toEqual([['PRIVMSG', '#hono', 'Hi']])
  })

  it('Should route by the command and the parameters', async () => {
    const app = new Hono()
    app.on('TCP', '/PING/:token', (c) => c.text(`PONG :${c.req.param('token')}`))
    app.on('TCP', '/PRIVMSG/:target/:text', (c) => {
      const { target, text } = c.req.param()
      // IRC is not a request/response protocol. Most of the output is pushed.
      getConnection(c).send(`:me PRIVMSG ${target} :${text.toUpperCase()}\r\n`)
      return c.body(null)
    })
    app.on('TCP', '/TOPIC/:channel/*', async (c) => {
      const message = parse(await c.req.text())!
      return c.text(`params=${JSON.stringify(message.params)}`)
    })
    const client = connect(tcp.socket(app, { protocol: irc() }))
    await client.send('PING :a b', 'PRIVMSG #hono :Hello World', 'TOPIC #hono :', 'BOGUS x')
    expect(await client.end()).toEqual([
      'PONG :a b',
      ':me PRIVMSG #hono :HELLO WORLD',
      'params=["#hono",""]',
      '421 * BOGUS :Unknown command',
    ])
  })

  it('Should ignore a line without a line terminator at the end of the stream', async () => {
    const app = new Hono()
    app.on('TCP', '/PING/:token', (c) => c.text(`PONG :${c.req.param('token')}`))
    const client = connect(tcp.socket(app, { protocol: irc() }))
    await client.send('PING a\r\nPING b\nPING c')
    // `send()` terminates the last line, so cut it off again.
    expect((await client.end()).slice(0, 2)).toEqual(['PONG :a', 'PONG :b'])
  })

  it('Should route a line that is too long as INPUT_TOO_LONG and go on', async () => {
    const app = new Hono()
    app.on('TCP', '/PING/:token', (c) => c.text(`PONG :${c.req.param('token')}`))
    app.on('TCP', '/' + encodeURIComponent(INPUT_TOO_LONG), async (c) => {
      return c.text(`too long, body=${JSON.stringify(await c.req.text())}`)
    })
    const client = connect(tcp.socket(app, { protocol: irc() }))
    await client.send('PING ' + 'a'.repeat(600), 'PING b')
    expect(await client.end()).toEqual(['too long, body=""', 'PONG :b'])
  })

  it('Should keep the tags of a line that is too long, if they are whole', () => {
    const decode = irc().decode()
    const tooLong = (chunks: string[]) =>
      chunks.flatMap((chunk) =>
        [...decode(encoder.encode(chunk))].map((m) => [m.args, new TextDecoder().decode(m.body)])
      )
    expect(tooLong([`@label=a;+b=c PING ${'a'.repeat(600)}\r\n`])).toEqual([
      [[INPUT_TOO_LONG], '@label=a;+b=c'],
    ])
    // Reported before the end of the line, from the first chunks.
    expect(tooLong(['@label=b PI', `NG ${'a'.repeat(6000)}`, '\r\n'])).toEqual([
      [[INPUT_TOO_LONG], '@label=b'],
    ])
    expect(tooLong([`@a=${'x'.repeat(4100)} PING a\r\n`, `PING ${'a'.repeat(600)}\r\n`])).toEqual([
      [[INPUT_TOO_LONG], ''],
      [[INPUT_TOO_LONG], ''],
    ])
  })

  it('Should reply ERR_INPUTTOOLONG for an app without a route for it', async () => {
    const client = connect(tcp.socket(new Hono(), { protocol: irc({ maxLength: 16 }) }))
    await client.send('PRIVMSG #hono :' + 'a'.repeat(32))
    expect(await client.end()).toEqual(['417 * :Input line was too long'])
  })

  it('Should give up on a line that does not end', () => {
    const decode = irc({ maxSkipLength: 6000 }).decode()
    const messages: string[][] = []
    const read = (chunk: string) => {
      for (const message of decode(encoder.encode(chunk))) {
        messages.push(message.args)
      }
    }
    // Past 4096 + 512 bytes without a line terminator, the line is too long at once.
    read('PING ' + 'a'.repeat(4000))
    expect(messages).toEqual([])
    read('a'.repeat(1000))
    expect(messages).toEqual([[INPUT_TOO_LONG]])
    read('a'.repeat(900))
    // tcp-hono closes the connection with `ERROR :Line too long` for this.
    expect(() => read('a'.repeat(200))).toThrow('Line too long')
  })
})

describe('Line limits', () => {
  const tags = (length: number) => '@a=' + 'x'.repeat(length - 4) + ' '

  it('Should allow 4096 bytes of tags and 512 bytes of the rest', () => {
    const rest = 'PING ' + 'a'.repeat(505)
    expect(decodeAll([`${tags(4096)}${rest}\r\n`])).toEqual([['PING', 'a'.repeat(505)]])
    expect(decodeAll([`${tags(4097)}PING a\r\n`])).toEqual([[INPUT_TOO_LONG]])
    expect(decodeAll([`${rest}a\r\n`])).toEqual([[INPUT_TOO_LONG]])
    // A line with LF only has one byte less of the line terminator.
    expect(decodeAll([`${rest}a\n`])).toEqual([['PING', 'a'.repeat(506)]])
  })

  it('Should drop a line that is too long, in any number of chunks, and go on', () => {
    const decode = irc().decode()
    const chunks = [
      'PING a',
      'a'.repeat(3000),
      'a'.repeat(3000),
      'a\r',
      '\nPING b\r\nPI',
      'NG c\r\n',
    ]
    const messages = chunks.flatMap((chunk) =>
      [...decode(encoder.encode(chunk))].map((m) => m.args)
    )
    expect(messages).toEqual([[INPUT_TOO_LONG], ['PING', 'b'], ['PING', 'c']])
  })

  it('Should split a line in chunks of one byte', () => {
    const decode = irc().decode()
    const line = 'PRIVMSG #hono :' + 'é'.repeat(200) + '\r\n'
    const messages = [...encoder.encode(line)].flatMap((byte) =>
      [...decode(Uint8Array.of(byte))].map((m) => m.args)
    )
    expect(messages).toEqual([['PRIVMSG', '#hono', 'é'.repeat(200)]])
  })
})

describe('Formatting', () => {
  it('Should keep a line well-formed whatever the parameters', () => {
    expect(format({ command: '401', params: ['nick', 'x y', 'No such nick'] })).toBe(
      '401 nick x :No such nick'
    )
    expect(format({ command: '366', params: ['nick', '', ':x', 'End'] })).toBe('366 nick * * End')
    expect(format({ command: 'X', params: ['a\rb', 'c d'] })).toBe('X a :c d')
  })

  it('Should measure and cut strings in bytes of UTF-8', () => {
    expect(byteLength('aé\u{1F600}\uD800')).toBe(1 + 2 + 4 + 3)
    expect(truncate('aé\u{1F600}b', 3)).toBe('aé')
    expect(truncate('aé\u{1F600}b', 6)).toBe('aé')
    expect(truncate('aé\u{1F600}b', 7)).toBe('aé\u{1F600}')
    expect(truncate('abc', 10)).toBe('abc')
  })

  it('Should cut the last parameter to fit in a max length', () => {
    const message = {
      source: 'nick!user@host',
      command: 'PRIVMSG',
      params: ['#hono', 'é'.repeat(300)],
    }
    const line = format({ ...message, tags: { time: 'now' } }, 510)
    expect(line.startsWith('@time=now :nick!user@host PRIVMSG #hono ')).toBe(true)
    const body = line.slice('@time=now '.length)
    expect(byteLength(body)).toBeLessThanOrEqual(510)
    expect(byteLength(body)).toBeGreaterThan(507)
    expect(body).toMatch(/ é+$/)
    // A last parameter that becomes empty is still a parameter.
    expect(format({ command: 'X', params: ['abcdef', 'gh'] }, 10)).toBe('X abcdef :')
    // If that is not enough, the line itself is cut.
    expect(format({ command: 'X', params: ['abcdef', 'gh'] }, 5)).toBe('X abc')
    expect(format({ command: 'PING', params: ['a b'] }, 510)).toBe('PING :a b')
  })
})
