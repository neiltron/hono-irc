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
import { MAX_LINE_LENGTH, byteLength, format } from './protocol.ts'
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
}

/**
 * A token bucket for each connection. A command takes tokens, and the tokens come back one at
 * a time. A client that runs out is disconnected with "Excess Flood".
 */
export type FloodOptions = {
  /** The number of tokens of a full bucket, which is how many commands can be sent at once. */
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
// The lengths are in bytes of UTF-8.
export const NICK_LENGTH = 30
export const CHANNEL_LENGTH = 50
export const TOPIC_LENGTH = 390
export const AWAY_LENGTH = 300
export const KICK_LENGTH = 300
/** The max number of channels that a client can join. */
export const MAX_CHANNELS = 50
/** The max number of targets of a command, as `TARGMAX` shows it. */
export const MAX_TARGETS = { PRIVMSG: 4, NOTICE: 4, KICK: 4, NAMES: 1, WHO: 1, WHOIS: 1 }

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

// The time is added once, so every recipient of a message gets the same one.
const stamp = (message: IRCMessage): IRCMessage =>
  message.tags?.time === undefined
    ? { ...message, tags: { time: new Date().toISOString(), ...message.tags } }
    : message

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
  /** The version of `CAP LS`, e.g. 302, or 0 if the client has not sent one with a version. */
  capVersion = 0
  /**
   * The messages to this client while its own command is handled. The middleware in `server.ts`
   * opens it and writes it as the response, so they are not pushed. `undefined` otherwise.
   */
  outbox?: IRCMessage[]

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
   */
  send(message: IRCMessage) {
    message = stamp(message)
    if (this.outbox) {
      this.outbox.push(message)
    } else {
      this.connection.send(this.format(message) + '\r\n')
    }
  }

  /**
   * Format a message for this client. This is the only place where the tags are filtered:
   * a tag is kept only if the client has negotiated the capability that owns it.
   *
   * This is also where the length of a line is enforced: without the tags and the line
   * terminator, it is at most 510 bytes. A longer last parameter is cut on a character boundary.
   */
  format(message: IRCMessage): string {
    const tags: Record<string, string> = {}
    for (const [key, value] of Object.entries(message.tags ?? {})) {
      // A client-only tag (`+name`) will belong to `message-tags`, which needs a rule here.
      const capability = this.server.tagCapabilities.get(key)
      if (capability && this.capabilities.has(capability)) {
        tags[key] = value
      }
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
  ])

  /**
   * The capability that a client must have negotiated to receive a message tag.
   * `Client.format()` drops a tag that is not listed here.
   */
  tagCapabilities = new Map<string, string>([
    ['time', 'server-time'],
    // ['msgid', 'message-tags'],
    // ['account', 'account-tag'],
    // ['batch', 'batch'],
    // ['label', 'labeled-response'],
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
    ])
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
