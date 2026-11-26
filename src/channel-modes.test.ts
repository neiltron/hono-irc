import { describe, expect, it } from 'vite-plus/test'
import { MAX_INVITES, MAX_LIST } from './state.ts'
import { exchange, setup } from './test-utils.ts'

/** A channel `#a` of alice, who is its operator, and bob and carol, who are not in it. */
const channel = async (capabilities: Record<string, string[]> = {}) => {
  const env = setup()
  const alice = await env.register('alice', capabilities.alice)
  const bob = await env.register('bob', capabilities.bob)
  const carol = await env.register('carol', capabilities.carol)
  await exchange(alice, 'JOIN #a')
  return { ...env, alice, bob, carol }
}

/** The numerics and the commands, without the parameters after the first `n`. */
const codes = (lines: string[]) => lines.map((line) => line.split(' ')[0])

describe('Advertised modes', () => {
  it('Should describe the channel modes in ISUPPORT and RPL_MYINFO', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const tokens = alice.lines
      .filter((line) => / 005 /.test(line))
      .flatMap((line) => line.split(' ').slice(3, -4))
    expect(tokens).toEqual(
      expect.arrayContaining([
        'CHANMODES=beI,k,l,imnst',
        'PREFIX=(ov)@+',
        'EXCEPTS',
        'INVEX',
        `MAXLIST=beI:${MAX_LIST}`,
        'MODES=4',
        'KEYLEN=23',
      ])
    )
    expect(alice.lines.find((line) => / 004 /.test(line))).toMatch(
      / 004 alice irc\.hono\.local \S+ \S+ Ibeiklmnostv Ibeklov$/
    )
  })
})

