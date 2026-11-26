import type { ContextRenderer } from 'hono'
import { Hono, getConnection, tcp } from 'tcp-hono'
import type { Socket, TCPOptions } from 'tcp-hono'
import { channels } from './commands/channels.ts'
import { messages } from './commands/messages.ts'
import { modes } from './commands/modes.ts'
import { queries } from './commands/queries.ts'
import { registration } from './commands/registration.ts'
import { flood } from './flood.ts'
import { ERR_INPUTTOOLONG, ERR_NOTREGISTERED, ERR_UNKNOWNCOMMAND } from './numerics.ts'
import { INPUT_TOO_LONG, format, irc, parse } from './protocol.ts'
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

  app.use('*', flood(server))

  app.use('*', async (c, next) => {
    const client = server.clients.get(getConnection(c))
    if (!client) {
      // A connection that was refused in `onOpen()`. Its read loop ends without a message.
      return c.body(null)
    }
    // A line that was too long comes without a body, and the rest are lines that parse.
    const message = parse(await c.req.text()) ?? { command: INPUT_TOO_LONG, params: [] }
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
      // The headers are kept for `Connection: close`.
      c.res = new Response([...lines, ...(body ? [body] : [])].join('\r\n'), {
        headers: c.res.headers,
      })
    }
  })

  app.route('/', registration(server))
  app.route('/', channels(server))
  app.route('/', messages(server))
  app.route('/', modes(server))
  app.route('/', queries(server))

  // The decoder yields this in place of a line that is too long. The line is dropped and the
  // connection stays open.
  app.on('TCP', '/' + encodeURIComponent(INPUT_TOO_LONG), (c) =>
    c.render([ERR_INPUTTOOLONG, 'Input line was too long'])
  )
  server.beforeRegistration.add(INPUT_TOO_LONG)

  // Every command is routed as `/COMMAND/*` and checks its own parameters, so a command that is
  // not routed is unknown.
  app.notFound((c) => c.render([ERR_UNKNOWNCOMMAND, c.var.message.command, 'Unknown command']))

  app.onError((error, c) => {
    console.error(error)
    return c.render(['NOTICE', c.var.client.nick, 'Internal server error'])
  })

  // The information about the connection that `connect()` hands over to `onOpen()`.
  let pending: ConnectionInfo | undefined

  const options: TCPOptions = {
    protocol: irc(),
    onOpen: (connection) => {
      const ip = pending?.ip
      const reason =
        server.clients.size >= server.maxConnections
          ? 'Too many connections'
          : ip !== undefined && (server.addresses.get(ip) ?? 0) >= server.maxConnectionsPerIp
            ? 'Too many connections from your address'
            : undefined
      if (reason) {
        // The connection does not get a client. tcp-hono writes the ERROR, ends the read loop,
        // and calls `onClose()`, which has nothing to clean up.
        connection.send(
          format({ command: 'ERROR', params: [`Closing Link: * (${reason})`] }) + '\r\n'
        )
        connection.close()
        return
      }
      server.clients.set(connection, new Client(server, connection, pending))
      if (ip !== undefined) {
        server.addresses.set(ip, (server.addresses.get(ip) ?? 0) + 1)
      }
    },
    onClose: (connection) => {
      // tcp-hono calls `onClose()` for every connection that it called `onOpen()` for, including
      // the refused ones, and if `onOpen()` threw.
      const client = server.clients.get(connection)
      if (!client) {
        return
      }
      server.clients.delete(connection)
      if (client.ip !== undefined) {
        const count = (server.addresses.get(client.ip) ?? 1) - 1
        if (count) {
          server.addresses.set(client.ip, count)
        } else {
          server.addresses.delete(client.ip)
        }
      }
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
      // The registration has to be done in time from the connection, whatever the client sends.
      if (
        client.registered
          ? silent > server.pingInterval * 2
          : now - client.signon > server.pingInterval
      ) {
        client.quit = client.registered ? 'Ping timeout' : 'Registration timeout'
        const error = format({
          command: 'ERROR',
          params: [`Closing Link: ${client.host} (${client.quit})`],
        })
        // tcp-hono writes what is queued before it closes the socket.
        client.connection.send(error + '\r\n')
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
