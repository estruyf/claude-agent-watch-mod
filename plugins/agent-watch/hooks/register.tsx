import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  HEARTBEAT_MS,
  isLive,
  isPrunable,
  isSafeId,
  parseRecord,
  readOptions,
} from './shared'
import type { AgentRecord, AgentSelf } from './shared'

type Engine = EngineInterface

const sessions = atom({ plugin: 'agent-watch', key: 'sessions' } as const, [])
const checkedAt = atom({ plugin: 'agent-watch', key: 'checkedAt' } as const, 0)
const self = atom({ plugin: 'agent-watch', key: 'self' } as const, null)
const limit = atom({ plugin: 'agent-watch', key: 'limit' } as const, 3)
const subagents = atom({ plugin: 'agent-watch', key: 'subagents' } as const, 0)
const nudged = atom({ plugin: 'agent-watch', key: 'nudged' } as const, [])
const pendingConfirm = atom(
  { plugin: 'agent-watch', key: 'pendingConfirm' } as const,
  null,
)

// ---------------------------------------------------------------------------
// Registry: one status file per session in ~/.claude/agent-watch/<id>.json
// ---------------------------------------------------------------------------

/** `~/.claude/agent-watch`, or under CLAUDE_CONFIG_DIR when that is set. */
const watchDir = async ($: Engine): Promise<string> => {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  const base = configDir !== undefined && configDir !== '' ? configDir : `${home}/.claude`

  return `${base.replace(/[\\/]+$/, '')}/agent-watch`
}

const fileOf = (dir: string, id: string) => `${dir}/${id}.json`

const writeRecord = async ($: Engine, record: AgentRecord): Promise<void> => {
  if (!isSafeId(record.id)) return
  const dir = await watchDir($)
  await $.fs.write(fileOf(dir, record.id), `${JSON.stringify(record, null, 2)}\n`)
}

/**
 * This session's own status, minted on first use and again when the session
 * id changed under it (a /clear goes on under a new id).
 */
const ensureSelf = async ($: Engine): Promise<AgentSelf> => {
  const id = await $.session.id()
  const held = await read($, self)
  if (held !== null && held.id === id) return held

  const fresh: AgentSelf = { id, status: 'idle', since: await $.clock.now(), before: null }
  await update($, self, () => fresh)

  return fresh
}

/** Writes this session's file with a fresh heartbeat and mirrors it in state. */
const writeSelf = async ($: Engine): Promise<AgentRecord> => {
  const own = await ensureSelf($)
  const record: AgentRecord = {
    id: own.id,
    cwd: await $.session.cwd(),
    status: own.status,
    since: own.since,
    heartbeat: await $.clock.now(),
  }
  await writeRecord($, record)
  await update($, sessions, list => {
    const others = list.filter(one => one.id !== record.id)

    return record.status === 'ended' ? others : [...others, record]
  })

  return record
}

/** Moves this session to `status`; `since` only moves when the status does. */
const moveTo = async (
  $: Engine,
  change: (own: AgentSelf) => AgentSelf,
): Promise<void> => {
  const own = await ensureSelf($)
  const next = change(own)
  if (next === own) return
  const now = await $.clock.now()
  await update($, self, () =>
    next.status === own.status ? next : { ...next, since: now },
  )
  await writeSelf($)
}

const toWorking = ($: Engine) =>
  moveTo($, own =>
    own.status === 'working' ? own : { ...own, status: 'working', before: null },
  )

const toIdle = ($: Engine) =>
  moveTo($, own => (own.status === 'idle' ? own : { ...own, status: 'idle', before: null }))

/** Blocked on the person: remembers where to return once they answer. */
const toWaiting = ($: Engine) =>
  moveTo($, own =>
    own.status === 'waiting' ? own : { ...own, status: 'waiting', before: own.status },
  )

/** The person answered: back to what the session was doing before. */
const resolveWait = ($: Engine) =>
  moveTo($, own =>
    own.status !== 'waiting'
      ? own
      : { ...own, status: own.before ?? 'working', before: null },
  )

