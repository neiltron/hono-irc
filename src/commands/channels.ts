import { Hono } from 'tcp-hono'
import {
  ERR_CHANNELISFULL,
  ERR_CHANOPRIVSNEEDED,
  ERR_NEEDMOREPARAMS,
  ERR_NOSUCHCHANNEL,
  ERR_NOTONCHANNEL,
  ERR_TOOMANYCHANNELS,
  ERR_USERNOTINCHANNEL,
  RPL_ENDOFNAMES,
  RPL_LIST,
  RPL_LISTEND,
  RPL_LISTSTART,
} from '../numerics.ts'
import { truncate } from '../protocol.ts'
import {
  Channel,
  KICK_LENGTH,
  MAX_CHANNELS,
  MAX_TARGETS,
  TOPIC_LENGTH,
  echo,
  isChannelName,
  msg,
  tooMany,
} from '../state.ts'
import type { Env, Line, Server } from '../state.ts'

/** Channels: `JOIN`, `PART`, `TOPIC`, `NAMES`, `LIST`, and `KICK`. */
export const channels = (server: Server) => {
  const app = new Hono<Env>()

  // Each command takes the parameters from the message, and ignores the ones that it does not use.

  app.on('TCP', '/JOIN/*', (c) => {
    const { client, message } = c.var
    const [list] = message.params
    if (!list) {
      return c.render([ERR_NEEDMOREPARAMS, 'JOIN', 'Not enough parameters'])
    }

    if (list === '0') {
      for (const channel of client.channels) {
        channel.send(msg(client.mask, 'PART', channel.name))
        server.leave(client, channel)
      }
      return c.render()
    }

    // The replies are rendered for each channel, so the client gets the JOIN of a channel
    // followed by its topic and names, before the next channel. The keys are ignored.
    for (const channelName of list.split(',')) {
      if (!isChannelName(channelName)) {
        c.render([ERR_NOSUCHCHANNEL, echo(channelName), 'No such channel'])
        continue
      }
      let channel = server.channels.get(server.fold(channelName))
      if (channel?.members.has(client)) {
        continue
      }
      if (client.channels.size >= MAX_CHANNELS) {
        c.render([ERR_TOOMANYCHANNELS, channelName, 'You have joined too many channels'])
        continue
      }
      if (!channel) {
        // The server is full of channels. ERR_CHANNELISFULL is the reply to JOIN for a limit.
        if (server.channels.size >= server.maxChannels) {
          c.render([ERR_CHANNELISFULL, channelName, 'Cannot join channel (too many channels)'])
          continue
        }
        channel = new Channel(channelName)
        server.channels.set(server.fold(channelName), channel)
      }
      // The first member is the operator.
      channel.members.set(client, new Set(channel.members.size ? [] : ['o']))
      client.channels.add(channel)

      for (const member of channel.members.keys()) {
        if (member.capabilities.has('extended-join')) {
          // `*` means that the client is not logged in to an account.
          member.send(msg(client.mask, 'JOIN', channel.name, '*', client.realname))
        } else {
          member.send(msg(client.mask, 'JOIN', channel.name))
        }
        if (member !== client && client.away && member.capabilities.has('away-notify')) {
          member.send(msg(client.mask, 'AWAY', client.away))
        }
      }
      if (channel.topic) {
        c.render(...server.topic(channel))
      }
      c.render(...server.names(client, channel))
    }
    return c.render()
  })

  app.on('TCP', '/PART/*', (c) => {
    const { client, message } = c.var
    const [list, reason] = message.params
    if (!list) {
      return c.render([ERR_NEEDMOREPARAMS, 'PART', 'Not enough parameters'])
    }
    const lines: Line[] = []
    for (const channelName of list.split(',')) {
      const channel = server.channels.get(server.fold(channelName))
      if (!channel) {
        lines.push([ERR_NOSUCHCHANNEL, echo(channelName), 'No such channel'])
      } else if (!channel.members.has(client)) {
        lines.push([ERR_NOTONCHANNEL, channel.name, "You're not on that channel"])
      } else {
        channel.send(
          msg(client.mask, 'PART', channel.name, ...(reason === undefined ? [] : [reason]))
        )
        server.leave(client, channel)
      }
    }
    return c.render(...lines)
  })

  app.on('TCP', '/TOPIC/*', (c) => {
    const { client, message } = c.var
    // `TOPIC #channel` asks for the topic and `TOPIC #channel :` clears it.
    const [channelName, text] = message.params
    if (!channelName) {
      return c.render([ERR_NEEDMOREPARAMS, 'TOPIC', 'Not enough parameters'])
    }
    const channel = server.channels.get(server.fold(channelName))
    if (!channel) {
      return c.render([ERR_NOSUCHCHANNEL, echo(channelName), 'No such channel'])
    }
    if (text === undefined) {
      return c.render(...server.topic(channel))
    }
    const ranks = channel.members.get(client)
    if (!ranks) {
      return c.render([ERR_NOTONCHANNEL, channel.name, "You're not on that channel"])
    }
    if (channel.modes.has('t') && !ranks.has('o')) {
      return c.render([ERR_CHANOPRIVSNEEDED, channel.name, "You're not channel operator"])
    }
    channel.topic = text
      ? {
          text: truncate(text, TOPIC_LENGTH),
          by: client.mask,
          at: Math.floor(Date.now() / 1000),
        }
      : undefined
    channel.send(msg(client.mask, 'TOPIC', channel.name, channel.topic?.text ?? ''))
    return c.render()
  })

  app.on('TCP', '/NAMES/*', (c) => {
    const { client, message } = c.var
    const [list] = message.params
    // Listing every channel is not supported, which a server may do.
    if (!list) {
      return c.render([RPL_ENDOFNAMES, '*', 'End of /NAMES list'])
    }
    const { targets, excess } = server.targets(list, MAX_TARGETS.NAMES)
    return c.render(
      ...targets.flatMap((channelName): Line[] => {
        const channel = server.channels.get(server.fold(channelName))
        return channel
          ? server.names(client, channel)
          : [[RPL_ENDOFNAMES, echo(channelName), 'End of /NAMES list']]
      }),
      ...tooMany(excess)
    )
  })

  app.on('TCP', '/LIST/*', (c) => {
    return c.render(
      [RPL_LISTSTART, 'Channel', 'Users  Name'],
      ...[...server.channels.values()].map((channel): Line => [
        RPL_LIST,
        channel.name,
        channel.members.size,
        channel.topic?.text ?? '',
      ]),
      [RPL_LISTEND, 'End of /LIST']
    )
  })

  // `KICK #channel nick1,nick2 :reason` kicks each one with a KICK of its own.
  app.on('TCP', '/KICK/*', (c) => {
    const { client, message } = c.var
    const [channelName, list, reason] = message.params
    if (!channelName || !list) {
      return c.render([ERR_NEEDMOREPARAMS, 'KICK', 'Not enough parameters'])
    }
    const channel = server.channels.get(server.fold(channelName))
    if (!channel) {
      return c.render([ERR_NOSUCHCHANNEL, echo(channelName), 'No such channel'])
    }
    const ranks = channel.members.get(client)
    if (!ranks) {
      return c.render([ERR_NOTONCHANNEL, channel.name, "You're not on that channel"])
    }
    if (!ranks.has('o')) {
      return c.render([ERR_CHANOPRIVSNEEDED, channel.name, "You're not channel operator"])
    }
    const { targets, excess } = server.targets(list, MAX_TARGETS.KICK)
    const comment = truncate(reason || client.nick, KICK_LENGTH)
    for (const nick of targets) {
      const target = server.nicks.get(server.fold(nick))
      if (!target || !channel.members.has(target)) {
        c.render([ERR_USERNOTINCHANNEL, echo(nick), channel.name, "They aren't on that channel"])
        continue
      }
      channel.send(msg(client.mask, 'KICK', channel.name, target.nick, comment))
      server.leave(target, channel)
    }
    return c.render(...tooMany(excess))
  })

  return app
}
