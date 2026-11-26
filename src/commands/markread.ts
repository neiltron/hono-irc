import { Hono } from 'tcp-hono'
import { parseTimestamp } from '../history.ts'
import { echo, fail, msg } from '../state.ts'
import type { Client, Env, Server } from '../state.ts'

const CAPABILITY = 'draft/read-marker'

const PREFIX = 'timestamp='

/** The parameter of a MARKREAD from the server: the timestamp, or `*` without one. */
const value = (at?: number) => (at === undefined ? '*' : PREFIX + new Date(at).toISOString())

/**
 * Read markers: `MARKREAD`, https://ircv3.net/specs/extensions/read-marker (a work in progress,
 * hence `draft/read-marker`).
 *
 * - A marker belongs to an account, for a channel or for the direct messages with another account
 *   (a nickname stands for the account of the client that has it, or the account of that name), so
 *   it is the same on every connection of the account, and the others with the capability are told
 *   when it moves. It is never shown to anyone else.
 * - It only moves forward, and not past the time of the server. A client that is not logged in has
 *   no marker: it gets `*`, and setting one fails with `INTERNAL_ERROR`.
 * - A client with the capability gets the marker of a channel when it joins, before the names.
 * - A target must exist, a channel or an account, so an account has at most a marker for each, and
 *   `history.maxMarkers` in all.
 */
export const markread = (server: Server) => {
  const app = new Hono<Env>()
  const history = server.history
  if (!history) {
    return app
  }
  server.capabilities.set(CAPABILITY, undefined)

  /** The folded target of a marker: a channel that exists, or an account. */
  const key = (name: string): string | undefined => {
    if (name[0] === '#') {
      const folded = server.fold(name)
      return server.channels.has(folded) || server.channelStore?.get(folded) ? folded : undefined
    }
    return server.accountOf(name)?.folded
  }

  const marker = (client: Client, target: string) =>
    client.account === undefined ? undefined : history.marker(server.fold(client.account), target)

  server.onJoin.push((client, channel) => {
    if (client.capabilities.has(CAPABILITY)) {
      client.send(
        msg(server.name, 'MARKREAD', channel.name, value(marker(client, server.fold(channel.name))))
      )
    }
  })

  // `MARKREAD <target>` asks for the marker, and `MARKREAD <target> timestamp=...` moves it.
  app.on('TCP', '/MARKREAD/*', (c) => {
    const { client, message } = c.var
    const [target, timestamp] = message.params
    if (!target) {
      return c.render(fail('MARKREAD', 'NEED_MORE_PARAMS', 'Missing parameters'))
    }
    const folded = key(target)
    if (!folded) {
      return c.render(fail('MARKREAD', 'INVALID_PARAMS', echo(target), 'Invalid target'))
    }
    if (timestamp === undefined) {
      return c.render(['MARKREAD', target, value(marker(client, folded))])
    }
    const at = timestamp.startsWith(PREFIX)
      ? parseTimestamp(timestamp.slice(PREFIX.length))
      : undefined
    if (at === undefined) {
      return c.render(fail('MARKREAD', 'INVALID_PARAMS', echo(timestamp), 'Invalid timestamp'))
    }
    if (client.account === undefined) {
      return c.render(
        fail('MARKREAD', 'INTERNAL_ERROR', echo(target), 'You must be logged in to an account')
      )
    }
    const account = server.fold(client.account)
    const marked = server.safely(() => history.mark(account, folded, Math.min(at, Date.now())))
    if (!marked) {
      return c.render(
        fail('MARKREAD', 'INTERNAL_ERROR', echo(target), 'The read timestamp could not be set')
      )
    }
    if (marked.moved) {
      // The other connections of the account.
      for (const other of server.clients.values()) {
        if (
          other !== client &&
          other.account !== undefined &&
          server.fold(other.account) === account &&
          other.capabilities.has(CAPABILITY)
        ) {
          other.send(msg(server.name, 'MARKREAD', target, value(marked.at)))
        }
      }
    }
    return c.render(['MARKREAD', target, value(marked.at)])
  })

  return app
}
