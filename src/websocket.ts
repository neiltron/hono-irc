import type { Socket } from 'tcp-hono'

/**
 * The IRCv3 WebSocket transport: https://ircv3.net/specs/extensions/websocket
 *
 * A WebSocket message is one IRC line without CRLF. With `text.ircv3.net` the lines are text
 * messages and must be UTF-8. With `binary.ircv3.net` they are binary messages of any bytes.
 */
export const TEXT = 'text.ircv3.net'
export const BINARY = 'binary.ircv3.net'
export type Subprotocol = typeof TEXT | typeof BINARY

/**
 * Pick the subprotocol from the `Sec-WebSocket-Protocol` header of the request. The client lists
 * them in the order it prefers, so the first one that the server supports wins. `undefined` means
 * that none was agreed on: the spec lets the server accept the connection without the header.
 */
export const negotiate = (header: string | null | undefined): Subprotocol | undefined => {
  for (const offer of header?.split(',') ?? []) {
    const protocol = offer.trim()
    if (protocol === TEXT || protocol === BINARY) {
      return protocol
    }
  }
}

/**
 * The part of a WebSocket that the adapter uses. The `WebSocket` of Cloudflare Workers,
 * of browsers, and of Node.js satisfy it. It must already be open, e.g. accepted.
 */
export interface WebSocketLike {
  readonly readyState: number
  /** The bytes that `send()` has queued and the network has not taken yet. */
  readonly bufferedAmount: number
  binaryType: string
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: Event & { data?: unknown }) => void
  ): void
}

export type WebSocketOptions = {
  /**
   * The negotiated subprotocol, which sets the type of the messages to the client. Without one,
   * the type of the first message from the client is used, and text until then.
   */
  protocol?: Subprotocol
  /**
   * The max length of a message from the client in bytes. A longer one closes the connection.
   * @default 8701 (8191 for the tags and 510 for the rest, which is 512 without CRLF)
   */
  maxLength?: number
  /**
   * The max number of bytes that may wait in either direction: the messages from the client that
   * the server has not read yet, and the messages to the client that the network has not taken
   * yet (`bufferedAmount`). Beyond it the connection is closed.
   * @default 1048576, the same as `maxBufferedBytes` of tcp-hono
   */
  maxBufferedBytes?: number
}

const CR = 13
const LF = 10
const CLOSED = 3
const encoder = new TextEncoder()
// Not fatal: a byte sequence that is not UTF-8 becomes U+FFFD in a text message, which the spec
// allows. A browser closes the connection on a text message that is not UTF-8.
const decoder = new TextDecoder()

/**
 * Turn an open WebSocket into a `Socket` of tcp-hono, so a server that frames lines with CRLF can
 * serve it as is. A message from the client becomes a line with CRLF on `readable`, and every line
 * written to `writable` is sent as one message.
 *
 * The WebSocket API has no backpressure: messages arrive whether or not they are read, and `send()`
 * never waits. So the buffers are bounded instead. A client that sends faster than the server
 * reads, or that does not read what is sent to it, is disconnected when either buffer goes over
 * `maxBufferedBytes`, as tcp-hono does with a TCP client that does not read. A runtime whose
 * `bufferedAmount` stays at 0 does not report its queue, and only that runtime bounds it.
 */
export const fromWebSocket = (ws: WebSocketLike, options: WebSocketOptions = {}): Socket => {
  const maxLength = options.maxLength ?? 8701
  const maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024
  // `undefined` until the first message from a client that negotiated no subprotocol.
  let binary = options.protocol === undefined ? undefined : options.protocol === BINARY
  let closed = false
  let reading = true
  let input!: ReadableStreamDefaultController<Uint8Array>
  // The part of the last chunk written after its last line feed.
  let partial = new Uint8Array(0)

  // End the input. The messages that the server has not read yet are still read.
  const finish = () => {
    if (!closed) {
      closed = true
      try {
        input.close()
      } catch {
        // It is already cancelled.
      }
    }
  }

  const close = (code: number, reason?: string) => {
    if (!closed) {
      finish()
      try {
        ws.close(code, reason)
      } catch {
        // It is already closed.
      }
    }
  }

  const receive = (data: unknown) => {
    if (closed || !reading) {
      return
    }
    if (binary === undefined) {
      binary = typeof data !== 'string'
    }
    let bytes: Uint8Array
    if (typeof data === 'string') {
      bytes = encoder.encode(data)
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } else {
      // A Blob, from a runtime that ignores `binaryType`. Reading it is asynchronous and would
      // reorder the messages.
      return close(1003, 'Unsupported data')
    }
    // A trailing line terminator is not allowed by the spec, but it is harmless, so it is removed.
    let end = bytes.length
    while (end > 0 && (bytes[end - 1] === LF || bytes[end - 1] === CR)) {
      end--
    }
    if (bytes.subarray(0, end).some((byte) => byte === LF || byte === CR)) {
      return close(1002, 'One IRC line per message')
    }
    if (end > maxLength) {
      return close(1009, 'Message too long')
    }
    if (end === 0) {
      return
    }
    const line = new Uint8Array(end + 2)
    line.set(bytes.subarray(0, end))
    line.set([CR, LF], end)
    input.enqueue(line)
    if (input.desiredSize! < 0) {
      close(1008, 'Too many messages')
    }
  }

  const send = (line: Uint8Array) => {
    // A text message must be UTF-8 and a binary one is sent as is. A copy, so the message does not
    // hold the whole buffer.
    ws.send(binary ? line.slice() : decoder.decode(line))
  }

  const readable = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        input = controller
      },
      cancel: () => {
        // The server does not read anymore. It closes the socket itself.
        reading = false
      },
    },
    { highWaterMark: maxBufferedBytes, size: (chunk) => chunk.byteLength }
  )

  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      if (closed) {
        throw new Error('The WebSocket is closed')
      }
      // A chunk may hold several lines, and a line may be split across chunks.
      const buffer = new Uint8Array(partial.length + chunk.length)
      buffer.set(partial)
      buffer.set(chunk, partial.length)
      let start = 0
      try {
        for (let i; (i = buffer.indexOf(LF, start)) !== -1; start = i + 1) {
          const end = i > start && buffer[i - 1] === CR ? i - 1 : i
          if (end > start) {
            send(buffer.subarray(start, end))
          }
        }
      } catch (error) {
        // `send()` throws when the WebSocket is closing.
        finish()
        throw error
      }
      partial = buffer.slice(start)
      if (partial.length + ws.bufferedAmount > maxBufferedBytes) {
        close(1008, 'Send buffer full')
        throw new Error('The client does not read fast enough')
      }
    },
    // A partial line at the end is not a message, like a line without CRLF on TCP, so it is dropped.
    close: () => close(1000),
    // tcp-hono aborts only when the client does not read fast enough.
    abort: () => close(1008, 'Send buffer full'),
  })

  ws.binaryType = 'arraybuffer'
  ws.addEventListener('message', (event) => receive(event.data))
  // The runtime answers the closing handshake, so the input just ends. Cloudflare Workers does
  // since the compatibility date 2026-04-07; with an older date, `close()` would be needed here.
  ws.addEventListener('close', finish)
  ws.addEventListener('error', finish)
  if (ws.readyState === CLOSED) {
    finish()
  }

  return { readable, writable, close: () => close(1000) }
}
