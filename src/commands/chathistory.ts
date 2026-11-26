import { Hono } from 'tcp-hono'
import { FIRST, LAST, encodeTime, parseTimestamp } from '../history.ts'
import { byteLength } from '../protocol.ts'
import { echo, fail } from '../state.ts'
import type { Channel, Chat, Client, Env, Server } from '../state.ts'
import { present } from './messages.ts'

const CAPABILITY = 'draft/chathistory'
const END = 'draft/chathistory-end'
/** The msgids of this server (see `Server.msgid()`). */
const MSGID = /^[0-9A-HJKMNP-TV-Z]{26}$/
/**
 * About how many bytes one reply may play back. A reply has at most `limit` messages, and a
 * multiline message can have many lines, so it also stops at this size, after one message at
 * least; the client asks for the rest as it would for the next page.
 */
const MAX_REPLY_BYTES = 256 * 1024

/** The number of parameters of each subcommand, with the subcommand. */
const ARITY: Record<string, number> = {
  LATEST: 4,
  BEFORE: 4,
  AFTER: 4,
  AROUND: 4,
  BETWEEN: 5,
  TARGETS: 4,
}

/** A message reference: a msgid, a time in milliseconds, or `*`. */
type Ref = { msgid: string } | { time: number } | '*'

/** The first msgid after the reference, excluded, as a bound of `History.page()`. */
const after = (ref: Exclude<Ref, '*'>) =>
  // The msgids after one are those from it with one more character, as they all have 26.
  'msgid' in ref ? ref.msgid + '0' : encodeTime(ref.time + 1)
/** The bound of the msgids before the reference, excluded. */
const before = (ref: Exclude<Ref, '*'>) => ('msgid' in ref ? ref.msgid : encodeTime(ref.time))

const later = (a: string, b: string) => (a > b ? a : b)
const iso = (ms: number) => new Date(ms).toISOString()

/** About how many bytes a message takes when it is played back. */
const size = (chat: Chat) =>
  byteLength(JSON.stringify(chat)) +
  (chat.lines?.length ?? 1) * (byteLength(chat.source) + byteLength(chat.target) + 64)

/**
 * Take the messages, in the order of the query, up to the limit and the size of a reply, and tell
 * whether there are more: the query asks for one more than the limit.
 */
const take = (chats: Chat[], limit: number) => {
  let bytes = 0
  let count = 0
  for (const chat of chats.slice(0, limit)) {
    bytes += size(chat)
    if (count && bytes > MAX_REPLY_BYTES) {
      break
    }
    count++
  }
  return { chats: chats.slice(0, count), more: chats.length > count }
}

/**
 * The history of a target that a client may read: its stored target, if it has one yet, the msgid
 * from which the client may read it, and its canonical name.
 */
type Readable = { target?: number; floor: string; name: string }

/**
 * Message history: `CHATHISTORY`, https://ircv3.net/specs/extensions/chathistory (a work in
 * progress, hence `draft/chathistory`), with the `chathistory` batch type.
 *
 * - A channel's history is for its members, unless they are banned and have neither operator nor
 *   voice. A member reads the whole history of a permanent channel, and the one of another channel
 *   from when it joined, which is deleted with the channel.
 * - The direct messages are stored only between two clients logged in to accounts, by the pair of
 *   accounts, so a client logged in to one reads them from any connection, whatever the nicknames.
 *   A nickname as the target is the account of the client that has it, or the account of that name.
 * - A message is played back as it was delivered (see `present()`), with its time and msgid, and
 *   nothing else happens: it is not stored again, marked as read, or answered with RPL_AWAY.
 * - `draft/event-playback` is not supported: only PRIVMSG and NOTICE are stored.
 */
