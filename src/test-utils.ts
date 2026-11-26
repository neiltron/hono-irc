import type { Socket } from 'tcp-hono'
import { createServer } from './server.ts'
import type { ServerOptions } from './server.ts'

const encoder = new TextEncoder()

/** Connect an in-memory client to a socket handler, e.g. the one that `tcp.socket()` returns. */
export const connect = (handler: (socket: Socket) => Promise<void>) => {
  const input = new TransformStream<Uint8Array, Uint8Array>()
  const output = new TransformStream<Uint8Array, Uint8Array>()
  const writer = input.writable.getWriter()
  const lines: string[] = []
  let cursor = 0
  let ended = false
  let notify = () => {}

  const closed = handler({ readable: input.readable, writable: output.writable, close: () => {} })

  const received = (async () => {
    const reader = output.readable.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\r\n')
      buffer = parts.pop()!
      lines.push(...parts)
      notify()
    }
    ended = true
    notify()
  })()

  return {
    /** The lines received so far. */
    lines,
    /** Resolves when the server has finished handling the connection. */
    closed,
    send: (...messages: string[]) =>
      writer.write(encoder.encode(messages.map((message) => message + '\r\n').join(''))),
    /** Send raw bytes, such as a line that is not UTF-8. */
    sendBytes: (bytes: Uint8Array) => writer.write(bytes),
    /** Wait for the next line that matches the pattern. The lines before it are skipped. */
    waitFor: async (pattern: RegExp, timeout = 1000): Promise<string> => {
      const deadline = Date.now() + timeout
      for (;;) {
        while (cursor < lines.length) {
          const line = lines[cursor++]
          if (pattern.test(line)) {
            return line
          }
        }
        if (ended || Date.now() > deadline) {
          throw new Error(`No line matches ${pattern}. Received:\n${lines.join('\n')}`)
        }
        await new Promise<void>((resolve) => {
          notify = resolve
          setTimeout(resolve, 20)
        })
      }
    },
    /** Close the writable side, and return all the lines after the server has closed its side. */
    end: async () => {
      await writer.close()
      await received
      return lines
    },
    /** Return all the lines after the server has closed the connection. */
    all: async () => {
      await received
      return lines
    },
    /** Disconnect without a QUIT. */
    drop: () => writer.abort(),
  }
}

/** A server without flood control, and a way to connect a client that registers. */
export const setup = (config?: ServerOptions) => {
  const server = createServer({ flood: false, ...config })
  const handler = server.connect
  /** Connect a client and complete the registration, with the capabilities and the address. */
  const register = async (nick: string, capabilities: string[] = [], ip?: string) => {
    const client = connect((socket) => server.connect(socket, { ip }))
    if (capabilities.length) {
      await client.send('CAP LS 302', `CAP REQ :${capabilities.join(' ')}`, 'CAP END')
    }
    await client.send(`NICK ${nick}`, `USER ${nick} 0 * :${nick} the user`)
    await client.waitFor(/ 376 /)
    return client
  }
  /** The state of the server, which `createServer()` does not return. */
  const state = () => [...server.clients.values()][0]?.server
  return { server, handler, register, state }
}

let sentinel = 0

/**
 * Send the lines, and return what the client gets in reply. A PING follows them, and the lines
 * up to its PONG are returned, without the tags and the source of each line.
 */
export const exchange = async (client: ReturnType<typeof connect>, ...lines: string[]) => {
  const token = `sentinel${++sentinel}`
  const pong = new RegExp(` PONG \\S+ ${token}$`)
  const start = client.lines.length
  await client.send(...lines, `PING ${token}`)
  await client.waitFor(pong)
  return client.lines
    .slice(start)
    .filter((line) => !pong.test(line))
    .map((line) => line.replace(/^(@\S+ )?:\S+ /, ''))
}
