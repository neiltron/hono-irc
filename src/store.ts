import type { DatabaseSync, StatementSync } from 'node:sqlite'

/**
 * A value that goes in or comes out of the database. The two backends agree on these: a TEXT is a
 * string, an INTEGER or a REAL is a number, and NULL is null. A BLOB is not part of the interface,
 * as one backend gives an `ArrayBuffer` and the other a `Uint8Array`; binary data is stored as
 * text, e.g. base64.
 */
export type SqlValue = string | number | null

/**
 * The persistent state of the server: a small synchronous SQL interface. The SQL is the dialect of
 * SQLite on both backends, a Durable Object and `node:sqlite`, so the tests on Node.js run the
 * queries of production.
 *
 * It is synchronous, so a handler can read and write while the outbox is open.
 */
export type Store = {
  /** Run one statement with `?` parameters, and return its rows. */
  query<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T[]
  /**
   * Run `fn` in a transaction: everything it writes is committed together, or rolled back if it
   * throws. `fn` must be synchronous, as on a Durable Object. Transactions can be nested.
   */
  transaction<T>(fn: () => T): T
}

/** What `sqlStore()` uses of the storage of a SQLite-backed Durable Object. */
type DurableObjectSql = {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } }
  transactionSync<T>(fn: () => T): T
}

/**
 * The SQLite database of a Durable Object, with the synchronous `ctx.storage.sql.exec()` and
 * `ctx.storage.transactionSync()`. `exec()` can not run `BEGIN` or `SAVEPOINT`, so a transaction
 * goes through `transactionSync()`. A cursor is consumed at once, as one must not be held across
 * an `await`. The storage is read only when a query runs, so making the store touches nothing.
 */
export const sqlStore = (storage: DurableObjectSql): Store => ({
  query: <T>(sql: string, ...params: SqlValue[]) =>
    storage.sql.exec(sql, ...params).toArray() as T[],
  transaction: (fn) => storage.transactionSync(fn),
})

const isPromise = (value: unknown) =>
  typeof (value as { then?: unknown } | null | undefined)?.then === 'function'

/**
 * A database of `node:sqlite`. The statements are prepared once, and the SQL of the server is a
 * fixed set of strings, so the cache is bounded. A transaction is a savepoint, which begins one
 * outside a transaction and nests inside one.
 */
