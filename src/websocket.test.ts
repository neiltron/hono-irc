import { describe, expect, it } from 'vite-plus/test'
import { createServer } from './server.ts'
import { BINARY, TEXT, fromWebSocket, negotiate } from './websocket.ts'

/** A WebSocket without a network. The test plays the client with `receive()` and `hangUp()`. */
class FakeWebSocket extends EventTarget {
  readyState = 1
  bufferedAmount = 0
  binaryType = 'blob'
  /** The messages sent to the client. */
  sent: (string | Uint8Array)[] = []
  closed?: { code?: number; reason?: string }

  send(data: string | Uint8Array) {
    if (this.readyState !== 1) {
      throw new Error('The WebSocket is not open')
    }
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.closed ??= { code, reason }
    this.readyState = 3
  }

  receive(data: string | ArrayBufferLike) {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  hangUp() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const bytes = (text: string) => encoder.encode(text)

/** Read what has been enqueued so far, until the stream is closed or nothing is left. */
const drain = async (readable: ReadableStream<Uint8Array>) => {
  const reader = readable.getReader()
  let text = ''
  let done = false
  for (;;) {
    const result = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) => setTimeout(resolve, 10)),
    ])
    if (!result || result.done) {
      done = !!result
      break
    }
    text += decoder.decode(result.value)
  }
  reader.releaseLock()
  return { text, done }
}

describe('negotiate()', () => {
  it('Should pick the first subprotocol that the client prefers', () => {
    expect(negotiate(`${BINARY}, ${TEXT}`)).toBe(BINARY)
    expect(negotiate(`${TEXT},${BINARY}`)).toBe(TEXT)
    expect(negotiate(`chat, ${BINARY}`)).toBe(BINARY)
  })

  it('Should agree on nothing without a known subprotocol', () => {
    expect(negotiate(null)).toBeUndefined()
    expect(negotiate('')).toBeUndefined()
    expect(negotiate('chat, irc')).toBeUndefined()
    expect(negotiate('TEXT.IRCV3.NET')).toBeUndefined()
  })
})

