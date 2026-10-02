import { expect, test } from 'claude-code/testing'

import { BAND_PROPS, MINUTE, SELF, start, world } from './world'

test('counts the live sessions across every status file', async ($, on) => {
  const w = world(on)
  w.seed('beta', 'working')
  w.seed('gamma', 'working')
  w.seed('delta', 'waiting')
  w.seed('epsilon', 'idle')
  w.seed('zeta', 'ended')
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-watch',
      surface,
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })
    // This session is idle too: 2 idle, the ended one left out.
    expect(await ui.find({ text: /2 working · 1 waiting · 2 idle/ })).toBeDefined()
    await ui.unmount()
  }
})

test('writes its own status file and keeps it beating', async ($, on) => {
  const w = world(on)
  await start($)
  const first = w.own()
  expect(first.id).toBe(SELF)
  expect(first.cwd).toBe('/work/alpha')
  expect(first.status).toBe('idle')

  await w.clock.advance(30_000)
  expect(w.own().heartbeat).toBe(first.heartbeat + 30_000)
  expect(w.own().since).toBe(first.since)
})

test('a session picked up between heartbeats shows within ten seconds', async ($, on) => {
  const w = world(on)
  await start($)
  w.seed('late', 'working')
  await w.clock.advance(10_000)

  const ui = await $.ui.mount({
    plugin: 'agent-watch',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await ui.find({ text: /1 working · 1 idle/ })).toBeDefined()
})

test('the band steps aside alone and under a survey', async ($, on) => {
  const w = world(on)
  await start($)

  const alone = await $.ui.mount({
    plugin: 'agent-watch',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await alone.find({ text: /engine drew/ })).toBeDefined()
  await alone.unmount()

  w.seed('beta', 'working', { ago: MINUTE })
  await w.clock.advance(30_000)
  const survey = await $.ui.mount({
    plugin: 'agent-watch',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND_PROPS, hasSurvey: true },
  })
  expect(await survey.find({ text: /engine drew/ })).toBeDefined()
  expect(await survey.find({ text: /working/ })).toBeUndefined()
})
