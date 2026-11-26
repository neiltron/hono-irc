import type { Connection } from 'tcp-hono'
import {
  RPL_CREATED,
  RPL_ENDOFMOTD,
  RPL_ENDOFNAMES,
  RPL_ISUPPORT,
  RPL_LUSERCHANNELS,
  RPL_LUSERCLIENT,
  RPL_LUSERME,
  RPL_LUSERUNKNOWN,
  RPL_MOTD,
  RPL_MOTDSTART,
  RPL_MYINFO,
  RPL_NAMREPLY,
  RPL_NOTOPIC,
  RPL_TOPIC,
  RPL_TOPICWHOTIME,
  RPL_WELCOME,
  RPL_YOURHOST,
  ERR_NOMOTD,
  ERR_TOOMANYTARGETS,
} from './numerics.ts'
import { MAX_LINE_LENGTH, MAX_TAG_DATA, byteLength, format, tagsLength } from './protocol.ts'
import type { IRCMessage } from './protocol.ts'

/** A reply from the server. The nickname of the client is inserted into a numeric reply. */
export type Line = [command: string, ...params: (string | number)[]]

declare module 'hono' {
  interface ContextRenderer {
    (...lines: Line[]): Response
  }
}

export type Env = {
  Variables: {
    client: Client
    message: IRCMessage
  }
}

export type ServerOptions = {
  /** The server name, which is the source of the replies. */
  name?: string
  network?: string
  motd?: string[]
  /**
   * A client that is silent for this long gets a PING, and is disconnected after twice as long.
   * A client that has not registered this long after it connected is disconnected.
   */
  pingInterval?: number
  /** The flood control of each connection, or `false` to turn it off. */
  flood?: FloodOptions | false
  /** The max number of connections. A connection over it is refused. */
  maxConnections?: number
  /** The max number of connections from one address, when the runtime knows the address. */
  maxConnectionsPerIp?: number
  /** The max number of channels on the server. */
  maxChannels?: number
  /** The limits of a `draft/multiline` batch from a client. */
  multiline?: MultilineOptions
}

/** The limits of a `draft/multiline` batch, which `CAP LS 302` shows. */
export type MultilineOptions = {
  /** The max length in bytes of the text of all its lines, with a line feed between two lines. */
  maxBytes?: number
  /** The max number of its lines. */
  maxLines?: number
  /** The milliseconds that a batch may stay open, checked by `tick()`. */
  timeout?: number
}

/**
 * A token bucket for each connection. A command takes tokens, and the tokens come back one at
 * a time. The command of a client that runs out waits until its tokens are back.
 */
export type FloodOptions = {
  /** The number of tokens of a full bucket, which is how many commands are handled at once. */
  burst?: number
  /** The milliseconds that it takes to get one token back. */
  interval?: number
  /** The tokens that a command takes, if not 1. */
  costs?: Record<string, number>
}

/** What the runtime knows about a connection. */
export type ConnectionInfo = {
  /** The address of the client. */
  ip?: string
  /** Whether the connection is encrypted, e.g. with TLS. */
  secure?: boolean
}

export const VERSION = 'hono-irc-0.0.1'
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
// The lengths are in bytes of UTF-8.
export const NICK_LENGTH = 30
export const CHANNEL_LENGTH = 50
export const TOPIC_LENGTH = 390
export const AWAY_LENGTH = 300
export const KICK_LENGTH = 300
/** The max number of channels that a client can join. */
export const MAX_CHANNELS = 50
/** The max number of targets of a command, as `TARGMAX` shows it. */
export const MAX_TARGETS = {
  PRIVMSG: 4,
  NOTICE: 4,
  TAGMSG: 4,
  KICK: 4,
  NAMES: 1,
  WHO: 1,
  WHOIS: 1,
}

// No whitespace, commas, colons, control characters such as BEL, or format characters,
// such as the bidirectional overrides and the zero-width ones, which can make two names look alike.
const CHANNEL_PATTERN = /^#[^\s,:\p{Cc}\p{Cf}]+$/u

