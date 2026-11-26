import { Hono } from 'tcp-hono'
import { ERR_NEEDMOREPARAMS } from '../numerics.ts'
import { byteLength } from '../protocol.ts'
import { NAME_LENGTH, fail, msg } from '../state.ts'
import type { Env, Server } from '../state.ts'

/**
 * `SETNAME`: https://ircv3.net/specs/extensions/setname
 *
 * The command works with or without the capability. The SETNAME message goes only to the clients
 * that have it: the client itself, to confirm the change, the ones that share a channel with it,
 * and with `extended-monitor`, the ones that monitor it. Without the capability, the client gets
 * nothing back for a change, as the spec suggests, and a FAIL for a realname that is not valid.
 */
export const setname = (server: Server) => {
  const app = new Hono<Env>()

  app.on('TCP', '/SETNAME/*', (c) => {
    const { client, message } = c.var
    const [realname] = message.params
    if (realname === undefined) {
      return c.render([ERR_NEEDMOREPARAMS, 'SETNAME', 'Not enough parameters'])
    }
    // Empty, or longer than NAMELEN. The spec defines the reply, so it is sent with or without
    // standard-replies.
    if (!realname || byteLength(realname) > NAME_LENGTH) {
      return c.render(fail('SETNAME', 'INVALID_REALNAME', 'Realname is not valid'))
    }
    const changed = realname !== client.realname
    client.realname = realname
    const notice = msg(client.mask, 'SETNAME', realname)
    if (changed) {
      for (const peer of server.audience(client, 'setname')) {
        peer.send(notice)
      }
    }
    if (client.capabilities.has('setname')) {
      client.send(notice)
    }
    return c.render()
  })

  return app
}
