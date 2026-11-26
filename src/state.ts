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
  ERR_BADCHANNELKEY,
  ERR_BANNEDFROMCHAN,
  ERR_CHANNELISFULL,
  ERR_INVITEONLYCHAN,
  RPL_MONOFFLINE,
  RPL_MONONLINE,
  ERR_NICKNAMEINUSE,
  ERR_SASLABORTED,
  RPL_LOGGEDIN,
} from './numerics.ts'
import { Accounts } from './accounts.ts'
import type { AccountOptions } from './accounts.ts'
import { ChannelStore } from './channels-store.ts'
import type { PermanentOptions, StoredEntry } from './channels-store.ts'
import { cloak } from './cloak.ts'
import { CROCKFORD, History, encodeTime } from './history.ts'
import type { HistoryOptions } from './history.ts'
import { compile, matches } from './masks.ts'
import type { Glob } from './masks.ts'
import { MAX_LINE_LENGTH, MAX_TAG_DATA, byteLength, format, tagsLength } from './protocol.ts'
import type { IRCMessage } from './protocol.ts'
import { memoryStore, migrate } from './store.ts'
import type { Store } from './store.ts'

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
    /** What the prepare step of the command made, if it has one. See `Server.prepare`. */
    prepared: unknown
  }
}

/**
 * The slow, asynchronous work of a command, such as deriving a key from a password, which runs
 * before its synchronous handler and hands it the result. See `Server.prepare`.
 */
export type Prepare = (client: Client, message: IRCMessage) => Promise<unknown>

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
  /**
   * The key of the cloaks, the hosts that are shown in place of the addresses. A client gets the
   * same cloak each time it connects from the same address while the key stays the same. Random
   * for each server by default.
   */
  cloakSecret?: string
  /**
   * The database: the accounts are stored in it. An in-memory one by default where the runtime has
   * `node:sqlite`. Without one (`false`, or on a runtime without it), there are no accounts.
   */
  database?: Store | false
  /** The accounts, their registration, and their limits. */
  accounts?: AccountOptions
  /**
   * Whether a channel that a client logged in to an account creates is permanent (+P), with the
   * account as its founder. Needs a database.
   */
  persistChannels?: boolean
  /** The limits of the permanent channels. */
  permanentChannels?: PermanentOptions
  /** The history of the messages (draft/chathistory), which needs a database. */
  history?: HistoryOptions
  /**
   * The number of stored messages that a client gets when it joins a channel, if it does not have
   * draft/chathistory to ask for them. 0, by default, sends none.
   */
  replayOnJoin?: number
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
/** The max length of a channel key, `KEYLEN`. */
export const KEY_LENGTH = 23
/** The max length of a realname, `NAMELEN`. */
export const NAME_LENGTH = 150
/** The max length of a mask of a list (+b, +e, +I). */
export const MASK_LENGTH = 100
/** The max number of entries of the lists of a channel, together, as `MAXLIST` shows it. */
export const MAX_LIST = 100
/** The max number of mode changes with a parameter in one MODE command, `MODES`. */
export const MAX_MODES = 4
/** The max number of nicknames that a client can monitor, `MONITOR`. */
export const MAX_MONITOR = 100
/** The max number of channels that a client is invited to at once. The oldest invite goes first. */
export const MAX_INVITES = 50
/** The text of ERR_NICKNAMEINUSE for a nickname that an account reserves. */
export const RESERVED = 'Nickname is reserved by a different account'

// No whitespace, commas, colons, control characters such as BEL, or format characters,
// such as the bidirectional overrides and the zero-width ones, which can make two names look alike.
const CHANNEL_PATTERN = /^#[^\s,:\p{Cc}\p{Cf}]+$/u

export const isChannelName = (name: string) =>
  CHANNEL_PATTERN.test(name) && byteLength(name) <= CHANNEL_LENGTH

// NICK_LENGTH characters, which are ASCII, so it is also the length in bytes.
const NICK_PATTERN = /^[A-Za-z_[\]\\`^{}|][A-Za-z0-9_\-[\]\\`^{}|]{0,29}$/

export const isNickname = (nick: string) => NICK_PATTERN.test(nick)

/** The channel modes of type A, the lists of masks: bans, ban exceptions, and invite exceptions. */
export type ListMode = 'b' | 'e' | 'I'
/** An entry of a list. `glob` is the folded mask, compiled. */
export type ListEntry = { mask: string; by: string; at: number; glob: Glob }

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

