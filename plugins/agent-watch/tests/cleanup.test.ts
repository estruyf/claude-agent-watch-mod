import { expect, test } from 'claude-code/testing'

import { BAND_PROPS, fileOf, MINUTE, start, submit, world } from './world'

test('a stale heartbeat does not count, then is pruned once old', async ($, on) => {
  const w = world(on)
  w.seed('beta', 'working')
  w.seed('gamma', 'working')
  // Crashed sessions: their files still say working.
  w.seed('stale-1', 'working', { ago: 3 * MINUTE })
  w.seed('stale-2', 'waiting', { ago: 61 * MINUTE })
  w.seed('gone', 'ended', { ago: 2 * 60 * MINUTE })
  await start($)

  await submit($)
  expect(w.toasts).toEqual([])

  const ui = await $.ui.mount({
    plugin: 'agent-watch',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await ui.find({ text: /^3 working$/ })).toBeDefined()

  // Over an hour old: removed. Recently stale: kept on disk, ignored.
  expect(w.files.has(fileOf('stale-2'))).toBe(false)
  expect(w.files.has(fileOf('gone'))).toBe(false)
  expect(w.files.has(fileOf('stale-1'))).toBe(true)
  expect(w.runs[0]?.slice(0, 3)).toEqual(['rm', '-f', '--'])
})

test('a session that stops beating drops out after two minutes', async ($, on) => {
  const w = world(on)
  w.seed('beta', 'working')
  await start($)
  const band = () =>
    $.ui.mount({ plugin: 'agent-watch', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

  expect(await (await band()).find({ text: /1 working/ })).toBeDefined()
  await w.clock.advance(2 * MINUTE + 30_000)
  expect(await (await band()).find({ text: /engine drew/ })).toBeDefined()
})

test('files that are not status files are skipped', async ($, on) => {
  const w = world(on)
  w.files.set(fileOf('broken'), '{ not json')
  w.files.set(fileOf('odd'), JSON.stringify({ id: 'odd', status: 'dancing' }))
  w.seed('beta', 'working')
  await start($)

  const ui = await $.ui.mount({
    plugin: 'agent-watch',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await ui.find({ text: /1 working · 1 idle/ })).toBeDefined()
})
