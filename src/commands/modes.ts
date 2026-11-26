import { Hono } from 'tcp-hono'
import {
  ERR_CHANOPRIVSNEEDED,
  ERR_NEEDMOREPARAMS,
  ERR_NOSUCHCHANNEL,
  ERR_NOSUCHNICK,
  ERR_UMODEUNKNOWNFLAG,
  ERR_UNKNOWNMODE,
  ERR_USERNOTINCHANNEL,
  ERR_USERSDONTMATCH,
  RPL_CHANNELMODEIS,
  RPL_CREATIONTIME,
  RPL_ENDOFBANLIST,
  RPL_UMODEIS,
} from '../numerics.ts'
import { echo, msg } from '../state.ts'
import type { Env, Line, Server } from '../state.ts'

/** Modes: `MODE` for a user and for a channel. */
export const modes = (server: Server) => {
  const app = new Hono<Env>()

  app.on('TCP', '/MODE/*', (c) => {
    const { client, message } = c.var
    const [targetName, modes, ...args] = message.params
    if (!targetName) {
      return c.render([ERR_NEEDMOREPARAMS, 'MODE', 'Not enough parameters'])
    }

    const channel = server.channels.get(server.fold(targetName))
    if (!channel) {
      if (targetName[0] === '#') {
        return c.render([ERR_NOSUCHCHANNEL, echo(targetName), 'No such channel'])
      }
      if (server.fold(targetName) !== server.fold(client.nick)) {
        return server.nicks.get(server.fold(targetName))?.registered
          ? c.render([ERR_USERSDONTMATCH, "Can't change mode for other users"])
          : c.render([ERR_NOSUCHNICK, echo(targetName), 'No such nick/channel'])
      }
      if (!modes) {
        return c.render([RPL_UMODEIS, client.invisible ? '+i' : '+'])
      }
      // The known modes are applied, and the unknown ones get one ERR_UMODEUNKNOWNFLAG after.
      let adding = true
      let unknown = false
      const before = client.invisible
      for (const mode of modes) {
        if (mode === '+' || mode === '-') {
          adding = mode === '+'
        } else if (mode === 'i') {
          client.invisible = adding
        } else {
          unknown = true
        }
      }
      if (client.invisible !== before) {
        client.send(msg(client.nick, 'MODE', client.nick, (client.invisible ? '+' : '-') + 'i'))
      }
      return c.render(
        ...(unknown ? [[ERR_UMODEUNKNOWNFLAG, 'Unknown MODE flag'] satisfies Line] : [])
      )
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
          lines.push([
            ERR_USERNOTINCHANNEL,
            echo(nick),
            channel.name,
            "They aren't on that channel",
          ])
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
        lines.push([ERR_UNKNOWNMODE, echo(mode), 'is unknown mode char to me'])
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