/**
 * A SASL exchange that a client has begun and not finished: the mechanism, and the base64 of the
 * client's response so far, which comes in chunks of 400 bytes.
 */
export type SaslSession = { mechanism: string; response: string }

/** A line of a multiline message, and whether it is joined to the line before it. */
export type MultilineLine = { text: string; concat: boolean }

/**
 * A message from a user to one target, as it is delivered, stored, and played back. `time` is the
 * time of its `msgid` in milliseconds. `account` and `bot` are those of the sender when it was
 * sent: a message that is played back has them as tags, and a live one gets the tags from the
 * sender as it is (`Server.sourceTags()`).
 */
export type Chat = {
  msgid: string
  time: number
  command: 'PRIVMSG' | 'NOTICE' | 'TAGMSG'
  /** The mask of the sender. */
  source: string
  account?: string
  bot?: boolean
  /** The target as the recipients get it: the name of the channel, or the nickname. */
  target: string
  /** The text of one line, or the lines of a multiline message. TAGMSG has neither. */
  text?: string
  lines?: MultilineLine[]
  /** The client-only tags. */
  tags: Record<string, string>
}

/**
 * A tag of the server that marks a message whose tags are complete, such as one that is played
 * back: `Server.sourceTags()` adds nothing to it. No capability owns it, so it is never sent.
 */