describe('fromWebSocket()', () => {
  it('Should turn each message into a line with CRLF', async () => {
    const ws = new FakeWebSocket()
    const socket = fromWebSocket(ws, { protocol: TEXT })
    expect(ws.binaryType).toBe('arraybuffer')
    ws.receive('NICK alice')
    ws.receive('PRIVMSG #hono :héllo')
    ws.receive('')
    ws.receive(bytes('PING x').buffer)
    expect((await drain(socket.readable)).text).toBe(
      'NICK alice\r\nPRIVMSG #hono :héllo\r\nPING x\r\n'
    )
  })

  it('Should pass the bytes of a binary message as they are', async () => {
    const ws = new FakeWebSocket()
    const socket = fromWebSocket(ws, { protocol: BINARY })
    ws.receive(new Uint8Array([0x50, 0x20, 0xff, 0xfe]).buffer)
    const reader = socket.readable.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([0x50, 0x20, 0xff, 0xfe, 13, 10]))
  })

  it('Should accept a trailing line terminator, but not a second line', async () => {
    const ws = new FakeWebSocket()
    const socket = fromWebSocket(ws, { protocol: TEXT })
    ws.receive('NICK alice\r\n')
    ws.receive('NICK bob\n')
    expect((await drain(socket.readable)).text).toBe('NICK alice\r\nNICK bob\r\n')
    expect(ws.closed).toBeUndefined()
    ws.receive('NICK carol\r\nJOIN #hono')
    expect(ws.closed).toEqual({ code: 1002, reason: 'One IRC line per message' })
    expect(await drain(socket.readable)).toEqual({ text: '', done: true })
  })

  it('Should close the connection on a message that is too long', async () => {
    const ws = new FakeWebSocket()
    const socket = fromWebSocket(ws, { protocol: TEXT, maxLength: 10 })
    ws.receive('0123456789')
    ws.receive('0123456789A')
    expect(ws.closed).toEqual({ code: 1009, reason: 'Message too long' })
    expect(await drain(socket.readable)).toEqual({ text: '0123456789\r\n', done: true })
  })

  it('Should send each line as a text message', async () => {
    const ws = new FakeWebSocket()
    const writer = fromWebSocket(ws, { protocol: TEXT }).writable.getWriter()
    await writer.write(bytes(':a PRIVMSG b :one\r\n:a PRIVMSG b :t'))
    await writer.write(bytes('wo\r\n\r\n:a PING x\n:a PRIVMSG b :thr'))
    await writer.write(bytes('ee\r'))
    await writer.write(bytes('\n'))
    expect(ws.sent).toEqual([
      ':a PRIVMSG b :one',
      ':a PRIVMSG b :two',
      ':a PING x',
      ':a PRIVMSG b :three',
    ])
  })

  it('Should replace the bytes that are not UTF-8 in a text message', async () => {
    const ws = new FakeWebSocket()
    const writer = fromWebSocket(ws, { protocol: TEXT }).writable.getWriter()
    await writer.write(new Uint8Array([0x61, 0xff, 0x62, 13, 10]))
    expect(ws.sent).toEqual(['a�b'])
  })

  it('Should send each line as a binary message with the binary subprotocol', async () => {
    const ws = new FakeWebSocket()
    const writer = fromWebSocket(ws, { protocol: BINARY }).writable.getWriter()
    await writer.write(new Uint8Array([0x61, 0xff, 13, 10, 0x62]))
    await writer.write(new Uint8Array([13, 10]))
    expect(ws.sent).toEqual([new Uint8Array([0x61, 0xff]), new Uint8Array([0x62])])
  })

  it('Should answer in the type of the first message without a subprotocol', async () => {
    const text = new FakeWebSocket()
    const textWriter = fromWebSocket(text).writable.getWriter()
    await textWriter.write(bytes('before\r\n'))
    text.receive('NICK alice')
    text.receive(bytes('NICK bob').buffer)
    await textWriter.write(bytes('after\r\n'))
    expect(text.sent).toEqual(['before', 'after'])

    const binary = new FakeWebSocket()
    const binaryWriter = fromWebSocket(binary).writable.getWriter()
    binary.receive(bytes('NICK alice').buffer)
    binary.receive('NICK bob')
    await binaryWriter.write(bytes('after\r\n'))
    expect(binary.sent).toEqual([bytes('after')])
  })

  it('Should end the input and refuse to write when the client closes', async () => {
    const ws = new FakeWebSocket()
    const socket = fromWebSocket(ws, { protocol: TEXT })
    ws.receive('QUIT')
    ws.hangUp()
    expect(await drain(socket.readable)).toEqual({ text: 'QUIT\r\n', done: true })
    await expect(socket.writable.getWriter().write(bytes('x\r\n'))).rejects.toThrow()
    expect(ws.closed).toBeUndefined()
  })

  it('Should close the WebSocket when the server closes', async () => {
    const ws = new FakeWebSocket()
    const socket = fromWebSocket(ws, { protocol: TEXT })
    const writer = socket.writable.getWriter()
    await writer.write(bytes('ERROR :Bye\r\nunfinished'))
    await writer.close()
    expect(ws.sent).toEqual(['ERROR :Bye'])
    expect(ws.closed).toEqual({ code: 1000, reason: undefined })
    expect(await drain(socket.readable)).toEqual({ text: '', done: true })

    const other = new FakeWebSocket()
    await fromWebSocket(other).close()
    expect(other.closed?.code).toBe(1000)
  })

  it('Should disconnect a client that does not read', async () => {
    const ws = new FakeWebSocket()
    const writer = fromWebSocket(ws, { protocol: TEXT, maxBufferedBytes: 100 }).writable.getWriter()
    await writer.write(bytes('one\r\n'))
    ws.bufferedAmount = 101
    await expect(writer.write(bytes('two\r\n'))).rejects.toThrow('does not read fast enough')
    expect(ws.closed).toEqual({ code: 1008, reason: 'Send buffer full' })
    expect(ws.sent).toEqual(['one', 'two'])
  })

  it('Should bound a partial line', async () => {
    const ws = new FakeWebSocket()
    const writer = fromWebSocket(ws, { protocol: TEXT, maxBufferedBytes: 100 }).writable.getWriter()
    await expect(writer.write(new Uint8Array(101).fill(0x61))).rejects.toThrow()
    expect(ws.closed?.code).toBe(1008)
  })

  it('Should disconnect a client that sends faster than the server reads', async () => {
    const ws = new FakeWebSocket()
    const socket = fromWebSocket(ws, { protocol: TEXT, maxBufferedBytes: 25 })
    ws.receive('PRIVMSG #a :1') // 15 bytes with CRLF
    expect(ws.closed).toBeUndefined()
    ws.receive('PRIVMSG #a :2')
    expect(ws.closed).toEqual({ code: 1008, reason: 'Too many messages' })
    ws.receive('PRIVMSG #a :3')
    expect((await drain(socket.readable)).text).toBe('PRIVMSG #a :1\r\nPRIVMSG #a :2\r\n')
  })

  it('Should end at once when the WebSocket is already closed', async () => {
    const ws = new FakeWebSocket()
    ws.readyState = 3
    expect(await drain(fromWebSocket(ws).readable)).toEqual({ text: '', done: true })
  })

  it('Should serve an IRC client', async () => {
    const server = createServer({ name: 'irc.example' })
    const ws = new FakeWebSocket()
    const closed = server.connect(fromWebSocket(ws, { protocol: TEXT }), { ip: '192.0.2.1' })
    ws.receive('NICK alice')
    ws.receive('USER alice 0 * :Alice')
    await expect.poll(() => ws.sent.some((m) => String(m).includes(' 376 '))).toBe(true)
    expect(ws.sent[0]).toMatch(/^:irc\.example 001 alice :Welcome/)
    expect(ws.sent.every((m) => typeof m === 'string' && !/[\r\n]/.test(m))).toBe(true)
    expect([...server.clients.values()][0].ip).toBe('192.0.2.1')

    ws.receive('QUIT :Bye')
    await closed
    expect(ws.sent.at(-1)).toMatch(/^ERROR :/)
    expect(ws.closed?.code).toBe(1000)
    expect(server.clients.size).toBe(0)
  })
})
