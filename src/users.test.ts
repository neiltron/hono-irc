import { describe, expect, it } from 'vite-plus/test'
import { parse } from './protocol.ts'
import { connect, exchange, isupport, setup, strip, transcript } from './test-utils.ts'

const tagsOf = (line: string) => parse(line)?.tags ?? {}

describe('SETNAME', () => {
  it('Should change the realname and tell the clients with the capability', async () => {
    const { register } = setup()
    const alice = await register('alice', ['setname'])
    const peer = await register('peer', ['setname'])
    const plain = await register('plain')
    const watcher = await register('watcher', ['setname', 'extended-monitor'])
    const monitor = await register('monitor', ['setname'])
    expect(isupport(alice.lines)).toContain('NAMELEN=150')
    await exchange(alice, 'JOIN #a')
    await exchange(peer, 'JOIN #a')
    await exchange(plain, 'JOIN #a')
    await exchange(watcher, 'MONITOR + alice')
    await exchange(monitor, 'MONITOR + alice')
    expect(await exchange(alice, 'SETNAME :Alice Liddell')).toEqual(['SETNAME :Alice Liddell'])
    expect(await peer.waitFor(/ SETNAME /)).toMatch(/^:alice!~alice@\S+ SETNAME :Alice Liddell$/)
    expect(await watcher.waitFor(/ SETNAME /)).toMatch(/ SETNAME :Alice Liddell$/)
    await exchange(plain)
    await exchange(monitor)
    expect(plain.lines.some((line) => / SETNAME /.test(line))).toBe(false)
    expect(monitor.lines.some((line) => / SETNAME /.test(line))).toBe(false)
    expect((await exchange(plain, 'WHOIS alice'))[0]).toMatch(/^311 plain alice .* :Alice Liddell$/)
    // The same realname again is confirmed, and not told to the others again.
    expect(await exchange(alice, 'SETNAME :Alice Liddell')).toEqual(['SETNAME :Alice Liddell'])
    await exchange(peer)
    expect(peer.lines.filter((line) => / SETNAME /.test(line))).toHaveLength(1)
  })

  it('Should be silent without the capability, and reject a realname that is not valid', async () => {
    const { register } = setup()
    const alice = await register('alice')
    expect(
      await exchange(
        alice,
        'SETNAME :New Name',
        'SETNAME :',
        `SETNAME :${'é'.repeat(76)}`,
        'SETNAME'
      )
    ).toEqual([
      'FAIL SETNAME INVALID_REALNAME :Realname is not valid',
      'FAIL SETNAME INVALID_REALNAME :Realname is not valid',
      '461 alice SETNAME :Not enough parameters',
    ])
    expect((await exchange(alice, 'WHOIS alice'))[0]).toMatch(/ :New Name$/)
    // USER is cut to NAMELEN.
    const { handler } = setup()
    const carol = connect(handler)
    await carol.send('NICK carol', `USER carol 0 * :${'x'.repeat(200)}`)
    await carol.waitFor(/ 376 /)
    expect((await exchange(carol, 'WHOIS carol'))[0]).toMatch(/ x{150}$/)
  })
})