export const isChannelName = (name: string) =>
  CHANNEL_PATTERN.test(name) && byteLength(name) <= CHANNEL_LENGTH
export const PREFIXES = { o: '@', v: '+' } as const
export type Rank = keyof typeof PREFIXES

/**
 * A parameter from a client, such as a nickname that does not exist, to send back as a parameter
 * before the last one of a reply, which can not be empty or have a space: the part before the
 * first space, or `*`.
 */
export const echo = (value: string) => value.split(' ')[0] || '*'

/** ERR_TOOMANYTARGETS for the first target that is over the limit, if any. */
export const tooMany = (excess: string[]): Line[] =>
  excess.length ? [[ERR_TOOMANYTARGETS, echo(excess[0]), 'Too many targets']] : []

/** Build a message, e.g. `msg(client.mask, 'JOIN', channel.name)`. Add `tags` with a spread. */
export const msg = (source: string, command: string, ...params: string[]): IRCMessage => ({
  source,
  command,
  params,
})

/** Add the `time` tag once, so every recipient of a message gets the same one. */
export const stamp = (message: IRCMessage): IRCMessage =>
  message.tags?.time === undefined
    ? { ...message, tags: { time: new Date().toISOString(), ...message.tags } }
    : message

/**
 * A standard reply, `FAIL <command> <code> [<context>...] <description>`, to render with
 * `c.render()` or to send. `command` is `*` for a reply that no command caused. A reply that no
 * spec defines is sent only to a client with `standard-replies`.
 */
export const fail = (command: string, code: string, ...rest: [...string[], string]): Line => [
  'FAIL',
  command,
  code,
  ...rest,
]
export const warn = (command: string, code: string, ...rest: [...string[], string]): Line => [
  'WARN',
  command,
  code,
  ...rest,
]
export const note = (command: string, code: string, ...rest: [...string[], string]): Line => [
  'NOTE',
  command,
  code,
  ...rest,
]

/**
 * The client-only tags (`+name`) of a message from a client, which are relayed with it. The other
 * tags of a client are never relayed: `time`, `msgid`, `batch`, `label` and the like are set by the
 * server, or read by it. `undefined` if they would take more than 4094 bytes on a line, which can
 * happen only with a raw CR in a value, as it is escaped to two bytes: the line is then too long.
 */
export const clientTags = (tags?: Record<string, string>): Record<string, string> | undefined => {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (key[0] === '+' && key.length > 1) {
      result[key] = value
    }
  }
  return tagsLength(result) <= MAX_TAG_DATA ? result : undefined
}

/** A message to the client during its own command, and whether it is part of the response. */
export type OutboxEntry = { message: IRCMessage; response: boolean }

/** A `draft/multiline` batch that a client has opened and not closed yet. */
export type InboundBatch = {
  ref: string
  /** The target of the batch, which every line must have. */
  target: string
  /** PRIVMSG or NOTICE, from the first line. */
  command?: 'PRIVMSG' | 'NOTICE'
  lines: { text: string; concat: boolean }[]
  /** The length of the combined message, as `max-bytes` counts it. */
  bytes: number
  /** The client-only tags of the `BATCH +` line, which are relayed with the message. */
  tags: Record<string, string>
  opened: number
}

export class Client {
  nick = '*'
  user = ''
  realname = ''
  /** The real address is not exposed to the other users. */
  host = `${crypto.randomUUID().slice(0, 8)}.user`
  /** The address of the client, if the runtime knows it. It is not shown to the other users. */
  ip?: string
  /** Whether the connection is encrypted. */
  secure: boolean
  registered = false
  /** Registration is suspended between `CAP LS`/`CAP REQ` and `CAP END`. */
  negotiating = false
  capabilities = new Set<string>()
  channels = new Set<Channel>()
  invisible = false
  away?: string
  quit?: string
  /** When the client connected. */
  signon = Date.now()
  /** When the client sent anything. A client that is silent for long gets a PING. */
  active = Date.now()
  /** When the client sent a PRIVMSG or a NOTICE, which is what WHOIS shows as the idle time. */
  idle = Date.now()
  pinged = false
  /** Whether a command of the client waits for the flood control. */
  delayed = false
  /** The version of `CAP LS`, e.g. 302, or 0 if the client has not sent one with a version. */
  capVersion = 0
  /**
   * The messages to this client while its own command is handled. The middleware in `server.ts`
   * opens it and writes it as the response, so they are not pushed. `undefined` otherwise.
   */
  outbox?: OutboxEntry[]
  /** The `draft/multiline` batch that the client is sending, if any. */
  inbound?: InboundBatch
  // The last reference tag of a batch to this client, which is unique for the connection.
  #references = 0

