import { Hono } from 'tcp-hono'
import { addressKey, hashPassword } from '../accounts.ts'
import type { Credential } from '../accounts.ts'
import { ERR_NEEDMOREPARAMS } from '../numerics.ts'
import { byteLength } from '../protocol.ts'
import { echo, fail, isNickname } from '../state.ts'
import type { Client, Env, Line, Server } from '../state.ts'

const CAPABILITY = 'draft/account-registration'

/** What the prepare step of REGISTER returns when the address has no tokens left. */
const THROTTLED = Symbol('throttled')

/** The hash of the password of a REGISTER, made by its prepare step. */
type Prepared = { name: string; credential: Credential }

/**
 * Account registration: `REGISTER` and `VERIFY`,
 * https://ircv3.net/specs/extensions/account-registration (a work in progress, hence `draft/`).
 *
 * - `before-connect`: REGISTER works before the registration of the connection, once the client
 *   has a nickname, so `COMPLETE_CONNECTION_REQUIRED` is never sent. The server has no password of
 *   its own (`PASS`) that this could get around.
 * - The account is named after the current nickname (no `custom-account-name`), with the rules and
 *   the casemapping of the nicknames. A client that registers is logged in to the account, as with
 *   SASL.
 * - No email: the email parameter is ignored and not stored. So there is no verification, and
 *   VERIFY only says that there is nothing to verify.
 * - The password is from `min-password-length` to `max-password-length` bytes, and not the name
 *   of the account. It is stored only as a hash (see `src/accounts.ts`).
 * - The limits: `maxAccounts` on the server, `maxPerAddress` within `registrationWindow` for an
 *   address, and the derivations of an address, which are throttled. They get
 *   `TEMPORARILY_UNAVAILABLE`, as does REGISTER when registration is closed.
 */
export const account = (server: Server) => {
  const app = new Hono<Env>()
  const accounts = server.accounts
  server.beforeRegistration.add('REGISTER').add('VERIFY')
  if (accounts?.registration === 'open') {
    server.capabilities.set(
      CAPABILITY,
      [
        'before-connect',
        `min-password-length=${accounts.minPasswordLength}`,
        `max-password-length=${accounts.maxPasswordLength}`,
      ].join(',')
    )
  }

  /**
   * Check a REGISTER as the state is now: the name and the password, or the reply that refuses it.
   * The prepare step checks it before it derives a key, and the handler again after.
   */
  const check = (client: Client, params: string[]): { name: string } | { error: Line } => {
    const [requested, , password] = params
    const refuse = (code: string, name: string, text: string) => ({
      error: fail('REGISTER', code, name, text),
    })
    if (!accounts || accounts.registration === 'closed') {
      return refuse('TEMPORARILY_UNAVAILABLE', echo(requested), 'Account registration is disabled')
    }
    if (client.account !== undefined) {
      return refuse('ALREADY_AUTHENTICATED', client.account, 'You are already logged in')
    }
    if (client.nick === '*') {
      return refuse('NEED_NICK', '*', 'You must choose a nickname first')
    }
    if (requested !== '*' && !isNickname(requested)) {
      return refuse('BAD_ACCOUNT_NAME', echo(requested), 'An account name must be a valid nickname')
    }
    if (requested !== '*' && server.fold(requested) !== server.fold(client.nick)) {
      return refuse(
        'ACCOUNT_NAME_MUST_BE_NICK',
        requested,
        'The account name must be your current nickname'
      )
    }
    // The name of the account is the nickname, as the client has it.
    const name = client.nick
    if (accounts.get(name)) {
      return refuse('ACCOUNT_EXISTS', name, 'Account already exists')
    }
    const length = byteLength(password)
    if (length < accounts.minPasswordLength || server.fold(password) === server.fold(name)) {
      return refuse(
        'WEAK_PASSWORD',
        name,
        `The password must have at least ${accounts.minPasswordLength} bytes and not be the account name`
      )
    }
    // A NUL would cut the password in SASL PLAIN, so it could never be used.
    if (length > accounts.maxPasswordLength || password.includes('\0')) {
      return refuse(
        'UNACCEPTABLE_PASSWORD',
        name,
        `The password must have at most ${accounts.maxPasswordLength} bytes and no NUL`
      )
    }
    if (
      accounts.count() >= accounts.maxAccounts ||
      accounts.recent(addressKey(client)) >= accounts.maxPerAddress
    ) {
      return refuse(
        'TEMPORARILY_UNAVAILABLE',
        name,
        'Too many accounts have been registered, try again later'
      )
    }
    return { name }
  }

  // The password is hashed only for a REGISTER that would succeed.
  server.prepare.set('REGISTER', async (client, message) => {
    if (message.params.length < 3) {
      return
    }
    const checked = check(client, message.params)
    if ('error' in checked) {
      return
    }
    const release = accounts!.admit(addressKey(client))
    if (!release) {
      return THROTTLED
    }
    try {
      const credential = await hashPassword(message.params[2], accounts!.iterations)
      return { name: checked.name, credential } satisfies Prepared
    } finally {
      release()
    }
  })

  // `REGISTER {<account> | *} {<email> | *} <password>`
  app.on('TCP', '/REGISTER/*', (c) => {
    const { client, message } = c.var
    if (message.params.length < 3) {
      return c.render([ERR_NEEDMOREPARAMS, 'REGISTER', 'Not enough parameters'])
    }
    // The state may have changed during the hash, e.g. the name is registered by another client.
    const checked = check(client, message.params)
    if ('error' in checked) {
      return c.render(checked.error)
    }
    const { name } = checked
    const prepared = c.var.prepared as Prepared | typeof THROTTLED | undefined
    if (prepared === THROTTLED) {
      return c.render(
        fail(
          'REGISTER',
          'TEMPORARILY_UNAVAILABLE',
          name,
          'Too many attempts from your address, try again later'
        )
      )
    }
    // No hash, if the prepare step failed.
    if (prepared?.name !== name) {
      return c.render(
        fail('REGISTER', 'TEMPORARILY_UNAVAILABLE', name, 'Account registration failed, try again')
      )
    }
    const created = server.safely(() =>
      accounts!.create(name, prepared.credential, addressKey(client))
    )
    if (created === undefined) {
      return c.render(
        fail('REGISTER', 'TEMPORARILY_UNAVAILABLE', name, 'Account registration failed, try again')
      )
    }
    if (!created) {
      return c.render(fail('REGISTER', 'ACCOUNT_EXISTS', name, 'Account already exists'))
    }
    c.render(['REGISTER', 'SUCCESS', name, 'Account successfully registered'])
    server.login(client, name)
    return c.render()
  })

  // `VERIFY {<account> | *} <code>`. Nothing is ever pending verification.
  app.on('TCP', '/VERIFY/*', (c) => {
    const { client, message } = c.var
    const [requested, code] = message.params
    if (code === undefined) {
      return c.render([ERR_NEEDMOREPARAMS, 'VERIFY', 'Not enough parameters'])
    }
    const name = echo(requested === '*' ? client.nick : requested)
    if (!accounts) {
      return c.render(
        fail('VERIFY', 'TEMPORARILY_UNAVAILABLE', name, 'Account registration is disabled')
      )
    }
    if (client.account !== undefined) {
      return c.render(
        fail('VERIFY', 'ALREADY_AUTHENTICATED', client.account, 'You are already logged in')
      )
    }
    return c.render(fail('VERIFY', 'INVALID_CODE', name, 'No verification is pending'))
  })

  return app
}
