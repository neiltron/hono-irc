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
import { AWAY_LENGTH, MAX_TARGETS, clientTags, echo, msg, stamp, tooMany } from '../state.ts'
import type { Client, Env, Line, Server } from '../state.ts'

/**
 * Deliver a message from the client to one target, with the rules of PRIVMSG: the channel must let
 * the client speak, and the user must exist. It is the decision for the whole message, which is
 * one line or a multiline batch.
 *
 * `send(recipient, target, response)` sends the message to one recipient, with `target` as the
 * channel or the user has its name. The sender gets its own copy only with echo-message, and that
 * echo is the response to its command. A message to oneself is also delivered as to anyone else,
 * outside the response, so with echo-message it comes twice, as labeled-response expects.
 *
 * Returns the replies to the sender: an error, or RPL_AWAY of the user.
 */
export const deliver = (
  server: Server,
  client: Client,
  targetName: string,
  send: (recipient: Client, target: string, response: boolean) => void
): Line[] => {
  const echoed = client.capabilities.has('echo-message')
  const channel = server.channels.get(server.fold(targetName))
  if (channel) {
    if (!channel.canSend(client)) {
      return [[ERR_CANNOTSENDTOCHAN, channel.name, 'Cannot send to channel']]
    }
    for (const member of channel.members.keys()) {
      if (member !== client) {
        send(member, channel.name, false)
      }
    }
    // A sender outside a channel without `n` is not a member, and gets its echo all the same.
    if (echoed) {
      send(client, channel.name, true)
    }
    return []
  }
  const target = server.nicks.get(server.fold(targetName))
  if (!target?.registered) {
    return [[ERR_NOSUCHNICK, echo(targetName), 'No such nick/channel']]
  }
  send(target, target.nick, false)
  if (echoed) {
    send(client, target.nick, true)
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
        // One message for each target, with the same ID and time for every recipient and the echo.
        // The client-only tags are relayed, and only to the clients that have message-tags.
        let relayed: IRCMessage | undefined
        const replies = deliver(server, client, targetName, (recipient, target, response) => {
          // TAGMSG is not delivered at all to a client without message-tags.
          if (command !== 'TAGMSG' || recipient.capabilities.has('message-tags')) {
            relayed ??= stamp({
              ...msg(client.mask, command, target, ...(command === 'TAGMSG' ? [] : [text])),
              tags: { msgid: server.msgid(), ...tags },
            })
            recipient.send(relayed, response)
          }
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
      for (const peer of server.peers(client)) {
        if (peer.capabilities.has('away-notify')) {
          peer.send(msg(client.mask, 'AWAY', ...(away ? [away] : [])))
        }
      }
    }
    return away
      ? c.render([RPL_NOWAWAY, 'You have been marked as being away'])
      : c.render([RPL_UNAWAY, 'You are no longer marked as being away'])
  })

  return app
}