  server: Server
  connection: Connection

  constructor(server: Server, connection: Connection, info: ConnectionInfo = {}) {
    this.server = server
    this.connection = connection
    this.ip = info.ip
    this.secure = info.secure ?? false
  }

  get mask() {
    return `${this.nick}!${this.user}@${this.host}`
  }

  /**
   * Send a message to the client. It goes to the outbox during the client's own request,
   * and is pushed to the connection otherwise. The `time` tag is added here.
   *
   * `response` is false for a message to the client during its own command that the command did
   * not answer, such as its own private message to itself, which is delivered like any other and
   * must not carry the `label` of the command. The echo of echo-message is the response.
   */
  send(message: IRCMessage, response = true) {
    message = stamp(message)
    if (this.outbox) {
      this.outbox.push({ message, response })
    } else {
      this.connection.send(this.format(message) + '\r\n')
    }
  }

  /** A new reference tag for a batch to this client. */
  reference(): string {
    return (++this.#references).toString(36)
  }

  /**
   * Send messages as one batch: `BATCH +ref type params`, the messages with the `batch` tag, and
   * `BATCH -ref`, with `tags`, such as `msgid`, on the `BATCH +` line. A client without `batch`
   * gets the messages alone, with `tags` on the first one.
   */
  sendBatch(
    batch: { source: string; type: string; params?: string[]; tags?: Record<string, string> },
    messages: IRCMessage[],
    response = true
  ) {
    if (!this.capabilities.has('batch')) {
      messages.forEach((message, i) => {
        this.send(i ? message : { ...message, tags: { ...batch.tags, ...message.tags } }, response)
      })
      return
    }
    const ref = this.reference()
    const { source, type, params = [], tags } = batch
    this.send({ tags, source, command: 'BATCH', params: ['+' + ref, type, ...params] }, response)
    for (const message of messages) {
      this.send({ ...message, tags: { batch: ref, ...message.tags } }, response)
    }
    const end = { source, command: 'BATCH', params: ['-' + ref] }
    this.send(tags?.time ? { ...end, tags: { time: tags.time } } : end, response)
  }

  /**
   * Format a message for this client. This is the only place where the tags are filtered:
   * a tag is kept only if the client has negotiated the capability that owns it, and a
   * client-only tag (`+name`) only if it has `message-tags`.
   *
   * The tags that the server sets come first, and the client-only ones after them. The server sets
   * a few short tags, far below the 4094 bytes of tag data that it may add, and the client-only
   * tags are at most 4094 bytes as they came in (see `clientTags()`), so a line has at most 8191
   * bytes of tags. If the client-only tags of a line took more anyway, they would be dropped
   * together, as a tag must not be cut.
   *
   * This is also where the length of a line is enforced: without the tags and the line
   * terminator, it is at most 510 bytes. A longer last parameter is cut on a character boundary.
   */
  format(message: IRCMessage): string {
    const tags: Record<string, string> = {}
    const relayed: Record<string, string> = {}
    for (const [key, value] of Object.entries(message.tags ?? {})) {
      if (key[0] === '+') {
        if (this.capabilities.has('message-tags')) {
          relayed[key] = value
        }
        continue
      }
      const capability = this.server.tagCapabilities.get(key)
      if (capability && this.capabilities.has(capability)) {
        tags[key] = value
      }
    }
    if (tagsLength(relayed) <= MAX_TAG_DATA) {
      Object.assign(tags, relayed)
    }
    return format({ ...message, tags }, MAX_LINE_LENGTH - 2)
  }
}

export class Channel {
  topic?: { text: string; by: string; at: number }
  members = new Map<Client, Set<Rank>>()
  modes = new Set(['n', 't'])
  created = Math.floor(Date.now() / 1000)

