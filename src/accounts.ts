import type { Store } from './store.ts'

/** The accounts and their registration, as set with `accounts` of `ServerOptions`. */
export type AccountOptions = {
  /**
   * Whether anyone may register an account with `REGISTER`. `closed` turns registration off, and
   * the existing accounts can still log in.
   */
  registration?: 'open' | 'closed'
  /**
   * The iterations of PBKDF2 for a new password. 100,000 by default, the most that Cloudflare
   * Workers allows. A password keeps the iterations that it was hashed with.
   */
  iterations?: number
  /** The min length of a password, in bytes. */
  minPasswordLength?: number
  /** The max length of a password, in bytes. */
  maxPasswordLength?: number
  /** Whether the name of an account is reserved as a nickname for the clients logged in to it. */
  reserveNicknames?: boolean
  /** The max number of accounts on the server. */
  maxAccounts?: number
  /** The max number of accounts registered from one address within `registrationWindow`. */
  maxPerAddress?: number
  /** The milliseconds that `maxPerAddress` counts back. */
  registrationWindow?: number
  /** The failed SASL authentications of a connection before it is disconnected. */
  maxFailures?: number
  /**
   * The keys derived from passwords for one address: `burst` at once, and one more every
   * `interval` milliseconds. A derivation is slow on purpose, so this bounds what one address can
   * make the server compute, however many times it reconnects.
   */
  throttle?: { burst?: number; interval?: number }
}

/** The algorithm of the stored passwords. */
export const ALGORITHM = 'pbkdf2-sha256'
/** The most iterations of PBKDF2 that Cloudflare Workers allows. */
export const MAX_ITERATIONS = 100_000
const SALT_LENGTH = 16
const HASH_BITS = 256

/** A password as it is stored: a hash of it and what made it. The salt and the hash in base64. */
export type Credential = {
  algorithm: string
  iterations: number
  salt: string
  hash: string
}

/** An account as it is stored. */
export type Account = Credential & { folded: string; name: string; created: number }

export const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
export const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

const encoder = new TextEncoder()

/** PBKDF2-HMAC-SHA-256 of the password with WebCrypto, which both runtimes have. */
export const derive = async (
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    HASH_BITS
  )
  return new Uint8Array(bits)
}

/** Hash a new password with a random salt. */
export const hashPassword = async (password: string, iterations: number): Promise<Credential> => {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
  const hash = await derive(password, salt, iterations)
  return { algorithm: ALGORITHM, iterations, salt: toBase64(salt), hash: toBase64(hash) }
}

/**
 * Compare two byte strings in a time that depends only on their length, which is not secret: the
 * hashes are always 32 bytes.
 */
export const equal = (a: Uint8Array, b: Uint8Array) => {
  let difference = a.length ^ b.length
  for (let i = 0; i < a.length; i++) {
    difference |= a[i] ^ (b[i] ?? 0)
  }
  return difference === 0
}

/**
 * A key derived from a password that a client sent, made by the slow step of a command and checked
 * by its handler against the account as it is then. The parameters are kept, so a hash made with
 * other ones does not match.
 */
export type Attempt = { folded: string; salt: string; iterations: number; hash: Uint8Array }

/** Derive the key of a password with the parameters of the stored account, to check it. */
export const attempt = async (account: Account, password: string): Promise<Attempt> => ({
  folded: account.folded,
  salt: account.salt,
  iterations: account.iterations,
  hash: await derive(password, fromBase64(account.salt), account.iterations),
})

/** Whether the key matches the account as it is now. */
export const verify = (account: Account, attempt: Attempt) =>
  account.algorithm === ALGORITHM &&
  attempt.folded === account.folded &&
  attempt.salt === account.salt &&
  attempt.iterations === account.iterations &&
  equal(attempt.hash, fromBase64(account.hash))

/**
 * Token buckets by key, for the derivations of each address. The buckets that are full again are
 * forgotten, so the map holds only the keys that were busy recently, and at most `maxKeys`: past
 * that, a new key is refused until some are forgotten.
 */
export class Throttle {
  #buckets = new Map<string, { tokens: number; at: number }>()
  burst: number
  interval: number
  maxKeys: number

  constructor(burst: number, interval: number, maxKeys = 10_000) {
    this.burst = burst
    this.interval = interval
    this.maxKeys = maxKeys
  }

