import { Hono } from 'tcp-hono'
import {
  ERR_CANNOTSENDTOCHAN,
  ERR_NORECIPIENT,
  ERR_NOSUCHNICK,
  ERR_NOTEXTTOSEND,
  RPL_AWAY,
  RPL_NOWAWAY,
  RPL_UNAWAY,
} from '../numerics.ts'
import { truncate } from '../protocol.ts'
import { AWAY_LENGTH, MAX_TARGETS, echo, msg, tooMany } from '../state.ts'
import type { Env, Line, Server } from '../state.ts'

/** Messages: `PRIVMSG`, `NOTICE`, and `AWAY`. */
export const messages = (server: Server) => {
  const app = new Hono<Env>()

  app.on('TCP', '/:command{PRIVMSG|NOTICE}/*', (c) => {
    const { client, message } = c.var
    const command = c.req.param('command') as 'PRIVMSG' | 'NOTICE'
    const [list, text] = message.params
    const deliver = (targetName: string, text: string): Line[] => {
      const echoed = client.capabilities.has('echo-message')
      const channel = server.channels.get(server.fold(targetName))
      if (channel) {
        const ranks = channel.members.get(client)
        if (
          (channel.modes.has('n') && !ranks) ||
          (channel.modes.has('m') && !ranks?.has('o') && !ranks?.has('v'))
        ) {
          return [[ERR_CANNOTSENDTOCHAN, channel.name, 'Cannot send to channel']]
        }
        const message = msg(client.mask, command, channel.name, text)
        for (const member of channel.members.keys()) {
          if (member !== client || echoed) {
            member.send(message)
          }
        }
        // A sender outside a channel without `n` is not a member, so it gets its echo here.
        if (echoed && !ranks) {
          client.send(message)
        }
        return []
      }
      const target = server.nicks.get(server.fold(targetName))
      if (!target?.registered) {
        return [[ERR_NOSUCHNICK, echo(targetName), 'No such nick/channel']]
      }
      const message = msg(client.mask, command, target.nick, text)
      target.send(message)
      if (echoed && target !== client) {
        client.send(message)
      }
      return target.away !== undefined ? [[RPL_AWAY, target.nick, target.away]] : []
    }

    // An automatic reply must not be sent in response to a NOTICE, so a NOTICE gets no error.
    const lines: Line[] = []
    if (!list) {
      lines.push([ERR_NORECIPIENT, `No recipient given (${command})`])
    } else if (!text) {
      lines.push([ERR_NOTEXTTOSEND, 'No text to send'])
    } else {
      // The targets are folded and repeated ones dropped, so a line can not deliver a message
      // to the same client many times over.
      const { targets, excess } = server.targets(list, MAX_TARGETS[command])
      client.idle = Date.now()
      for (const targetName of targets) {
        lines.push(...deliver(targetName, text))
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
