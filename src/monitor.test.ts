import { describe, expect, it } from 'vite-plus/test'
import { MAX_MONITOR } from './state.ts'
import { connect, exchange, isupport, setup, strip } from './test-utils.ts'

describe('MONITOR', () => {
  it('Should tell the status of the targets and the changes', async () => {
    const { register, handler } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    expect(isupport(alice.lines)).toContain(`MONITOR=${MAX_MONITOR}`)
    expect(await exchange(alice, 'MONITOR + Bob,carol,bad*nick,bob')).toEqual([
      expect.stringMatching(/^730 alice bob!~bob@\S+$/),
      '731 alice carol',
    ])
    // carol registers.
    const carol = connect(handler)
    await carol.send('NICK carol', 'USER carol 0 * :Carol')
    expect(await alice.waitFor(/ 730 /)).toMatch(/ 730 alice carol!~carol@\S+$/)
    // A change of nickname is offline and online, but not a change of case. carol is taken.
    await exchange(bob, 'NICK BOB', 'NICK robert', 'NICK carol', 'NICK bob')
    await exchange(alice)
    expect(
      alice.lines
        .filter((line) => / 73\d /.test(line))
        .slice(3)
        .map(strip)
    ).toEqual(['731 alice BOB', expect.stringMatching(/^730 alice bob!~bob@\S+$/)])
    // A quit, and a lost connection.
    await bob.send('QUIT')
    expect(await alice.waitFor(/ 731 /)).toMatch(/ 731 alice bob$/)
    await carol.drop()
    expect(await alice.waitFor(/ 731 /)).toMatch(/ 731 alice carol$/)
    expect(await exchange(alice, 'MONITOR S', 'MONITOR L')).toEqual([
      '731 alice Bob,carol',
      '732 alice Bob,carol',
      '733 alice :End of MONITOR list',
    ])
  })

  it('Should remove and clear targets, and answer the missing parameters', async () => {
    const { register } = setup()
    const alice = await register('alice')
    expect(
      await exchange(
        alice,
        'MONITOR + a,b,c',
        'MONITOR - A,x',
        'MONITOR L',
        'MONITOR C',
        'MONITOR L',
        'MONITOR',
        'MONITOR +',
        'MONITOR X'
      )
    ).toEqual([
      '731 alice a,b,c',
      '732 alice b,c',
      '733 alice :End of MONITOR list',
      '733 alice :End of MONITOR list',
      '461 alice MONITOR :Not enough parameters',
      '461 alice MONITOR :Not enough parameters',
    ])
  })

  it('Should limit the list', async () => {
    const { register, state } = setup()
    const alice = await register('alice')
    const nicks = Array.from({ length: MAX_MONITOR - 2 }, (_, i) => `n${i}`)
    for (let i = 0; i < nicks.length; i += 40) {
      await exchange(alice, `MONITOR + ${nicks.slice(i, i + 40).join(',')}`)
    }
    expect(await exchange(alice, 'MONITOR + n0,x1,x2,x3,x4')).toEqual([
      '731 alice n0,x1,x2',
      `734 alice ${MAX_MONITOR} x3,x4 :Monitor list is full.`,
    ])
    expect(state()!.nicks.get('alice')!.monitoring.size).toBe(MAX_MONITOR)
  })

  it('Should leave nothing behind when a client goes', async () => {
    const { register, state } = setup()
    const alice = await register('alice')
    const bob = await register('bob')
    await exchange(alice, 'MONITOR + x,y,bob')
    await exchange(bob, 'MONITOR + x,alice')
    const server = state()!
    expect([...server.monitors.keys()].sort()).toEqual(['alice', 'bob', 'x', 'y'])
    expect(server.monitors.get('x')!.size).toBe(2)
    await alice.send('QUIT')
    await alice.closed
    expect([...server.monitors.keys()].sort()).toEqual(['alice', 'x'])
    await exchange(bob, 'MONITOR - x')
    expect([...server.monitors.keys()]).toEqual(['alice'])
    await bob.drop()
    await bob.closed
    expect(server.monitors.size).toBe(0)
  })
})

describe('extended-monitor', () => {
  it('Should tell AWAY to the clients that monitor and ask for it', async () => {
    const { register } = setup()
    const alice = await register('alice')
    const both = await register('both', ['extended-monitor', 'away-notify'])
    const away = await register('away', ['away-notify'])
    const extended = await register('extended', ['extended-monitor'])
    const member = await register('member', ['extended-monitor', 'away-notify'])
    for (const client of [both, away, extended, member]) {
      await exchange(client, 'MONITOR + alice')
    }
    await exchange(alice, 'JOIN #a')
    await exchange(member, 'JOIN #a')
    await exchange(alice, 'AWAY :lunch', 'AWAY')
    for (const client of [both, away, extended, member]) {
      await exchange(client)
    }
    const aways = (client: typeof alice) =>
      client.lines.filter((line) => / AWAY( |$)/.test(line)).map(strip)
    expect(aways(both)).toEqual(['AWAY lunch', 'AWAY'])
    // Once, though it shares a channel and monitors.
    expect(aways(member)).toEqual(['AWAY lunch', 'AWAY'])
    expect(aways(away)).toEqual([])
    expect(aways(extended)).toEqual([])
  })
})
