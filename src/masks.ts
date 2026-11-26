// The masks of the lists of a channel (+b, +e, +I): `nick!user@host` with wildcards.
//
// `*` matches any number of characters and `?` one character, as in Modern IRC. A backslash
// escapes one of `*`, `?`, and `\`, and is itself otherwise, since a nickname can have a backslash.
//
// A mask is not turned into a RegExp: a mask such as `*a*a*a*a*b` would make a backtracking regular
// expression take exponential time on every JOIN and message. The matcher below backtracks only to
// the last `*`, so it takes at most the product of the two lengths.

/** A literal character, or `ONE` for `?`, or `ANY` for `*`. */
type Token = string | typeof ONE | typeof ANY
const ONE = 1
const ANY = 2

/** A mask that is ready to match. */
export type Glob = Token[]

/** Compile a mask that is already folded. */
export const compile = (mask: string): Glob => {
  const chars = Array.from(mask)
  const tokens: Token[] = []
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    if (char === '\\' && '*?\\'.includes(chars[i + 1] ?? 'x')) {
      tokens.push(chars[++i])
    } else if (char === '*') {
      // `**` is `*`.
      if (tokens.at(-1) !== ANY) {
        tokens.push(ANY)
      }
    } else {
      tokens.push(char === '?' ? ONE : char)
    }
  }
  return tokens
}

/** Whether a string, already folded, matches a compiled mask. */
export const matches = (glob: Glob, value: string): boolean => {
  const text = Array.from(value)
  let g = 0
  let t = 0
  // The position after the last `*`, and the position in the text that it matched up to.
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (g < glob.length && (glob[g] === ONE || glob[g] === text[t])) {
      g++
      t++
    } else if (g < glob.length && glob[g] === ANY) {
      star = ++g
      mark = t
    } else if (star !== -1) {
      // The last `*` takes one character more.
      g = star
      t = ++mark
    } else {
      return false
    }
  }
  while (glob[g] === ANY) {
    g++
  }
  return g === glob.length
}

/**
 * The full form of a mask, as most servers store it: `bob` is `bob!*@*`, `*@host` and `@host`
 * are `*!*@host`, `user@host` is `*!user@host`, and `bob!user` is `bob!user@*`.
 */
export const normalize = (mask: string): string => {
  const at = mask.indexOf('@')
  const rest = at === -1 ? mask : mask.slice(0, at)
  const host = at === -1 ? '' : mask.slice(at + 1)
  const bang = rest.indexOf('!')
  const nick = bang === -1 ? (at === -1 ? rest : '') : rest.slice(0, bang)
  const user = bang === -1 ? (at === -1 ? '' : rest) : rest.slice(bang + 1)
  return `${nick || '*'}!${user || '*'}@${host || '*'}`
}
