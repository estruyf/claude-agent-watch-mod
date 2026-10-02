import { expect, test } from 'claude-code/testing'

import { MINUTE, PANE_PROPS, run, start, submit, world } from './world'

test('/agents-limit sets, shows and resets the limit', async ($, on) => {
  const w = world(on)
  w.seed('beta', 'working')
  w.seed('gamma', 'waiting')
  await start($)

  await submit($)
  expect(w.toasts).toEqual([])

  const set = await run($, 'agents-limit', '2')
  expect(set.text).toBe('Agent limit set to 2.')

  await submit($, 'again')
  expect(w.toasts).toEqual(['Hey elio, be aware you are already running 2 agents.'])

  const shown = await run($, 'agents-limit', '')
  expect(shown.text).toBe('Agent limit: 2 (set with /agents-limit).')

  const reset = await run($, 'agents-limit', 'reset')
  expect(reset.text).toBe('Agent limit reset to 3 from the plugin config.')

  await submit($, 'once more')
  expect(w.toasts.length).toBe(1)
})

test('/agents-limit refuses what is not a whole number', async ($, on) => {
  world(on)
  await start($)
  for (const args of ['0', '-1', '2.5', 'many']) {
    const ran = await run($, 'agents-limit', args)
    expect(ran.text).toContain('Usage: /agents-limit <n>')
  }
})

test('a stored override survives into the next session', { options: { limit: 5 } }, async ($, on) => {
  const w = world(on, { store: { limit: 1 } })
  w.seed('beta', 'working')
  await start($)
  await submit($)
  expect(w.toasts).toEqual(['Hey elio, be aware you are already running 1 agent.'])
})

test('/agents-list opens a pane: waiting first, then idle longest first, then working', async ($, on) => {
  const w = world(on)
  const now = w.clock.now()
  w.seed('busy', 'working', { since: now - 50 * MINUTE })
  w.seed('asks', 'waiting', { since: now - 3 * MINUTE })
  w.seed('napping', 'idle', { since: now - 90 * MINUTE })
  w.seed('resting', 'idle', { since: now - 10 * MINUTE })
  await start($)

  const ran = await run($, 'agents-list', '')
  expect(ran.text).toBe('Agent Watch: 1 working · 1 waiting · 3 idle (limit 3).')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-watch',
      surface,
      component: 'Pane',
      requestId: 'agent-watch',
      props: PANE_PROPS,
    })
    const rows = await ui.findAll({ text: /^(asks|napping|resting|busy|alpha)/ })
    expect(rows.map(row => row.text)).toEqual([
      'asks',
      'napping',
      'resting',
      'alpha (this one)',
      'busy',
    ])
    expect(await ui.find({ text: '1h 30m' })).toBeDefined()
    expect(await ui.find({ text: /2 of 3 running/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a command name the engine refuses does not stop the heartbeat', async ($, on) => {
  const w = world(on, { refuse: ['agents-list'] })
  await start($)
  expect(w.own().status).toBe('idle')

  const set = await run($, 'agents-limit', '4')
  expect(set.text).toBe('Agent limit set to 4.')
  await w.clock.advance(30_000)
  expect(w.own().heartbeat).toBe(w.clock.now())
})
