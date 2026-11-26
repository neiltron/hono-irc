import { Hono } from 'tcp-hono'
import { compile, normalize } from '../masks.ts'
import {
  ERR_BANLISTFULL,
  ERR_CHANOPRIVSNEEDED,
  ERR_INVALIDMODEPARAM,
  ERR_NEEDMOREPARAMS,
  ERR_NOSUCHCHANNEL,
  ERR_NOSUCHNICK,
  ERR_NOTONCHANNEL,
  ERR_TOOMANYCHANNELS,
  ERR_UMODEUNKNOWNFLAG,
  ERR_UNKNOWNERROR,
  ERR_UNKNOWNMODE,
  ERR_USERNOTINCHANNEL,
  ERR_USERSDONTMATCH,
  RPL_BANLIST,
  RPL_CHANNELMODEIS,
  RPL_CREATIONTIME,
  RPL_ENDOFBANLIST,
  RPL_ENDOFEXCEPTLIST,
  RPL_ENDOFINVEXLIST,
  RPL_EXCEPTLIST,
  RPL_INVEXLIST,
  RPL_UMODEIS,
} from '../numerics.ts'
import { MAX_LINE_LENGTH, byteLength } from '../protocol.ts'
import { KEY_LENGTH, MASK_LENGTH, MAX_LIST, MAX_MODES, echo, msg } from '../state.ts'
import type { Channel, Client, Env, Line, ListMode, Server } from '../state.ts'

type Change = { adding: boolean; mode: string; arg?: string }

// The channel modes by their type in CHANMODES, and the ranks of PREFIX.
const LISTS = 'beI'
const RANKS = 'ov'

/** The replies that show a list: an entry and the end. */
const LIST_REPLIES: Record<ListMode, [entry: string, end: string, text: string]> = {
  b: [RPL_BANLIST, RPL_ENDOFBANLIST, 'End of channel ban list'],
  e: [RPL_EXCEPTLIST, RPL_ENDOFEXCEPTLIST, 'End of channel exception list'],
  I: [RPL_INVEXLIST, RPL_ENDOFINVEXLIST, 'End of Channel Invite Exception List'],
}

// A key goes in JOIN as one item of a list, so it can not have a comma, and a key or a mask is a
// parameter in the middle of a line, so it can not have a space or start with a colon.
const KEY_PATTERN = /^[^\s,:\p{Cc}][^\s,\p{Cc}]*$/u
const MASK_PATTERN = /^[^\s:\p{Cc}][^\s\p{Cc}]*$/u

/** The modestring of the changes, e.g. `+ov-k`, and their parameters. */
const modestring = (changes: Change[]) => {
  let sign: boolean | undefined
  let modes = ''
  for (const change of changes) {
    if (change.adding !== sign) {
      sign = change.adding
      modes += sign ? '+' : '-'
    }
    modes += change.mode
  }
  return [modes, ...changes.flatMap((change) => change.arg ?? [])]
}

/** User modes: `i` (invisible) and `B` (bot). */
const userModes = (client: Client) => '+' + (client.bot ? 'B' : '') + (client.invisible ? 'i' : '')

