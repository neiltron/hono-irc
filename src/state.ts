import type { Connection } from 'tcp-hono'
import {
  RPL_CREATED,
  RPL_ENDOFMOTD,
  RPL_ENDOFNAMES,
  RPL_ISUPPORT,
  RPL_LUSERCHANNELS,
  RPL_LUSERCLIENT,
  RPL_LUSERME,
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
} from './numerics.ts'
import { format } from './protocol.ts'
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
  /** A client that is silent for this long gets a PING, and is disconnected after twice as long. */
  pingInterval?: number
}

/** What the runtime knows about a connection. */
export type ConnectionInfo = {
  /** The address of the client. */
  ip?: string
  /** Whether the connection is encrypted, e.g. with TLS. */
  secure?: boolean
}

export const VERSION = 'hono-irc-0.0.1'
// No whitespace, commas, colons, or control characters such as BEL.
export const CHANNEL_PATTERN = /^#[^\s,:\p{Cc}]{1,49}$/u
export const TOPIC_LENGTH = 390
export const MAX_CHANNELS = 50
export const PREFIXES = { o: '@', v: '+' } as const
export type Rank = keyof typeof PREFIXES

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
  signon = Date.now()
  active = Date.now()
  pinged = false
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
    return format({ ...message, tags })
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
  created = new Date()

  clients = new Map<Connection, Client>()
  /** By the folded nickname. */
  nicks = new Map<string, Client>()
  /** By the folded channel name. */
  channels = new Map<string, Channel>()

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
    this.isupport = new Map<string, string | true>([
      ['CASEMAPPING', 'ascii'],
      ['CHANTYPES', '#'],
      ['CHANMODES', ',,,mnt'],
      ['PREFIX', '(ov)@+'],
      ['NICKLEN', '30'],
      ['CHANNELLEN', '50'],
      ['TOPICLEN', String(TOPIC_LENGTH)],
      ['CHANLIMIT', `#:${MAX_CHANNELS}`],
      ['NETWORK', this.network],
    ])
  }

  // CASEMAPPING=ascii
  fold(name: string) {
    return name.toLowerCase()
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

  leave(client: Client, channel: Channel) {
    channel.members.delete(client)
    client.channels.delete(channel)
    if (!channel.members.size) {
      this.channels.delete(this.fold(channel.name))
    }
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
    const lines: Line[] = []
    const all = client.capabilities.has('multi-prefix')
    const userhost = client.capabilities.has('userhost-in-names')
    let chunk: string[] = []
    for (const member of channel.members.keys()) {
      chunk.push(channel.prefix(member, all) + (userhost ? member.mask : member.nick))
      if (chunk.join(' ').length > 350) {
        lines.push([RPL_NAMREPLY, '=', channel.name, chunk.join(' ')])
        chunk = []
      }
    }
    if (chunk.length) {
      lines.push([RPL_NAMREPLY, '=', channel.name, chunk.join(' ')])
    }
    return [...lines, [RPL_ENDOFNAMES, channel.name, 'End of /NAMES list']]
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
    return [
      [RPL_LUSERCLIENT, `There are ${this.nicks.size} users and 0 invisible on 1 servers`],
      [RPL_LUSERCHANNELS, this.channels.size, 'channels formed'],
      [RPL_LUSERME, `I have ${this.nicks.size} clients and 0 servers`],
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
