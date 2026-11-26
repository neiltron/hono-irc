import { describe, expect, it } from 'vite-plus/test'
import { Hono, getConnection, tcp } from 'tcp-hono'
import { format, irc, parse } from './protocol.ts'
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

  it('Should close the connection for a line that is too long', async () => {
    const client = connect(tcp.socket(new Hono(), { protocol: irc({ maxLength: 16 }) }))
    await client.send('PRIVMSG #hono :' + 'a'.repeat(32))
    expect(await client.all()).toEqual(['ERROR :Line too long'])
  })
})
