import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, RenderElement } from 'claude-code'

import type { AgentRecord } from '../types'

export const T0 = Date.UTC(2026, 9, 2, 9, 0, 0)
export const HOME = '/home/elio'
export const DIR = `${HOME}/.claude/agent-watch`
export const SELF = 'self-session'
export const MINUTE = 60_000

export const fileOf = (id: string) => `${DIR}/${id}.json`

/**
 * The world beneath the plugin, in memory: a file system holding the watch
 * folder, a clock at T0, a store, the environment, and the engine's own
 * answers for the events the plugin raises. Records what it was asked.
 */
export const world = (
  on: On,
  options: { store?: Record<string, unknown>; cwd?: string; agents?: AgentInfo[] } = {},
) => {
  const files = new Map<string, string>()
  const toasts: string[] = []
  const runs: string[][] = []
  const fills: string[] = []
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, options.store ?? {})
  mock.env(on, { HOME, USER: 'elio' })

  on('session.id', () => ({ value: SELF }))
  on('session.cwd', () => ({ value: options.cwd ?? '/work/alpha' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('classic.Notification', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PreToolUse', () => ({}))
  on('tool.call', () => ({ result: 'done' }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: options.agents ?? [] }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  // The engine's own drawing, where the plugin leaves a site to it.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine drew this') as RenderElement
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path.replace(/\/$/, '')}/`
    const entries = [...files.keys()]
      .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(path => ({
        name: path.slice(prefix.length),
        kind: 'file' as const,
        size: files.get(path)?.length ?? 0,
        mtimeMs: T0,
        isLink: false,
      }))
    return { value: entries }
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'rm') {
      for (const path of e.argv.slice(1)) files.delete(path)
    }
    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  /** Another session's status file, heard from `ago` ms before T0. */
  const seed = (
    id: string,
    status: AgentRecord['status'],
    extra: { cwd?: string; since?: number; ago?: number } = {},
  ) => {
    const heartbeat = clock.now() - (extra.ago ?? 0)
    const record: AgentRecord = {
      id,
      cwd: extra.cwd ?? `/work/${id}`,
      status,
      since: extra.since ?? heartbeat,
      heartbeat,
    }
    files.set(fileOf(id), JSON.stringify(record))
  }

  const own = (): AgentRecord => JSON.parse(files.get(fileOf(SELF)) ?? 'null')

  return { files, toasts, runs, fills, clock, seed, own }
}

export const start = ($: Engine) =>
  $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })

export const submit = ($: Engine, text = 'go') =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

/** A slash command as the person types it at a wide terminal. */
export const run = ($: Engine, command: string, args = '') =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 3,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 3 },
  view: {},
}

export const PANE_PROPS = {
  title: 'Agents',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}
