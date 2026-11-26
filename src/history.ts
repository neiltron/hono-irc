import { byteLength, formatTagData, parseTags } from './protocol.ts'
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
  /**
   * The bytes of the messages kept for each target, and on the server, as `rowSize()` counts them:
   * the newest messages that fit are kept.
   */
  maxTargetBytes?: number
  maxBytes?: number
  /**
   * The max length in bytes of the client-only tags of a stored message, as on a line. The tags of
   * a message are relayed whole, and stored only if they fit: the stored copy has none otherwise.
   */
  maxStoredTags?: number
  /** The max number of targets that an account has read markers for. */
  maxMarkers?: number
  /** The max number of messages of one `CHATHISTORY` request, the `CHATHISTORY` token. */
  limit?: number
}

/** The max number of targets that an account has read markers for, by default. */
export const MAX_MARKERS = 200

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
/**
 * The oldest rows that one message may delete to get its target, or the server, back under its
 * budget of bytes. A row has at most about 30 KB, and at least `ROW_OVERHEAD` bytes, so this frees
 * the size of any one message.
 */
const PRUNE_ROWS = 512

/**
 * What a row takes beyond the bytes of its text columns, about: its integers, and the headers of
 * the record and of its entries in the two indexes, whose msgids are counted with the columns.
 * Migration 3 counts the rows that were stored before it with the same formula, in SQL.
 */
export const ROW_OVERHEAD = 64

/**
 * The size of a row as the budgets count it: the bytes of its text columns, the msgid twice more,
 * for the indexes `(target, msgid)` and `(target, msgid, size)`, and `ROW_OVERHEAD`. It is stored
 * with the row.
 */
export const rowSize = (columns: {
  msgid: string
  command: string
  source: string
  account: string | null
  recipient: string
  text: string | null
  lines: string | null
  tags: string | null
}) =>
  ROW_OVERHEAD +
  3 * byteLength(columns.msgid) +
  byteLength(columns.command) +
  byteLength(columns.source) +
  byteLength(columns.account ?? '') +
  byteLength(columns.recipient) +
  byteLength(columns.text ?? '') +
  byteLength(columns.lines ?? '') +
  byteLength(columns.tags ?? '')

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

// The client-only tags are stored as on a line (`+a=1;+b`), and were stored as JSON before
// migration 3, which a key, starting with `+`, tells apart.
const readTags = (tags: string | null): Record<string, string> =>
  tags === null
    ? {}
    : tags[0] === '{'
      ? (JSON.parse(tags) as Record<string, string>)
      : parseTags(tags)

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
  tags: readTags(row.tags),
})