  /** Take a token for the key, if it has one. */
  take(key: string, now = Date.now()): boolean {
    let bucket = this.#buckets.get(key)
    if (!bucket) {
      if (this.#buckets.size >= this.maxKeys) {
        this.#prune(now)
      }
      if (this.#buckets.size >= this.maxKeys) {
        return false
      }
      bucket = { tokens: this.burst, at: now }
      this.#buckets.set(key, bucket)
    }
    bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.at) / this.interval)
    bucket.at = now
    if (bucket.tokens < 1) {
      return false
    }
    bucket.tokens -= 1
    return true
  }

  #prune(now: number) {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.tokens + (now - bucket.at) / this.interval >= this.burst) {
        this.#buckets.delete(key)
      }
    }
  }

  get size() {
    return this.#buckets.size
  }
}

/**
 * The key of the address of a client for the limits, from its cloak, which is a keyed hash of the
 * address: the whole address for IPv4, and its /64 for IPv6, as one host often has a whole /64. The
 * clients whose address is unknown share one key.
 */
export const addressKey = (client: { ip?: string; host: string }) => {
  if (client.ip === undefined) {
    return 'unknown'
  }
  return client.host.endsWith('.ip6')
    ? client.host.slice(client.host.indexOf('.') + 1)
    : client.host
}

/**
 * The accounts in the store. Every method is synchronous, so a handler can use it while its outbox
 * is open. The names are folded by the casemapping of the server, as nicknames.
 */
export class Accounts {
  store: Store
  fold: (name: string) => string
  registration: 'open' | 'closed'
  iterations: number
  minPasswordLength: number
  maxPasswordLength: number
  reserveNicknames: boolean
  maxAccounts: number
  maxPerAddress: number
  registrationWindow: number
  maxFailures: number
  throttle: Throttle

  constructor(store: Store, fold: (name: string) => string, options: AccountOptions = {}) {
    this.store = store
    this.fold = fold
    this.registration = options.registration ?? 'open'
    this.iterations = options.iterations ?? MAX_ITERATIONS
    this.minPasswordLength = options.minPasswordLength ?? 8
    // 300 bytes, which the spec of account-registration suggests, so that a password also fits in
    // a message to a service.
    this.maxPasswordLength = options.maxPasswordLength ?? 300
    this.reserveNicknames = options.reserveNicknames ?? true
    this.maxAccounts = options.maxAccounts ?? 100_000
    this.maxPerAddress = options.maxPerAddress ?? 5
    this.registrationWindow = options.registrationWindow ?? 3_600_000
    this.maxFailures = options.maxFailures ?? 3
    this.throttle = new Throttle(options.throttle?.burst ?? 10, options.throttle?.interval ?? 6000)
  }

  /** The account of a name, if it is registered. */
  get(name: string): Account | undefined {
    return this.store.query<Account>(
      'SELECT folded, name, algorithm, iterations, salt, hash, created FROM accounts WHERE folded = ?',
      this.fold(name)
    )[0]
  }

  count(): number {
    return this.store.query<{ count: number }>('SELECT count(*) AS count FROM accounts')[0].count
  }

  /** The accounts registered from the address within the window. */
  recent(address: string, now = Date.now()): number {
    return this.store.query<{ count: number }>(
      'SELECT count(*) AS count FROM registrations WHERE address = ? AND at > ?',
      address,
      now - this.registrationWindow
    )[0].count
  }

  /**
   * Register an account, unless the name is taken, and count it for the address. One transaction,
   * which also forgets the registrations older than the window. Returns whether it was created.
   */
  create(name: string, credential: Credential, address: string, now = Date.now()): boolean {
    return this.store.transaction(() => {
      const created = this.store.query(
        `INSERT INTO accounts (folded, name, algorithm, iterations, salt, hash, created)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (folded) DO NOTHING RETURNING folded`,
        this.fold(name),
        name,
        credential.algorithm,
        credential.iterations,
        credential.salt,
        credential.hash,
        now
      )
      if (!created.length) {
        return false
      }
      this.store.query('DELETE FROM registrations WHERE at <= ?', now - this.registrationWindow)
      this.store.query('INSERT INTO registrations (address, at) VALUES (?, ?)', address, now)
      return true
    })
  }
}
