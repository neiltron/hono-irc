import type { Context, Next } from 'hono'
import { getConnection } from 'tcp-hono'
import { format } from './protocol.ts'
import type { Client, Env, Server } from './state.ts'

type Bucket = { tokens: number; at: number; registered: boolean }

/**
 * Flood control: a token bucket for each connection, as set by `flood` of `ServerOptions`.
 * A command takes tokens, NICK, JOIN, and PART more than one, and a token comes back every
 * `interval`. A client that runs out is disconnected with "Excess Flood".
 *
 * Before the registration, every command takes one token, and the bucket is full again once the
 * client has registered, so a normal registration does not use up what comes after it.
 *
 * It runs before the middleware of `server.ts`, so it counts every line, including the ones that
 * are rejected before the registration, and it writes its ERROR outside the outbox.
 */
export const flood = (server: Server) => {
  const buckets = new WeakMap<Client, Bucket>()

  return async (c: Context<Env>, next: Next) => {
    const options = server.flood
    const client = server.clients.get(getConnection(c))
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
    if (bucket.tokens >= 0) {
      return next()
    }
    // The connection is closed after the response, and the others are told in `onClose()`.
    client.quit = 'Excess Flood'
    c.header('Connection', 'close')
    return c.text(
      format({ command: 'ERROR', params: [`Closing Link: ${client.host} (${client.quit})`] })
    )
  }
}
