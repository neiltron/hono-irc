import { Hono } from 'tcp-hono'
import type { Context } from 'hono'
import { addressKey, attempt, toBase64, verify } from '../accounts.ts'
import type { Accounts, Attempt } from '../accounts.ts'
import {
  ERR_NEEDMOREPARAMS,
  ERR_SASLABORTED,
  ERR_SASLALREADY,
  ERR_SASLFAIL,
  ERR_SASLTOOLONG,
  RPL_SASLMECHS,
  RPL_SASLSUCCESS,
} from '../numerics.ts'
import { MAX_LINE_LENGTH, format } from '../protocol.ts'
import { NICK_LENGTH } from '../state.ts'
import type { Client, Env, Line, SaslSession, Server } from '../state.ts'

/** The length of a chunk of base64 in an AUTHENTICATE line. */
const CHUNK = 400
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const CHUNK_PATTERN = /^[A-Za-z0-9+/=]+$/

/** What a mechanism makes of a whole response of the client. */
export type Outcome =
  /** The client is authenticated as the account, which is the name as it was registered. */
  | { account: string }
  /** A challenge to send, to which the client responds. */
  | { challenge: Uint8Array }
  /** ERR_SASLFAIL, with the text. */
  | { fail: string }

/**
 * A SASL mechanism. A client-first mechanism, such as PLAIN or EXTERNAL, gets an empty challenge
 * first. For each whole response of the client, `prepare()`, if any, does the slow work, such as
 * deriving a key, outside the handler, and `step()` decides synchronously, with the state as it is
 * then. A mechanism with more steps, such as SCRAM-SHA-256, would keep its state in the session.
 */
export type Mechanism = {
  /** The max length of a response in bytes. A longer one gets ERR_SASLTOOLONG. */
  maxResponse: (accounts: Accounts) => number
  prepare?: (server: Server, client: Client, response: Uint8Array) => Promise<unknown>
  step: (server: Server, client: Client, response: Uint8Array, prepared: unknown) => Outcome
}

/** What a prepare step returns when the address has no tokens left for a derivation. */
const THROTTLED = Symbol('throttled')

const FAILED = 'SASL authentication failed'
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

/**
 * The response of PLAIN (RFC 4616): `[authzid] NUL authcid NUL passwd`, in UTF-8. A client can only
 * act as itself, so the authorization identity is empty or the account itself.
 */
const parsePlain = (server: Server, response: Uint8Array) => {
  let text: string
  try {
    text = utf8.decode(response)
  } catch {
    return
  }
  const parts = text.split('\0')
  if (parts.length !== 3) {
    return
  }
  const [authzid, authcid, password] = parts
  if (!authcid || !password || (authzid && server.fold(authzid) !== server.fold(authcid))) {
    return
  }
  const account = server.accounts?.get(authcid)
  return account && { account, password }
}

/** PLAIN: the name of the account and its password. */
const plain: Mechanism = {
  maxResponse: (accounts) => 2 * NICK_LENGTH + 2 + accounts.maxPasswordLength,
  // A key is derived only for an account that exists, from a response that is well-formed. The
  // accounts are no secret: their names are reserved as nicknames, and REGISTER tells them too.
  prepare: async (server, client, response) => {
    const credentials = parsePlain(server, response)
    if (!credentials) {
      return
    }
    const release = server.accounts!.admit(addressKey(client))
    if (!release) {
      return THROTTLED
    }
    try {
      return await attempt(credentials.account, credentials.password)
    } finally {
      release()
    }
  },
  step: (server, _client, response, prepared) => {
    // The account is read again: it may have changed during the derivation.
    const credentials = parsePlain(server, response)
    if (!credentials) {
      return { fail: FAILED }
    }
    if (prepared === THROTTLED) {
      return { fail: `${FAILED}: too many attempts from your address, try again later` }
    }
    if (!prepared) {
      return { fail: `${FAILED}: try again later` }
    }
    return verify(credentials.account, prepared as Attempt)
      ? { account: credentials.account.name }
      : { fail: FAILED }
  },
}

/** The mechanisms, by name, in the order of the `sasl` capability. */
export const mechanisms = new Map<string, Mechanism>([['PLAIN', plain]])

/** A message as AUTHENTICATE lines: chunks of 400 bytes of base64, and `+` for an empty one. */
export const chunks = (bytes: Uint8Array): string[] => {
  const data = toBase64(bytes)
  const result: string[] = []
  for (let i = 0; i < data.length; i += CHUNK) {
    result.push(data.slice(i, i + CHUNK))
  }
  // An empty message, or one whose last chunk is exactly 400 bytes, ends with `+`.
  if (data.length % CHUNK === 0) {
    result.push('+')
  }
  return result
}

type Collected = { more: string } | { response: Uint8Array } | { invalid: true } | { tooLong: true }

/**
 * Add a chunk from the client to what it has sent of its response: wait for more after a chunk of
 * 400 bytes, and decode the whole response after a shorter one, or `+`. It changes nothing, so the
 * prepare step and the handler come to the same decision.
 */