  name: string

  constructor(name: string) {
    this.name = name
  }

  /** Whether the client may send a message to the channel: PRIVMSG, NOTICE, TAGMSG, or multiline. */
  canSend(client: Client) {
    const ranks = this.members.get(client)
    return !(
      (this.modes.has('n') && !ranks) ||
      (this.modes.has('m') && !ranks?.has('o') && !ranks?.has('v'))
    )
  }

  /** Send a message to every member, including the sender. */
  send(message: IRCMessage) {
    message = stamp(message)
    for (const member of this.members.keys()) {
      member.send(message)
    }
  }

  prefix(client: Client, all = false) {
    const ranks = this.members.get(client)
    const prefixes = (Object.keys(PREFIXES) as Rank[])
      .filter((rank) => ranks?.has(rank))
      .map((rank) => PREFIXES[rank])
    return all ? prefixes.join('') : (prefixes[0] ?? '')
  }
}

/**
 * The state of the server and the helpers that the command modules share.
 * It is in memory and does not depend on a runtime.
 */
export class Server {
  name: string
  network: string
  motd: string[]
  pingInterval: number
  flood: Required<FloodOptions> | false
  maxConnections: number
  maxConnectionsPerIp: number
  maxChannels: number
  multiline: Required<MultilineOptions>
  created = new Date()

  clients = new Map<Connection, Client>()
  /** By the folded nickname. */
  nicks = new Map<string, Client>()
  /** By the folded channel name. */
  channels = new Map<string, Channel>()
  /** The number of connections from each address that the runtime told. */
  addresses = new Map<string, number>()

  /**
   * The capabilities, with the value that `CAP LS 302` shows, e.g. `sasl` to `PLAIN`.
   * A feature module adds its own here.
   */
  capabilities = new Map<string, string | undefined>([
    ['away-notify', undefined],
    ['cap-notify', undefined],
    ['echo-message', undefined],
    ['extended-join', undefined],
    ['multi-prefix', undefined],
    ['server-time', undefined],
    ['userhost-in-names', undefined],
    ['message-tags', undefined],
    ['batch', undefined],
    ['labeled-response', undefined],
    ['standard-replies', undefined],
  ])

  /**
   * The capability that a client must have negotiated to receive a message tag.
   * `Client.format()` drops a tag that is not listed here.
   */
  tagCapabilities = new Map<string, string>([
    ['time', 'server-time'],
    // ['account', 'account-tag'],
    ['msgid', 'message-tags'],
    ['batch', 'batch'],
    ['label', 'labeled-response'],
  ])

  /** The RPL_ISUPPORT tokens. `true` is a token without a value. */
  isupport: Map<string, string | true>

  /** The commands that a client can send before the registration. */
  beforeRegistration = new Set(['CAP', 'NICK', 'USER', 'PASS', 'PING', 'PONG', 'QUIT'])

