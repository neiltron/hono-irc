// The host that the other users see in place of the address of a client.
//
// A cloak is a keyed hash of the address, so it is the same for the same address and it can not
// be turned back into the address without the key. The key is `cloakSecret` of the server.
//
// The hash is HMAC-SHA-256 in plain JavaScript, because a `Client` is made synchronously in
// `onOpen()`, and the digests of WebCrypto are asynchronous. HMAC-SHA-256 is a pseudorandom
// function: without the key, a cloak tells nothing about the address, and nobody can work out the
// cloak of an address to compare it, which is what a brute force of the 2^32 IPv4 addresses would
// need. It hashes a few bytes once for each connection, so its speed does not matter.

// The round constants of SHA-256.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** SHA-256 (FIPS 180-4). */
export const sha256 = (data: Uint8Array): Uint8Array => {
  // The message, a 1 bit, zeros, and the length in bits, to a multiple of 64 bytes.
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000))
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0)

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  // A Uint32Array keeps each value modulo 2^32.
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4)
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = w[i - 16] + s0 + w[i - 7] + s1
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) |
        0
      const t2 =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    hash[0] += a
    hash[1] += b
    hash[2] += c
    hash[3] += d
    hash[4] += e
    hash[5] += f
    hash[6] += g
    hash[7] += h
  }
  const digest = new Uint8Array(32)
  const out = new DataView(digest.buffer)
  hash.forEach((value, i) => out.setUint32(i * 4, value))
  return digest
}

const encoder = new TextEncoder()

/** HMAC-SHA-256 (RFC 2104). */
export const hmac = (key: Uint8Array, message: Uint8Array): Uint8Array => {
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? sha256(key) : key)
  const inner = new Uint8Array(64 + message.length)
  const outer = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36
    outer[i] = block[i] ^ 0x5c
  }
  inner.set(message, 64)
  outer.set(sha256(inner), 64)
  return sha256(outer)
}

/** The 16-bit groups of an IPv6 address, or `undefined` if it is not one. */
const parseIPv6 = (address: string): number[] | undefined => {
  let text = address.toLowerCase()
  // An IPv4 address in the last 32 bits, e.g. `::ffff:192.0.2.1`.
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (v4) {
    const octets = parseIPv4(v4[2])
    if (!octets) {
      return
    }
    text = v4[1] + ((octets[0] << 8) | octets[1]).toString(16) + ':'
    text += ((octets[2] << 8) | octets[3]).toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) {
    return
  }
  const groups = halves.map((half) => (half ? half.split(':') : []))
  if (groups.flat().some((group) => !/^[\da-f]{1,4}$/.test(group))) {
    return
  }
  const [head, tail] = groups
  const missing = 8 - head.length - (tail?.length ?? 0)
  if (tail ? missing < 1 : missing !== 0) {
    return
  }
  return [...head, ...Array<string>(missing).fill('0'), ...(tail ?? [])].map((group) =>
    parseInt(group, 16)
  )
}

/** The four octets of an IPv4 address, or `undefined` if it is not one. */
const parseIPv4 = (address: string): number[] | undefined => {
  const octets = address.split('.')
  if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet))) {
    return
  }
  const numbers = octets.map(Number)
  return numbers.every((octet) => octet <= 255) ? numbers : undefined
}

/**
 * The cloak of an address. Each label is a hash of a part of the address, from the whole address
 * to its network: `<address>.<network>.<wider network>.ip4` for IPv4, with the /32, the /24, and
 * the /16, and `.ip6` for IPv6, with the /128, the /64, and the /48. So the clients of one network
 * share the end of their cloaks, and a ban such as `*!*@*.<network>.<wider network>.ip4` bans the
 * network. An IPv4 address mapped to IPv6 (`::ffff:192.0.2.1`), which Node.js gives for an IPv4
 * client of a dual-stack listener, is cloaked as IPv4. Anything else is hashed as a whole.
 */
export const cloak = (address: string, secret: string): string => {
  const key = encoder.encode(secret)
  // 32 bits of a hash, as 8 hexadecimal digits. The labels say what they hash, so the same
  // bytes in another place give another label.
  const label = (part: string) =>
    [...hmac(key, encoder.encode(part)).subarray(0, 4)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')

  const groups = parseIPv6(address)
  const mapped =
    groups && groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
      ? [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]
      : undefined
  const octets = mapped ?? parseIPv4(address)
  if (octets) {
    const prefix = (count: number) => `ip4/${count * 8} ${octets.slice(0, count).join('.')}`
    return `${label(prefix(4))}.${label(prefix(3))}.${label(prefix(2))}.ip4`
  }
  if (groups) {
    const prefix = (count: number) => `ip6/${count * 16} ${groups.slice(0, count).join(':')}`
    return `${label(prefix(8))}.${label(prefix(4))}.${label(prefix(3))}.ip6`
  }
  return `${label(`address ${address}`)}.ip`
}
