import type { Message, Protocol } from 'tcp-hono'

const decoder = new TextDecoder()

/**
 * An IRC message: `@tags :source COMMAND param param :trailing param`.
 */
export type IRCMessage = {
  /** IRCv3 message tags. A tag without a value is an empty string. */
  tags?: Record<string, string>
  /** The prefix without the leading `:`, e.g. `nick!user@host` or a server name. */
  source?: string
  /** Uppercased for a message parsed by `parse()`. */
  command: string
  params: string[]
}

const unescapes: Record<string, string> = { ':': ';', s: ' ', r: '\r', n: '\n' }
const escapes: Record<string, string> = { ';': '\\:', ' ': '\\s', '\r': '\\r', '\n': '\\n' }

const unescapeTag = (value: string) => value.replace(/\\(.?)/g, (_, c: string) => unescapes[c] ?? c)
const escapeTag = (value: string) => value.replace(/[; \r\n\\]/g, (c) => escapes[c] ?? '\\\\')

/**
 * Parse a line without the line terminator. Returns `undefined` if the line has no command.
 */
export const parse = (line: string): IRCMessage | undefined => {
  let rest = line.replace(/^ +/, '')
  // Cut out the first word and the spaces that follow it.
  const word = () => {
    const i = rest.indexOf(' ')
    const value = i === -1 ? rest : rest.slice(0, i)
    rest = i === -1 ? '' : rest.slice(i).replace(/^ +/, '')
    return value
  }

  let tags: Record<string, string> | undefined
  if (rest[0] === '@') {
    tags = {}
    for (const tag of word().slice(1).split(';')) {
      const i = tag.indexOf('=')
      const key = i === -1 ? tag : tag.slice(0, i)
      if (key) {
        tags[key] = i === -1 ? '' : unescapeTag(tag.slice(i + 1))
      }
    }
  }
  const source = rest[0] === ':' ? word().slice(1) : undefined
  const command = word().toUpperCase()
  if (!command) {
    return
  }
  const params: string[] = []
  while (rest) {
    if (rest[0] === ':') {
      params.push(rest.slice(1))
      break
    }
    params.push(word())
  }
  return { ...(tags && { tags }), ...(source !== undefined && { source }), command, params }
}

/** The max length of a line without the tags, in bytes, including the line terminator. */
export const MAX_LINE_LENGTH = 512
/** The max length of the tags of a line from a client, in bytes, with `@` and the space after. */
export const MAX_TAGS_LENGTH = 4096
/** The max length of a line that is skipped as too long, before the connection is closed. */
export const MAX_SKIP_LENGTH = 65536

// The bytes of a character in UTF-8, and whether it is a surrogate pair of two code units.
// A lone surrogate is encoded as U+FFFD, which is 3 bytes, like `TextEncoder` does.
const charAt = (value: string, i: number): [size: number, pair: boolean] => {
  const code = value.charCodeAt(i)
  if (code < 0x80) {
    return [1, false]
  }
  if (code < 0x800) {
    return [2, false]
  }
  const next = value.charCodeAt(i + 1)
  return code >= 0xd800 && code < 0xdc00 && next >= 0xdc00 && next < 0xe000 ? [4, true] : [3, false]
}

/** The length of a string in bytes of UTF-8. */
export const byteLength = (value: string): number => {
  let length = 0
  for (let i = 0; i < value.length; i++) {
    const [size, pair] = charAt(value, i)
    length += size
    i += pair ? 1 : 0
  }
  return length
}

/** Cut a string to at most `max` bytes of UTF-8, without splitting a character. */
export const truncate = (value: string, max: number): string => {
  let length = 0
  for (let i = 0; i < value.length; i++) {
    const [size, pair] = charAt(value, i)
    if (length + size > max) {
      return value.slice(0, i)
    }
    length += size
    i += pair ? 1 : 0
  }
  return value
}

// A line terminator in a parameter would let a client inject a message.
const clean = (value: string) => value.replace(/[\r\n\0]/g, ' ')

// Everything but the tags.
const formatBody = (message: IRCMessage): string => {
  const parts: string[] = []
  if (message.source !== undefined) {
    parts.push(':' + clean(message.source))
  }
  parts.push(message.command)
  const last = message.params.length - 1
  message.params.forEach((param, i) => {
    param = clean(param)
    if (i < last) {
      // A parameter before the last one can not be empty, have a space, or start with `:`,
      // or the line would mean something else. The callers should not pass one, but if one
      // does, the line stays well-formed.
      param = param.split(' ')[0]
      parts.push(param && param[0] !== ':' ? param : '*')
    } else {
      const trailing = param === '' || param.includes(' ') || param[0] === ':'
      parts.push(trailing ? ':' + param : param)
    }
  })
  return parts.join(' ')
}

/**
 * Format a message into a line without the line terminator.
 * The last parameter is sent as a trailing parameter if it is empty, has a space, or starts with `:`.
 *
 * With `max`, the line without the tags is at most `max` bytes: the last parameter is shortened
 * on a character boundary, and if that is not enough, the line itself is cut.
 */
export const format = (message: IRCMessage, max?: number): string => {
  const tags = Object.entries(message.tags ?? {})
  const head = tags.length
    ? '@' + tags.map(([k, v]) => (v === '' ? k : `${k}=${escapeTag(v)}`)).join(';') + ' '
    : ''
  let body = formatBody(message)
  if (max !== undefined && byteLength(body) > max && message.params.length) {
    const params = [...message.params]
    const last = clean(params[params.length - 1])
    // One byte more, for the `:` that a shortened parameter may need, e.g. when it becomes empty.
    params[params.length - 1] = truncate(last, byteLength(last) - (byteLength(body) - max) - 1)
    body = formatBody({ ...message, params })
  }
  if (max !== undefined && byteLength(body) > max) {
    body = truncate(body, max)
  }
  return head + body
}

