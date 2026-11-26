import { Hono } from 'tcp-hono'
import { ERR_INPUTTOOLONG, ERR_NEEDMOREPARAMS } from '../numerics.ts'
import { INPUT_TOO_LONG, byteLength } from '../protocol.ts'
import type { IRCMessage } from '../protocol.ts'
import { MAX_TARGETS, clientTags, echo, fail, msg, tooMany } from '../state.ts'
import type { Client, Env, InboundBatch, Line, Server } from '../state.ts'
import { CONCAT, MULTILINE, deliver } from './messages.ts'

const TYPE = MULTILINE
// A reference tag has only ASCII letters, digits, and hyphens.
const REF_PATTERN = /^[A-Za-z0-9-]+$/

/**
 * What a line costs the flood control, if it is part of a multiline batch, and `undefined` for
 * the other lines. A line of the open batch is free, and the batch is charged as a whole when it
 * closes: one token for every 512 bytes of its text or every 5 lines, whichever is more, and at
 * least one. A client may send a whole batch at once, as the spec expects, and it reaches the
 * others at once; the bytes cost what they would as single lines, and the lines up to five times
 * less. A batch is bounded by `max-bytes` and `max-lines`, and once it fails, its lines cost as
 * usual.
 */
export const batchCost = (client: Client, message: IRCMessage): number | undefined => {
  const batch = client.inbound
  if (!batch) {
    return
  }
  if (message.tags?.batch === batch.ref) {
    return 0
  }
  if (message.command === 'BATCH' && message.params[0] === '-' + batch.ref) {
    return Math.max(1, Math.ceil(batch.bytes / 512), Math.ceil(batch.lines.length / 5))
  }
}

/** Give up a batch that has been open for too long. `tick()` calls it. */
export const expire = (server: Server, client: Client, now: number) => {
  const batch = client.inbound
  // A client whose closing line waits for the flood control has sent it in time.
  if (batch && !client.delayed && now - batch.opened > server.multiline.timeout) {
    client.inbound = undefined
    client.send(
      msg(server.name, 'FAIL', 'BATCH', 'TIMEOUT', batch.ref, 'Multiline batch timed out')
    )
  }
}

/**
 * Client-initiated batches (https://ircv3.net/specs/extensions/client-batch), of the only type that
 * the server knows, `draft/multiline` (https://ircv3.net/specs/extensions/multiline).
 *
 * A client opens a batch with `BATCH +ref draft/multiline <target>`, sends PRIVMSG or NOTICE lines
 * with the tag `batch=ref`, and closes it with `BATCH -ref`. The lines are kept, one batch at a
 * time for a connection, and checked as they come: a batch that breaks a rule gets a FAIL and is
 * dropped, and the rest of its lines are ignored. When it closes, it is delivered once, with the
 * rules of PRIVMSG: as one batch to the clients that have `draft/multiline` and `batch`, and as
 * single lines to the others.
 */