/** What a deletion returns, to keep the counts and the bytes. */
type Deleted = { target: number; size: number }

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
  maxTargetBytes: number
  maxBytes: number
  maxStoredTags: number
  maxMarkers: number
  /**
   * The number of messages and their bytes, of each target that has been written to since the
   * start, counted once from the index and then kept up to date, so that a message does not count
   * its target again.
   */
  #counts = new Map<number, { count: number; bytes: number }>()
  /** The bytes of all the messages, counted once when a message is first stored. */
  #total?: number

  constructor(store: Store, options: HistoryOptions = {}) {
    this.store = store
    this.maxMessages = options.maxMessages ?? 10_000
    this.maxAge = options.maxAge ?? 90 * DAY
    this.maxRows = options.maxRows ?? 2_000_000
    this.limit = options.limit ?? 100
    this.maxTargetBytes = options.maxTargetBytes ?? 16 * 1024 * 1024
    this.maxBytes = options.maxBytes ?? 1024 * 1024 * 1024
    this.maxStoredTags = options.maxStoredTags ?? 1024
    this.maxMarkers = options.maxMarkers ?? MAX_MARKERS
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

  #count(target: number): { count: number; bytes: number } {
    let counted = this.#counts.get(target)
    if (counted === undefined) {
      const [{ n, bytes }] = this.store.query<{ n: number; bytes: number }>(
        'SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM history WHERE target = ?',
        target
      )
      counted = { count: n, bytes }
      this.#counts.set(target, counted)
    }
    return counted
  }

  #totalBytes(): number {
    this.#total ??= this.store.query<{ bytes: number }>(
      'SELECT coalesce(sum(size), 0) AS bytes FROM history'
    )[0].bytes
    return this.#total
  }

  /** Forget the rows that were deleted, for the counts and the bytes. */
  #deleted(rows: Deleted[]) {
    for (const { target, size } of rows) {
      const counted = this.#counts.get(target)
      if (counted !== undefined) {
        counted.count--
        counted.bytes -= size
      }
      if (this.#total !== undefined) {
        this.#total -= size
      }
    }
  }

  /**
   * Delete the oldest rows of a target until `bytes` are freed: the shortest run of them that does,
   * of at most `PRUNE_ROWS`, found with the sizes in the index `history_sizes`, so that only the
   * rows that are deleted are read.
   */
  #freeTarget(target: number, bytes: number) {
    this.#deleted(
      this.store.query<Deleted>(
        `DELETE FROM history WHERE id IN (
           SELECT id FROM (
             SELECT id, sum(size) OVER (ORDER BY msgid ROWS UNBOUNDED PRECEDING) - size AS earlier
             FROM (
               SELECT id, msgid, size FROM history WHERE target = ? ORDER BY msgid LIMIT ${PRUNE_ROWS}
             )
           ) WHERE earlier < ?
         ) RETURNING target, size`,
        target,
        bytes
      )
    )
  }

  /**
   * Delete the oldest rows of the server, but `keep`, until `bytes` are freed, and at most
   * `PRUNE_ROWS`: one row, then twice as many each time, as no index has the sizes in the order of
   * storage. So a few statements free a large message, and at most about twice the rows that it
   * takes are deleted.
   */
  #freeServer(bytes: number, keep: number) {
    let freed = 0
    let deleted = 0
    for (let limit = 1; freed < bytes && deleted < PRUNE_ROWS; limit *= 2) {
      const count = Math.min(limit, PRUNE_ROWS - deleted)
      const rows = this.store.query<Deleted>(
        `DELETE FROM history WHERE id IN (
           SELECT id FROM history WHERE id != ? ORDER BY id LIMIT ?
         ) RETURNING target, size`,
        keep,
        count
      )
      this.#deleted(rows)
      for (const { size } of rows) {
        freed += size
      }
      deleted += rows.length
      if (rows.length < count) {
        break
      }
    }
  }

  /**
   * Store a message, in one transaction with the retention of its target and of the server: the
   * oldest rows over `maxMessages`, a few of those older than `maxAge`, and a few over `maxRows`.
   */
  add(target: number, chat: Chat, now = Date.now()) {
    const data = formatTagData(chat.tags)
    const columns = {
      msgid: chat.msgid,
      command: chat.command,
      source: chat.source,
      account: chat.account ?? null,
      recipient: chat.target,
      text: chat.text ?? null,
      lines: chat.lines ? JSON.stringify(chat.lines) : null,
      // The tags that do not fit are relayed, but not stored.
      tags: data && byteLength(data) <= this.maxStoredTags ? data : null,
    }
    const size = rowSize(columns)
    try {
      this.#add(target, chat, columns, size, now)
    } catch (error) {
      // What was counted of a write that was rolled back is counted again.
      this.#counts.delete(target)
      this.#total = undefined
      throw error
    }
  }

  #add(
    target: number,
    chat: Chat,
    columns: Parameters<typeof rowSize>[0],
    size: number,
    now: number
  ) {
    this.store.transaction(() => {
      const counted = this.#count(target)
      const count = counted.count
      this.#totalBytes()
      const [{ id }] = this.store.query<{ id: number }>(
        `INSERT INTO history (target, ${COLUMNS}, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        target,
        columns.msgid,
        chat.time,
        columns.command,
        columns.source,
        columns.account,
        chat.bot ? 1 : 0,
        columns.recipient,
        columns.text,
        columns.lines,
        columns.tags,
        size
      )
      counted.count++
      counted.bytes += size
      this.#total! += size
      // The oldest of the target over the limit, and a few of those that are too old. A target
      // can be far over the limit after it is lowered: it gets back under it a few rows at a time.
      const excess = Math.min(count + 1 - this.maxMessages, PRUNE + 1)
      if (excess > 0) {
        this.#deleted(
          this.store.query<Deleted>(
            `DELETE FROM history WHERE id IN (
               SELECT id FROM history WHERE target = ? ORDER BY msgid LIMIT ?
             ) RETURNING target, size`,
            target,
            excess
          )
        )
      }
      this.#deleted(
        this.store.query<Deleted>(
          `DELETE FROM history WHERE id IN (
             SELECT id FROM history WHERE target = ? AND msgid < ? ORDER BY msgid LIMIT ?
           ) RETURNING target, size`,
          target,
          // The time of a message is the one of its msgid, so this is a range of the index.
          encodeTime(now - this.maxAge),
          PRUNE
        )
      )
      // The server keeps the last `maxRows` rows it stored, at most.
      if (id > this.maxRows) {
        this.#deleted(
          this.store.query<Deleted>(
            `DELETE FROM history WHERE id IN (
             SELECT id FROM history WHERE id <= ? ORDER BY id LIMIT ?
           ) RETURNING target, size`,
            id - this.maxRows,
            PRUNE
          )
        )
      }
      // The budgets of bytes, of the target and of the server: the oldest rows go, as many as it
      // takes to free what is over, up to `PRUNE_ROWS`, so a message frees at least its own size.
      if (counted.bytes > this.maxTargetBytes) {
        this.#freeTarget(target, counted.bytes - this.maxTargetBytes)
      }
      if (this.#total! > this.maxBytes) {
        this.#freeServer(this.#total! - this.maxBytes, id)
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
      const rows = this.store.query<Deleted>(
        `DELETE FROM history WHERE id IN (SELECT id FROM history WHERE target = ? LIMIT ?)
         RETURNING target, size`,
        doomed.id,
        budget - deleted
      )
      this.#deleted(rows)
      deleted += rows.length
      if (deleted < budget) {
        this.store.query('DELETE FROM targets WHERE id = ?', doomed.id)
      }
    }
    if (deleted < budget) {
      // The rows are in the order of storage, which is the order of time but for a clock that went
      // back, so the oldest are among the first.
      const rows = this.store.query<Deleted>(
        `DELETE FROM history WHERE id IN (
           SELECT id FROM (SELECT id, time FROM history ORDER BY id LIMIT ?) WHERE time < ?
         ) RETURNING target, size`,
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
        if (n >= this.maxMarkers) {
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
