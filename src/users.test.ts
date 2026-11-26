import { describe, expect, it } from 'vite-plus/test'
import { connect, exchange, isupport, setup } from './test-utils.ts'

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
})