export const multiline = (server: Server) => {
  const app = new Hono<Env>()
  const { maxBytes, maxLines } = server.multiline
  server.capabilities.set(TYPE, `max-bytes=${maxBytes},max-lines=${maxLines}`)
  server.tagCapabilities.set(CONCAT, TYPE)

  // The batch fails: it is dropped, and the lines of its reference that follow are ignored, as
  // those of a batch that is not open.
  const reject = (client: Client, code: string, ...rest: [...string[], string]): Line => {
    client.inbound = undefined
    return fail('BATCH', code, ...rest)
  }

  // A line with a `batch` tag belongs to that batch, whatever its command, so it is taken here,
  // before the routes of the commands.
  app.use('*', async (c, next) => {
    const { client, message } = c.var
    const ref = message.tags?.batch
    const batch = client.inbound
    if (ref === undefined) {
      return next()
    }
    if (!batch || batch.ref !== ref) {
      // A batch that is not open, or that has failed: its lines are ignored. A line that is too
      // long still gets its reply.
      return message.command === INPUT_TOO_LONG ? next() : c.render()
    }
    if (message.command === INPUT_TOO_LONG) {
      return c.render(
        [ERR_INPUTTOOLONG, 'Input line was too long'],
        reject(client, 'MULTILINE_INVALID', 'Invalid multiline batch with a line too long')
      )
    }
    return c.render(...add(client, batch, message))
  })

  // Add a line to the open batch, or reject the batch.
  const add = (client: Client, batch: InboundBatch, message: IRCMessage): Line[] => {
    const { command, params } = message
    if (command === 'BATCH') {
      return [
        reject(client, 'MULTILINE_INVALID', 'Invalid multiline batch: a batch can not be nested'),
      ]
    }
    if (command !== 'PRIVMSG' && command !== 'NOTICE') {
      return [reject(client, 'MULTILINE_INVALID', `Invalid multiline batch with ${echo(command)}`)]
    }
    if (batch.command && batch.command !== command) {
      return [
        reject(client, 'MULTILINE_INVALID', 'Invalid multiline batch with PRIVMSG and NOTICE'),
      ]
    }
    const [target = '', text = ''] = params
    if (server.fold(target) !== server.fold(batch.target)) {
      return [
        reject(
          client,
          'MULTILINE_INVALID_TARGET',
          echo(batch.target),
          echo(target),
          'Invalid multiline target'
        ),
      ]
    }
    const concat = message.tags?.[CONCAT] !== undefined
    if (concat && !text) {
      return [
        reject(client, 'MULTILINE_INVALID', 'Invalid multiline batch with concatenated blank line'),
      ]
    }
    if (batch.lines.length >= maxLines) {
      return [
        reject(
          client,
          'MULTILINE_MAX_LINES',
          String(maxLines),
          'Multiline batch max-lines exceeded'
        ),
      ]
    }
    // Each line feed that joins two lines counts as one byte.
    const bytes = batch.bytes + (batch.lines.length && !concat ? 1 : 0) + byteLength(text)
    if (bytes > maxBytes) {
      return [
        reject(
          client,
          'MULTILINE_MAX_BYTES',
          String(maxBytes),
          'Multiline batch max-bytes exceeded'
        ),
      ]
    }
    batch.command = command
    batch.bytes = bytes
    batch.lines.push({ text, concat })
    return []
  }

  app.on('TCP', '/BATCH/*', (c) => {
    const { client, message } = c.var
    const [reference, type, target] = message.params
    if (!reference) {
      return c.render([ERR_NEEDMOREPARAMS, 'BATCH', 'Not enough parameters'])
    }
    const ref = reference.slice(1)
    if (!'+-'.includes(reference[0]) || !REF_PATTERN.test(ref)) {
      return c.render(fail('BATCH', 'INVALID_REFTAG', echo(ref), 'Invalid reference tag'))
    }
    if (reference[0] === '+') {
      if (client.inbound) {
        // One batch at a time. The open one goes on, and the lines of this one are ignored.
        return c.render(
          fail('BATCH', 'MULTILINE_INVALID', 'Invalid multiline batch: another batch is open')
        )
      }
      // The type is known only to a client that has negotiated it, and `batch`, which it needs.
      const known = client.capabilities.has(TYPE) && client.capabilities.has('batch')
      if (type !== TYPE || !known) {
        return c.render(
          fail(
            'BATCH',
            'UNKNOWN_TYPE',
            ref,
            echo(type ?? '*'),
            'Unknown or unnegotiated batch type'
          )
        )
      }
      if (!target) {
        return c.render(fail('BATCH', 'MULTILINE_INVALID', 'Invalid multiline batch: no target'))
      }
      // All the client-only tags of the message are on this line.
      const tags = clientTags(message.tags)
      if (!tags) {
        return c.render([ERR_INPUTTOOLONG, 'Input line was too long'])
      }
      client.inbound = { ref, target, lines: [], bytes: 0, tags, opened: Date.now() }
      return c.render()
    }

    const batch = client.inbound
    if (batch?.ref !== ref) {
      // The end of a batch that is not open, or that has failed, which has already been told.
      return c.render()
    }
    client.inbound = undefined
    if (!batch.command || batch.lines.every(({ text }) => !text)) {
      return c.render(
        fail(
          'BATCH',
          'MULTILINE_INVALID',
          batch.command
            ? 'Invalid multiline batch with blank lines only'
            : 'Invalid multiline batch'
        )
      )
    }
    return c.render(...send(client, batch, batch.command))
  })

  // Deliver a batch, with the checks of PRIVMSG done once for the whole message, as one message:
  // one msgid, and one row of the history.
  const send = (client: Client, batch: InboundBatch, command: 'PRIVMSG' | 'NOTICE') => {
    const { targets, excess } = server.targets(batch.target, MAX_TARGETS[command])
    client.idle = Date.now()
    const lines: Line[] = []
    for (const targetName of targets) {
      lines.push(
        ...deliver(server, client, targetName, { command, lines: batch.lines, tags: batch.tags })
      )
    }
    lines.push(...tooMany(excess))
    // An automatic reply must not be sent in response to a NOTICE.
    return command === 'NOTICE' ? [] : lines
  }

  return app
}
