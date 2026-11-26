import { Hono } from 'tcp-hono'
import {
  ERR_CHANOPRIVSNEEDED,
  ERR_NOSUCHCHANNEL,
  ERR_UMODEUNKNOWNFLAG,
  ERR_UNKNOWNMODE,
  ERR_USERNOTINCHANNEL,
  ERR_USERSDONTMATCH,
  RPL_CHANNELMODEIS,
  RPL_CREATIONTIME,
  RPL_ENDOFBANLIST,
  RPL_UMODEIS,
} from '../numerics.ts'
import { CHANNEL_PATTERN, msg } from '../state.ts'
import type { Env, Line, Server } from '../state.ts'

/** Modes: `MODE` for a user and for a channel. */
export const modes = (server: Server) => {
  const app = new Hono<Env>()

  app.on('TCP', '/MODE/:target/*', (c) => {
    const { client, message } = c.var
    const targetName = c.req.param('target')
    const [, modes, ...args] = message.params

    const channel = server.channels.get(server.fold(targetName))
    if (!channel) {
      if (CHANNEL_PATTERN.test(targetName)) {
        return c.render([ERR_NOSUCHCHANNEL, targetName, 'No such channel'])
      }
      if (server.fold(targetName) !== server.fold(client.nick)) {
        return c.render([ERR_USERSDONTMATCH, "Can't change mode for other users"])
      }
      if (modes) {
        const adding = modes[0] !== '-'
        if (modes.replace(/[+-]/g, '') !== 'i') {
          return c.render([ERR_UMODEUNKNOWNFLAG, 'Unknown MODE flag'])
        }
        client.invisible = adding
        client.send(msg(client.nick, 'MODE', client.nick, (adding ? '+' : '-') + 'i'))
        return c.render()
      }
      return c.render([RPL_UMODEIS, client.invisible ? '+i' : '+'])
    }

    if (!modes) {
      return c.render(
        [RPL_CHANNELMODEIS, channel.name, '+' + [...channel.modes].sort().join('')],
        [RPL_CREATIONTIME, channel.name, channel.created]
      )
    }

    const lines: Line[] = []
    const changes: { adding: boolean; mode: string; arg?: string }[] = []
    const operator = channel.members.get(client)?.has('o')
    let adding = true
    for (const mode of modes) {
      if (mode === '+' || mode === '-') {
        adding = mode === '+'
      } else if (mode === 'b' && !args.length) {
        // Clients ask for the ban list on joining. Bans are not implemented, so it is empty.
        lines.push([RPL_ENDOFBANLIST, channel.name, 'End of channel ban list'])
      } else if (!operator) {
        lines.push([ERR_CHANOPRIVSNEEDED, channel.name, "You're not channel operator"])
        break
      } else if (mode === 'o' || mode === 'v') {
        const nick = args.shift()
        const target = nick ? server.nicks.get(server.fold(nick)) : undefined
        const ranks = target && channel.members.get(target)
        if (!nick) {
          continue
        }
        if (!target || !ranks) {
          lines.push([ERR_USERNOTINCHANNEL, nick, channel.name, "They aren't on that channel"])
        } else if (ranks.has(mode) !== adding) {
          ranks[adding ? 'add' : 'delete'](mode)
          changes.push({ adding, mode, arg: target.nick })
        }
      } else if ('mnt'.includes(mode)) {
        if (channel.modes.has(mode) !== adding) {
          channel.modes[adding ? 'add' : 'delete'](mode)
          changes.push({ adding, mode })
        }
      } else {
        lines.push([ERR_UNKNOWNMODE, mode, 'is unknown mode char to me'])
      }
    }

    if (changes.length) {
      let sign: boolean | undefined
      let modestring = ''
      for (const change of changes) {
        if (change.adding !== sign) {
          sign = change.adding
          modestring += sign ? '+' : '-'
        }
        modestring += change.mode
      }
      const modeArgs = changes.flatMap((change) => change.arg ?? [])
      channel.send(msg(client.mask, 'MODE', channel.name, modestring, ...modeArgs))
    }
    return c.render(...lines)
  })

  return app
}
