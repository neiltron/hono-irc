import { Hono } from 'tcp-hono'
import {
  ERR_CANNOTSENDTOCHAN,
  ERR_INPUTTOOLONG,
  ERR_NORECIPIENT,
  ERR_NOSUCHNICK,
  ERR_NOTEXTTOSEND,
  RPL_AWAY,
  RPL_NOWAWAY,
  RPL_UNAWAY,
} from '../numerics.ts'
import { truncate } from '../protocol.ts'
import type { IRCMessage } from '../protocol.ts'
import { AWAY_LENGTH, MAX_TARGETS, VERBATIM, clientTags, echo, msg, tooMany } from '../state.ts'
import type { Chat, Client, Env, Line, MultilineLine, Server } from '../state.ts'

/** What a client sends to one target: one line, or the lines of a multiline batch. */
export type Outgoing = {
  command: Chat['command']
  text?: string
  lines?: MultilineLine[]
  /** The client-only tags, which are relayed with it. */
  tags: Record<string, string>
}

export const MULTILINE = 'draft/multiline'
export const CONCAT = 'draft/multiline-concat'

/**
 * Send a message from a user to one client, live or played back from the history, so that both
 * follow the same rules of the capabilities:
 *
 * - TAGMSG only to a client with message-tags.
 * - A multiline message as one `draft/multiline` batch to a client that has it and `batch`, with the
 *   msgid and the client-only tags on the `BATCH +` line. To the others, its lines one by one,
 *   without the blank ones, with those tags on the first line.
 * - The `time` tag is the time of the msgid, which the history keeps, and `Client.format()` keeps
 *   each tag only for a client with its capability.
 *
 * A message that is played back (`replay`) has the `account` and `bot` tags of its sender as they
 * were then, and is marked `VERBATIM`, so that `Server.sourceTags()` adds nothing of the client that
 * has the same mask now. `parent` is the batch that it is played back in, e.g. a `chathistory` one.
 */
export const present = (
  recipient: Client,
  chat: Chat,
  response: boolean,
  { parent, replay = false }: { parent?: string; replay?: boolean } = {}
) => {
  if (chat.command === 'TAGMSG' && !recipient.capabilities.has('message-tags')) {
    return
  }
  const time = new Date(chat.time).toISOString()
  const outer: Record<string, string> = parent === undefined ? {} : { batch: parent }
  const sender: Record<string, string> = replay
    ? {
        ...(chat.bot && { bot: '' }),
        ...(chat.account !== undefined && { account: chat.account }),
        [VERBATIM]: '',
      }
    : {}
  const { source, command, target } = chat
  // The tags of the message, which a multiline batch has on its `BATCH +` line.
  const tags = { time, msgid: chat.msgid, ...chat.tags, ...sender }
  if (!chat.lines) {
    const params = chat.text === undefined ? [target] : [target, chat.text]
    recipient.send({ tags: { ...outer, ...tags }, source, command, params }, response)
    return
  }
  const line = (text: string, extra?: Record<string, string>): IRCMessage => ({
    tags: { time, ...extra, ...sender },
    source,
    command,
    params: [target, text],
  })
  if (recipient.capabilities.has(MULTILINE) && recipient.capabilities.has('batch')) {
    recipient.sendBatch(
      { source, type: MULTILINE, params: [target], tags },
      chat.lines.map(({ text, concat }) => line(text, concat ? { [CONCAT]: '' } : {})),
      response,
      parent
    )
    return
  }
  // The fallback keeps the lines as the client split them, without the blank ones.
  chat.lines
    .filter(({ text }) => text)
    .forEach(({ text }, i) => {
      const message = i ? line(text) : line(text, tags)
      recipient.send({ ...message, tags: { ...outer, ...message.tags } }, response)
    })
}

/**
 * Deliver a message from the client to one target, with the rules of PRIVMSG: the channel must let
 * the client speak, and the user must exist. It is the decision for the whole message, which is
 * one line or a multiline batch, and the only path of PRIVMSG, NOTICE, and TAGMSG.
 *
 * A message that is allowed gets its msgid and time, the same for every recipient and the echo, and
 * is stored in the history of the target, once: the channel's, or for a direct message between two
 * clients logged in to accounts, the one of the two accounts (see `Server.record()`).
 *
 * The sender gets its own copy only with echo-message, and that echo is the response to its
 * command. A message to oneself is also delivered as to anyone else, outside the response, so with
 * echo-message it comes twice, as labeled-response expects.
 *
 * Returns the replies to the sender: an error, or RPL_AWAY of the user.
 */