describe('Bot mode', () => {
  it('Should set the mode and show it in WHOIS, WHO, and WHOX', async () => {
    const { register } = setup({ network: 'ExampleNet' })
    const robo = await register('robo')
    const alice = await register('alice')
    expect(isupport(robo.lines)).toContain('BOT=B')
    expect(robo.lines.find((line) => / 004 /.test(line))).toMatch(/ 004 robo \S+ \S+ Bi /)
    await exchange(alice, 'JOIN #a')
    expect(await exchange(robo, 'MODE robo +B', 'MODE robo +i', 'MODE robo', 'JOIN #a')).toEqual([
      'MODE robo +B',
      'MODE robo +i',
      '221 robo +Bi',
      'JOIN #a',
      '353 robo = #a :@alice robo',
      '366 robo #a :End of /NAMES list',
    ])
    const whois = await exchange(alice, 'WHOIS robo')
    expect(whois).toContain('335 alice robo :is a Bot on ExampleNet')
    expect(whois.indexOf('335 alice robo :is a Bot on ExampleNet')).toBe(whois.length - 3)
    expect((await exchange(alice, 'WHO #a'))[1]).toMatch(/ robo HB :0 robo the user$/)
    expect((await exchange(alice, 'WHO robo %nf'))[0]).toBe('354 alice robo HB')
    expect(await exchange(robo, 'MODE robo -B+B-iB')).toEqual(['MODE robo -Bi'])
    expect(await exchange(alice, 'WHOIS robo')).not.toContainEqual(expect.stringMatching(/^335 /))
  })

  it('Should tag the messages of a bot for the clients with message-tags', async () => {
    const { register } = setup()
    const robo = await register('robo')
    const tagged = await register('tagged', ['message-tags'])
    const plain = await register('plain')
    await exchange(robo, 'MODE robo +B')
    await exchange(tagged, 'JOIN #a')
    await exchange(plain, 'JOIN #a')
    await exchange(robo, 'JOIN #a', 'PRIVMSG #a :beep', 'NICK robot', 'MODE robot -B')
    await exchange(robo, 'PRIVMSG #a :quiet', 'MODE robot +B')
    await robo.send('QUIT :bye')
    await tagged.waitFor(/ QUIT /)
    await plain.waitFor(/ QUIT /)
    expect(tagged.lines.filter((line) => /^(@\S+ )?:robo/.test(line))).toEqual([
      expect.stringMatching(/^@bot :robo!\S+ JOIN #a$/),
      expect.stringMatching(/^@msgid=\w+;bot :robo!\S+ PRIVMSG #a beep$/),
      expect.stringMatching(/^@bot :robo!\S+ NICK robot$/),
      expect.stringMatching(/^@msgid=\w+ :robot!\S+ PRIVMSG #a quiet$/),
      expect.stringMatching(/^@bot :robot!\S+ QUIT :Quit: bye$/),
    ])
    expect(plain.lines.filter((line) => line.startsWith('@'))).toEqual([])
    expect(plain.lines.filter((line) => line.startsWith(':robo'))).toHaveLength(5)
  })

  it('Should tag a multiline batch of a bot, its fallback lines, and its labeled echo', async () => {
    const { register } = setup()
    const caps = ['batch', 'draft/multiline', 'message-tags']
    const robo = await register('robo', [...caps, 'echo-message', 'labeled-response'])
    const full = await register('full', caps)
    const fallback = await register('fallback', ['message-tags'])
    const plain = await register('plain')
    for (const client of [robo, full, fallback, plain]) {
      await exchange(client, 'JOIN #a')
    }
    await exchange(robo, 'MODE robo +B')
    const echo = await transcript(
      robo,
      'BATCH +ml draft/multiline #a',
      '@batch=ml PRIVMSG #a hello',
      '@batch=ml PRIVMSG #a :again',
      '@label=l1 BATCH -ml',
      '@label=l2 PRIVMSG #a :single'
    )
    // The echo is labeled on its BATCH line, and every line of it is tagged.
    expect(echo).toHaveLength(5)
    expect(echo.map((line) => Object.keys(tagsOf(line)).sort())).toEqual([
      ['bot', 'label', 'msgid'],
      ['batch', 'bot'],
      ['batch', 'bot'],
      ['bot'],
      ['bot', 'label', 'msgid'],
    ])
    expect(tagsOf(echo[0]).label).toBe('l1')
    expect(tagsOf(echo[4]).label).toBe('l2')
    expect(echo[4]).toMatch(/ :robo!\S+ PRIVMSG #a single$/)
    for (const client of [full, fallback, plain]) {
      await client.waitFor(/ PRIVMSG #a single$/)
    }
    const from = (client: typeof robo) => client.lines.filter((line) => /(^| ):robo!/.test(line))
    // The whole batch with draft/multiline, and the lines without it, as with message-tags.
    expect(from(full).map((line) => tagsOf(line).bot)).toEqual(['', '', '', '', ''])
    expect(from(full).map((line) => line.split(' ')[2])).toEqual([
      'BATCH',
      'PRIVMSG',
      'PRIVMSG',
      'BATCH',
      'PRIVMSG',
    ])
    expect(from(fallback).map((line) => [tagsOf(line).bot, strip(line)])).toEqual([
      ['', 'PRIVMSG #a hello'],
      ['', 'PRIVMSG #a again'],
      ['', 'PRIVMSG #a single'],
    ])
    expect(from(plain).map((line) => line.split(' ').slice(1).join(' '))).toEqual([
      'PRIVMSG #a hello',
      'PRIVMSG #a again',
      'PRIVMSG #a single',
    ])
  })
})

describe('Labeled responses of the channel and user commands', () => {
  const caps = ['batch', 'labeled-response', 'setname']

  it('Should label the replies of INVITE, MODE lists, WHOX, MONITOR, and SETNAME', async () => {
    const { register } = setup()
    const alice = await register('alice', caps)
    const bob = await register('bob')
    await exchange(alice, 'JOIN #a')
    const labels = (lines: string[]) => lines.map((line) => tagsOf(line).label ?? '-')
    // One line: the label is on it.
    const invite = await transcript(alice, '@label=i1 INVITE bob #a')
    expect(invite).toEqual([expect.stringMatching(/^@label=i1 :\S+ 341 alice bob #a$/)])
    expect(await bob.waitFor(/ INVITE /)).not.toContain('label')
    const empty = await transcript(alice, '@label=b0 MODE #a b')
    expect(empty).toEqual([expect.stringMatching(/^@label=b0 :\S+ 368 alice #a :/)])
    const setname = await transcript(alice, '@label=s1 SETNAME :Alice A')
    expect(setname).toEqual([expect.stringMatching(/^@label=s1 :alice!\S+ SETNAME :Alice A$/)])
    // Several lines: a labeled-response batch around them.
    await exchange(alice, 'MODE #a +b x')
    for (const [label, command] of [
      ['b1', 'MODE #a b'],
      ['w1', 'WHO #a %nf,5'],
      ['m1', 'MONITOR + bob,nobody'],
    ]) {
      const lines = await transcript(alice, `@label=${label} ${command}`)
      expect(lines[0]).toMatch(
        new RegExp(`^@label=${label} :\\S+ BATCH \\+(\\S+) labeled-response$`)
      )
      const ref = lines[0].split(' ')[3].slice(1)
      expect(lines.slice(1, -1).every((line) => tagsOf(line).batch === ref)).toBe(true)
      expect(lines.at(-1)).toMatch(new RegExp(` BATCH -${ref}$`))
      expect(labels(lines)).toEqual([label, ...Array(lines.length - 1).fill('-')])
    }
    // No reply: an ACK.
    expect(await transcript(alice, '@label=m2 MONITOR - bob')).toEqual([
      expect.stringMatching(/^@label=m2 :\S+ ACK$/),
    ])
  })

  it('Should leave a MONITOR notification to the client out of its response', async () => {
    const { register } = setup()
    const alice = await register('alice', caps)
    await exchange(alice, 'MONITOR + alice2')
    const lines = await transcript(alice, '@label=n1 NICK alice2')
    expect(lines).toEqual([
      expect.stringMatching(/^@label=n1 :alice!\S+ NICK alice2$/),
      expect.stringMatching(/^:\S+ 730 alice2 alice2!\S+$/),
    ])
  })
})
