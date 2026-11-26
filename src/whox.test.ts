import { describe, expect, it } from 'vite-plus/test'
import { exchange, isupport, setup } from './test-utils.ts'

describe('WHOX', () => {
  it('Should advertise WHOX and reply with the fields that are asked for, in order', async () => {
    const { register } = setup()
    const alice = await register('alice', ['multi-prefix'])
    const bob = await register('bob')
    expect(isupport(alice.lines)).toContain('WHOX')
    await exchange(alice, 'JOIN #a', 'MODE #a +v alice')
    await exchange(bob, 'JOIN #a', 'AWAY :lunch')
    const host = (await exchange(alice, 'WHO alice'))[0].split(' ')[4]
    expect(await exchange(alice, 'WHO #a %rnafotcuihsdl,42')).toEqual([
      expect.stringMatching(
        new RegExp(
          `^354 alice 42 #a ~alice 255\\.255\\.255\\.255 ${host.replace(/\./g, '\\.')} ` +
            'irc\\.hono\\.local alice H@\\+ 0 \\d+ 0 n/a :alice the user$'
        )
      ),
      expect.stringMatching(
        /^354 alice 42 #a ~bob 255\.255\.255\.255 \S+ irc\.hono\.local bob G 0 \d+ 0 n\/a :bob the user$/
      ),
      '315 alice #a :End of /WHO list',
    ])
    // The fields of irc-framework, without the idle time and the address.
    expect(await exchange(alice, 'WHO bob %tcuhsnfdaor,7')).toEqual([
      expect.stringMatching(
        /^354 alice 7 \* ~bob \S+ irc\.hono\.local bob G 0 0 n\/a :bob the user$/
      ),
      '315 alice bob :End of /WHO list',
    ])
  })

  it('Should take only a token of up to three digits, and ignore the unknown fields', async () => {
    const { register } = setup()
    const alice = await register('alice')
    expect(
      await exchange(alice, 'WHO alice %tn,1234', 'WHO alice %tn', 'WHO alice %nxyz', 'WHO alice %')
    ).toEqual([
      '354 alice 0 alice',
      '315 alice alice :End of /WHO list',
      '354 alice 0 alice',
      '315 alice alice :End of /WHO list',
      '354 alice alice',
      '315 alice alice :End of /WHO list',
      '354 alice',
      '315 alice alice :End of /WHO list',
    ])
    // Without `%`, it is the plain WHO.
    expect(await exchange(alice, 'WHO alice o')).toEqual([
      expect.stringMatching(/^352 alice \* ~alice \S+ irc\.hono\.local alice H :0 alice the user$/),
      '315 alice alice :End of /WHO list',
    ])
  })

  it('Should hide the invisible members and the secret channels from outside', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    const carol = await register('carol')
    await exchange(alice, 'MODE alice +i', 'JOIN #a', 'JOIN #s', 'MODE #s +s')
    await exchange(bob, 'JOIN #a', 'JOIN #s')
    expect(await exchange(carol, 'WHO #a %n', 'WHO #s %n')).toEqual([
      '354 carol bob',
      '315 carol #a :End of /WHO list',
      '315 carol #s :End of /WHO list',
    ])
    expect(await exchange(bob, 'WHO #s %n')).toEqual([
      '354 bob alice',
      '354 bob bob',
      '315 bob #s :End of /WHO list',
    ])
  })
})