  constructor(config: ServerOptions = {}) {
    this.name = config.name ?? 'irc.hono.local'
    this.network = config.network ?? 'HonoIRC'
    this.motd = config.motd ?? ['Hono beyond HTTP.']
    this.pingInterval = config.pingInterval ?? 90_000
    this.flood =
      config.flood === false
        ? false
        : {
            burst: config.flood?.burst ?? 10,
            interval: config.flood?.interval ?? 2000,
            costs: config.flood?.costs ?? { NICK: 3, JOIN: 2, PART: 2 },
          }
    this.maxConnections = config.maxConnections ?? 1000
    this.maxConnectionsPerIp = config.maxConnectionsPerIp ?? 10
    this.maxChannels = config.maxChannels ?? 1000
    this.multiline = {
      maxBytes: config.multiline?.maxBytes ?? 4096,
      maxLines: config.multiline?.maxLines ?? 100,
      timeout: config.multiline?.timeout ?? 30_000,
    }
    this.isupport = new Map<string, string | true>([
      ['CASEMAPPING', 'ascii'],
      ['CHANTYPES', '#'],
      ['CHANMODES', ',,,mnt'],
      ['PREFIX', '(ov)@+'],
      ['NICKLEN', String(NICK_LENGTH)],
      ['CHANNELLEN', String(CHANNEL_LENGTH)],
      ['TOPICLEN', String(TOPIC_LENGTH)],
      ['CHANLIMIT', `#:${MAX_CHANNELS}`],
      ['NETWORK', this.network],
      ['AWAYLEN', String(AWAY_LENGTH)],
      ['KICKLEN', String(KICK_LENGTH)],
      [
        'TARGMAX',
        Object.entries(MAX_TARGETS)
          .map(([command, max]) => `${command}:${max}`)
          .join(','),
      ],
      // Every client-only tag is allowed. The token is empty, which means the same as no token.
      ['CLIENTTAGDENY', ''],
      ['UTF8ONLY', true],
    ])
  }

  // The time and the random part of the last message ID, which are increased for the next one.
  #msgTime = 0
  #msgRandom = new Uint8Array(10)

  /**
   * A new message ID for the `msgid` tag. It is like a ULID: 48 bits of the time in milliseconds
   * and 80 random bits, in 26 characters of Crockford's base32, so the IDs sort by time and do not
   * repeat across restarts. Within the same millisecond, or if the clock goes back, the random
   * part of the last one is increased by one, so they stay unique and in order in a process.
   */
  msgid(): string {
    const now = Date.now()
    const random = this.#msgRandom
    if (now > this.#msgTime) {
      this.#msgTime = now
      crypto.getRandomValues(random)
    } else {
      for (let i = random.length - 1; i >= 0 && ++random[i] === 256; i--) {
        random[i] = 0
      }
    }
    let id = ''
    for (let time = this.#msgTime, i = 0; i < 10; i++, time = Math.floor(time / 32)) {
      id = CROCKFORD[time % 32] + id
    }
    // 80 bits are 16 characters of 5 bits.
    let bits = 0
    let value = 0
    for (const byte of random) {
      value = ((value & 31) << 8) | byte
      bits += 8
      while (bits >= 5) {
        bits -= 5
        id += CROCKFORD[(value >> bits) & 31]
      }
    }
    return id
  }

  /** CASEMAPPING=ascii: only A to Z are folded, so a name with other letters stays as it is. */
  fold(name: string) {
    return name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
  }

  /**
   * Split a list of targets, e.g. `#a,bob`. The empty ones and the repeated ones are dropped,
   * and the ones over `max` are returned as `excess`.
   */
  targets(list: string, max: number) {
    const seen = new Set<string>()
    const targets: string[] = []
    for (const target of list.split(',')) {
      if (target && !seen.has(this.fold(target))) {
        seen.add(this.fold(target))
        targets.push(target)
      }
    }
    return { targets: targets.slice(0, max), excess: targets.slice(max) }
  }

  /** The clients that share a channel with the client, without the client. */
  peers(client: Client) {
    const result = new Set<Client>()
    for (const channel of client.channels) {
      for (const member of channel.members.keys()) {
        result.add(member)
      }
    }
    result.delete(client)
    return result
  }

  /** The members of a channel that a client can see: an invisible one only from inside. */
  visibleMembers(client: Client, channel: Channel) {
    const inside = channel.members.has(client)
    return [...channel.members.keys()].filter((member) => inside || !member.invisible)
  }

  leave(client: Client, channel: Channel) {
    channel.members.delete(client)
    client.channels.delete(channel)
    if (!channel.members.size) {
      this.channels.delete(this.fold(channel.name))
    }
  }

