import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { MIGRATIONS, memoryStore, migrate, nodeStore, sqlStore } from './store.ts'
import type { Store } from './store.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A path for a database file in a new temporary directory. */
const databaseFile = () => {
  const directory = mkdtempSync(join(tmpdir(), 'hono-irc-'))
  directories.push(directory)
  return join(directory, 'irc.sqlite')
}

const table = (store: Store) => {
  store.query('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL)')
}

describe('nodeStore', () => {
  it('Should run queries with parameters and return the rows', () => {
    const store = memoryStore()!
    table(store)
    expect(store.query('INSERT INTO t (name, score) VALUES (?, ?) RETURNING id', 'a', 1.5)).toEqual(
      [{ id: 1 }]
    )
    store.query('INSERT INTO t (name, score) VALUES (?, ?)', 'b', null)
    expect(store.query('SELECT name, score FROM t ORDER BY id').map((row) => ({ ...row }))).toEqual(
      [
        { name: 'a', score: 1.5 },
        { name: 'b', score: null },
      ]
    )
    // A parameter is a value, never SQL.
    expect(store.query('SELECT count(*) AS n FROM t WHERE name = ?', "a' OR 1=1 --")).toEqual([
      expect.objectContaining({ n: 0 }),
    ])
  })

  it('Should commit a transaction, and roll it back if it throws', () => {
    const store = memoryStore()!
    table(store)
    expect(store.transaction(() => store.query('INSERT INTO t (name) VALUES (?)', 'kept'))).toEqual(
      []
    )
    expect(() =>
      store.transaction(() => {
        store.query('INSERT INTO t (name) VALUES (?)', 'lost')
        throw new Error('no')
      })
    ).toThrow('no')
    expect(store.query<{ name: string }>('SELECT name FROM t').map((row) => row.name)).toEqual([
      'kept',
    ])
  })

  it('Should nest transactions', () => {
    const store = memoryStore()!
    table(store)
    store.transaction(() => {
      store.query('INSERT INTO t (name) VALUES (?)', 'outer')
      expect(() =>
        store.transaction(() => {
          store.query('INSERT INTO t (name) VALUES (?)', 'inner')
          throw new Error('inner')
        })
      ).toThrow('inner')
      store.transaction(() => store.query('INSERT INTO t (name) VALUES (?)', 'second'))
    })
    expect(store.query<{ name: string }>('SELECT name FROM t').map((row) => row.name)).toEqual([
      'outer',
      'second',
    ])
  })

  it('Should refuse an asynchronous transaction, as a Durable Object does', () => {
    const store = memoryStore()!
    table(store)
    expect(() =>
      store.transaction(async () => {
        store.query('INSERT INTO t (name) VALUES (?)', 'async')
      })
    ).toThrow('synchronous')
    expect(store.query('SELECT * FROM t')).toEqual([])
  })

  it('Should keep the data in a file across reopening', () => {
    const file = databaseFile()
    let db = new DatabaseSync(file)
    let store = nodeStore(db)
    table(store)
    store.query('INSERT INTO t (name) VALUES (?)', 'persisted')
    db.close()
    db = new DatabaseSync(file)
    store = nodeStore(db)
    expect(store.query<{ name: string }>('SELECT name FROM t')[0].name).toBe('persisted')
    db.close()
  })
})

describe('sqlStore', () => {
  it('Should use the synchronous SQL API of a Durable Object', () => {
    const calls: unknown[][] = []
    const storage = {
      sql: {
        exec: (query: string, ...bindings: unknown[]) => {
          calls.push([query, ...bindings])
          return { toArray: () => [{ one: 1 }] }
        },
      },
      transactionSync: <T>(fn: () => T): T => {
        calls.push(['transaction'])
        return fn()
      },
    }
    const store = sqlStore(storage)
    expect(store.transaction(() => store.query('SELECT ?', 'x'))).toEqual([{ one: 1 }])
    expect(calls).toEqual([['transaction'], ['SELECT ?', 'x']])
  })
})

describe('migrate', () => {
  const version = (store: Store) =>
    store.query<{ version: number }>('SELECT max(version) AS version FROM migrations')[0].version

  it('Should create the schema once', () => {
    const store = memoryStore()!
    migrate(store)
    migrate(store)
    expect(version(store)).toBe(MIGRATIONS.length)
    expect(store.query('SELECT * FROM accounts')).toEqual([])
    expect(store.query('SELECT count(*) AS n FROM migrations')).toEqual([
      expect.objectContaining({ n: MIGRATIONS.length }),
    ])
  })

  it('Should apply only the new migrations, each in a transaction', () => {
    const store = memoryStore()!
    const first = [['CREATE TABLE a (x)']]
    migrate(store, first)
    // The second one fails halfway, and leaves nothing of itself.
    const broken = [...first, ['CREATE TABLE b (x)', 'INSERT INTO nope VALUES (1)']]
    expect(() => migrate(store, broken)).toThrow()
    expect(version(store)).toBe(1)
    expect(store.query("SELECT name FROM sqlite_master WHERE name = 'b'")).toEqual([])
    migrate(store, [...first, ['CREATE TABLE b (x)']])
    expect(version(store)).toBe(2)
  })

  it('Should refuse a database that is newer than the server', () => {
    const store = memoryStore()!
    migrate(store, [['CREATE TABLE a (x)'], ['CREATE TABLE b (x)']])
    expect(() => migrate(store, [['CREATE TABLE a (x)']])).toThrow(/schema version 2/)
  })

  it('Should keep the schema in a file', () => {
    const file = databaseFile()
    let db = new DatabaseSync(file)
    migrate(nodeStore(db))
    db.close()
    db = new DatabaseSync(file)
    const store = nodeStore(db)
    migrate(store)
    expect(version(store)).toBe(MIGRATIONS.length)
    db.close()
  })
})
