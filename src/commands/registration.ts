import { Hono } from 'tcp-hono'
import {
  ERR_ALREADYREGISTERED,
  ERR_ERRONEUSNICKNAME,
  ERR_INVALIDCAPCMD,
  ERR_NICKNAMEINUSE,
} from '../numerics.ts'
import { msg } from '../state.ts'
import type { Env, Line, Server } from '../state.ts'

const NICK_PATTERN = /^[A-Za-z_[\]\\`^{}|][A-Za-z0-9_\-[\]\\`^{}|]{0,29}$/
// A `CAP LS` reply is split into lines of this many bytes of capabilities.
const CAP_LS_LENGTH = 400

const encoder = new TextEncoder()

/** Connection registration: `CAP`, `NICK`, `USER`, `PASS`, `PING`, `PONG`, and `QUIT`. */
export const registration = (server: Server) => {
  const app = new Hono<Env>()

  app.on('TCP', '/CAP/:subcommand/*', (c) => {
    const { client, message } = c.var
    const subcommand = c.req.param('subcommand').toUpperCase()
    const target = client.nick

    if (subcommand === 'LS') {
      client.negotiating ||= !client.registered
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
      client.negotiating ||= !client.registered
      const requested = message.params.at(-1) ?? ''
      const changes = requested.split(' ').filter(Boolean)
      if (!changes.every((cap) => server.capabilities.has(cap.replace(/^-/, '')))) {
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
    return c.render([ERR_INVALIDCAPCMD, subcommand, 'Invalid CAP command'])
  })

  app.on('TCP', '/PASS/*', (c) => c.render())

  app.on('TCP', '/NICK/:nick', (c) => {
    const { client } = c.var
    const nick = c.req.param('nick')
    if (!NICK_PATTERN.test(nick)) {
      return c.render([ERR_ERRONEUSNICKNAME, nick, 'Erroneous nickname'])
    }
    const owner = server.nicks.get(server.fold(nick))
    if (owner && owner !== client) {
      return c.render([ERR_NICKNAMEINUSE, nick, 'Nickname is already in use'])
    }
    if (nick === client.nick) {
      return c.render()
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

  app.on('TCP', '/USER/:user/:mode/:unused/:realname', (c) => {
    const { client } = c.var
    if (client.registered) {
      return c.render([ERR_ALREADYREGISTERED, 'You may not reregister'])
    }
    // The username is not verified with Ident.
    client.user =
      '~' +
      (c.req
        .param('user')
        .replace(/[^\w.-]/g, '')
        .slice(0, 10) || 'user')
    client.realname = c.req.param('realname')
    return c.render(...server.register(client))
  })

  app.on('TCP', '/PING/:token', (c) => c.render(['PONG', server.name, c.req.param('token')]))

  app.on('TCP', '/PONG/*', (c) => c.render())

  app.on('TCP', '/QUIT/*', (c) => {
    const { client, message } = c.var
    client.quit = `Quit: ${message.params[0] ?? ''}`.trim()
    // The connection is closed after the response, and the others are notified in `onClose()`.
    // The ERROR line is the body of the response itself, without a source or tags.
    c.header('Connection', 'close')
    return c.text(`ERROR :Closing Link: ${client.host} (${client.quit})`)
  })

  return app
}
