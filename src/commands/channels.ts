import { Hono } from 'tcp-hono'
import {
  ERR_CHANOPRIVSNEEDED,
  ERR_NOSUCHCHANNEL,
  ERR_NOTONCHANNEL,
  ERR_TOOMANYCHANNELS,
  ERR_USERNOTINCHANNEL,
  RPL_ENDOFNAMES,
  RPL_LIST,
  RPL_LISTEND,
  RPL_LISTSTART,
} from '../numerics.ts'
import { CHANNEL_PATTERN, Channel, MAX_CHANNELS, TOPIC_LENGTH, msg } from '../state.ts'
import type { Env, Line, Server } from '../state.ts'

/** Channels: `JOIN`, `PART`, `TOPIC`, `NAMES`, `LIST`, and `KICK`. */
export const channels = (server: Server) => {
  const app = new Hono<Env>()

  app.on('TCP', '/JOIN/:channels/*', (c) => {
    const { client } = c.var

    if (c.req.param('channels') === '0') {
      for (const channel of client.channels) {
        channel.send(msg(client.mask, 'PART', channel.name))
        server.leave(client, channel)
      }
      return c.render()
    }

    // The replies are rendered for each channel, so the client gets the JOIN of a channel
    // followed by its topic and names, before the next channel.
    for (const channelName of c.req.param('channels').split(',')) {
      if (!CHANNEL_PATTERN.test(channelName)) {
        c.render([ERR_NOSUCHCHANNEL, channelName, 'No such channel'])
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

  app.on('TCP', '/PART/:channels/*', (c) => {
    const { client, message } = c.var
    const lines: Line[] = []
    for (const channelName of c.req.param('channels').split(',')) {
      const channel = server.channels.get(server.fold(channelName))
      if (!channel) {
        lines.push([ERR_NOSUCHCHANNEL, channelName, 'No such channel'])
      } else if (!channel.members.has(client)) {
        lines.push([ERR_NOTONCHANNEL, channel.name, "You're not on that channel"])
      } else {
        channel.send(msg(client.mask, 'PART', channel.name, ...message.params.slice(1, 2)))
        server.leave(client, channel)
      }
    }
    return c.render(...lines)
  })

  app.on('TCP', '/TOPIC/:channel/*', (c) => {
    const { client, message } = c.var
    const channel = server.channels.get(server.fold(c.req.param('channel')))
    if (!channel) {
      return c.render([ERR_NOSUCHCHANNEL, c.req.param('channel'), 'No such channel'])
    }
    // `TOPIC #channel` asks for the topic and `TOPIC #channel :` clears it,
    // so the parameter is taken from the message. A path can not have an empty segment.
    const text = message.params[1]
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
      ? { text: text.slice(0, TOPIC_LENGTH), by: client.mask, at: Math.floor(Date.now() / 1000) }
      : undefined
    channel.send(msg(client.mask, 'TOPIC', channel.name, channel.topic?.text ?? ''))
    return c.render()
  })

  app.on('TCP', '/NAMES/:channels/*', (c) => {
    const lines = c.req
      .param('channels')
      .split(',')
      .flatMap((channelName): Line[] => {
        const channel = server.channels.get(server.fold(channelName))
        return channel
          ? server.names(c.var.client, channel)
          : [[RPL_ENDOFNAMES, channelName, 'End of /NAMES list']]
      })
    return c.render(...lines)
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

  app.on('TCP', '/KICK/:channel/:nick/*', (c) => {
    const { client, message } = c.var
    const channel = server.channels.get(server.fold(c.req.param('channel')))
    if (!channel) {
      return c.render([ERR_NOSUCHCHANNEL, c.req.param('channel'), 'No such channel'])
    }
    if (!channel.members.get(client)?.has('o')) {
      return c.render([ERR_CHANOPRIVSNEEDED, channel.name, "You're not channel operator"])
    }
    const target = server.nicks.get(server.fold(c.req.param('nick')))
    if (!target || !channel.members.has(target)) {
      return c.render([
        ERR_USERNOTINCHANNEL,
        c.req.param('nick'),
        channel.name,
        "They aren't on that channel",
      ])
    }
    channel.send(
      msg(client.mask, 'KICK', channel.name, target.nick, message.params[2] ?? client.nick)
    )
    server.leave(target, channel)
    return c.render()
  })

  return app
}