export const chathistory = (server: Server) => {
  const app = new Hono<Env>()
  const history = server.history
  if (!history) {
    return app
  }
  server.capabilities.set(CAPABILITY, undefined)
  server.tagCapabilities.set(END, CAPABILITY)
  server.isupport.set('CHATHISTORY', String(history.limit))
  server.isupport.set('MSGREFTYPES', 'msgid,timestamp')

  /**
   * The msgid from which a member reads the history of a channel: from when it joined, or in a
   * permanent channel, from when the channel became permanent, if that is earlier.
   */
  const floor = (client: Client, channel: Channel) => {
    const joined = channel.joined.get(client)! + '0'
    if (!channel.permanent) {
      return joined
    }
    const since = channel.since ?? FIRST
    return since < joined ? since : joined
  }

  /** The history of a target that the client may read, or `undefined`. */
  const readable = (client: Client, name: string): Readable | undefined => {
    if (name[0] === '#') {
      const channel = server.channels.get(server.fold(name))
      if (
        !channel?.members.has(client) ||
        (channel.banned(client) && !channel.privileged(client))
      ) {
        return
      }
      return { target: channel.history, floor: floor(client, channel), name: channel.name }
    }
    const peer = client.account === undefined ? undefined : server.accountOf(name)
    if (!peer) {
      return
    }
    const target = history.direct(server.fold(client.account!), peer.folded)
    return { target, floor: FIRST, name: peer.name }
  }

  /** Play messages back to the client, in one `chathistory` batch if it has `batch`. */
  const play = (client: Client, name: string, chats: Chat[], end: boolean) => {
    if (!client.capabilities.has('batch')) {
      for (const chat of chats) {
        present(client, chat, true, { replay: true })
      }
      return
    }
    const ref = client.reference()
    client.send({
      ...(end && { tags: { [END]: '' } }),
      source: server.name,
      command: 'BATCH',
      params: ['+' + ref, 'chathistory', name],
    })
    for (const chat of chats) {
      present(client, chat, true, { parent: ref, replay: true })
    }
    client.send({ source: server.name, command: 'BATCH', params: ['-' + ref] })
  }

  /** A page of a target in the order of the query, with one more message to tell if there are. */
  const page = (
    target: number | undefined,
    order: 'ASC' | 'DESC',
    low: string,
    high: string,
    limit: number
  ) => take(target === undefined ? [] : history.page(target, order, low, high, limit + 1), limit)

  /** The messages of a subcommand, in the order of time, and whether there are no more. */
  const select = (
    subcommand: string,
    { target, floor }: Readable,
    refs: Ref[],
    limit: number
  ): { chats: Chat[]; end: boolean } => {
    const [ref, other] = refs
    if (subcommand === 'LATEST') {
      const low = ref === '*' ? floor : later(floor, after(ref))
      const { chats, more } = page(target, 'DESC', low, LAST, limit)
      return { chats: chats.reverse(), end: !more }
    }
    if (ref === '*' || other === '*') {
      throw new Error('Unexpected *')
    }
    if (subcommand === 'BEFORE') {
      const { chats, more } = page(target, 'DESC', floor, before(ref), limit)
      return { chats: chats.reverse(), end: !more }
    }
    if (subcommand === 'AFTER') {
      const { chats, more } = page(target, 'ASC', later(floor, after(ref)), LAST, limit)
      return { chats, end: !more }
    }
    if (subcommand === 'AROUND') {
      // Half before the reference, and the rest from it on, the message itself included.
      const earlier = page(target, 'DESC', floor, before(ref), Math.floor(limit / 2))
      const rest = limit - earlier.chats.length
      const from = later(floor, before(ref))
      const next = page(target, 'ASC', from, LAST, rest)
      return {
        chats: [...earlier.chats.reverse(), ...next.chats],
        end: !earlier.more && !next.more,
      }
    }
    // BETWEEN, counted from the first reference, forward or backward in time.
    if (before(ref) <= before(other)) {
      const { chats, more } = page(target, 'ASC', later(floor, after(ref)), before(other), limit)
      return { chats, end: !more }
    }
    const { chats, more } = page(target, 'DESC', later(floor, after(other)), before(ref), limit)
    return { chats: chats.reverse(), end: !more }
  }

  /**
   * The targets of `TARGETS`: the channels that the client is in and may read, and the accounts
   * that it has direct messages with, with the time of their last message.
   */
  const targets = (client: Client): { name: string; time: number }[] => {
    const result: { name: string; time: number }[] = []
    for (const channel of client.channels) {
      const source = readable(client, channel.name)
      const time =
        source?.target === undefined ? undefined : history.latest(source.target, source.floor)
      if (time !== undefined) {
        result.push({ name: channel.name, time })
      }
    }
    if (client.account !== undefined) {
      for (const { target, peer } of history.correspondents(server.fold(client.account))) {
        const time = history.latest(target)
        if (time !== undefined) {
          result.push({ name: server.accounts!.get(peer)?.name ?? peer, time })
        }
      }
    }
    return result
  }

  /** A reference from a parameter, or the error that it is. */
  const parseRef = (param: string): Ref | 'invalid' | 'type' => {
    if (param === '*') {
      return '*'
    }
    const i = param.indexOf('=')
    const [type, value] = [param.slice(0, i), param.slice(i + 1)]
    if (type === 'timestamp') {
      const time = parseTimestamp(value)
      return time === undefined ? 'invalid' : { time }
    }
    if (type === 'msgid') {
      return MSGID.test(value) ? { msgid: value } : 'invalid'
    }
    return i > 0 ? 'type' : 'invalid'
  }

  // `CHATHISTORY <subcommand> <target> <reference> [<reference>] <limit>`, and
  // `CHATHISTORY TARGETS <timestamp> <timestamp> <limit>`.
  app.on('TCP', '/CHATHISTORY/*', (c) => {
    const { client, message } = c.var
    const [given = '', ...params] = message.params
    const subcommand = given.toUpperCase()
    const invalid = (...rest: [...string[], string]) =>
      c.render(fail('CHATHISTORY', 'INVALID_PARAMS', echo(subcommand), ...rest))
    if (!given) {
      return invalid('Insufficient parameters')
    }
    const arity = ARITY[subcommand]
    if (!arity) {
      return invalid('Unknown command')
    }
    if (message.params.length < arity) {
      return invalid('Insufficient parameters')
    }
    if (message.params.length > arity) {
      return invalid('Too many parameters')
    }
    const targetName = subcommand === 'TARGETS' ? '' : params.shift()!
    const limitParam = params.pop()!
    const refs: Ref[] = []
    for (const [i, param] of params.entries()) {
      const ref = parseRef(param)
      if (ref === 'type') {
        return c.render(
          fail(
            'CHATHISTORY',
            'INVALID_MSGREFTYPE',
            subcommand,
            echo(targetName || '*'),
            echo(param),
            'Unknown message reference type'
          )
        )
      }
      // `*` is only the reference of LATEST, and TARGETS takes timestamps.
      if (
        ref === 'invalid' ||
        (ref === '*' && (subcommand !== 'LATEST' || i > 0)) ||
        (subcommand === 'TARGETS' && !(typeof ref === 'object' && 'time' in ref))
      ) {
        return invalid(echo(param), 'Invalid message reference')
      }
      refs.push(ref)
    }
    if (!/^\d{1,9}$/.test(limitParam) || !Number(limitParam)) {
      return invalid(echo(limitParam), 'Invalid limit')
    }
    const limit = Math.min(Number(limitParam), history.limit)

    // The database may fail: the client is told that nothing can be retrieved.
    const failed = (error: unknown) => {
      server.report(error)
      return c.render(
        fail(
          'CHATHISTORY',
          'MESSAGE_ERROR',
          subcommand,
          echo(targetName || '*'),
          'Messages could not be retrieved'
        )
      )
    }

    if (subcommand === 'TARGETS') {
      const [a, b] = refs.map((ref) => (ref as { time: number }).time)
      const [low, high] = a <= b ? [a, b] : [b, a]
      let all: { name: string; time: number }[]
      try {
        all = targets(client)
      } catch (error) {
        return failed(error)
      }
      const found = all
        .filter(({ time }) => time > low && time < high)
        // From the first timestamp, and then in the order of time.
        .sort((x, y) => (a <= b ? x.time - y.time : y.time - x.time))
      const listed = found.slice(0, limit).sort((x, y) => x.time - y.time)
      const lines = listed.map(({ name, time }) => ({
        source: server.name,
        command: 'CHATHISTORY',
        params: ['TARGETS', name, iso(time)],
      }))
      client.sendBatch(
        {
          source: server.name,
          type: 'draft/chathistory-targets',
          ...(found.length <= limit && { tags: { [END]: '' } }),
        },
        lines
      )
      return c.render()
    }

    let source: Readable | undefined
    let selected: { chats: Chat[]; end: boolean }
    try {
      source = readable(client, targetName)
      if (!source) {
        return c.render(
          fail(
            'CHATHISTORY',
            'INVALID_TARGET',
            subcommand,
            echo(targetName),
            'Messages could not be retrieved'
          )
        )
      }
      selected = select(subcommand, source, refs, limit)
    } catch (error) {
      return failed(error)
    }
    play(client, source.name, selected.chats, selected.end)
    return c.render()
  })

  // replayOnJoin: the last messages of a channel to a client that joins it, unless it can ask for
  // them with draft/chathistory, as the spec says. The rules are those of CHATHISTORY LATEST.
  if (server.replayOnJoin > 0) {
    server.onJoin.push((client, channel) => {
      if (client.capabilities.has(CAPABILITY)) {
        return
      }
      const source = readable(client, channel.name)
      if (source?.target === undefined) {
        return
      }
      const { chats, end } = select('LATEST', source, ['*'], server.replayOnJoin)
      if (chats.length) {
        play(client, source.name, chats, end)
      }
    })
  }

  return app
}
