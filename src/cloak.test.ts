import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vite-plus/test'
import { cloak, hmac, sha256 } from './cloak.ts'
import { setup } from './test-utils.ts'

const encoder = new TextEncoder()
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('The hash of the cloaks', () => {
  // The lengths around the ends of a block of 64 bytes, where the padding changes.
  const lengths = [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 200, 1000]

  it('Should be SHA-256', () => {
    for (const length of lengths) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 7 + length) & 0xff)
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'))
    }
  })

  it('Should be HMAC-SHA-256, with a short and a long key', () => {
    for (const keyLength of [0, 16, 64, 65, 100]) {
      const key = Uint8Array.from({ length: keyLength }, (_, i) => i)
      for (const length of lengths) {
        const data = Uint8Array.from({ length }, (_, i) => i ^ 0x5a)
        expect(hex(hmac(key, data))).toBe(createHmac('sha256', key).update(data).digest('hex'))
      }
    }
    expect(hex(hmac(encoder.encode('key'), encoder.encode('The quick brown fox')))).toBe(
      createHmac('sha256', 'key').update('The quick brown fox').digest('hex')
    )
  })
})

describe('Cloaks', () => {
  const label = '[\\da-f]{8}'

  it('Should be the same for an address, and share the end with its network', () => {
    const a = cloak('192.0.2.1', 'secret')
    expect(a).toMatch(new RegExp(`^${label}\\.${label}\\.${label}\\.ip4$`))
    expect(cloak('192.0.2.1', 'secret')).toBe(a)
    const [, ...network] = a.split('.')
    // The same /24.
    const b = cloak('192.0.2.200', 'secret')
    expect(b).not.toBe(a)
    expect(b.split('.').slice(1)).toEqual(network)
    // The same /16 only.
    const c = cloak('192.0.3.1', 'secret').split('.')
    expect(c[1]).not.toBe(network[0])
    expect(c[2]).toBe(network[1])
    // Another /16.
    expect(cloak('198.51.100.1', 'secret').split('.')[2]).not.toBe(network[1])
  })

  it('Should depend on the secret, and not show the address', () => {
    expect(cloak('192.0.2.1', 'other')).not.toBe(cloak('192.0.2.1', 'secret'))
    for (const address of ['192.0.2.1', '2001:db8::1']) {
      const host = cloak(address, 'secret')
      expect(host).not.toContain('192')
      expect(host).not.toContain('db8')
    }
  })

  it('Should share the end within an IPv6 /64, whatever the form of the address', () => {
    const a = cloak('2001:db8:1:2::1', 'secret')
    expect(a).toMatch(new RegExp(`^${label}\\.${label}\\.${label}\\.ip6$`))
    expect(cloak('2001:0DB8:0001:0002:0000:0000:0000:0001', 'secret')).toBe(a)
    const b = cloak('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 'secret')
    expect(b).not.toBe(a)
    expect(b.split('.').slice(1)).toEqual(a.split('.').slice(1))
    // Another /64 in the same /48.
    const c = cloak('2001:db8:1:3::1', 'secret').split('.')
    expect(c[1]).not.toBe(a.split('.')[1])
    expect(c[2]).toBe(a.split('.')[2])
  })

  it('Should cloak an IPv4 address mapped to IPv6 as IPv4', () => {
    expect(cloak('::ffff:192.0.2.1', 'secret')).toBe(cloak('192.0.2.1', 'secret'))
    expect(cloak('::FFFF:c000:201', 'secret')).toBe(cloak('192.0.2.1', 'secret'))
    expect(cloak('::1', 'secret')).toMatch(/\.ip6$/)
  })

  it('Should hash anything else as a whole', () => {
    for (const address of ['unknown', '1:2:3:4:5:6:7:8:9', '1::2::3', '192.0.2.256', '::g']) {
      expect(cloak(address, 'secret')).toMatch(new RegExp(`^${label}\\.ip$`))
    }
  })

  it('Should be the host of a client, stable across connections and servers', async () => {
    const first = setup({ cloakSecret: 'secret' })
    const alice = await first.register('alice', [], '192.0.2.1')
    const bob = await first.register('bob', [], '192.0.2.1')
    const again = setup({ cloakSecret: 'secret' })
    const carol = await again.register('carol', [], '192.0.2.1')
    const host = cloak('192.0.2.1', 'secret')
    for (const [client, nick] of [
      [alice, 'alice'],
      [bob, 'bob'],
      [carol, 'carol'],
    ] as const) {
      expect(client.lines.find((line) => / 001 /.test(line))).toContain(`${nick}@${host}`)
    }
  })
})