/** Modes: `MODE` for a user and for a channel. */
export const modes = (server: Server) => {
  const app = new Hono<Env>()

  /**
   * The MODE messages of the changes. They are split so that each line fits, as a line with a
   * few long masks can be longer than 512 bytes.
   */
  const announce = (client: Client, channel: Channel, changes: Change[]) => {
    const fits = (part: Change[]) =>
      byteLength(`:${client.mask} MODE ${channel.name} ${modestring(part).join(' ')}`) <=
      MAX_LINE_LENGTH - 2
    let part: Change[] = []
    for (const change of changes) {
      if (part.length && !fits([...part, change])) {
        channel.send(msg(client.mask, 'MODE', channel.name, ...modestring(part)))
        part = []
      }
      part.push(change)
    }
    if (part.length) {
      channel.send(msg(client.mask, 'MODE', channel.name, ...modestring(part)))
    }
  }

  /** RPL_CHANNELMODEIS. The values of the key and the limit are only for the members. */
  const channelModes = (client: Client, channel: Channel): Line => {
    const letters = [...channel.modes]
    const values: string[] = []
    if (channel.key !== undefined) {
      letters.push('k')
    }
    if (channel.limit !== undefined) {
      letters.push('l')
    }
    letters.sort()
    if (channel.members.has(client)) {
      for (const letter of letters) {
        if (letter === 'k') {
          values.push(channel.key!)
        } else if (letter === 'l') {
          values.push(String(channel.limit))
        }
      }
    }
    return [RPL_CHANNELMODEIS, channel.name, '+' + letters.join(''), ...values]
  }

  /**
   * The entries of a list. The bans are shown to anyone who can see the channel, and the
   * exceptions only to the operators, as on most servers.
   */
  const showList = (client: Client, channel: Channel, mode: ListMode): Line[] => {
    const [entry, end, text] = LIST_REPLIES[mode]
    if (mode !== 'b' && !channel.members.get(client)?.has('o')) {
      return [[ERR_CHANOPRIVSNEEDED, channel.name, "You're not channel operator"]]
    }
    const entries = channel.visibleTo(client) ? channel.lists[mode] : []
    return [
      ...entries.map((item): Line => [entry, channel.name, item.mask, item.by, item.at]),
      [end, channel.name, text],
    ]
  }

  app.on('TCP', '/MODE/*', (c) => {
    const { client, message } = c.var
    const [targetName, modes, ...args] = message.params
    if (!targetName) {
      return c.render([ERR_NEEDMOREPARAMS, 'MODE', 'Not enough parameters'])
    }

    // A permanent channel that is empty shows its modes and lists too.
    const channel = server.find(targetName)
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
        return c.render([RPL_UMODEIS, userModes(client)])
      }
      // The known modes are applied, and the unknown ones get one ERR_UMODEUNKNOWNFLAG after.
      let adding = true
      let unknown = false
      const before = { i: client.invisible, B: client.bot }
      for (const mode of modes) {
        if (mode === '+' || mode === '-') {
          adding = mode === '+'
        } else if (mode === 'i') {
          client.invisible = adding
        } else if (mode === 'B') {
          client.bot = adding
        } else {
          unknown = true
        }
      }
      const changes: Change[] = []
      if (client.bot !== before.B) {
        changes.push({ adding: client.bot, mode: 'B' })
      }
      if (client.invisible !== before.i) {
        changes.push({ adding: client.invisible, mode: 'i' })
      }
      if (changes.length) {
        client.send(msg(client.nick, 'MODE', client.nick, ...modestring(changes)))
      }
      return c.render(
        ...(unknown ? [[ERR_UMODEUNKNOWNFLAG, 'Unknown MODE flag'] satisfies Line] : [])
      )
    }

    if (!modes) {
      return c.render(channelModes(client, channel), [
        RPL_CREATIONTIME,
        channel.name,
        channel.created,
      ])
    }

    // The modes are applied in order. A mode of type A (a list) takes a parameter to change the
    // list, and shows the list without one, which anyone may ask for. Type B (k) takes one both
    // ways, type C (l) only to set it, and type D none. A mode that needs a parameter that is
    // missing is ignored, and so are the ones over MODES.
    const lines: Line[] = []
    const changes: Change[] = []
    const shown = new Set<string>()
    const operator = channel.members.get(client)?.has('o')
    let adding = true
    let parameters = 0
    for (const mode of modes) {
      if (mode === '+' || mode === '-') {
        adding = mode === '+'
        continue
      }
      const takes =
        LISTS.includes(mode) || RANKS.includes(mode) || mode === 'k' || (mode === 'l' && adding)
      if (LISTS.includes(mode) && !args.length) {
        if (!shown.has(mode)) {
          shown.add(mode)
          lines.push(...showList(client, channel, mode as ListMode))
        }
        continue
      }
      if (!takes && mode !== 'l' && !server.settings.includes(mode)) {
        lines.push([ERR_UNKNOWNMODE, echo(mode), 'is unknown mode char to me'])
        continue
      }
      // Only the founder, logged in, makes the channel permanent or ordinary, from inside it.
      if (mode === 'P') {
        if (!channel.members.has(client)) {
          lines.push([ERR_NOTONCHANNEL, channel.name, "You're not on that channel"])
        } else if (!server.founds(client, channel)) {
          lines.push([ERR_CHANOPRIVSNEEDED, channel.name, "You're not the channel founder"])
        } else if (channel.permanent !== adding) {
          const allowed = server.safely(
            () => !adding || server.channelStore!.allows(channel.founder!)
          )
          if (allowed === false) {
            lines.push([ERR_TOOMANYCHANNELS, channel.name, 'Too many permanent channels'])
          } else if (
            allowed &&
            server.safely(() => {
              server.setPermanent(channel, adding)
              return true
            })
          ) {
            changes.push({ adding, mode })
          } else {
            // The database failed: the channel is as it was.
            lines.push([
              ERR_UNKNOWNERROR,
              'MODE',
              'The channel could not be stored, try again later',
            ])
          }
        }
        continue
      }
      if (!operator) {
        lines.push([ERR_CHANOPRIVSNEEDED, channel.name, "You're not channel operator"])
        break
      }
      let arg: string | undefined
      if (takes) {
        if (parameters >= MAX_MODES) {
          continue
        }
        arg = args.shift()
        // `-k` without a key is taken as it is.
        if (arg === undefined && (mode !== 'k' || adding)) {
          continue
        }
        parameters += arg === undefined ? 0 : 1
      }

      if (RANKS.includes(mode)) {
        const target = server.nicks.get(server.fold(arg!))
        const ranks = target && channel.members.get(target)
        if (!target || !ranks) {
          lines.push([
            ERR_USERNOTINCHANNEL,
            echo(arg!),
            channel.name,
            "They aren't on that channel",
          ])
        } else if (ranks.has(mode as 'o' | 'v') !== adding) {
          ranks[adding ? 'add' : 'delete'](mode as 'o' | 'v')
          changes.push({ adding, mode, arg: target.nick })
        }
      } else if (LISTS.includes(mode)) {
        const list = channel.lists[mode as ListMode]
        const mask = normalize(arg!)
        const folded = server.fold(mask)
        const index = list.findIndex((entry) => server.fold(entry.mask) === folded)
        if (!MASK_PATTERN.test(arg!) || byteLength(mask) > MASK_LENGTH) {
          lines.push([ERR_INVALIDMODEPARAM, channel.name, mode, echo(arg!), 'Invalid mask'])
        } else if (!adding) {
          if (index !== -1) {
            const [removed] = list.splice(index, 1)
            changes.push({ adding, mode, arg: removed.mask })
          }
        } else if (index === -1) {
          const { b, e, I } = channel.lists
          if (b.length + e.length + I.length >= MAX_LIST) {
            lines.push([ERR_BANLISTFULL, channel.name, mask, 'Channel list is full'])
          } else {
            const at = Math.floor(Date.now() / 1000)
            list.push({ mask, by: client.mask, at, glob: compile(folded) })
            changes.push({ adding, mode, arg: mask })
          }
        }
      } else if (mode === 'k') {
        if (!adding) {
          if (channel.key !== undefined) {
            channel.key = undefined
            // A mode of type B has a parameter both ways, and the key is not repeated.
            changes.push({ adding, mode, arg: '*' })
          }
        } else if (!KEY_PATTERN.test(arg!) || byteLength(arg!) > KEY_LENGTH) {
          lines.push([ERR_INVALIDMODEPARAM, channel.name, mode, echo(arg!), 'Invalid key'])
        } else if (channel.key !== arg) {
          channel.key = arg
          changes.push({ adding, mode, arg })
        }
      } else if (mode === 'l') {
        if (!adding) {
          if (channel.limit !== undefined) {
            channel.limit = undefined
            changes.push({ adding, mode })
          }
        } else if (!/^\d{1,9}$/.test(arg!) || !Number(arg)) {
          lines.push([ERR_INVALIDMODEPARAM, channel.name, mode, echo(arg!), 'Invalid limit'])
        } else if (channel.limit !== Number(arg)) {
          channel.limit = Number(arg)
          changes.push({ adding, mode, arg: String(channel.limit) })
        }
      } else if (channel.modes.has(mode) !== adding) {
        channel.modes[adding ? 'add' : 'delete'](mode)
        changes.push({ adding, mode })
      }
    }

    if (changes.some(({ mode }) => !RANKS.includes(mode))) {
      server.persist(channel)
    }
    if (changes.length) {
      announce(client, channel, changes)
    }
    return c.render(...lines)
  })

  return app
}
