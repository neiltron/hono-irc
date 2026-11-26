import { Hono } from 'tcp-hono'
import {
  ERR_NEEDMOREPARAMS,
  ERR_NONICKNAMEGIVEN,
  ERR_NOSUCHNICK,
  RPL_AWAY,
  RPL_ENDOFWHO,
  RPL_ENDOFWHOIS,
  RPL_ISON,
  RPL_USERHOST,
  RPL_WHOISCHANNELS,
  RPL_WHOISIDLE,
  RPL_WHOISSERVER,
  RPL_WHOISUSER,
  RPL_WHOREPLY,
} from '../numerics.ts'
import { MAX_TARGETS, echo, tooMany } from '../state.ts'
import type { Channel, Client, Env, Line, Server } from '../state.ts'

/** Queries: `WHO`, `WHOIS`, `ISON`, `USERHOST`, `MOTD`, and `LUSERS`. */
export const queries = (server: Server) => {
  const app = new Hono<Env>()

  /** A registered client by its nickname. */
  const user = (nick: string) => {
    const client = server.nicks.get(server.fold(nick))
    return client?.registered ? client : undefined
  }

  app.on('TCP', '/WHO/*', (c) => {
    const { client, message } = c.var
    const [mask] = message.params
    if (!mask) {
      return c.render([ERR_NEEDMOREPARAMS, 'WHO', 'Not enough parameters'])
    }
    const all = client.capabilities.has('multi-prefix')
    const row = (target: Client, channel?: Channel): Line => [
      RPL_WHOREPLY,
      channel?.name ?? '*',
      target.user,
      target.host,
      server.name,
      target.nick,
      (target.away === undefined ? 'H' : 'G') + (channel?.prefix(target, all) ?? ''),
      `0 ${target.realname}`,
    ]
    const { targets, excess } = server.targets(mask, MAX_TARGETS.WHO)
    const [name = ''] = targets
    const channel = server.channels.get(server.fold(name))
    const target = user(name)
    return c.render(
      ...(channel
        ? server.visibleMembers(client, channel).map((member) => row(member, channel))
        : target
          ? [row(target)]
          : []),
      ...tooMany(excess),
      [RPL_ENDOFWHO, echo(mask), 'End of /WHO list']
    )
  })

  app.on('TCP', '/WHOIS/*', (c) => {
    const { client, message } = c.var
    // `WHOIS server nick` asks a server, and this is the only one.
    const list = message.params.at(-1)
    if (!list) {
      return c.render([ERR_NONICKNAMEGIVEN, 'No nickname given'])
    }
    const { targets, excess } = server.targets(list, MAX_TARGETS.WHOIS)
    const all = client.capabilities.has('multi-prefix')
    const lines = targets.flatMap((nick): Line[] => {
      const target = user(nick)
      if (!target) {
        return [[ERR_NOSUCHNICK, echo(nick), 'No such nick/channel']]
      }
      // A secret channel is shown only to its members.
      const joined = [...target.channels]
        .filter((channel) => channel.visibleTo(client))
        .map((channel) => channel.prefix(target, all) + channel.name)
      return [
        [RPL_WHOISUSER, target.nick, target.user, target.host, '*', target.realname],
        ...server
          .pack(client, [target.nick], joined)
          .map((chunk): Line => [RPL_WHOISCHANNELS, target.nick, chunk]),
        [RPL_WHOISSERVER, target.nick, server.name, server.network],
        ...(target.away !== undefined ? [[RPL_AWAY, target.nick, target.away] satisfies Line] : []),
        [
          RPL_WHOISIDLE,
          target.nick,
          Math.floor((Date.now() - target.idle) / 1000),
          Math.floor(target.signon / 1000),
          'seconds idle, signon time',
        ],
      ]
    })
    // RPL_ENDOFWHOIS has the list as the client sent it.
    return c.render(...lines, ...tooMany(excess), [
      RPL_ENDOFWHOIS,
      echo(list),
      'End of /WHOIS list',
    ])
  })

  // `ISON nick1 nick2`, or `ISON :nick1 nick2`. The reply has the ones that are online.
  app.on('TCP', '/ISON/*', (c) => {
    const { client, message } = c.var
    const nicks = message.params.flatMap((param) => param.split(' ')).filter(Boolean)
    if (!nicks.length) {
      return c.render([ERR_NEEDMOREPARAMS, 'ISON', 'Not enough parameters'])
    }
    const online = nicks.flatMap((nick) => user(nick)?.nick ?? [])
    // Only one line, so the ones that do not fit are left out.
    return c.render([RPL_ISON, server.pack(client, [], online)[0] ?? ''])
  })

  // `USERHOST nick1 nick2` for up to five nicknames. A reply is `nick=+user@host`, with `-`
  // in place of `+` for a user that is away.
  app.on('TCP', '/USERHOST/*', (c) => {
    const { client, message } = c.var
    if (!message.params.length) {
      return c.render([ERR_NEEDMOREPARAMS, 'USERHOST', 'Not enough parameters'])
    }
    const replies = message.params.slice(0, 5).flatMap((nick) => {
      const target = user(nick)
      return target
        ? `${target.nick}=${target.away === undefined ? '+' : '-'}${target.user}@${target.host}`
        : []
    })
    return c.render([RPL_USERHOST, server.pack(client, [], replies)[0] ?? ''])
  })

  app.on('TCP', '/MOTD/*', (c) => c.render(...server.motdLines()))

  app.on('TCP', '/LUSERS/*', (c) => c.render(...server.lusers()))

  return app
}
