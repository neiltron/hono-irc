import type { Socket } from 'tcp-hono'

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
