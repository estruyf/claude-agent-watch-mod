import { expect, test } from 'claude-code/testing'

import { BAND_PROPS, SELF, start, world } from './world'

test('a claude -p run writes no status file and is not counted', async ($, on) => {
  const w = world(on, { surfaces: [] })
  w.seed('beta', 'working')
  w.seed('gamma', 'working')
  w.seed('delta', 'working')
  await $.session.start({ cwd: '/work/alpha', surface: null, isInteractive: false })

  const sent = await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'sdk' } })
  expect(sent.drop).toBeUndefined()
  await $.turn.start({ text: 'go', turnId: 't1' })
  await w.clock.advance(30_000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.session.end({ reason: 'other', sessionId: SELF, resume: { id: SELF } })

  expect(w.hasOwn()).toBe(false)
  expect(w.toasts).toEqual([])
})

test('a desktop session counts once its surface attaches', async ($, on) => {
  const w = world(on, { surfaces: [] })
  w.seed('beta', 'working')
  await $.session.start({ cwd: '/work/alpha', surface: null, isInteractive: false })
  expect(w.hasOwn()).toBe(false)

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(w.own().status).toBe('idle')

  const ui = await $.ui.mount({
    plugin: 'agent-watch',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await ui.find({ text: /1 working · 1 idle/ })).toBeDefined()
})

test('an interactive terminal session still counts', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.own().status).toBe('idle')
})
