import { Hono } from 'tcp-hono'
import {
  ERR_NONICKNAMEGIVEN,
  ERR_NOSUCHNICK,
  RPL_AWAY,
  RPL_ENDOFWHO,
  RPL_ENDOFWHOIS,
  RPL_WHOISCHANNELS,
  RPL_WHOISIDLE,
  RPL_WHOISSERVER,
  RPL_WHOISUSER,
  RPL_WHOREPLY,
} from '../numerics.ts'
import type { Channel, Client, Env, Line, Server } from '../state.ts'

/** Queries: `WHO`, `WHOIS`, `MOTD`, and `LUSERS`. */
export const queries = (server: Server) => {
  const app = new Hono<Env>()

  app.on('TCP', '/WHO/:mask/*', (c) => {
    const mask = c.req.param('mask')
    const channel = server.channels.get(server.fold(mask))
    const user = server.nicks.get(server.fold(mask))
    const row = (target: Client, channel?: Channel): Line => [
      RPL_WHOREPLY,
      channel?.name ?? '*',
      target.user,
      target.host,
      server.name,
      target.nick,
      (target.away === undefined ? 'H' : 'G') + (channel?.prefix(target) ?? ''),
      `0 ${target.realname}`,
    ]
    return c.render(
      ...(channel
        ? [...channel.members.keys()].map((member) => row(member, channel))
        : user
          ? [row(user)]
          : []),
      [RPL_ENDOFWHO, mask, 'End of /WHO list']
    )
  })

  app.on('TCP', '/WHOIS/*', (c) => {
    const nick = c.var.message.params.at(-1)
    if (!nick) {
      return c.render([ERR_NONICKNAMEGIVEN, 'No nickname given'])
    }
    const target = server.nicks.get(server.fold(nick))
    if (!target?.registered) {
      return c.render(
        [ERR_NOSUCHNICK, nick, 'No such nick/channel'],
        [RPL_ENDOFWHOIS, nick, 'End of /WHOIS list']
      )
    }
    const joined = [...target.channels].map((channel) => channel.prefix(target) + channel.name)
    return c.render(
      [RPL_WHOISUSER, target.nick, target.user, target.host, '*', target.realname],
      ...(joined.length ? [[RPL_WHOISCHANNELS, target.nick, joined.join(' ')] satisfies Line] : []),
      [RPL_WHOISSERVER, target.nick, server.name, server.network],
      ...(target.away !== undefined ? [[RPL_AWAY, target.nick, target.away] satisfies Line] : []),
      [
        RPL_WHOISIDLE,
        target.nick,
        Math.floor((Date.now() - target.active) / 1000),
        Math.floor(target.signon / 1000),
        'seconds idle, signon time',
      ],
      [RPL_ENDOFWHOIS, target.nick, 'End of /WHOIS list']
    )
  })

  app.on('TCP', '/MOTD/*', (c) => c.render(...server.motdLines()))

  app.on('TCP', '/LUSERS/*', (c) => c.render(...server.lusers()))

  return app
}
