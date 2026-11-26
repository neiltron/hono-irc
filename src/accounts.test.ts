import { pbkdf2Sync } from 'node:crypto'
import { describe, expect, it } from 'vite-plus/test'
import {
  ALGORITHM,
  Accounts,
  MAX_ITERATIONS,
  Throttle,
  addressKey,
  attempt,
  derive,
  equal,
  fromBase64,
  hashPassword,
  toBase64,
  verify,
} from './accounts.ts'
import type { Account } from './accounts.ts'
import { memoryStore, migrate } from './store.ts'

const fold = (name: string) => name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())

const accounts = (options = {}) => {
  const store = memoryStore()!
  migrate(store)
  return new Accounts(store, fold, options)
}

describe('Password hashing', () => {
  it('Should be PBKDF2-HMAC-SHA-256, as node:crypto computes it', async () => {
    const salt = new Uint8Array(16).fill(7)
    const derived = await derive('pässwörd', salt, 1000)
    expect(Buffer.from(derived)).toEqual(pbkdf2Sync('pässwörd', salt, 1000, 32, 'sha256'))
  })

  it('Should store the algorithm, the iterations, a random salt, and the hash', async () => {
    const a = await hashPassword('correct horse', 10)
    const b = await hashPassword('correct horse', 10)
    expect(a).toMatchObject({ algorithm: ALGORITHM, iterations: 10 })
    expect(fromBase64(a.salt)).toHaveLength(16)
    expect(fromBase64(a.hash)).toHaveLength(32)
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
    expect(JSON.stringify(a)).not.toContain('correct horse')
  })

  it('Should use the most iterations that Cloudflare Workers allows by default', () => {
    expect(MAX_ITERATIONS).toBe(100_000)
    expect(accounts().iterations).toBe(100_000)
  })

  it('Should verify a password with the parameters of the account', async () => {
    const credential = await hashPassword('correct horse', 10)
    const account: Account = { ...credential, folded: 'alice', name: 'Alice', created: 0 }
    expect(verify(account, await attempt(account, 'correct horse'))).toBe(true)
    expect(verify(account, await attempt(account, 'correct horsE'))).toBe(false)
    // A key made for another account, salt, or count does not match, nor another algorithm.
    const right = await attempt(account, 'correct horse')
    expect(verify({ ...account, folded: 'bob' }, right)).toBe(false)
    expect(verify({ ...account, iterations: 11 }, right)).toBe(false)
    expect(verify({ ...account, salt: toBase64(new Uint8Array(16)) }, right)).toBe(false)
    expect(verify({ ...account, algorithm: 'plain' }, right)).toBe(false)
  })

  it('Should compare bytes without stopping at the first difference', () => {
    expect(equal(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(equal(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(equal(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false)
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false)
  })
})

describe('Accounts', () => {
  it('Should create an account once, and find it by its folded name', async () => {
    const store = accounts()
    const credential = await hashPassword('password', 10)
    expect(store.create('Alice', credential, 'host', 1000)).toBe(true)
    expect(store.create('ALICE', credential, 'host', 1000)).toBe(false)
    expect(store.get('aLiCe')).toEqual({
      ...credential,
      folded: 'alice',
      name: 'Alice',
      created: 1000,
    })
    expect(store.get('bob')).toBeUndefined()
    expect(store.count()).toBe(1)
    // A refused one is not counted for the address.
    expect(store.recent('host', 1000)).toBe(1)
  })

  it('Should count the registrations of an address within the window, and forget older ones', async () => {
    const store = accounts({ registrationWindow: 100 })
    const credential = await hashPassword('password', 10)
    store.create('a', credential, 'host', 1000)
    store.create('b', credential, 'host', 1050)
    store.create('c', credential, 'other', 1050)
    expect(store.recent('host', 1060)).toBe(2)
    expect(store.recent('host', 1120)).toBe(1)
    // A registration deletes the rows older than the window.
    store.create('d', credential, 'other', 1200)
    expect(
      store.store.query('SELECT address, at FROM registrations').map((row) => ({ ...row }))
    ).toEqual([{ address: 'other', at: 1200 }])
  })

  it('Should roll the account back if the registration can not be counted', async () => {
    const store = accounts()
    store.store.query('DROP TABLE registrations')
    expect(() =>
      store.create('alice', { algorithm: ALGORITHM, iterations: 1, salt: '', hash: '' }, 'host')
    ).toThrow()
    expect(store.get('alice')).toBeUndefined()
  })
})

describe('Throttle', () => {
  it('Should give a burst, and a token every interval after it', () => {
    const throttle = new Throttle(2, 100)
    expect([throttle.take('a', 0), throttle.take('a', 0), throttle.take('a', 0)]).toEqual([
      true,
      true,
      false,
    ])
    expect(throttle.take('b', 0)).toBe(true)
    expect(throttle.take('a', 50)).toBe(false)
    expect(throttle.take('a', 150)).toBe(true)
  })

  it('Should hold at most so many keys, and forget the ones that are full again', () => {
    const throttle = new Throttle(1, 100, 2)
    expect(throttle.take('a', 0)).toBe(true)
    expect(throttle.take('b', 0)).toBe(true)
    // Both are busy: a new key is refused.
    expect(throttle.take('c', 50)).toBe(false)
    expect(throttle.size).toBe(2)
    // Once they are full again, they are forgotten.
    expect(throttle.take('c', 200)).toBe(true)
    expect(throttle.size).toBe(1)
  })
})

describe('addressKey', () => {
  it('Should be the cloak of an IPv4 address, the /64 of an IPv6 one, or one key for unknown', () => {
    expect(addressKey({ ip: '192.0.2.1', host: 'aaaa.bbbb.cccc.ip4' })).toBe('aaaa.bbbb.cccc.ip4')
    expect(addressKey({ ip: '2001:db8::1', host: 'aaaa.bbbb.cccc.ip6' })).toBe('bbbb.cccc.ip6')
    expect(addressKey({ host: 'abcd1234.user' })).toBe('unknown')
  })
})