describe('Invite-only (+i) and INVITE', () => {
  it('Should let in only the invited, once', async () => {
    const { alice, bob, carol } = await channel()
    expect(await exchange(alice, 'MODE #a +i')).toEqual(['MODE #a +i'])
    expect(await exchange(bob, 'JOIN #a')).toEqual(['473 bob #a :Cannot join channel (+i)'])
    expect(await exchange(alice, 'INVITE bob #a')).toEqual(['341 alice bob #a'])
    expect(await bob.waitFor(/ INVITE /)).toMatch(/^:alice!~alice@\S+ INVITE bob #a$/)
    expect(await exchange(bob, 'INVITE')).toEqual(['336 bob #a', '337 bob :End of /INVITE list'])
    expect(codes(await exchange(bob, 'JOIN #a'))).toEqual(['JOIN', '353', '366'])
    // The invite is used up.
    expect(await exchange(bob, 'INVITE', 'PART #a', 'JOIN #a')).toEqual([
      '337 bob :End of /INVITE list',
      'PART #a',
      '473 bob #a :Cannot join channel (+i)',
    ])
    expect(await exchange(carol, 'JOIN #a')).toEqual(['473 carol #a :Cannot join channel (+i)'])
  })

  it('Should check who invites whom', async () => {
    const { alice, bob, carol } = await channel()
    await exchange(bob, 'JOIN #a')
    expect(
      await exchange(
        carol,
        'INVITE',
        'INVITE bob',
        'INVITE nobody #a',
        'INVITE bob #nowhere',
        'INVITE alice #a'
      )
    ).toEqual([
      '337 carol :End of /INVITE list',
      '461 carol INVITE :Not enough parameters',
      '401 carol nobody :No such nick/channel',
      '403 carol #nowhere :No such channel',
      "442 carol #a :You're not on that channel",
    ])
    expect(await exchange(bob, 'INVITE alice #a')).toEqual([
      '443 bob alice #a :is already on channel',
    ])
    // Any member may invite to a channel without +i, and only an operator to one with it.
    expect(await exchange(bob, 'INVITE carol #a')).toEqual(['341 bob carol #a'])
    await exchange(alice, 'MODE #a +i')
    expect(await exchange(bob, 'INVITE carol #a')).toEqual([
      "482 bob #a :You're not channel operator",
    ])
  })

  it('Should tell the members with invite-notify', async () => {
    const { alice, bob, carol, register } = await channel({ bob: ['invite-notify'] })
    const dave = await register('dave')
    await exchange(bob, 'JOIN #a')
    await exchange(dave, 'JOIN #a')
    await exchange(alice, 'INVITE carol #a')
    expect(await bob.waitFor(/ INVITE /)).toMatch(/^:alice!\S+ INVITE carol #a$/)
    expect(await carol.waitFor(/ INVITE /)).toMatch(/^:alice!\S+ INVITE carol #a$/)
    await exchange(dave)
    expect(dave.lines.some((line) => / INVITE /.test(line))).toBe(false)
    expect(alice.lines.some((line) => / INVITE /.test(line))).toBe(false)
  })

  it('Should forget the invites of a client that leaves, and to a channel that ends', async () => {
    const { alice, bob, carol, state } = await channel()
    await exchange(alice, 'INVITE bob #a', 'INVITE carol #a')
    const server = state()!
    const room = server.channels.get('#a')!
    expect(room.invited.size).toBe(2)
    await bob.send('QUIT')
    await bob.closed
    expect(room.invited.size).toBe(1)
    const invitee = server.nicks.get('carol')!
    expect(invitee.invites.size).toBe(1)
    await exchange(alice, 'PART #a')
    expect(server.channels.size).toBe(0)
    expect(invitee.invites.size).toBe(0)
    // A new channel of the same name is not the one carol was invited to.
    await exchange(alice, 'JOIN #a', 'MODE #a +i')
    expect(await exchange(carol, 'JOIN #a')).toEqual(['473 carol #a :Cannot join channel (+i)'])
  })

  it('Should keep the last invites of a client', async () => {
    const { alice, bob, carol, state } = await channel()
    // Two of them, as a client can not join so many channels.
    for (let i = 0; i <= MAX_INVITES; i++) {
      await exchange(i % 2 ? alice : carol, `JOIN #c${i}`, `INVITE bob #c${i}`)
    }
    const list = await exchange(bob, 'INVITE')
    expect(list).toHaveLength(MAX_INVITES + 1)
    expect(list[0]).toBe('336 bob #c1')
    expect(state()!.channels.get('#c0')!.invited.size).toBe(0)
  })
})

describe('Key (+k)', () => {
  it('Should ask for the key, and match the keys to the channels in order', async () => {
    const { alice, bob } = await channel()
    await exchange(alice, 'JOIN #b')
    expect(await exchange(alice, 'MODE #a +k secret', 'MODE #b +k other')).toEqual([
      'MODE #a +k secret',
      'MODE #b +k other',
    ])
    expect(await exchange(bob, 'JOIN #a', 'JOIN #a wrong', 'JOIN #b,#a other')).toEqual([
      '475 bob #a :Cannot join channel (+k)',
      '475 bob #a :Cannot join channel (+k)',
      'JOIN #b',
      '353 bob = #b :@alice bob',
      '366 bob #b :End of /NAMES list',
      '475 bob #a :Cannot join channel (+k)',
    ])
    expect(codes(await exchange(bob, 'JOIN #c,#a,#d x,secret'))).toEqual([
      'JOIN',
      '353',
      '366',
      'JOIN',
      '353',
      '366',
      'JOIN',
      '353',
      '366',
    ])
  })

  it('Should show the key only to the members', async () => {
    const { alice, carol } = await channel()
    await exchange(alice, 'MODE #a +kl secret 10')
    expect((await exchange(alice, 'MODE #a'))[0]).toBe('324 alice #a +klnt secret 10')
    expect((await exchange(carol, 'MODE #a'))[0]).toBe('324 carol #a +klnt')
  })

  it('Should reject a key that is not valid, and remove it with any parameter', async () => {
    const { alice, bob } = await channel()
    expect(
      await exchange(alice, 'MODE #a +k a,b', `MODE #a +k ${'k'.repeat(24)}`, 'MODE #a +k')
    ).toEqual(['696 alice #a k a,b :Invalid key', `696 alice #a k ${'k'.repeat(24)} :Invalid key`])
    expect(await exchange(alice, 'MODE #a +k key', 'MODE #a -k whatever', 'MODE #a -k')).toEqual([
      'MODE #a +k key',
      'MODE #a -k *',
    ])
    expect(codes(await exchange(bob, 'JOIN #a'))).toEqual(['JOIN', '353', '366'])
  })

  it('Should let only an operator set it', async () => {
    const { bob } = await channel()
    await exchange(bob, 'JOIN #a')
    expect(await exchange(bob, 'MODE #a +k key')).toEqual([
      "482 bob #a :You're not channel operator",
    ])
  })
})

describe('Limit (+l)', () => {
  it('Should keep the channel to the limit, which an invite gets around', async () => {
    const { alice, bob, carol } = await channel()
    expect(await exchange(alice, 'MODE #a +l 2', 'MODE #a +l 2')).toEqual(['MODE #a +l 2'])
    await exchange(bob, 'JOIN #a')
    expect(await exchange(carol, 'JOIN #a')).toEqual(['471 carol #a :Cannot join channel (+l)'])
    await exchange(alice, 'INVITE carol #a')
    expect(codes(await exchange(carol, 'JOIN #a'))).toEqual(['JOIN', '353', '366'])
    expect(await exchange(alice, 'MODE #a -l', 'MODE #a -l')).toEqual(['MODE #a -l'])
  })

  it('Should reject a limit that is not a positive number, and ignore one without a value', async () => {
    const { alice } = await channel()
    expect(
      await exchange(alice, 'MODE #a +l 0', 'MODE #a +l x', 'MODE #a +l 1234567890', 'MODE #a +l')
    ).toEqual([
      '696 alice #a l 0 :Invalid limit',
      '696 alice #a l x :Invalid limit',
      '696 alice #a l 1234567890 :Invalid limit',
    ])
    // `-l` takes no parameter, so the next mode gets it, and `-k` takes one, even without a key.
    expect(await exchange(alice, 'MODE #a +l 5', 'MODE #a -l+v alice')).toEqual([
      'MODE #a +l 5',
      'MODE #a -l+v alice',
    ])
    expect(await exchange(alice, 'MODE #a -k+v alice')).toEqual([])
  })

  it('Should tell the limit of a channel from the limit of the server', async () => {
    const { register } = setup({ maxChannels: 1 })
    const alice = await register('alice')
    const bob = await register('bob')
    await exchange(alice, 'JOIN #a', 'MODE #a +l 1')
    expect(await exchange(bob, 'JOIN #a,#b')).toEqual([
      '471 bob #a :Cannot join channel (+l)',
      '471 bob #b :Cannot join channel (too many channels)',
    ])
  })
})

describe('Bans (+b) and exceptions (+e, +I)', () => {
  it('Should keep a list of masks in their full form', async () => {
    const { alice, carol } = await channel()
    const lines = await exchange(alice, 'MODE #a +bbb Bob *@host.example u@h', 'MODE #a +b bob')
    expect(lines).toEqual(['MODE #a +bbb Bob!*@* *!*@host.example *!u@h'])
    expect(await exchange(alice, 'MODE #a b')).toEqual([
      expect.stringMatching(/^367 alice #a Bob!\*@\* alice!~alice@\S+ \d+$/),
      expect.stringMatching(/^367 alice #a \*!\*@host\.example alice!\S+ \d+$/),
      expect.stringMatching(/^367 alice #a \*!u@h alice!\S+ \d+$/),
      '368 alice #a :End of channel ban list',
    ])
    expect(await exchange(alice, 'MODE #a -b+b BOB!*@* n!u', 'MODE #a -b nobody')).toEqual([
      'MODE #a -b+b Bob!*@* n!u@*',
    ])
    // Anyone may see the bans of a channel that is not secret.
    expect(codes(await exchange(carol, 'MODE #a +b'))).toEqual(['367', '367', '367', '368'])
    expect(await exchange(carol, 'MODE #a +b x')).toEqual([
      "482 carol #a :You're not channel operator",
    ])
  })

  it('Should keep a banned client out, unless it is excepted', async () => {
    const { alice, bob, carol } = await channel()
    await exchange(alice, 'MODE #a +b *!*@*')
    expect(await exchange(bob, 'JOIN #a')).toEqual(['474 bob #a :Cannot join channel (+b)'])
    // An invite does not get around a ban.
    await exchange(alice, 'INVITE bob #a')
    expect(await exchange(bob, 'JOIN #a')).toEqual(['474 bob #a :Cannot join channel (+b)'])
    expect(await exchange(alice, 'MODE #a +e b?b!*@*')).toEqual(['MODE #a +e b?b!*@*'])
    expect(codes(await exchange(bob, 'JOIN #a'))).toEqual(['JOIN', '353', '366'])
    expect(await exchange(carol, 'JOIN #a')).toEqual(['474 carol #a :Cannot join channel (+b)'])
  })

  it('Should let a client with an invite exception into an invite-only channel', async () => {
    const { alice, bob, carol } = await channel()
    await exchange(alice, 'MODE #a +iI carol!*@*')
    expect(await exchange(bob, 'JOIN #a')).toEqual(['473 bob #a :Cannot join channel (+i)'])
    expect(codes(await exchange(carol, 'JOIN #a'))).toEqual(['JOIN', '353', '366'])
  })

  it('Should show the exceptions only to operators', async () => {
    const { alice, bob } = await channel()
    await exchange(alice, 'MODE #a +eI x y')
    await exchange(bob, 'JOIN #a')
    expect(await exchange(bob, 'MODE #a e', 'MODE #a I')).toEqual([
      "482 bob #a :You're not channel operator",
      "482 bob #a :You're not channel operator",
    ])
    expect(await exchange(alice, 'MODE #a eIe')).toEqual([
      expect.stringMatching(/^348 alice #a x!\*@\* /),
      '349 alice #a :End of channel exception list',
      expect.stringMatching(/^346 alice #a y!\*@\* /),
      '347 alice #a :End of Channel Invite Exception List',
    ])
  })

  it('Should keep a banned member quiet, and its nickname, unless it has voice', async () => {
    const { alice, bob } = await channel()
    await exchange(bob, 'JOIN #a')
    await exchange(alice, 'MODE #a +b bob!*@*')
    expect(await exchange(bob, 'PRIVMSG #a :hi', 'NICK robert')).toEqual([
      '404 bob #a :Cannot send to channel',
      '435 bob robert #a :Cannot change nickname while banned on channel',
    ])
    await exchange(alice, 'MODE #a +v bob')
    expect(await exchange(bob, 'PRIVMSG #a :hi')).toEqual([])
    expect(await alice.waitFor(/ PRIVMSG /)).toMatch(/:bob!\S+ PRIVMSG #a hi$/)
    expect(await exchange(bob, 'NICK robert')).toEqual(['NICK robert'])
  })

  it('Should keep a banned member from sending a TAGMSG or a multiline message', async () => {
    const { register } = setup()
    const caps = ['batch', 'draft/multiline', 'message-tags', 'echo-message']
    const alice = await register('alice', caps)
    const bob = await register('bob', caps)
    await exchange(alice, 'JOIN #a')
    await exchange(bob, 'JOIN #a')
    await exchange(alice, 'MODE #a +b bob')
    const multiline = [
      'BATCH +ml draft/multiline #a',
      '@batch=ml PRIVMSG #a hello',
      '@batch=ml PRIVMSG #a :again',
      'BATCH -ml',
    ]
    expect(await exchange(bob, '@+typing=active TAGMSG #a', ...multiline)).toEqual([
      '404 bob #a :Cannot send to channel',
      '404 bob #a :Cannot send to channel',
    ])
    await exchange(alice)
    expect(alice.lines.filter((line) => /:bob!\S+ (TAGMSG|BATCH|PRIVMSG) /.test(line))).toEqual([])
    // With voice, both go through.
    await exchange(alice, 'MODE #a +v bob')
    expect(
      (await exchange(bob, '@+typing=active TAGMSG #a', ...multiline)).filter(
        (line) => !line.startsWith('BATCH') && !line.startsWith('PRIVMSG')
      )
    ).toEqual(['TAGMSG #a'])
    expect(await alice.waitFor(/ BATCH -/)).toMatch(/^:bob!\S+ BATCH -\S+$/)
    expect(alice.lines.filter((line) => /:bob!\S+ PRIVMSG #a /.test(line))).toHaveLength(2)
  })

  it('Should keep a banned client from sending from outside', async () => {
    const { alice, carol } = await channel()
    await exchange(alice, 'MODE #a -n+b carol')
    expect(await exchange(carol, 'PRIVMSG #a :hi')).toEqual([
      '404 carol #a :Cannot send to channel',
    ])
  })

  it('Should match the wildcards and the escapes, and fold the case', async () => {
    const { alice, bob, carol, register } = await channel()
    const odd = await register('a\\b')
    await exchange(alice, 'MODE #a +b ?OB!~*@*.user', 'MODE #a +b a\\b')
    expect(codes(await exchange(bob, 'JOIN #a'))).toEqual(['474'])
    expect(codes(await exchange(carol, 'JOIN #a'))).toEqual(['JOIN', '353', '366'])
    expect(codes(await exchange(odd, 'JOIN #a'))).toEqual(['474'])
    // `\*` is a star, which no nickname has.
    await exchange(alice, 'MODE #a -bb ?OB!~*@*.user a\\b!*@*', 'MODE #a +b c\\*')
    expect(codes(await exchange(bob, 'JOIN #a'))).toEqual(['JOIN', '353', '366'])
  })

  it('Should match a mask with many stars quickly', async () => {
    const { alice, bob } = await channel()
    const mask = '*a'.repeat(40) + '*b!*@*'
    await exchange(alice, `MODE #a +b ${mask}`)
    const start = Date.now()
    expect(await exchange(bob, 'NICK aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'JOIN #a')).toHaveLength(4)
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('Should reject a mask that is not valid', async () => {
    const { alice } = await channel()
    expect(
      await exchange(alice, `MODE #a +b ${'x'.repeat(100)}`, 'MODE #a +b :a b', 'MODE #a +b ::x')
    ).toEqual([
      `696 alice #a b ${'x'.repeat(100)} :Invalid mask`,
      '696 alice #a b a :Invalid mask',
      '696 alice #a b * :Invalid mask',
    ])
  })

  it('Should limit the lists of a channel together', async () => {
    const { alice } = await channel()
    for (let i = 0; i < MAX_LIST; i += 4) {
      await exchange(alice, `MODE #a +beIb m${i} m${i + 1} m${i + 2} m${i + 3}`)
    }
    expect(await exchange(alice, 'MODE #a +b m0', 'MODE #a +e full')).toEqual([
      '478 alice #a full!*@* :Channel list is full',
    ])
    expect(await exchange(alice, 'MODE #a -b+e m0 full')).toEqual(['MODE #a -b+e m0!*@* full!*@*'])
  })
})

describe('MODE', () => {
  it('Should apply at most MODES changes with a parameter', async () => {
    const { alice } = await channel()
    expect(await exchange(alice, 'MODE #a +bbbbbm a b c d e')).toEqual([
      'MODE #a +bbbbm a!*@* b!*@* c!*@* d!*@*',
    ])
  })

  it('Should split a change that does not fit in a line', async () => {
    const { register } = setup()
    const alice = await register('a'.repeat(30))
    const bob = await register('bob')
    const name = '#' + 'c'.repeat(49)
    await exchange(alice, `JOIN ${name}`)
    await exchange(bob, `JOIN ${name}`)
    // Four masks of 100 bytes.
    const masks = ['a', 'b', 'c', 'd'].map(
      (c) => `${c.repeat(40)}!${'u'.repeat(20)}@${'h'.repeat(38)}`
    )
    await exchange(alice, `MODE ${name} +bbbb ${masks.join(' ')}`)
    await exchange(bob)
    const lines = bob.lines.filter((line) => / MODE #c/.test(line))
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(Buffer.byteLength(line) + 2).toBeLessThanOrEqual(512)
    }
    expect(lines.flatMap((line) => line.split(' ').slice(4))).toEqual(masks)
  })

  it('Should answer an unknown mode, and keep the old replies', async () => {
    const { alice, bob } = await channel()
    expect(await exchange(alice, 'MODE #a +xs')).toEqual([
      'MODE #a +s',
      '472 alice x :is unknown mode char to me',
    ])
    await exchange(bob, 'JOIN #a')
    expect(await exchange(bob, 'MODE #a +m')).toEqual(["482 bob #a :You're not channel operator"])
  })
})

describe('Secret (+s)', () => {
  it('Should hide the channel from those outside it', async () => {
    const { alice, bob, carol } = await channel()
    await exchange(alice, 'MODE #a +s', 'TOPIC #a :hidden', 'JOIN #b')
    await exchange(bob, 'JOIN #a', 'JOIN #b')
    expect(await exchange(carol, 'LIST', 'NAMES #a', 'WHO #a', 'TOPIC #a', 'MODE #a b')).toEqual([
      '321 carol Channel :Users  Name',
      '322 carol #b 2 :',
      '323 carol :End of /LIST',
      '366 carol #a :End of /NAMES list',
      '315 carol #a :End of /WHO list',
      "442 carol #a :You're not on that channel",
      '368 carol #a :End of channel ban list',
    ])
    expect((await exchange(carol, 'WHOIS bob')).find((line) => line.startsWith('319'))).toBe(
      '319 carol bob #b'
    )
    // The members see it, and NAMES marks it as secret.
    expect(await exchange(bob, 'NAMES #a')).toEqual([
      '353 bob @ #a :@alice bob',
      '366 bob #a :End of /NAMES list',
    ])
    expect((await exchange(bob, 'WHOIS alice')).find((line) => line.startsWith('319'))).toBe(
      '319 bob alice :@#a @#b'
    )
    expect(codes(await exchange(bob, 'LIST'))).toEqual(['321', '322', '322', '323'])
  })
})

describe('no-implicit-names', () => {
  it('Should leave out the names after a JOIN, but not after a NAMES', async () => {
    const { register } = setup()
    const alice = await register('alice', ['no-implicit-names'])
    expect(await exchange(alice, 'JOIN #a', 'TOPIC #a :t', 'PART #a', 'JOIN #a')).toEqual([
      'JOIN #a',
      'TOPIC #a t',
      'PART #a',
      'JOIN #a',
    ])
    expect(await exchange(alice, 'NAMES #a')).toEqual([
      '353 alice = #a @alice',
      '366 alice #a :End of /NAMES list',
    ])
  })
})
