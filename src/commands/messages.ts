import { Hono } from 'tcp-hono'
import {
  ERR_CANNOTSENDTOCHAN,
  ERR_NOSUCHNICK,
  RPL_AWAY,
  RPL_NOWAWAY,
  RPL_UNAWAY,
} from '../numerics.ts'
import { msg } from '../state.ts'
import type { Env, Line, Server } from '../state.ts'

/** Messages: `PRIVMSG`, `NOTICE`, and `AWAY`. */
export const messages = (server: Server) => {
  const app = new Hono<Env>()

  app.on('TCP', '/:command{PRIVMSG|NOTICE}/:targets/:text', (c) => {
    const { client } = c.var
    const { command, text } = c.req.param()
    // An automatic reply must not be sent in response to a NOTICE.
    const lines: Line[] = []

    for (const targetName of c.req.param('targets').split(',')) {
      const channel = server.channels.get(server.fold(targetName))
      if (channel) {
        const ranks = channel.members.get(client)
        if (
          (channel.modes.has('n') && !ranks) ||
          (channel.modes.has('m') && !ranks?.has('o') && !ranks?.has('v'))
        ) {
          lines.push([ERR_CANNOTSENDTOCHAN, channel.name, 'Cannot send to channel'])
          continue
        }
        const message = msg(client.mask, command, channel.name, text)
        for (const member of channel.members.keys()) {
          if (member !== client || client.capabilities.has('echo-message')) {
            member.send(message)
          }
        }
        continue
      }
      const target = server.nicks.get(server.fold(targetName))
      if (!target?.registered) {
        lines.push([ERR_NOSUCHNICK, targetName, 'No such nick/channel'])
        continue
      }
      const message = msg(client.mask, command, target.nick, text)
      target.send(message)
      if (client.capabilities.has('echo-message') && target !== client) {
        client.send(message)
      }
      if (target.away !== undefined) {
        lines.push([RPL_AWAY, target.nick, target.away])
      }
    }
    return command === 'NOTICE' ? c.render() : c.render(...lines)
  })

  app.on('TCP', '/AWAY/*', (c) => {
    const { client, message } = c.var
    client.away = message.params[0] || undefined
    for (const peer of server.peers(client)) {
      if (peer.capabilities.has('away-notify')) {
        peer.send(msg(client.mask, 'AWAY', ...(client.away ? [client.away] : [])))
      }
    }
    return client.away
      ? c.render([RPL_NOWAWAY, 'You have been marked as being away'])
      : c.render([RPL_UNAWAY, 'You are no longer marked as being away'])
  })

  return app
}