/** Marks a session's file ended; the session that owns it is going away. */
const markEnded = async ($: Engine, id: string): Promise<void> => {
  const own = await read($, self)
  const now = await $.clock.now()
  const record: AgentRecord = {
    id,
    cwd: await $.session.cwd(),
    status: 'ended',
    since: now,
    heartbeat: now,
  }
  await writeRecord($, record)
  await update($, sessions, list => list.filter(one => one.id !== id))
  if (own !== null && own.id === id) {
    const ended: AgentSelf = { ...own, status: 'ended', since: now, before: null }
    await update($, self, () => ended)
  }
}

/** Every status file in the watch folder, parsed; files that do not parse are skipped. */
const readAll = async ($: Engine): Promise<AgentRecord[]> => {
  const dir = await watchDir($)
  const entries = await $.fs.list(dir).catch(() => [])
  const records = await Promise.all(
    entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
      .map(async entry => {
        const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => '')

        return typeof text === 'string' ? parseRecord(text) : undefined
      }),
  )

  return records.filter((one): one is AgentRecord => one !== undefined)
}

/**
 * Removes ended and stale files older than an hour. `$.fs` has no delete, so
 * this goes through `rm`; where that is not there the files are only ignored.
 */
const prune = async ($: Engine, records: readonly AgentRecord[], now: number) => {
  const dir = await watchDir($)
  const old = records.filter(one => isPrunable(one, now) && isSafeId(one.id))
  if (old.length === 0) return 0
  const paths = old.map(one => fileOf(dir, one.id))
  const ran = await $.process
    .run(['rm', '-f', '--', ...paths], { timeoutMs: 5_000 })
    .catch(() => undefined)

  return ran?.exitCode === 0 ? old.length : 0
}

/**
 * The heartbeat: writes this session's file, reads every session's, keeps the
 * live ones in state and prunes the old ones.
 */
const refresh = async (
  $: Engine,
  options: { countSubagents: boolean; isPruning?: boolean },
): Promise<AgentRecord[]> => {
  const own = await writeSelf($)
  const now = await $.clock.now()
  const all = await readAll($)
  const live = all.filter(one => isLive(one, now) && one.id !== own.id)
  const list = own.status === 'ended' ? live : [...live, own]
  await update($, sessions, () => list)
  await update($, checkedAt, () => now)

  if (options.countSubagents) {
    const running = await $.agent
      .list()
      .then(agents => agents.filter(agent => agent.status === 'running').length)
      .catch(() => 0)
    await update($, subagents, () => running)
  }
  if (options.isPruning !== false) await prune($, all, now)

  return list
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Notification types that are not a wait on the person. */
const NOT_WAITING = new Set(['idle_prompt', 'auth_success'])

export const register: Register = (on, options) => {
  const config = readOptions(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ensureSelf($)
    await refresh($, config)
    $.clock.every(HEARTBEAT_MS, () => {
      void refresh($, config)
    })

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (result.drop === undefined) await toWorking($)

    return result
  })

  // A subagent's run raises no turn.start: this is always the main loop.
  on('turn.start', async ($, e, next) => {
    await toWorking($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await toIdle($)

    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    const isWait = e.agent_id === undefined && !NOT_WAITING.has(e.notification_type)
    if (isWait && (await ensureSelf($)).status === 'working') await toWaiting($)

    return next(e)
  })

  // A permission dialog blocks on the person whichever loop asked for it.
  on('classic.PermissionRequest', async ($, e, next) => {
    await toWaiting($)

    return next(e)
  })

  // A tool call resolves once its dialog was answered and the tool ran.
  on('tool.call', async ($, e, next) => {
    const isQuestion = e.agentId === undefined && String(e.tool) === 'AskUserQuestion'
    if (isQuestion) await toWaiting($)
    const ran = await next(e)
    await resolveWait($)

    return ran
  })

  on('session.end', async ($, e, next) => {
    await markEnded($, e.sessionId)
    const ended = await next(e)
    // A /clear goes on under a new id, with no session.start of its own.
    if (e.reason === 'clear') {
      $.clock.after(500, () => {
        void writeSelf($)
      })
    }

    return ended
  })
}