export const nodeStore = (db: DatabaseSync): Store => {
  const statements = new Map<string, StatementSync>()
  let depth = 0
  return {
    query: <T>(sql: string, ...params: SqlValue[]) => {
      let statement = statements.get(sql)
      if (!statement) {
        statement = db.prepare(sql)
        statements.set(sql, statement)
      }
      return statement.all(...params) as T[]
    },
    transaction: (fn) => {
      const name = `tx${++depth}`
      db.exec(`SAVEPOINT ${name}`)
      try {
        const result = fn()
        // As on a Durable Object, whose `transactionSync()` does not wait for a promise either.
        if (isPromise(result)) {
          throw new TypeError('A transaction must be synchronous')
        }
        db.exec(`RELEASE ${name}`)
        return result
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`)
        db.exec(`RELEASE ${name}`)
        throw error
      } finally {
        depth--
      }
    },
  }
}

/**
 * An in-memory database where the runtime has `node:sqlite`, such as Node.js in the tests, and
 * `undefined` elsewhere. It is loaded with `process.getBuiltinModule()`, not imported, so the
 * bundle of the Worker does not depend on `node:sqlite`; a Durable Object passes its own database.
 */
export const memoryStore = (): Store | undefined => {
  const sqlite = globalThis.process?.getBuiltinModule?.('node:sqlite') as
    | typeof import('node:sqlite')
    | undefined
  return sqlite && nodeStore(new sqlite.DatabaseSync(':memory:'))
}

/**
 * The schema, as a list of migrations. Migration `n` (from 1) brings the database from version
 * `n - 1` to `n`. A migration is never changed once released: a change is a new one at the end.
 */
export const MIGRATIONS: string[][] = [
  [
    // An account, by its name folded with the casemapping of the nicknames. `name` is the name as
    // it was registered. The password is kept only as a hash, with what made it, so that the
    // parameters can change later: `algorithm` (`pbkdf2-sha256`), `iterations`, and the `salt` and
    // the `hash` in base64.
    `CREATE TABLE accounts (
      folded TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      iterations INTEGER NOT NULL,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      created INTEGER NOT NULL
    )`,
    // The recent registrations from each address, to limit them. `address` is a keyed hash of the
    // address, not the address. The rows older than the window are deleted.
    `CREATE TABLE registrations (
      address TEXT NOT NULL,
      at INTEGER NOT NULL
    )`,
    'CREATE INDEX registrations_by_address ON registrations (address, at)',
  ],
  [
    // A permanent channel (+P), by its folded name. `name` is the name as it was created,
    // `created` is in seconds (RPL_CREATIONTIME), `founder` is the folded name of the account of
    // the founder, and `modes` are the modes of type D. `lists` is the JSON of the lists (+b, +e,
    // +I): `[mode, mask, by, at]` for each entry. `history` is the target of its messages, and
    // `used` the time in milliseconds when it was last joined or left, for the purge of the channels
    // that nobody uses.
    `CREATE TABLE channels (
      folded TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created INTEGER NOT NULL,
      founder TEXT NOT NULL,
      modes TEXT NOT NULL,
      key TEXT,
      max_members INTEGER,
      topic TEXT,
      topic_by TEXT,
      topic_at INTEGER,
      lists TEXT NOT NULL,
      history INTEGER,
      used INTEGER NOT NULL
    )`,
    'CREATE INDEX channels_by_founder ON channels (founder)',
    'CREATE INDEX channels_by_use ON channels (used)',
    // A conversation whose messages are stored: a channel, or the direct messages between two
    // accounts, `low` and `high`, folded and in order. `ending` is NULL for a history that is kept,
    // 0 for the one of an ordinary channel, which goes with the channel, and 1 for one to delete.
    `CREATE TABLE targets (
      id INTEGER PRIMARY KEY,
      low TEXT,
      high TEXT,
      ending INTEGER
    )`,
    'CREATE UNIQUE INDEX targets_by_pair ON targets (low, high) WHERE low IS NOT NULL',
    'CREATE INDEX targets_by_high ON targets (high) WHERE high IS NOT NULL',
    'CREATE INDEX targets_by_ending ON targets (ending) WHERE ending IS NOT NULL',
    // A PRIVMSG or a NOTICE, one row each, multiline or not. `id` is the order of storage, `msgid`
    // sorts by time (see `Server.msgid()`), and `time` is the time of the msgid in milliseconds.
    // `source` is the mask of the sender at the time, `account` its account, `recipient` the target
    // as the recipients got it, `text` the text of a single line, or `lines` the JSON of the lines
    // of a multiline message, and `tags` the JSON of the client-only tags.
    `CREATE TABLE history (
      id INTEGER PRIMARY KEY,
      target INTEGER NOT NULL,
      msgid TEXT NOT NULL,
      time INTEGER NOT NULL,
      command TEXT NOT NULL,
      source TEXT NOT NULL,
      account TEXT,
      bot INTEGER NOT NULL,
      recipient TEXT NOT NULL,
      text TEXT,
      lines TEXT,
      tags TEXT
    )`,
    'CREATE UNIQUE INDEX history_by_target ON history (target, msgid)',
    // The last message that an account has read in a target (draft/read-marker): a folded channel
    // name, or the folded name of the other account. `at` is in milliseconds.
    `CREATE TABLE read_markers (
      account TEXT NOT NULL,
      target TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (account, target)
    ) WITHOUT ROWID`,
  ],
]

/**
 * Bring the schema up to date. Each migration that the database does not have yet runs in its own
 * transaction, with the version that it brings, so running this again does nothing, and a
 * migration that fails leaves the database at the version before it.
 *
 * A database whose version is newer than this server knows is refused, rather than used with a
 * schema that the code does not expect.
 */
export const migrate = (store: Store, migrations = MIGRATIONS) => {
  store.query(
    'CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, at INTEGER NOT NULL)'
  )
  const [{ version }] = store.query<{ version: number | null }>(
    'SELECT max(version) AS version FROM migrations'
  )
  const current = version ?? 0
  if (current > migrations.length) {
    throw new Error(
      `The database has schema version ${current}, and this server knows up to ${migrations.length}`
    )
  }
  for (let next = current + 1; next <= migrations.length; next++) {
    store.transaction(() => {
      for (const sql of migrations[next - 1]) {
        store.query(sql)
      }
      store.query('INSERT INTO migrations (version, at) VALUES (?, ?)', next, Date.now())
    })
  }
}
