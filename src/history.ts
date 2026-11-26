import type { Chat } from './state.ts'
import type { Store } from './store.ts'

/** The history of the messages, as set with `history` of `ServerOptions`. */
export type HistoryOptions = {
  /** The newest messages kept for each target, a channel or a pair of accounts. */
  maxMessages?: number
  /** The milliseconds that a message is kept. */
  maxAge?: number
  /** The messages kept on the server, all targets together. */
  maxRows?: number
  /** The max number of messages of one `CHATHISTORY` request, the `CHATHISTORY` token. */
  limit?: number
}

/** The max number of targets that an account has read markers for. */
export const MAX_MARKERS = 1000

const DAY = 86_400_000

/** The characters of the msgids, Crockford's base32, which are in the order of ASCII. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * The first 10 characters of the msgids of a time in milliseconds (see `Server.msgid()`). A msgid
 * is after this string if and only if its time is at least `ms`, so a time is a bound of the index
 * of the msgids.
 */
export const encodeTime = (ms: number) => {
  let id = ''
  for (let time = ms, i = 0; i < 10; i++, time = Math.floor(time / 32)) {
    id = CROCKFORD[time % 32] + id
  }
  return id
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

/**
 * The time in milliseconds of a timestamp of server-time, `YYYY-MM-DDThh:mm:ss.sssZ`, as the
 * references of CHATHISTORY and MARKREAD have it, or `undefined`. The fraction of a second may have
 * other lengths, and is cut to milliseconds.
 */
export const parseTimestamp = (value: string): number | undefined => {
  const time = Date.parse(value)
  return TIMESTAMP.test(value) && Number.isFinite(time) ? time : undefined
}

// The bounds of `page()` that let everything through: every msgid is between them.
export const FIRST = ''
export const LAST = '~'

/** The rows that one call of `add()` may delete beyond the one it adds, for each rule. */
const PRUNE = 2
/** The rows that one `sweep()` may delete. */
const SWEEP = 1000
/** The targets that have ended that one `sweep()` may look at. */
const SWEEP_TARGETS = 100

type Row = {
  id: number
  target: number
  msgid: string
  time: number
  command: string
  source: string
  account: string | null
  bot: number
  recipient: string
  text: string | null
  lines: string | null
  tags: string | null
}

const COLUMNS = 'msgid, time, command, source, account, bot, recipient, text, lines, tags'

const toChat = (row: Row): Chat => ({
  msgid: row.msgid,
  time: row.time,
  command: row.command as Chat['command'],
  source: row.source,
  ...(row.account !== null && { account: row.account }),
  bot: !!row.bot,
  target: row.recipient,
  ...(row.text !== null && { text: row.text }),
  ...(row.lines !== null && { lines: JSON.parse(row.lines) as Chat['lines'] }),
  tags: row.tags === null ? {} : (JSON.parse(row.tags) as Record<string, string>),
})

/**
 * The stored messages (draft/chathistory) and read markers (draft/read-marker). Every method is
 * synchronous, so a handler can use it while its outbox is open.
 *
 * A target is a conversation: the history of a channel, or the direct messages between two
 * accounts. A message is one row, with its msgid, which sorts by time, so every query is a range
 * of the index `(target, msgid)`. The retention is enforced a little at a time: each message
 * deletes at most a few old rows of its target and of the whole server, and `sweep()`, from
 * `tick()`, a bounded number of the rows that no message touches any more.
 */
export class History {
  store: Store
  maxMessages: number
  maxAge: number
  maxRows: number
  limit: number
  /**
   * The number of messages of each target that has been written to since the start, counted once
   * from the index and then kept up to date, so that a message does not count its target again.
   */
  #counts = new Map<number, number>()

  constructor(store: Store, options: HistoryOptions = {}) {
    this.store = store
    this.maxMessages = options.maxMessages ?? 10_000
    this.maxAge = options.maxAge ?? 90 * DAY
    this.maxRows = options.maxRows ?? 2_000_000
    this.limit = options.limit ?? 100
    // The ordinary channels have not survived the restart, so their histories go.
    store.query('UPDATE targets SET ending = 1 WHERE ending = 0')
  }

  /** A new target for the history of a channel, which is kept if the channel is permanent. */
  createTarget(permanent: boolean): number {
    return this.store.query<{ id: number }>(
      'INSERT INTO targets (ending) VALUES (?) RETURNING id',
      permanent ? null : 0
    )[0].id
  }

  /** Keep the history of a channel (`null`), let it go with the channel (0), or delete it (1). */
  setEnding(target: number, ending: null | 0 | 1) {
    this.store.query('UPDATE targets SET ending = ? WHERE id = ?', ending, target)
    if (ending === 1) {
      this.#counts.delete(target)
    }
  }

  /** The target of the direct messages between two accounts, folded, made if `create`. */
  direct(a: string, b: string, create = false): number | undefined {
    const [low, high] = a < b ? [a, b] : [b, a]
    const found = this.store.query<{ id: number }>(
      'SELECT id FROM targets WHERE low = ? AND high = ?',
      low,
      high
    )[0]
    if (found || !create) {
      return found?.id
    }
    return this.store.query<{ id: number }>(
      'INSERT INTO targets (low, high) VALUES (?, ?) RETURNING id',
      low,
      high
    )[0].id
  }

  /** The accounts that an account has direct messages with, and their targets. */
  correspondents(account: string): { target: number; peer: string }[] {
    return [
      ...this.store.query<{ id: number; peer: string }>(
        'SELECT id, high AS peer FROM targets WHERE low = ?',
        account
      ),
      ...this.store.query<{ id: number; peer: string }>(
        'SELECT id, low AS peer FROM targets WHERE high = ? AND low != high',
        account
      ),
    ].map(({ id, peer }) => ({ target: id, peer }))
  }

  #count(target: number): number {
    let count = this.#counts.get(target)
    if (count === undefined) {
      count = this.store.query<{ n: number }>(
        'SELECT count(*) AS n FROM history WHERE target = ?',
        target
      )[0].n
      this.#counts.set(target, count)
    }
    return count
  }

  /** Forget the rows that were deleted, for the counts. */
  #deleted(rows: { target: number }[]) {
    for (const { target } of rows) {
      const count = this.#counts.get(target)
      if (count !== undefined) {
        this.#counts.set(target, count - 1)
      }
    }
  }

  /**
   * Store a message, in one transaction with the retention of its target and of the server: the
   * oldest rows over `maxMessages`, a few of those older than `maxAge`, and a few over `maxRows`.
   */
  add(target: number, chat: Chat, now = Date.now()) {
    this.store.transaction(() => {
      const count = this.#count(target)
      const [{ id }] = this.store.query<{ id: number }>(
        `INSERT INTO history (target, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        target,
        chat.msgid,
        chat.time,
        chat.command,
        chat.source,
        chat.account ?? null,
        chat.bot ? 1 : 0,
        chat.target,
        chat.text ?? null,
        chat.lines ? JSON.stringify(chat.lines) : null,
        Object.keys(chat.tags).length ? JSON.stringify(chat.tags) : null
      )
      this.#counts.set(target, count + 1)
      // The oldest of the target over the limit, and a few of those that are too old. A target
      // can be far over the limit after it is lowered: it gets back under it a few rows at a time.
      const excess = Math.min(count + 1 - this.maxMessages, PRUNE + 1)
      if (excess > 0) {
        this.#deleted(
          this.store.query<{ target: number }>(
            `DELETE FROM history WHERE id IN (
               SELECT id FROM history WHERE target = ? ORDER BY msgid LIMIT ?
             ) RETURNING target`,
            target,
            excess
          )
        )
      }
      this.#deleted(
        this.store.query<{ target: number }>(
          `DELETE FROM history WHERE id IN (
             SELECT id FROM history WHERE target = ? AND msgid < ? ORDER BY msgid LIMIT ?
           ) RETURNING target`,
          target,
          // The time of a message is the one of its msgid, so this is a range of the index.
          encodeTime(now - this.maxAge),
          PRUNE
        )
      )
      // The server keeps the last `maxRows` rows it stored, at most.
      if (id > this.maxRows) {
        this.#deleted(
          this.store.query<{ target: number }>(
            `DELETE FROM history WHERE id IN (
             SELECT id FROM history WHERE id <= ? ORDER BY id LIMIT ?
           ) RETURNING target`,
            id - this.maxRows,
            PRUNE
          )
        )
      }
    })
  }

  /**
   * The messages of a target whose msgid is from `low` (included) to `high` (excluded), in the
   * order of the msgids, from the first (`ASC`) or the last (`DESC`), at most `limit`. They are
   * returned in the order of the query.
   */
  page(target: number, order: 'ASC' | 'DESC', low: string, high: string, limit: number): Chat[] {
    const sql =
      order === 'ASC'
        ? `SELECT ${COLUMNS} FROM history WHERE target = ? AND msgid >= ? AND msgid < ?
           ORDER BY msgid ASC LIMIT ?`
        : `SELECT ${COLUMNS} FROM history WHERE target = ? AND msgid >= ? AND msgid < ?
           ORDER BY msgid DESC LIMIT ?`
    return this.store.query<Row>(sql, target, low, high, limit).map(toChat)
  }

  /** The time of the last message of a target from `low` (a msgid, included), if any. */
  latest(target: number, low = FIRST): number | undefined {
    return this.store.query<{ time: number }>(
      `SELECT time FROM history WHERE target = ? AND msgid >= ? ORDER BY msgid DESC LIMIT 1`,
      target,
      low
    )[0]?.time
  }

  /**
   * Delete a bounded number of rows that no message deletes: the histories of the channels that
   * have ended, and the oldest rows of the server if they are too old. Returns how many it deleted.
   */
  sweep(now = Date.now(), budget = SWEEP): number {
    let deleted = 0
    // The targets that have ended, a few at a time, as many may have no rows left.
    for (let i = 0; i < SWEEP_TARGETS && deleted < budget; i++) {
      const doomed = this.store.query<{ id: number }>(
        'SELECT id FROM targets WHERE ending = 1 LIMIT 1'
      )[0]
      if (!doomed) {
        break
      }
      const rows = this.store.query(
        `DELETE FROM history WHERE id IN (SELECT id FROM history WHERE target = ? LIMIT ?)
         RETURNING id`,
        doomed.id,
        budget - deleted
      ).length
      deleted += rows
      if (deleted < budget) {
        this.store.query('DELETE FROM targets WHERE id = ?', doomed.id)
      }
    }
    if (deleted < budget) {
      // The rows are in the order of storage, which is the order of time but for a clock that went
      // back, so the oldest are among the first.
      const rows = this.store.query<{ target: number }>(
        `DELETE FROM history WHERE id IN (
           SELECT id FROM (SELECT id, time FROM history ORDER BY id LIMIT ?) WHERE time < ?
         ) RETURNING target`,
        budget - deleted,
        now - this.maxAge
      )
      this.#deleted(rows)
      deleted += rows.length
      // The pairs of accounts that have no message left.
      for (const target of new Set(rows.map((row) => row.target))) {
        if (!this.store.query('SELECT 1 FROM history WHERE target = ? LIMIT 1', target).length) {
          this.store.query('DELETE FROM targets WHERE id = ? AND low IS NOT NULL', target)
        }
      }
    }
    return deleted
  }

  /** The read marker of an account (folded) for a target (folded), in milliseconds. */
  marker(account: string, target: string): number | undefined {
    return this.store.query<{ at: number }>(
      'SELECT at FROM read_markers WHERE account = ? AND target = ?',
      account,
      target
    )[0]?.at
  }

  /**
   * Move the read marker forward, never back. Returns the marker after it and whether it moved, or
   * `undefined` if the account has markers for too many targets already.
   */
  mark(account: string, target: string, at: number): { at: number; moved: boolean } | undefined {
    return this.store.transaction(() => {
      const current = this.marker(account, target)
      if (current !== undefined && current >= at) {
        return { at: current, moved: false }
      }
      if (current === undefined) {
        const [{ n }] = this.store.query<{ n: number }>(
          'SELECT count(*) AS n FROM read_markers WHERE account = ?',
          account
        )
        if (n >= MAX_MARKERS) {
          return undefined
        }
      }
      this.store.query(
        `INSERT INTO read_markers (account, target, at) VALUES (?, ?, ?)
         ON CONFLICT (account, target) DO UPDATE SET at = excluded.at`,
        account,
        target,
        at
      )
      return { at, moved: true }
    })
  }
}
