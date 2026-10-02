import { expect, test } from 'claude-code/testing'

import { fileOf, SELF, start, submit, world } from './world'

test('working on submit, idle once the turn completes', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.own().status).toBe('idle')

  await submit($)
  expect(w.own().status).toBe('working')
  const workingSince = w.own().since

  await w.clock.advance(5_000)
  await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.own().status).toBe('idle')
  expect(w.own().since).toBe(workingSince + 5_000)
})

test('turn.start marks working too', async ($, on) => {
  const w = world(on)
  await start($)
  await $.turn.start({ text: '', turnId: 't1' })
  expect(w.own().status).toBe('working')
})

test('a permission request is waiting; the answered call goes back to working', async ($, on) => {
  const w = world(on)
  await start($)
  await submit($)

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(w.own().status).toBe('waiting')

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(w.own().status).toBe('working')
})

test('a permission notification is waiting, the idle reminder is not', async ($, on) => {
  const w = world(on)
  await start($)
  await submit($)

  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  expect(w.own().status).toBe('working')

  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  expect(w.own().status).toBe('waiting')
})

test('a notification never turns an idle session into a waiting one', async ($, on) => {
  const w = world(on)
  await start($)
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  expect(w.own().status).toBe('idle')
})

test('subagent turns and notifications do not move the state', async ($, on) => {
  const w = world(on)
  await start($)
  await submit($)

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's1', agentId: 'sub-1', reason: 'answer' })
  expect(w.own().status).toBe('working')

  await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt', agent_id: 'sub-1' })
  expect(w.own().status).toBe('working')
})

test('an interrupted wait ends idle with the turn', async ($, on) => {
  const w = world(on)
  await start($)
  await submit($)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  expect(w.own().status).toBe('idle')
})

test('session.end marks the file ended', async ($, on) => {
  const w = world(on)
  await start($)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SELF, resume: { id: SELF } })
  expect(w.own().status).toBe('ended')
  expect(w.files.has(fileOf(SELF))).toBe(true)
})