/**
 * The command of the message that the decoder yields in place of a line that is too long.
 * It has spaces, so it is never the command of a line from a client. The message has no body.
 */
export const INPUT_TOO_LONG = 'INPUT TOO LONG'

export type IRCOptions = {
  /**
   * The max length of a line without the tags, in bytes, including the line terminator.
   * @default 512
   */
  maxLength?: number
  /**
   * The max length of the tags, in bytes, including `@` and the space after them.
   * @default 4096
   */
  maxTagsLength?: number
  /**
   * A line that is too long is skipped up to its line terminator. The connection is closed once
   * more than this many bytes of one line have been skipped, so the client can not make the
   * server read forever without a message.
   * @default 65536 (`MAX_SKIP_LENGTH`)
   */
  maxSkipLength?: number
}

const TOO_LONG = Symbol('too long')

/**
 * Create a function that cuts out lines from chunks. Both CRLF and LF are accepted.
 * A line that is too long is yielded as `TOO_LONG`, once, and its bytes are dropped.
 */
const splitLines = (options: IRCOptions) => {
  const maxLength = options.maxLength ?? MAX_LINE_LENGTH
  const maxTagsLength = options.maxTagsLength ?? MAX_TAGS_LENGTH
  const maxSkipLength = options.maxSkipLength ?? MAX_SKIP_LENGTH
  // A line that has not ended can not be longer than this.
  const limit = maxLength + maxTagsLength
  // The start of the current line, from the previous chunks.
  let parts: Uint8Array[] = []
  let buffered = 0
  // How many bytes of a line that is too long have been dropped, while it has not ended.
  let skipped: number | undefined

  // The line has its CR, if any, but not its LF.
  const tooLong = (line: Uint8Array) => {
    const tags = line[0] === 0x40 ? line.indexOf(0x20) + 1 || line.length : 0
    return tags > maxTagsLength || line.length + 1 - tags > maxLength
  }

  return function* (chunk?: Uint8Array): Generator<Uint8Array | typeof TOO_LONG> {
    if (!chunk) {
      // The end of the stream. A line without a line terminator is not a message.
      return
    }
    // Each byte of a chunk is looked at once, and a line is copied at most once.
    let start = 0
    for (let end; (end = chunk.indexOf(0x0a, start)) !== -1; start = end + 1) {
      if (skipped !== undefined) {
        // The end of the line that was too long.
        skipped = undefined
        continue
      }
      let line = chunk.subarray(start, end)
      if (parts.length) {
        const joined = new Uint8Array(buffered + line.length)
        let offset = 0
        for (const part of [...parts, line]) {
          joined.set(part, offset)
          offset += part.length
        }
        line = joined
        parts = []
        buffered = 0
      }
      yield tooLong(line)
        ? TOO_LONG
        : line.subarray(0, line[line.length - 1] === 0x0d ? -1 : line.length)
    }

    const rest = chunk.subarray(start)
    if (skipped !== undefined) {
      skipped += rest.length
    } else if (buffered + rest.length > limit) {
      // The line can not be valid any more. It is reported at once, and the rest of it is dropped.
      skipped = buffered + rest.length
      parts = []
      buffered = 0
      yield TOO_LONG
    } else if (rest.length) {
      parts.push(rest)
      buffered += rest.length
    }
    if (skipped !== undefined && skipped > maxSkipLength) {
      throw new Error('Line too long')
    }
  }
}

/**
 * IRC protocol for `tcp-hono`. A message is a line terminated by CRLF or LF.
 *
 * The command is uppercased and the parameters follow it: `PRIVMSG #hono :Hello World` is routed
 * as `/PRIVMSG/#hono/Hello World`. The whole line is available as the body. Use `parse()` to get
 * the tags, the source, and the parameters that a path can not express, such as an empty one.
 *
 * A line that is too long is not a message. It is routed as `INPUT_TOO_LONG`, without a body,
 * so the app can reply to it and keep the connection open.
 *
 * IRC is not a request/response protocol, so most of the output is written with `send()` of
 * the connection. A response without a body, e.g. `c.body(null)`, writes nothing.
 */
export const irc = (options: IRCOptions = {}): Protocol => ({
  decode: () => {
    const split = splitLines(options)
    return function* (chunk): Generator<Message> {
      for (const body of split(chunk)) {
        if (body === TOO_LONG) {
          yield { args: [INPUT_TOO_LONG] }
          continue
        }
        const message = parse(decoder.decode(body))
        if (message) {
          yield { args: [message.command, ...message.params], body }
        }
      }
    }
  },
  respond: async (res, message) => {
    const text = await res.text()
    if (res.status === 404 && message?.args[0] === INPUT_TOO_LONG) {
      return new Response('417 * :Input line was too long\r\n')
    }
    if (res.status === 404) {
      // The app does not have a route for the command and does not have its own `notFound()`.
      return new Response(`421 * ${message?.args[0] ?? '*'} :Unknown command\r\n`)
    }
    if (res.status === 400 && !message) {
      // A malformed message. The connection is closed after this.
      return new Response(`ERROR :${text}\r\n`)
    }
    // The replies are small, so they are not streamed. The headers are kept for `Connection: close`.
    return new Response(text && !text.endsWith('\n') ? text + '\r\n' : text || null, {
      headers: res.headers,
    })
  },
})