  /**
   * Join the items with spaces into as few strings as possible, so that each one fits as the last
   * parameter of a numeric reply to the client that has the given parameters before it.
   */
  pack(client: Client, params: string[], items: string[]): string[] {
    const head = `:${this.name} 000 ${client.nick} ${params.map((param) => param + ' ').join('')}:`
    const max = MAX_LINE_LENGTH - 2 - byteLength(head)
    const chunks: string[] = []
    let chunk = ''
    let length = 0
    for (const item of items) {
      const size = byteLength(item)
      // The length is checked before the item is added, so a line never goes over.
      if (chunk && length + 1 + size > max) {
        chunks.push(chunk)
        chunk = ''
        length = 0
      }
      chunk = chunk ? `${chunk} ${item}` : item
      length += (length ? 1 : 0) + size
    }
    return chunk ? [...chunks, chunk] : chunks
  }

  topic(channel: Channel): Line[] {
    return channel.topic
      ? [
          [RPL_TOPIC, channel.name, channel.topic.text],
          [RPL_TOPICWHOTIME, channel.name, channel.topic.by, channel.topic.at],
        ]
      : [[RPL_NOTOPIC, channel.name, 'No topic is set']]
  }

  names(client: Client, channel: Channel): Line[] {
    const all = client.capabilities.has('multi-prefix')
    const userhost = client.capabilities.has('userhost-in-names')
    const entries = this.visibleMembers(client, channel).map(
      (member) => channel.prefix(member, all) + (userhost ? member.mask : member.nick)
    )
    return [
      ...this.pack(client, ['=', channel.name], entries).map((chunk): Line => [
        RPL_NAMREPLY,
        '=',
        channel.name,
        chunk,
      ]),
      [RPL_ENDOFNAMES, channel.name, 'End of /NAMES list'],
    ]
  }

  motdLines(): Line[] {
    return this.motd.length
      ? [
          [RPL_MOTDSTART, `- ${this.name} Message of the day -`],
          ...this.motd.map((text): Line => [RPL_MOTD, `- ${text}`]),
          [RPL_ENDOFMOTD, 'End of /MOTD command'],
        ]
      : [[ERR_NOMOTD, 'MOTD File is missing']]
  }

  lusers(): Line[] {
    let users = 0
    let invisible = 0
    for (const client of this.clients.values()) {
      users += client.registered ? 1 : 0
      invisible += client.registered && client.invisible ? 1 : 0
    }
    const unknown = this.clients.size - users
    return [
      [
        RPL_LUSERCLIENT,
        `There are ${users - invisible} users and ${invisible} invisible on 1 servers`,
      ],
      ...(unknown ? [[RPL_LUSERUNKNOWN, unknown, 'unknown connection(s)'] satisfies Line] : []),
      [RPL_LUSERCHANNELS, this.channels.size, 'channels formed'],
      [RPL_LUSERME, `I have ${users} clients and 0 servers`],
    ]
  }

  /** The RPL_ISUPPORT replies, with at most 13 tokens each. */
  isupportLines(): Line[] {
    const tokens = [...this.isupport].map(([key, value]) =>
      value === true ? key : `${key}=${value}`
    )
    const lines: Line[] = []
    for (let i = 0; i < tokens.length; i += 13) {
      lines.push([RPL_ISUPPORT, ...tokens.slice(i, i + 13), 'are supported by this server'])
    }
    return lines
  }

  /** Complete the registration if the client has sent everything. Returns the welcome messages. */
  register(client: Client): Line[] {
    if (client.registered || client.negotiating || client.nick === '*' || !client.user) {
      return []
    }
    client.registered = true
    return [
      [RPL_WELCOME, `Welcome to the ${this.network} Network, ${client.mask}`],
      [RPL_YOURHOST, `Your host is ${this.name}, running version ${VERSION}`],
      [RPL_CREATED, `This server was created ${this.created.toUTCString()}`],
      [RPL_MYINFO, this.name, VERSION, 'i', 'mntov'],
      ...this.isupportLines(),
      ...this.lusers(),
      ...this.motdLines(),
    ]
  }
}
