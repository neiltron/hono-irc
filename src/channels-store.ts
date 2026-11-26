import type { Channel, ListMode } from './state.ts'
import type { Store } from './store.ts'

/** The permanent channels (+P), as set with `permanentChannels` of `ServerOptions`. */
export type PermanentOptions = {
  /** The max number of permanent channels that one account has founded. */
  maxPerAccount?: number
  /** The max number of permanent channels on the server. */
  maxChannels?: number
  /** The milliseconds after which a permanent channel that nobody has joined is deleted. */
  expire?: number
}

/** A permanent channel as it is stored. */
export type ChannelRow = {
  folded: string
  name: string
  created: number
  founder: string
  modes: string
  key: string | null
  max_members: number | null
  topic: string | null
  topic_by: string | null
  topic_at: number | null
  lists: string
  history: number | null
  used: number
}

/** An entry of a list as it is stored: the mode, the mask, who set it, and when. */
export type StoredEntry = [mode: ListMode, mask: string, by: string, at: number]

/** The state of a channel that is stored, which is everything but the members and the invites. */
const state = (channel: Channel) => [
  // The type D modes, of which `P` itself, which every stored channel has.
  [...channel.modes].sort().join(''),
  channel.key ?? null,
  channel.limit ?? null,
  channel.topic?.text ?? null,
  channel.topic?.by ?? null,
  channel.topic?.at ?? null,
  JSON.stringify(
    (['b', 'e', 'I'] as const).flatMap((mode) =>
      channel.lists[mode].map((entry): StoredEntry => [mode, entry.mask, entry.by, entry.at])
    )
  ),
]

/**
 * The permanent channels in the store, by their folded names. Every method is synchronous, so a
 * handler writes a change while it makes it, in the same request. `Server` makes a `Channel` of a
 * row (`Server.restore()`).
 */
export class ChannelStore {
  store: Store
  maxPerAccount: number
  maxChannels: number
  expire: number
  /** The number of rows, which is counted once. */
  count: number

  constructor(store: Store, options: PermanentOptions = {}) {
    this.store = store
    this.maxPerAccount = options.maxPerAccount ?? 20
    this.maxChannels = options.maxChannels ?? 10_000
    this.expire = options.expire ?? 90 * 86_400_000
    this.count = store.query<{ n: number }>('SELECT count(*) AS n FROM channels')[0].n
  }

  get(folded: string): ChannelRow | undefined {
    return this.store.query<ChannelRow>('SELECT * FROM channels WHERE folded = ?', folded)[0]
  }

  /** The number of permanent channels that an account (folded) has founded. */
  owned(founder: string): number {
    return this.store.query<{ n: number }>(
      'SELECT count(*) AS n FROM channels WHERE founder = ?',
      founder
    )[0].n
  }

  /** Whether the founder may have one more permanent channel. */
  allows(founder: string) {
    return this.count < this.maxChannels && this.owned(founder) < this.maxPerAccount
  }

  /** Store a channel that becomes permanent. It must have a founder. */
  insert(folded: string, channel: Channel, now = Date.now()) {
    this.store.query(
      `INSERT INTO channels (folded, name, created, founder, modes, key, max_members, topic,
         topic_by, topic_at, lists, history, used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      folded,
      channel.name,
      channel.created,
      channel.founder!,
      ...state(channel),
      channel.history ?? null,
      now
    )
    this.count++
  }

  /** Write the state of a permanent channel after a change: its modes, topic, or lists. */
  save(folded: string, channel: Channel) {
    this.store.query(
      `UPDATE channels SET modes = ?, key = ?, max_members = ?, topic = ?, topic_by = ?,
         topic_at = ?, lists = ? WHERE folded = ?`,
      ...state(channel),
      folded
    )
  }

  /** Set the target of the history of a permanent channel. */
  setHistory(folded: string, target: number) {
    this.store.query('UPDATE channels SET history = ? WHERE folded = ?', target, folded)
  }

  /** Note that a permanent channel has been joined, or left, now. */
  touch(folded: string, now = Date.now()) {
    this.store.query('UPDATE channels SET used = ? WHERE folded = ?', now, folded)
  }

  /** Delete a permanent channel. */
  remove(folded: string) {
    if (this.store.query('DELETE FROM channels WHERE folded = ? RETURNING folded', folded).length) {
      this.count--
    }
  }

  /** The permanent channels that are not secret, for LIST. */
  listed(): Pick<ChannelRow, 'folded' | 'name' | 'topic'>[] {
    return this.store.query(
      "SELECT folded, name, topic FROM channels WHERE instr(modes, 's') = 0 ORDER BY folded"
    )
  }

  /** The permanent channels that nobody has joined for too long, the oldest first. */
  expired(now: number, limit: number): Pick<ChannelRow, 'folded' | 'history'>[] {
    return this.store.query(
      'SELECT folded, history FROM channels WHERE used < ? ORDER BY used LIMIT ?',
      now - this.expire,
      limit
    )
  }
}