export const deliver = (
  server: Server,
  client: Client,
  targetName: string,
  outgoing: Outgoing
): Line[] => {
  const echoed = client.capabilities.has('echo-message')
  const compose = (target: string): Chat => ({
    ...server.stamp(),
    ...outgoing,
    source: client.mask,
    ...(client.account !== undefined && { account: client.account }),
    bot: client.bot,
    target,
  })
  // The message is delivered even if the database fails.
  const store = (write: () => void) => {
    try {
      write()
    } catch (error) {
      console.error(error)
    }
  }
  const channel = server.channels.get(server.fold(targetName))
  if (channel) {
    if (!channel.canSend(client)) {
      return [[ERR_CANNOTSENDTOCHAN, channel.name, 'Cannot send to channel']]
    }
    const chat = compose(channel.name)
    store(() => server.record(channel, chat))
    for (const member of channel.members.keys()) {
      if (member !== client) {
        present(member, chat, false)
      }
    }
    // A sender outside a channel without `n` is not a member, and gets its echo all the same.
    if (echoed) {
      present(client, chat, true)
    }
    return []
  }
  const target = server.nicks.get(server.fold(targetName))
  if (!target?.registered) {
    return [[ERR_NOSUCHNICK, echo(targetName), 'No such nick/channel']]
  }
  const chat = compose(target.nick)
  store(() => server.recordDirect(client, target, chat))
  present(target, chat, false)
  if (echoed) {
    present(client, chat, true)
  }
  return target.away !== undefined ? [[RPL_AWAY, target.nick, target.away]] : []
}

/** Messages: `PRIVMSG`, `NOTICE`, `TAGMSG`, and `AWAY`. */
export const messages = (server: Server) => {
  const app = new Hono<Env>()

  app.on('TCP', '/:command{PRIVMSG|NOTICE|TAGMSG}/*', (c) => {
    const { client, message } = c.var
    const command = c.req.param('command') as 'PRIVMSG' | 'NOTICE' | 'TAGMSG'
    const [list, text] = message.params
    const tags = clientTags(message.tags)

    // An automatic reply must not be sent in response to a NOTICE, so a NOTICE gets no error.
    const lines: Line[] = []
    if (!tags) {
      lines.push([ERR_INPUTTOOLONG, 'Input line was too long'])
    } else if (!list) {
      lines.push([ERR_NORECIPIENT, `No recipient given (${command})`])
    } else if (!text && command !== 'TAGMSG') {
      lines.push([ERR_NOTEXTTOSEND, 'No text to send'])
    } else {
      // The targets are folded and repeated ones dropped, so a line can not deliver a message
      // to the same client many times over.
      const { targets, excess } = server.targets(list, MAX_TARGETS[command])
      if (command !== 'TAGMSG') {
        client.idle = Date.now()
      }
      for (const targetName of targets) {
        // One message for each target. The client-only tags are relayed, and only to the clients
        // that have message-tags.
        const replies = deliver(server, client, targetName, {
          command,
          ...(command !== 'TAGMSG' && { text }),
          tags,
        })
        // A TAGMSG, such as a typing notification, does not get RPL_AWAY.
        lines.push(...replies.filter(([reply]) => command !== 'TAGMSG' || reply !== RPL_AWAY))
      }
      lines.push(...tooMany(excess))
    }
    return command === 'NOTICE' ? c.render() : c.render(...lines)
  })

  app.on('TCP', '/AWAY/*', (c) => {
    const { client, message } = c.var
    const away = message.params[0] ? truncate(message.params[0], AWAY_LENGTH) : undefined
    // The others are told only of a change.
    if (away !== client.away) {
      client.away = away
      for (const peer of server.audience(client, 'away-notify')) {
        peer.send(msg(client.mask, 'AWAY', ...(away ? [away] : [])))
      }
    }
    return away
      ? c.render([RPL_NOWAWAY, 'You have been marked as being away'])
      : c.render([RPL_UNAWAY, 'You are no longer marked as being away'])
  })

  return app
}
