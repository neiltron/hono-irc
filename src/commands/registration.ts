import { Hono } from 'tcp-hono'
import {
  ERR_ALREADYREGISTERED,
  ERR_BANNICKCHANGE,
  ERR_ERRONEUSNICKNAME,
  ERR_INVALIDCAPCMD,
  ERR_NEEDMOREPARAMS,
  ERR_NICKNAMEINUSE,
  ERR_NONICKNAMEGIVEN,
  ERR_NOORIGIN,
} from '../numerics.ts'
import { MAX_LINE_LENGTH, format } from '../protocol.ts'
import { echo, msg } from '../state.ts'
import type { Env, Line, Server } from '../state.ts'

// NICK_LENGTH characters, which are ASCII, so it is also the length in bytes.
const NICK_PATTERN = /^[A-Za-z_[\]\\`^{}|][A-Za-z0-9_\-[\]\\`^{}|]{0,29}$/
// A `CAP LS` reply is split into lines of this many bytes of capabilities.
const CAP_LS_LENGTH = 400

const encoder = new TextEncoder()

/** Connection registration: `CAP`, `NICK`, `USER`, `PASS`, `PING`, `PONG`, and `QUIT`. */
export const registration = (server: Server) => {
  const app = new Hono<Env>()

  // Each command takes the parameters from the message, and ignores the ones that it does not use.

  app.on('TCP', '/CAP/*', (c) => {
    const { client, message } = c.var
    if (!message.params.length) {
      return c.render([ERR_NEEDMOREPARAMS, 'CAP', 'Not enough parameters'])
    }
    const subcommand = message.params[0].toUpperCase()
    const target = client.nick

    if (subcommand === 'LS') {
      client.negotiating ||= !client.registered
      // `CAP LS 302` enables cap-notify implicitly, and it can not be disabled after that.
      client.capVersion = Math.max(client.capVersion, Number(message.params[1]) || 0)
      if (client.capVersion >= 302) {
        client.capabilities.add('cap-notify')
      }
      const capabilities = [...server.capabilities].sort(([a], [b]) => (a < b ? -1 : 1))
      // Before version 302, a client gets the names only, in one line.
      if (!(Number(message.params[1]) >= 302)) {
        return c.render(['CAP', target, 'LS', capabilities.map(([name]) => name).join(' ')])
      }
      const chunks = ['']
      for (const [name, value] of capabilities) {
        const token = value === undefined ? name : `${name}=${value}`
        const last = chunks[chunks.length - 1]
        if (last && encoder.encode(`${last} ${token}`).length > CAP_LS_LENGTH) {
          chunks.push(token)
        } else {
          chunks[chunks.length - 1] = last ? `${last} ${token}` : token
        }
      }
      // Every line but the last has `*`, which tells the client that more lines follow.
      return c.render(
        ...chunks.map((chunk, i): Line =>
          i < chunks.length - 1 ? ['CAP', target, 'LS', '*', chunk] : ['CAP', target, 'LS', chunk]
        )
      )
    }
    if (subcommand === 'LIST') {
      return c.render(['CAP', target, 'LIST', [...client.capabilities].join(' ')])
    }
    if (subcommand === 'REQ') {
      const requested = message.params[1]
      if (requested === undefined) {
        return c.render([ERR_NEEDMOREPARAMS, 'CAP', 'Not enough parameters'])
      }
      client.negotiating ||= !client.registered
      const changes = requested.split(' ').filter(Boolean)
      if (
        !changes.every((cap) => server.capabilities.has(cap.replace(/^-/, ''))) ||
        (client.capVersion >= 302 && changes.includes('-cap-notify'))
      ) {
        return c.render(['CAP', target, 'NAK', requested])
      }
      for (const cap of changes) {
        if (cap[0] === '-') {
          client.capabilities.delete(cap.slice(1))
        } else {
          client.capabilities.add(cap)
        }
      }
      return c.render(['CAP', target, 'ACK', requested])
    }
    if (subcommand === 'END') {
      client.negotiating = false
      return c.render(...server.register(client))
    }
    return c.render([ERR_INVALIDCAPCMD, echo(subcommand), 'Invalid CAP command'])
  })

  // The password is not checked, but it can only be sent before the registration.
  app.on('TCP', '/PASS/*', (c) => {
    const { client, message } = c.var
    if (client.registered) {
      return c.render([ERR_ALREADYREGISTERED, 'You may not reregister'])
    }
    if (!message.params.length) {
      return c.render([ERR_NEEDMOREPARAMS, 'PASS', 'Not enough parameters'])
    }
    return c.render()
  })

  app.on('TCP', '/NICK/*', (c) => {
    const { client, message } = c.var
    const nick = message.params[0]
    if (!nick) {
      return c.render([ERR_NONICKNAMEGIVEN, 'No nickname given'])
    }
    if (!NICK_PATTERN.test(nick)) {
      return c.render([ERR_ERRONEUSNICKNAME, echo(nick), 'Erroneous nickname'])
    }
    const owner = server.nicks.get(server.fold(nick))
    if (owner && owner !== client) {
      return c.render([ERR_NICKNAMEINUSE, nick, 'Nickname is already in use'])
    }
    if (nick === client.nick) {
      return c.render()
    }
    // A member that is banned can not change its nickname to get around the ban, unless it is an
    // operator or has voice, as on most servers.
    const banned = [...client.channels].find(
      (channel) => channel.banned(client) && !channel.privileged(client)
    )
    if (banned) {
      return c.render([
        ERR_BANNICKCHANGE,
        nick,
        banned.name,
        'Cannot change nickname while banned on channel',
      ])
    }
    if (client.registered) {
      for (const target of [client, ...server.peers(client)]) {
        target.send(msg(client.mask, 'NICK', nick))
      }
    }
    server.nicks.delete(server.fold(client.nick))
    server.nicks.set(server.fold(nick), client)
    client.nick = nick
    return c.render(...server.register(client))
  })

  app.on('TCP', '/USER/*', (c) => {
    const { client, message } = c.var
    if (client.registered) {
      return c.render([ERR_ALREADYREGISTERED, 'You may not reregister'])
    }
    const [user, , , realname] = message.params
    if (!user || !realname) {
      return c.render([ERR_NEEDMOREPARAMS, 'USER', 'Not enough parameters'])
    }
    // The username is not verified with Ident.
    client.user = '~' + (user.replace(/[^\w.-]/g, '').slice(0, 10) || 'user')
    client.realname = realname
    return c.render(...server.register(client))
  })

  app.on('TCP', '/PING/*', (c) => {
    const [token] = c.var.message.params
    if (token === undefined) {
      return c.render([ERR_NEEDMOREPARAMS, 'PING', 'Not enough parameters'])
    }
    // The token may be any non-empty string. Some servers say ERR_NOORIGIN for an empty one.
    if (!token) {
      return c.render([ERR_NOORIGIN, 'No origin specified'])
    }
    return c.render(['PONG', server.name, token])
  })

  app.on('TCP', '/PONG/*', (c) => c.render())

  app.on('TCP', '/QUIT/*', (c) => {
    const { client, message } = c.var
    client.quit = `Quit: ${message.params[0] ?? ''}`.trim()
    // The connection is closed after the response, and the others are notified in `onClose()`.
    // The ERROR line is the body of the response itself, without a source or tags. It is formatted
    // like any other line, so a line terminator in the reason can not end it.
    c.header('Connection', 'close')
    return c.text(
      format(
        { command: 'ERROR', params: [`Closing Link: ${client.host} (${client.quit})`] },
        MAX_LINE_LENGTH - 2
      )
    )
  })

  return app
}