export const VERBATIM = 'hono-irc/verbatim'

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
  /**
   * The real address is not exposed to the other users. The host is a cloak of the address if the
   * runtime knows it, which stays the same for the same address, or random otherwise.
   */
  host: string
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
  /** User mode `B`: the client is a bot. */
  bot = false
  /**
   * The channels that the client is invited to, oldest first. `Channel.invited` is the other side.
   */
  invites = new Set<Channel>()
  /**
   * The nicknames that the client monitors, as it sent them, by the folded nickname.
   * `Server.monitors` is the other side.
   */
  monitoring = new Map<string, string>()
  /**
   * The messages to this client while its own command is handled. The middleware in `server.ts`
   * opens it and writes it as the response, so they are not pushed. `undefined` otherwise.
   */
  outbox?: OutboxEntry[]
  /** The `draft/multiline` batch that the client is sending, if any. */
  inbound?: InboundBatch
  /** The name of the account that the client is logged in to, as it was registered. */
  account?: string
  /** The SASL exchange that the client is in, if any. */
  sasl?: SaslSession
  /** The failed SASL authentications on this connection. */
  saslFailures = 0
  // The last reference tag of a batch to this client, which is unique for the connection.
  #references = 0

  server: Server
  connection: Connection

  constructor(server: Server, connection: Connection, info: ConnectionInfo = {}) {
    this.server = server
    this.connection = connection
    this.ip = info.ip
    this.secure = info.secure ?? false
    this.host =
      info.ip === undefined
        ? `${crypto.randomUUID().slice(0, 8)}.user`
        : cloak(info.ip, server.cloakSecret)
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
    message = stamp(this.server.sourceTags(message))
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
   *
   * `parent` is the reference of a batch that this one is nested in, such as a `chathistory` batch:
   * the `BATCH` lines have it, and the messages have the reference of this one.
   */
  sendBatch(
    batch: { source: string; type: string; params?: string[]; tags?: Record<string, string> },
    messages: IRCMessage[],
    response = true,
    parent?: string
  ) {
    const outer: Record<string, string> = parent === undefined ? {} : { batch: parent }
    if (!this.capabilities.has('batch')) {
      messages.forEach((message, i) => {
        this.send(i ? message : { ...message, tags: { ...batch.tags, ...message.tags } }, response)
      })
      return
    }
    const ref = this.reference()
    const { source, type, params = [], tags } = batch
    this.send(
      {
        tags: { ...outer, ...tags },
        source,
        command: 'BATCH',
        params: ['+' + ref, type, ...params],
      },
      response
    )
    for (const message of messages) {
      this.send({ ...message, tags: { batch: ref, ...message.tags } }, response)
    }
    const end = { source, command: 'BATCH', params: ['-' + ref] }
    const time: Record<string, string> = tags?.time === undefined ? {} : { time: tags.time }
    this.send({ ...end, tags: { ...outer, ...time } }, response)
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

  // The modes of type D are in `modes`: i, m, n, s, and t. The others are below.

  /** The key (+k). */
  key?: string
  /** The limit of members (+l). */
  limit?: number
  /** The lists of masks (+b, +e, +I). */
  lists: Record<ListMode, ListEntry[]> = { b: [], e: [], I: [] }
  /** The clients that are invited, until they join. `Client.invites` is the other side. */
  invited = new Set<Client>()
  /** The folded name of the account of the client that created the channel, if it had one. */
  founder?: string
  /** The target of the stored messages of the channel, once it has one (see `History`). */
  history?: number
  /**
   * A msgid made when each member joined, which sorts after every message before. In a channel that
   * is not permanent, a member reads the history from there on.
   */
  joined = new Map<Client, string>()

  /** Whether the channel is permanent (+P): it is stored, and stays when it is empty. */
  get permanent() {
    return this.modes.has('P')
  }

  /** Whether the client matches a mask of a list. */
  matches(mode: ListMode, client: Client) {
    const mask = client.server.fold(client.mask)
    return this.lists[mode].some((entry) => matches(entry.glob, mask))
  }

  /** Whether the client is banned (+b), and not excepted from the bans (+e). */
  banned(client: Client) {
    return this.matches('b', client) && !this.matches('e', client)
  }

  /** Whether the client is a member that is an operator or has voice, which a ban does not stop. */
  privileged(client: Client) {
    const ranks = this.members.get(client)
    return !!ranks && (ranks.has('o') || ranks.has('v'))
  }

  /** Whether the client sees the channel: a secret one (+s) only from inside. */
  visibleTo(client: Client) {
    return !this.modes.has('s') || this.members.has(client)
  }

  /**
   * Whether the client may join with the key, or the error that stops it. An invite lets the client
   * in in spite of +i, +k, and +l, but not of a ban.
   */
  canJoin(client: Client, key?: string): Line | undefined {
    const invited = this.invited.has(client)
    if (this.banned(client)) {
      return [ERR_BANNEDFROMCHAN, this.name, 'Cannot join channel (+b)']
    }
    if (this.modes.has('i') && !invited && !this.matches('I', client)) {
      return [ERR_INVITEONLYCHAN, this.name, 'Cannot join channel (+i)']
    }
    if (this.key !== undefined && key !== this.key && !invited) {
      return [ERR_BADCHANNELKEY, this.name, 'Cannot join channel (+k)']
    }
    if (this.limit !== undefined && this.members.size >= this.limit && !invited) {
      return [ERR_CHANNELISFULL, this.name, 'Cannot join channel (+l)']
    }
  }

  /**
   * Whether the client may send a message to the channel: from outside only without +n, only an
   * operator or a member with voice with +m, and not while it is banned, unless it is one of them.
   */
  canSend(client: Client) {
    if (this.modes.has('n') && !this.members.has(client)) {
      return false
    }
    return this.privileged(client) || (!this.modes.has('m') && !this.banned(client))
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
  cloakSecret: string
  created = new Date()

  clients = new Map<Connection, Client>()
  /** By the folded nickname. */
  nicks = new Map<string, Client>()
  /** By the folded channel name. */
  channels = new Map<string, Channel>()
  /** The number of connections from each address that the runtime told. */
  addresses = new Map<string, number>()
  /**
   * The clients that monitor a nickname, by the folded nickname.
   * `Client.monitoring` is the other side.
   */
  monitors = new Map<string, Set<Client>>()

  /**
   * The capabilities, with the value that `CAP LS 302` shows, e.g. `sasl` to `PLAIN`.
   * A feature module adds its own here.
   */
  capabilities = new Map<string, string | undefined>([
    ['account-notify', undefined],
    ['account-tag', undefined],
    ['away-notify', undefined],
    ['cap-notify', undefined],
    ['echo-message', undefined],
    ['extended-join', undefined],
    ['extended-monitor', undefined],
    ['invite-notify', undefined],
    ['multi-prefix', undefined],
    ['no-implicit-names', undefined],
    ['server-time', undefined],
    ['setname', undefined],
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
    // The spec of bot mode sends it only with `message-tags`.
    ['bot', 'message-tags'],
    ['account', 'account-tag'],
    ['msgid', 'message-tags'],
    ['batch', 'batch'],
    ['label', 'labeled-response'],
  ])

  /** The RPL_ISUPPORT tokens. `true` is a token without a value. */
  isupport: Map<string, string | true>

  /** The commands that a client can send before the registration. */
  beforeRegistration = new Set(['CAP', 'NICK', 'USER', 'PASS', 'PING', 'PONG', 'QUIT'])

  /**
   * The prepare steps of the commands, by command. A handler is synchronous, so the slow work that
   * a command needs, which is asynchronous, such as deriving a key from a password with WebCrypto,
   * is done here first. The middleware of `server.ts` runs it before the outbox is opened, like
   * the wait of the flood control, and hands the result to the handler as `c.var.prepared`.
   *
   * A step only computes: it must not change the state, which the others can change meanwhile.
   * The handler reads the state again and decides. A command with a step takes its flood cost
   * even before the registration.
   */
  prepare = new Map<string, Prepare>()

  /** The database, if the server has one. */
  store?: Store
  /** The accounts, if the server has a database. */
  accounts?: Accounts
  /** The permanent channels, if the server has a database. */
  channelStore?: ChannelStore
  /** The stored messages and read markers, if the server has a database. */
  history?: History
  persistChannels: boolean
  replayOnJoin: number
  /** The channel modes of type D, which `P` is one of with a database. */
  settings: string

  /**
   * What a feature sends to a client that joins a channel, after the JOIN and the topic, and
   * before the names, such as its read marker. A hook sends with `client.send()`.
   */
  onJoin: ((client: Client, channel: Channel) => void)[] = []

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
            costs: config.flood?.costs ?? {
              NICK: 3,
              JOIN: 2,
              PART: 2,
              AUTHENTICATE: 2,
              REGISTER: 3,
              // A request reads up to `history.limit` messages, and plays them back.
              CHATHISTORY: 2,
            },
          }
    this.maxConnections = config.maxConnections ?? 1000
    this.maxConnectionsPerIp = config.maxConnectionsPerIp ?? 10
    this.maxChannels = config.maxChannels ?? 1000
    this.multiline = {
      maxBytes: config.multiline?.maxBytes ?? 4096,
      maxLines: config.multiline?.maxLines ?? 100,
      timeout: config.multiline?.timeout ?? 30_000,
    }
    this.cloakSecret =
      config.cloakSecret ??
      Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('')
    const store = config.database === false ? undefined : (config.database ?? memoryStore())
    if (store) {
      migrate(store)
      this.store = store
      this.accounts = new Accounts(store, (name) => this.fold(name), config.accounts)
      this.channelStore = new ChannelStore(store, config.permanentChannels)
      this.history = new History(store, config.history)
    }
    this.persistChannels = config.persistChannels ?? true
    this.replayOnJoin = config.replayOnJoin ?? 0
    this.settings = store ? 'Pimnst' : 'imnst'
    this.isupport = new Map<string, string | true>([
      ['CASEMAPPING', 'ascii'],
      ['CHANTYPES', '#'],
      // The lists, the key, the limit, and the modes without a parameter.
      ['CHANMODES', `beI,k,l,${this.settings}`],
      ['EXCEPTS', true],
      ['INVEX', true],
      ['MAXLIST', `beI:${MAX_LIST}`],
      ['MODES', String(MAX_MODES)],
      ['KEYLEN', String(KEY_LENGTH)],
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
      ['NAMELEN', String(NAME_LENGTH)],
      ['MONITOR', String(MAX_MONITOR)],
      ['WHOX', true],
      ['BOT', 'B'],
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
    return this.stamp().msgid
  }

  /**
   * A new message ID and its time in milliseconds, which is the `time` tag of the message. The time
   * never goes back in a process, so the order of the IDs is the order of the times.
   */
  stamp(): { msgid: string; time: number } {
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
    let id = encodeTime(this.#msgTime)
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
    return { msgid: id, time: this.#msgTime }
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

  /**
   * The members of a channel that a client can see: an invisible one only from inside, and none of
   * a secret channel from outside.
   */
  visibleMembers(client: Client, channel: Channel) {
    const inside = channel.members.has(client)
    if (!channel.visibleTo(client)) {
      return []
    }
    return [...channel.members.keys()].filter((member) => inside || !member.invisible)
  }

  leave(client: Client, channel: Channel) {
    channel.members.delete(client)
    channel.joined.delete(client)
    client.channels.delete(channel)
    if (!channel.members.size) {
      this.channels.delete(this.fold(channel.name))
      // An invite is to this channel, not to another one of the same name later.
      for (const invited of channel.invited) {
        invited.invites.delete(channel)
      }
      channel.invited.clear()
      // A permanent channel stays stored, with its history. The history of another one goes.
      if (channel.permanent) {
        this.channelStore?.touch(this.fold(channel.name))
      } else if (channel.history !== undefined) {
        this.history?.setEnding(channel.history, 1)
      }
    }
  }

  /**
   * A channel from the store, as it was when it was last changed, if it is permanent. It is not
   * added to the channels: the caller does, when a client joins it.
   */
  restore(name: string): Channel | undefined {
    const row = this.channelStore?.get(this.fold(name))
    if (!row) {
      return
    }
    const channel = new Channel(row.name)
    channel.created = row.created
    channel.founder = row.founder
    channel.modes = new Set(row.modes)
    channel.key = row.key ?? undefined
    channel.limit = row.max_members ?? undefined
    if (row.topic !== null) {
      channel.topic = { text: row.topic, by: row.topic_by ?? '', at: row.topic_at ?? 0 }
    }
    for (const [mode, mask, by, at] of JSON.parse(row.lists) as StoredEntry[]) {
      channel.lists[mode].push({ mask, by, at, glob: compile(this.fold(mask)) })
    }
    channel.history = row.history ?? undefined
    return channel
  }

  /**
   * A channel by its name: one that has members, or a permanent one that is empty, which is not
   * added to the channels. A secret one that is empty is left out, as nobody is in it.
   */
  find(name: string): Channel | undefined {
    const channel = this.channels.get(this.fold(name)) ?? this.restore(name)
    return channel && (channel.members.size || !channel.modes.has('s')) ? channel : undefined
  }

  /** Write the state of a channel to the store, if it is permanent and has members. */
  persist(channel: Channel) {
    if (channel.permanent && this.channels.get(this.fold(channel.name)) === channel) {
      this.channelStore?.save(this.fold(channel.name), channel)
    }
  }

  /**
   * The account that a nickname stands for, as a target of the history or of a read marker: the
   * account of the client that has the nickname, or else the account of that name. `name` is the
   * nickname of that client, or the name of the account.
   */
  accountOf(nick: string): { folded: string; name: string } | undefined {
    const online = this.nicks.get(this.fold(nick))
    if (online?.registered && online.account !== undefined) {
      return { folded: this.fold(online.account), name: online.nick }
    }
    const account = this.accounts?.get(nick)
    return account && { folded: account.folded, name: account.name }
  }

  /** Whether the client is logged in to the account that founded the channel. */
  founds(client: Client, channel: Channel) {
    return (
      channel.founder !== undefined &&
      client.account !== undefined &&
      this.fold(client.account) === channel.founder
    )
  }

  /**
   * Make a channel permanent, or ordinary. A permanent one is stored, and its history kept; an
   * ordinary one is deleted from the store, and its history goes when the channel does. One
   * transaction.
   */
  setPermanent(channel: Channel, permanent: boolean) {
    const store = this.channelStore!
    const folded = this.fold(channel.name)
    this.store!.transaction(() => {
      if (permanent) {
        channel.modes.add('P')
        store.insert(folded, channel)
      } else {
        channel.modes.delete('P')
        store.remove(folded)
      }
      if (channel.history !== undefined) {
        this.history!.setEnding(channel.history, permanent ? null : 0)
      }
    })
  }

  /**
   * Delete a bounded amount of what has expired: the permanent channels that nobody has joined for
   * `permanentChannels.expire`, with their histories, and old messages (see `History.sweep()`).
   */
  expire(now = Date.now()) {
    const store = this.channelStore
    const history = this.history
    if (!store || !history) {
      return
    }
    for (const { folded, history: target } of store.expired(now, 10)) {
      // A channel with members is in use, whatever the store says.
      if (this.channels.has(folded)) {
        store.touch(folded, now)
        continue
      }
      this.store!.transaction(() => {
        store.remove(folded)
        if (target !== null) {
          history.setEnding(target, 1)
        }
      })
    }
    history.sweep(now)
  }

  /**
   * Store a message of a channel in its history, which is made with the first message.
   */
  record(channel: Channel, chat: Chat) {
    const history = this.history
    if (!history || chat.command === 'TAGMSG') {
      return
    }
    this.store!.transaction(() => {
      if (channel.history === undefined) {
        channel.history = history.createTarget(channel.permanent)
        if (channel.permanent) {
          this.channelStore!.setHistory(this.fold(channel.name), channel.history)
        }
      }
      history.add(channel.history, chat)
    })
  }

  /**
   * Store a direct message, if both ends are logged in to accounts: its history is the one of the
   * two accounts, whatever their nicknames and connections.
   */
  recordDirect(sender: Client, recipient: Client, chat: Chat) {
    const history = this.history
    if (!history || chat.command === 'TAGMSG' || !sender.account || !recipient.account) {
      return
    }
    this.store!.transaction(() => {
      const target = history.direct(
        this.fold(sender.account!),
        this.fold(recipient.account!),
        true
      )!
      history.add(target, chat)
    })
  }

  /** Invite a client to a channel. A client keeps the last MAX_INVITES invites. */
  invite(client: Client, channel: Channel) {
    client.invites.delete(channel)
    client.invites.add(channel)
    channel.invited.add(client)
    if (client.invites.size > MAX_INVITES) {
      const [oldest] = client.invites
      this.uninvite(client, oldest)
    }
  }

  uninvite(client: Client, channel: Channel) {
    client.invites.delete(channel)
    channel.invited.delete(client)
  }

  /** Add a nickname to the list of a client. */
  monitor(client: Client, nick: string) {
    const folded = this.fold(nick)
    client.monitoring.set(folded, nick)
    const watchers = this.monitors.get(folded) ?? new Set()
    watchers.add(client)
    this.monitors.set(folded, watchers)
  }

  /** Remove a nickname, folded, from the list of a client. */
  unmonitor(client: Client, folded: string) {
    client.monitoring.delete(folded)
    const watchers = this.monitors.get(folded)
    watchers?.delete(client)
    if (!watchers?.size) {
      this.monitors.delete(folded)
    }
  }

  /** Tell the clients that monitor a nickname that it is online, as the client, or offline. */
  notifyMonitors(nick: string, client?: Client) {
    for (const watcher of this.monitors.get(this.fold(nick)) ?? []) {
      this.reply(watcher, [client ? [RPL_MONONLINE, client.mask] : [RPL_MONOFFLINE, nick]], false)
    }
  }

  /**
   * The clients that get a notification of a change of the client, such as an AWAY or a SETNAME,
   * which they get with the capability: the ones that share a channel with it, and with
   * `extended-monitor`, the ones that monitor it. The client itself is not included.
   */
  audience(client: Client, capability: string) {
    const result = new Set<Client>()
    for (const peer of this.peers(client)) {
      if (peer.capabilities.has(capability)) {
        result.add(peer)
      }
    }
    for (const watcher of this.monitors.get(this.fold(client.nick)) ?? []) {
      if (
        watcher !== client &&
        watcher.capabilities.has('extended-monitor') &&
        watcher.capabilities.has(capability)
      ) {
        result.add(watcher)
      }
    }
    return result
  }

  /** Clean up after a client that has gone: its invites and its list of MONITOR. */
  forget(client: Client) {
    for (const channel of client.invites) {
      channel.invited.delete(client)
    }
    client.invites.clear()
    for (const folded of client.monitoring.keys()) {
      this.unmonitor(client, folded)
    }
  }

  /**
   * Send replies from the server to a client. A numeric reply gets the nickname of the client.
   * `c.render()` sends the replies to the requesting client with this, and a notification such as
   * one of MONITOR is sent with it too, with `response` false when it is not an answer to the
   * command of the client, so that labeled-response leaves it out of the response.
   */
  reply(client: Client, lines: Line[], response = true) {
    for (const [command, ...params] of lines) {
      client.send(
        {
          source: this.name,
          command,
          params: [...(/^\d{3}$/.test(command) ? [client.nick] : []), ...params.map(String)],
        },
        response
      )
    }
  }

  /**
   * Add the tags that tell about the client that a message comes from: `bot` for a client in bot
   * mode, and `account` for one that is logged in (account-tag). The client is found by the
   * nickname of the source when the message is sent, and the source must be its whole mask.
   */
  sourceTags(message: IRCMessage): IRCMessage {
    const bang = message.source?.indexOf('!') ?? -1
    if (bang < 1 || message.tags?.[VERBATIM] !== undefined) {
      return message
    }
    const sender = this.nicks.get(this.fold(message.source!.slice(0, bang)))
    if (!sender || sender.mask !== message.source || !(sender.bot || sender.account)) {
      return message
    }
    // After the tags that the message has, and without replacing them.
    const tags = { ...message.tags }
    if (sender.bot) {
      tags.bot ??= ''
    }
    if (sender.account) {
      tags.account ??= sender.account
    }
    return { ...message, tags }
  }

  /**
   * Whether the nickname is the name of an account that the client is not logged in to, which
   * reserves it, unless `reserveNicknames` is off.
   */
  reserved(client: Client, nick: string) {
    if (!this.accounts?.reserveNicknames) {
      return false
    }
    const owner = this.accounts.get(nick)
    return !!owner && (client.account === undefined || this.fold(client.account) !== owner.folded)
  }

  /**
   * Log the client in to an account, with RPL_LOGGEDIN and the `lines` that go with it, such as
   * RPL_SASLSUCCESS. A registered client is then shown with ACCOUNT to itself and to the others
   * that have account-notify (account-notify, extended-monitor). The ACCOUNT is sent before the
   * account is set, so its `account` tag is the one the client had, as account-tag shows.
   */
  login(client: Client, account: string, ...lines: Line[]) {
    // Before the registration, the client may not have a nickname or a username yet.
    const mask = client.nick === '*' ? '*' : `${client.nick}!${client.user || '*'}@${client.host}`
    this.reply(client, [
      [RPL_LOGGEDIN, mask, account, `You are now logged in as ${account}`],
      ...lines,
    ])
    if (client.registered && client.account !== account) {
      const notice = msg(client.mask, 'ACCOUNT', account)
      for (const peer of this.audience(client, 'account-notify')) {
        peer.send(notice)
      }
      if (client.capabilities.has('account-notify')) {
        client.send(notice)
      }
    }
    client.account = account
    // An exchange that is still open, e.g. when the client registers the account, has no use.
    client.sasl = undefined
  }

  /**
   * Join the items with spaces into as few strings as possible, so that each one fits as the last
   * parameter of a numeric reply to the client that has the given parameters before it.
   */
  pack(client: Client, params: string[], items: string[], separator = ' '): string[] {
    const head = `:${this.name} 000 ${client.nick} ${params.map((param) => param + ' ').join('')}:`
    const max = MAX_LINE_LENGTH - 2 - byteLength(head)
    const chunks: string[] = []
    let chunk = ''
    let length = 0
    for (const item of items) {
      const size = byteLength(item)
      // The length is checked before the item is added, so a line never goes over.
      if (chunk && length + separator.length + size > max) {
        chunks.push(chunk)
        chunk = ''
        length = 0
      }
      chunk = chunk ? `${chunk}${separator}${item}` : item
      length += (length ? separator.length : 0) + size
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
    // `@` is a secret channel and `=` a public one.
    const symbol = channel.modes.has('s') ? '@' : '='
    return [
      ...this.pack(client, [symbol, channel.name], entries).map((chunk): Line => [
        RPL_NAMREPLY,
        symbol,
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

  /**
   * Complete the registration if the client has sent everything. Returns the welcome messages.
   *
   * A SASL exchange that is still going on is aborted first, as sasl-3.1 says, so the client
   * registers without the account. A nickname that an account reserves stops the registration
   * with ERR_NICKNAMEINUSE, and is released, so the client can send another one.
   */
  register(client: Client): Line[] {
    if (client.registered || client.negotiating || client.nick === '*' || !client.user) {
      return []
    }
    const lines: Line[] = []
    if (client.sasl) {
      client.sasl = undefined
      lines.push([ERR_SASLABORTED, 'SASL authentication aborted'])
    }
    if (this.reserved(client, client.nick)) {
      const nick = client.nick
      this.nicks.delete(this.fold(nick))
      client.nick = '*'
      return [...lines, [ERR_NICKNAMEINUSE, nick, RESERVED]]
    }
    client.registered = true
    this.notifyMonitors(client.nick, client)
    return [
      ...lines,
      [RPL_WELCOME, `Welcome to the ${this.network} Network, ${client.mask}`],
      [RPL_YOURHOST, `Your host is ${this.name}, running version ${VERSION}`],
      [RPL_CREATED, `This server was created ${this.created.toUTCString()}`],
      // The user modes, the channel modes, and the channel modes that have a parameter.
      [
        RPL_MYINFO,
        this.name,
        VERSION,
        'Bi',
        `Ibeklov${this.settings}`.split('').sort().join(''),
        'Ibeklov',
      ],
      ...this.isupportLines(),
      ...this.lusers(),
      ...this.motdLines(),
    ]
  }
}
