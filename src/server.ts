import type { ContextRenderer } from 'hono'
import { Hono, getConnection, tcp } from 'tcp-hono'
import type { Socket, TCPOptions } from 'tcp-hono'
import { channels } from './commands/channels.ts'
import { messages } from './commands/messages.ts'
import { modes } from './commands/modes.ts'
import { queries } from './commands/queries.ts'
import { registration } from './commands/registration.ts'
import { ERR_NEEDMOREPARAMS, ERR_NOTREGISTERED, ERR_UNKNOWNCOMMAND } from './numerics.ts'
import { irc, parse } from './protocol.ts'
import type { IRCMessage } from './protocol.ts'
import { Client, Server, msg } from './state.ts'
import type { ConnectionInfo, Env, Line, ServerOptions } from './state.ts'

export type { ConnectionInfo, ServerOptions }

/**
 * An IRC server. The state is in memory and it does not depend on a runtime.
 * It handles one connection at a time, like a Durable Object does.
 */
export const createServer = (config: ServerOptions = {}) => {
  const server = new Server(config)
  const app = new Hono<Env>()

  app.use('*', async (c, next) => {
    const client = server.clients.get(getConnection(c))!
    const message = parse(await c.req.text())!
    client.active = Date.now()
    client.pinged = false
    c.set('client', client)
    c.set('message', message)
    // The replies come from the server, and a numeric reply has the nickname of the client.
    c.setRenderer(((...lines: Line[]) => {
      for (const [command, ...params] of lines) {
        client.send({
          source: server.name,
          command,
          params: [...(/^\d{3}$/.test(command) ? [client.nick] : []), ...params.map(String)],
        })
      }
      return c.body(null)
    }) as ContextRenderer)

    // The outbox collects every message to this client while its command is handled: the
    // replies of `c.render()` and the messages of `client.send()` and `channel.send()` that
    // reach it, such as its own JOIN. They become the response, in the order they were sent.
    // The messages to the other clients are pushed to their connections at once.
    //
    // The outbox belongs to the requesting client, and it is open only while `next()` runs
    // synchronously. The handlers are synchronous, so it covers the handler, `notFound()`, and
    // `onError()`, and nothing that another connection does in the meantime. If a handler ever
    // awaits, the outbox is closed from that point: what it sends after the await is pushed
    // before the response, out of order, and outside anything that wraps the response.
    const outbox: IRCMessage[] = []
    client.outbox = outbox
    let handled: Promise<void> | undefined
    try {
      if (!client.registered && !server.beforeRegistration.has(message.command)) {
        c.render([ERR_NOTREGISTERED, 'You have not registered'])
      } else {
        handled = next()
      }
    } finally {
      client.outbox = undefined
    }
    await handled

    if (outbox.length) {
      // A body that a handler writes itself, such as the ERROR of QUIT, follows the outbox.
      const body = c.finalized ? await c.res.text() : ''
      const lines = outbox.map((message) => client.format(message))
      c.res = new Response([...lines, ...(body ? [body] : [])].join('\r\n'))
    }
  })

  app.route('/', registration(server))
  app.route('/', channels(server))
  app.route('/', messages(server))
  app.route('/', modes(server))
  app.route('/', queries(server))

  // A command that is not routed: unknown, or without the required parameters.
  // `app.route()` adds the routes of a module to `app.routes`, so they are all here.
  const commands = new Set(app.routes.flatMap((route) => route.path.match(/[A-Z]{2,}/g) ?? []))
  app.notFound((c) => {
    const { command } = c.var.message
    return commands.has(command)
      ? c.render([ERR_NEEDMOREPARAMS, command, 'Not enough parameters'])
      : c.render([ERR_UNKNOWNCOMMAND, command, 'Unknown command'])
  })

  app.onError((error, c) => {
    console.error(error)
    return c.render(['NOTICE', c.var.client.nick, 'Internal server error'])
  })

  // The information about the connection that `connect()` hands over to `onOpen()`.
  let pending: ConnectionInfo | undefined

  const options: TCPOptions = {
    protocol: irc(),
    onOpen: (connection) => {
      server.clients.set(connection, new Client(server, connection, pending))
    },
    onClose: (connection) => {
      const client = server.clients.get(connection)!
      server.clients.delete(connection)
      if (server.nicks.get(server.fold(client.nick)) === client) {
        server.nicks.delete(server.fold(client.nick))
      }
      for (const peer of server.peers(client)) {
        peer.send(msg(client.mask, 'QUIT', client.quit ?? 'Connection closed'))
      }
      for (const channel of client.channels) {
        server.leave(client, channel)
      }
    },
  }

  const handler = tcp.socket(app, options)

  /**
   * Handle a connection until it is closed. This is the only way a runtime hands over a socket.
   *
   * `onOpen()` does not get the socket, so the information goes through `pending`. The handler of
   * tcp-hono calls `onOpen()` synchronously, before its first `await`, so `pending` is set only
   * during that call and no other connection sees it.
   */
  const connect = (socket: Socket, info?: ConnectionInfo): Promise<void> => {
    pending = info
    try {
      return handler(socket)
    } finally {
      pending = undefined
    }
  }

  /** Find the clients that have gone without closing the connection. Call it periodically. */
  const tick = () => {
    const now = Date.now()
    for (const client of server.clients.values()) {
      const silent = now - client.active
      if (
        silent > server.pingInterval * 2 ||
        (!client.registered && silent > server.pingInterval)
      ) {
        client.quit = client.registered ? 'Ping timeout' : 'Registration timeout'
        client.connection.send(`ERROR :Closing Link: ${client.host} (${client.quit})\r\n`)
        client.connection.close()
      } else if (silent > server.pingInterval && !client.pinged) {
        client.pinged = true
        client.connection.send(`PING :${server.name}\r\n`)
      }
    }
  }

  return {
    app,
    options,
    connect,
    tick,
    clients: server.clients,
    channels: server.channels,
    /** The capabilities, with the values that `CAP LS 302` shows. */
    capabilities: server.capabilities,
    /** The RPL_ISUPPORT tokens. */
    isupport: server.isupport,
  }
}
