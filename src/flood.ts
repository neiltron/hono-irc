import type { Context, Next } from 'hono'
import { getConnection } from 'tcp-hono'
import type { Connection } from 'tcp-hono'
import type { Client, Env, Server } from './state.ts'

type Bucket = { tokens: number; at: number; registered: boolean }

// A wait is done in slices of this many milliseconds, so it ends soon after the connection closes.
const SLICE = 50

/**
 * Wait, unless the connection is closed meanwhile. tcp-hono reads nothing from a connection while
 * one of its messages is handled, so a close by the server is seen here, e.g. a timeout or a client
 * that does not read, and a client that goes away is seen once the wait is over.
 */
const wait = async (ms: number, connection: Connection) => {
  const until = Date.now() + ms
  while (!connection.closed && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(SLICE, until - Date.now())))
  }
}

/**
 * Flood control: a token bucket for each connection, as set by `flood` of `ServerOptions`.
 * A command takes tokens, NICK, JOIN, and PART more than one, and a token comes back every
 * `interval`. A client that runs out is not disconnected: its command waits until the tokens are
 * back, which is called fake lag. A client that sends too much just gets slower.
 *
 * A connection is handled one message at a time, so the wait holds back only the client's own
 * messages, and the ones it sends meanwhile wait in the transport: TCP slows the client down, and
 * the WebSocket adapter closes the connection past `maxBufferedBytes`. The others go on as usual.
 *
 * Before the registration, every command takes one token, and the bucket is full again once the
 * client has registered, so a normal registration does not use up what comes after it.
 *
 * It runs before the middleware of `server.ts`, so it counts every line, including the ones that
 * are rejected before the registration, and it waits before the outbox is opened.
 */
export const flood = (server: Server) => {
  const buckets = new WeakMap<Client, Bucket>()

  return async (c: Context<Env>, next: Next) => {
    const options = server.flood
    const connection = getConnection(c)
    const client = server.clients.get(connection)
    if (!options || !client) {
      return next()
    }
    const now = Date.now()
    let bucket = buckets.get(client)
    if (!bucket || bucket.registered !== client.registered) {
      bucket = { tokens: options.burst, at: now, registered: client.registered }
      buckets.set(client, bucket)
    }
    bucket.tokens = Math.min(options.burst, bucket.tokens + (now - bucket.at) / options.interval)
    bucket.at = now

    // The path is the command and the parameters, each percent-encoded.
    const command = decodeURIComponent(c.req.path.split('/')[1] ?? '')
    bucket.tokens -= client.registered ? (options.costs[command] ?? 1) : 1
    if (bucket.tokens < 0) {
      // The client is not silent while it waits, so the ping timeout leaves it alone.
      client.delayed = true
      try {
        await wait(-bucket.tokens * options.interval, connection)
      } finally {
        client.delayed = false
      }
      if (connection.closed) {
        return c.body(null)
      }
    }
    return next()
  }
}
