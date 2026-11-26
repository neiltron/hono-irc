import { Hono } from 'tcp-hono'
import {
  ERR_MONLISTFULL,
  ERR_NEEDMOREPARAMS,
  RPL_ENDOFMONLIST,
  RPL_MONLIST,
  RPL_MONOFFLINE,
  RPL_MONONLINE,
} from '../numerics.ts'
import { MAX_MONITOR, isNickname } from '../state.ts'
import type { Client, Env, Line, Server } from '../state.ts'

/**
 * `MONITOR`: https://ircv3.net/specs/extensions/monitor
 *
 * A client is told when a nickname that it monitors comes online or goes offline. The lists are in
 * `Client.monitoring`, and `Server.monitors` has the clients by the nickname, so a change of one
 * client is told to the ones that monitor it without going through every client. The server tells
 * them in `register()`, the NICK command, and the `onClose()` hook.
 */
export const monitor = (server: Server) => {
  const app = new Hono<Env>()

  /** RPL_MONONLINE and RPL_MONOFFLINE for the nicknames, in lines that fit. */
  const status = (client: Client, nicks: string[]): Line[] => {
    const online: string[] = []
    const offline: string[] = []
    for (const nick of nicks) {
      const target = server.nicks.get(server.fold(nick))
      if (target?.registered) {
        online.push(target.mask)
      } else {
        offline.push(nick)
      }
    }
    return [
      ...server.pack(client, [], online, ',').map((chunk): Line => [RPL_MONONLINE, chunk]),
      ...server.pack(client, [], offline, ',').map((chunk): Line => [RPL_MONOFFLINE, chunk]),
    ]
  }

  // `MONITOR + a,b`, `MONITOR - a,b`, `MONITOR C`, `MONITOR L`, and `MONITOR S`.
  app.on('TCP', '/MONITOR/*', (c) => {
    const { client, message } = c.var
    const [modifier, list] = message.params
    if (!modifier) {
      return c.render([ERR_NEEDMOREPARAMS, 'MONITOR', 'Not enough parameters'])
    }
    const subcommand = modifier.toUpperCase()

    if (subcommand === '+' || subcommand === '-') {
      if (!list) {
        return c.render([ERR_NEEDMOREPARAMS, 'MONITOR', 'Not enough parameters'])
      }
      // The empty and the repeated ones are dropped.
      const { targets } = server.targets(list, Infinity)
      if (subcommand === '-') {
        for (const nick of targets) {
          server.unmonitor(client, server.fold(nick))
        }
        return c.render()
      }
      // A target that is not a valid nickname is left out. The ones over the limit are refused,
      // and the status of the others is sent.
      const added: string[] = []
      for (const [i, nick] of targets.entries()) {
        if (!isNickname(nick)) {
          continue
        }
        if (!client.monitoring.has(server.fold(nick)) && client.monitoring.size >= MAX_MONITOR) {
          // The list as the client sent it, cut to what fits before the text.
          const text = 'Monitor list is full.'
          const [rest] = server.pack(client, [String(MAX_MONITOR), text], targets.slice(i), ',')
          return c.render(...status(client, added), [ERR_MONLISTFULL, MAX_MONITOR, rest, text])
        }
        server.monitor(client, nick)
        added.push(nick)
      }
      return c.render(...status(client, added))
    }
    if (subcommand === 'C') {
      for (const folded of client.monitoring.keys()) {
        server.unmonitor(client, folded)
      }
      return c.render()
    }
    if (subcommand === 'L') {
      return c.render(
        ...server
          .pack(client, [], [...client.monitoring.values()], ',')
          .map((chunk): Line => [RPL_MONLIST, chunk]),
        [RPL_ENDOFMONLIST, 'End of MONITOR list']
      )
    }
    if (subcommand === 'S') {
      return c.render(...status(client, [...client.monitoring.values()]))
    }
    // An unknown modifier is ignored, as on most servers: the spec has no reply for it.
    return c.render()
  })

  return app
}