const collect = (accounts: Accounts, session: SaslSession, chunk: string): Collected => {
  if (chunk.length > CHUNK) {
    return { tooLong: true }
  }
  if (chunk !== '+' && !CHUNK_PATTERN.test(chunk)) {
    return { invalid: true }
  }
  const data = session.response + (chunk === '+' ? '' : chunk)
  const mechanism = mechanisms.get(session.mechanism)!
  if (data.length > Math.ceil(mechanism.maxResponse(accounts) / 3) * 4) {
    return { tooLong: true }
  }
  if (chunk.length === CHUNK) {
    return { more: data }
  }
  if (!BASE64.test(data)) {
    return { invalid: true }
  }
  return { response: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) }
}

/**
 * SASL: `AUTHENTICATE`, https://ircv3.net/specs/extensions/sasl-3.1 and
 * https://ircv3.net/specs/extensions/sasl-3.2, with the mechanisms of `mechanisms`.
 *
 * - Before and after the registration, with the `sasl` capability. A client that is logged in gets
 *   ERR_SASLALREADY: an account can not be changed on a connection.
 * - A registration that completes during an exchange aborts it (see `Server.register()`).
 * - A connection that fails `maxFailures` times is disconnected. The keys derived for an address
 *   are throttled, and a derivation takes the flood cost of AUTHENTICATE.
 */
export const sasl = (server: Server) => {
  const app = new Hono<Env>()
  const accounts = server.accounts
  server.beforeRegistration.add('AUTHENTICATE')
  // sasl-3.2: not advertised, and so NAKed, when there are no accounts.
  if (accounts) {
    server.capabilities.set('sasl', [...mechanisms.keys()].join(','))
  }

  server.prepare.set('AUTHENTICATE', async (client, message) => {
    const [chunk] = message.params
    const session = client.sasl
    if (!accounts || !session || !chunk || chunk === '*' || client.account) {
      return
    }
    const collected = collect(accounts, session, chunk)
    if ('response' in collected) {
      return mechanisms.get(session.mechanism)!.prepare?.(server, client, collected.response)
    }
  })

  /** End the exchange with an error, which counts as a failure. */
  const failed = (c: Context<Env>, line: Line) => {
    const { client } = c.var
    client.sasl = undefined
    client.saslFailures++
    c.render(line)
    if (client.saslFailures < accounts!.maxFailures) {
      return c.render()
    }
    // sasl-3.2 lets the server disconnect after failures, once it has told why.
    client.quit = 'Too many SASL authentication failures'
    c.header('Connection', 'close')
    return c.text(
      format(
        { command: 'ERROR', params: [`Closing Link: ${client.host} (${client.quit})`] },
        MAX_LINE_LENGTH - 2
      )
    )
  }

  app.on('TCP', '/AUTHENTICATE/*', (c) => {
    const { client, message, prepared } = c.var
    const [chunk] = message.params
    if (!chunk) {
      return c.render([ERR_NEEDMOREPARAMS, 'AUTHENTICATE', 'Not enough parameters'])
    }
    // The client must have the capability, which there is only with accounts.
    if (!accounts || !client.capabilities.has('sasl')) {
      return c.render([ERR_SASLFAIL, FAILED])
    }
    if (client.account !== undefined) {
      return c.render([ERR_SASLALREADY, 'You have already authenticated using SASL'])
    }
    if (chunk === '*') {
      client.sasl = undefined
      return c.render([ERR_SASLABORTED, 'SASL authentication aborted'])
    }

    const session = client.sasl
    if (!session) {
      // The first line names the mechanism. An unknown one leaves the state as it was, and the
      // client may try another.
      const name = chunk.toUpperCase()
      if (!mechanisms.has(name)) {
        return c.render(
          [RPL_SASLMECHS, [...mechanisms.keys()].join(','), 'are available SASL mechanisms'],
          [ERR_SASLFAIL, FAILED]
        )
      }
      client.sasl = { mechanism: name, response: '' }
      return c.render(...chunks(new Uint8Array()).map((data): Line => ['AUTHENTICATE', data]))
    }

    const collected = collect(accounts, session, chunk)
    if ('tooLong' in collected) {
      return failed(c, [ERR_SASLTOOLONG, 'SASL message too long'])
    }
    if ('invalid' in collected) {
      return failed(c, [ERR_SASLFAIL, FAILED])
    }
    if ('more' in collected) {
      session.response = collected.more
      return c.render()
    }
    const outcome = mechanisms
      .get(session.mechanism)!
      .step(server, client, collected.response, prepared)
    if ('fail' in outcome) {
      return failed(c, [ERR_SASLFAIL, outcome.fail])
    }
    if ('challenge' in outcome) {
      session.response = ''
      return c.render(...chunks(outcome.challenge).map((data): Line => ['AUTHENTICATE', data]))
    }
    client.sasl = undefined
    server.login(client, outcome.account, [RPL_SASLSUCCESS, 'SASL authentication successful'])
    return c.render()
  })

  return app
}
