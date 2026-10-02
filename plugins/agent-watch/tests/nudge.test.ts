import { expect, test } from 'claude-code/testing'

import { MINUTE, start, submit, world } from './world'

const WARNING = 'Hey elio, be aware you are already running 3 agents.'

test('warns on submit when the other sessions reach the limit', async ($, on) => {
  const w = world(on)
  w.seed('beta', 'working')
  w.seed('gamma', 'working')
  w.seed('delta', 'waiting')
  w.seed('epsilon', 'idle')
  await start($)

  const sent = await submit($)
  expect(sent.drop).toBeUndefined()
  expect(w.toasts).toContain(WARNING)
  expect(w.own().status).toBe('working')
})

test('stays quiet under the limit, and idle sessions do not count', async ($, on) => {
  const w = world(on)
  w.seed('beta', 'working')
  w.seed('gamma', 'waiting')
  w.seed('delta', 'idle')
  w.seed('epsilon', 'idle')
  await start($)

  await submit($)
  expect(w.toasts.filter(text => text.startsWith('Hey'))).toEqual([])
})

test('greets by the configured name', { options: { name: 'Elio', limit: 1 } }, async ($, on) => {
  const w = world(on)
  w.seed('beta', 'working')
  await start($)

  await submit($)
  expect(w.toasts).toContain('Hey Elio, be aware you are already running 1 agent.')
})

test('leaves a prompt typed over a running turn alone', async ($, on) => {
  const w = world(on)
  w.seed('beta', 'working')
  w.seed('gamma', 'working')
  w.seed('delta', 'working')
  await start($)

  await $.prompt.submit({ text: 'also', wait: false, turnId: 't1', origin: { kind: 'composer' } })
  expect(w.toasts).toEqual([])
})

test('strict mode holds the prompt until it is sent again', { options: { strict: true } }, async ($, on) => {
  const w = world(on)
  w.seed('beta', 'working')
  w.seed('gamma', 'working')
  w.seed('delta', 'working')
  await start($)

  const held = await submit($, 'refactor it')
  expect(held.drop).toContain(WARNING)
  expect(held.drop).toContain('Press Enter again')
  expect(w.own().status).toBe('idle')
  await w.clock.advance(100)
  expect(w.fills).toEqual(['refactor it'])

  const sent = await submit($, 'refactor it')
  expect(sent.drop).toBeUndefined()
  expect(w.own().status).toBe('working')
})

test('counts this session\'s running subagents when asked', { options: { countSubagents: true } }, async ($, on) => {
  const w = world(on, {
    agents: [
      { id: 'a1', description: 'scan', type: 'Explore', status: 'running' },
      { id: 'a2', description: 'done', type: 'Explore', status: 'completed' },
    ],
  })
  w.seed('beta', 'working')
  w.seed('gamma', 'working')
  await start($)

  await submit($)
  expect(w.toasts).toContain(WARNING)
})

test('nudges once per state about a session forgotten past idleMinutes', async ($, on) => {
  const w = world(on)
  const betaSince = w.clock.now() - 31 * MINUTE
  const gammaSince = w.clock.now() - 29 * MINUTE - 45_000
  w.seed('beta', 'idle', { since: betaSince })
  w.seed('gamma', 'waiting', { since: gammaSince })
  await start($)
  expect(w.toasts).toEqual(['Agent Watch: beta idle for 31m'])

  // Both keep beating; gamma crosses 30 minutes on the next heartbeat.
  w.seed('beta', 'idle', { since: betaSince })
  w.seed('gamma', 'waiting', { since: gammaSince })
  await w.clock.advance(30_000)
  w.seed('beta', 'idle', { since: betaSince })
  w.seed('gamma', 'waiting', { since: gammaSince })
  await w.clock.advance(30_000)
  expect(w.toasts).toEqual([
    'Agent Watch: beta idle for 31m',
    'Agent Watch: gamma waiting on you for 30m',
  ])

  // A new state is a new nudge once it is forgotten in turn.
  const later = w.clock.now() - 40 * MINUTE
  w.seed('beta', 'waiting', { since: later })
  w.seed('gamma', 'waiting', { since: gammaSince })
  await w.clock.advance(30_000)
  expect(w.toasts.at(-1)).toBe('Agent Watch: beta waiting on you for 40m')
  expect(w.toasts.length).toBe(3)
})

test('only the session prompted last sends the forgotten nudge', async ($, on) => {
  const w = world(on)
  const now = w.clock.now()
  w.seed('beta', 'idle', { since: now - 45 * MINUTE })
  // You typed in gamma a minute ago: gamma nudges, this session stays quiet.
  w.seed('gamma', 'working', { since: now - MINUTE, prompted: now - MINUTE })
  await start($)
  expect(w.toasts).toEqual([])

  // You switch to this session and prompt: it leads now, but beta was
  // already seen while gamma led, so it is not nudged a second time.
  await submit($)
  w.seed('beta', 'idle', { since: now - 45 * MINUTE })
  w.seed('gamma', 'working', { since: now - MINUTE, prompted: now - MINUTE })
  await w.clock.advance(30_000)
  expect(w.own().prompted).toBe(now)
  expect(w.toasts).toEqual([])

  // A session forgotten after the switch is nudged here.
  w.seed('beta', 'idle', { since: now - 45 * MINUTE })
  w.seed('gamma', 'idle', { since: now - 31 * MINUTE, prompted: now - MINUTE })
  await w.clock.advance(30_000)
  expect(w.toasts).toEqual(['Agent Watch: gamma idle for 32m'])
})

test('a session forgotten itself never leads the nudges', async ($, on) => {
  const w = world(on)
  const now = w.clock.now()
  // Prompted last, but idle for an hour: you are not there.
  w.seed('beta', 'idle', { since: now - 60 * MINUTE, prompted: now - 61 * MINUTE })
  w.seed('gamma', 'waiting', { since: now - 40 * MINUTE })
  await start($)
  expect(w.toasts).toEqual([
    'Agent Watch: 2 sessions need you: beta idle for 1h 0m, gamma waiting on you for 40m',
  ])
})
