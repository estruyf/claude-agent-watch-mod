import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  countOf,
  folderName,
  forgotten,
  formatDuration,
  HEARTBEAT_MS,
  isLive,
  isPrunable,
  isSafeId,
  nudgeKey,
  othersActive,
  parseRecord,
  readOptions,
  sortForPane,
  warningText,
} from './shared'
import type { AgentRecord, AgentSelf, AgentStatus, Options } from './shared'

type Engine = EngineInterface

const PANE = 'agent-watch'

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
// Nudge: the warning at the limit and the toast for forgotten sessions
// ---------------------------------------------------------------------------

/** The `/agents-limit` override from the store, else the configured limit. */
const loadLimit = async ($: Engine, config: Options): Promise<number> => {
  const stored = await $.store.get('limit')
  const value = typeof stored === 'number' && Number.isInteger(stored) && stored > 0
    ? stored
    : config.limit
  await update($, limit, () => value)

  return value
}

const nameOf = async ($: Engine, config: Options): Promise<string> => {
  if (config.name !== '') return config.name
  const user = (await $.env.get('USER')) ?? (await $.env.get('USERNAME'))

  return user !== undefined && user !== '' ? user : 'there'
}

/**
 * Counts the other sessions working or waiting (and this one's running
 * subagents when asked); at or over the limit, warns, or in strict mode holds
 * the prompt until it is sent a second time.
 */
const nudge = async (
  $: Engine,
  config: Options,
  text: string,
): Promise<{ drop: string } | undefined> => {
  const list = await refresh($, { countSubagents: config.countSubagents, isPruning: false })
  const own = await ensureSelf($)
  const extra = config.countSubagents ? await read($, subagents) : 0
  const running = othersActive(list, own.id) + extra
  const max = await loadLimit($, config)

  if (running < max) {
    await update($, pendingConfirm, () => null)
    return undefined
  }
  const warning = warningText(await nameOf($, config), running)
  if (!config.strict) {
    $.ui.toast(warning, { timeoutMs: 6_000 })
    return undefined
  }
  if ((await read($, pendingConfirm)) === text) {
    await update($, pendingConfirm, () => null)
    return undefined
  }
  await update($, pendingConfirm, () => text)
  // Put the prompt back so a second Enter sends it.
  $.clock.after(50, () => {
    void $.prompt.fill({ text })
  })

  return { drop: `${warning} The limit is ${max}. Press Enter again to send it anyway.` }
}

/** One toast for the other sessions idle or waiting longer than idleMinutes. */
const nudgeForgotten = async ($: Engine, config: Options, list: readonly AgentRecord[]) => {
  const own = await ensureSelf($)
  const now = await $.clock.now()
  const seen = await read($, nudged)
  const late = forgotten(list, own.id, now, config.idleMinutes)
  const fresh = late.filter(one => !seen.includes(nudgeKey(one)))
  // Remember only keys that still stand, so the list never grows.
  await update($, nudged, () => late.map(nudgeKey))
  if (fresh.length === 0) return

  const line = (one: AgentRecord) =>
    `${folderName(one.cwd)} ${one.status === 'waiting' ? 'waiting on you' : 'idle'} for ${formatDuration(now - one.since)}`
  $.ui.toast(
    fresh.length === 1
      ? `Agent Watch: ${line(fresh[0] as AgentRecord)}`
      : `Agent Watch: ${fresh.length} sessions need you: ${fresh.map(line).join(', ')}`,
    { timeoutMs: 8_000 },
  )
}

const tick = async ($: Engine, config: Options) => {
  await loadLimit($, config)
  const list = await refresh($, config)
  await nudgeForgotten($, config, list)
}

const LIMIT_USAGE = 'Usage: /agents-limit <n> (a whole number, 1 or more), or /agents-limit reset'

// ---------------------------------------------------------------------------
// Overview: the /agents pane and the band above the prompt
// ---------------------------------------------------------------------------

/** Single-width symbols, no emoji. */
const SYMBOL: Record<AgentStatus, string> = {
  working: '\u25cf', // ●
  waiting: '\u25c6', // ◆
  idle: '\u25cb', // ○
  ended: '\u00b7', // ·
}

const COLOR: Record<AgentStatus, string | undefined> = {
  working: 'green',
  waiting: 'yellow',
  idle: undefined,
  ended: undefined,
}

/** `3 working · 1 waiting · 2 idle`, leaving out the states with none. */
const summaryOf = (list: readonly AgentRecord[]): string => {
  const counts = countOf(list)
  const parts = [
    counts.working > 0 ? `${counts.working} working` : '',
    counts.waiting > 0 ? `${counts.waiting} waiting` : '',
    counts.idle > 0 ? `${counts.idle} idle` : '',
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(' \u00b7 ') : 'no sessions'
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
    await $.command.register({
      name: 'agents-limit',
      description: 'Set how many sessions may run before Agent Watch warns you',
      argumentHint: '<n> | reset',
      immediate: true,
    })
    await $.command.register({
      name: 'agents',
      description: 'List every Claude Code session: waiting, idle and working',
      immediate: true,
    })
    await ensureSelf($)
    await tick($, config)
    $.clock.every(HEARTBEAT_MS, () => {
      void tick($, config)
    })

    return started
  })

  on('command.run', { command: 'agents-limit' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '') {
      const isOverride = (await $.store.get('limit')) !== undefined
      const max = await loadLimit($, config)

      return { text: `Agent limit: ${max} (${isOverride ? 'set with /agents-limit' : 'from the plugin config'}).` }
    }
    if (arg === 'reset') {
      await $.store.delete('limit')
      const max = await loadLimit($, config)

      return { text: `Agent limit reset to ${max} from the plugin config.` }
    }
    const value = Number(arg)
    if (!Number.isInteger(value) || value < 1) return { text: LIMIT_USAGE }
    await $.store.set('limit', value)
    await update($, limit, () => value)

    return { text: `Agent limit set to ${value}.` }
  })

  on('command.run', { command: 'agents' }, async $ => {
    const list = await refresh($, { countSubagents: config.countSubagents, isPruning: false })
    const max = await loadLimit($, config)
    await $.ui.open({ id: PANE, title: 'Agents' })

    return { text: `Agent Watch: ${summaryOf(list)} (limit ${max}).` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = sortForPane(await read($, sessions))
    const own = await read($, self)
    const max = await read($, limit)
    const now = Math.max(await read($, checkedAt), await $.clock.now())
    const running = list.filter(one => one.status === 'working' || one.status === 'waiting').length
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={running >= max ? 'yellow' : undefined}>
            {running} of {max} running
          </Text>
          <Text dimColor> {'\u00b7'} {summaryOf(list)}</Text>
        </Box>
        {list.length === 0 && <Text dimColor>No sessions found yet.</Text>}
        {list.slice(0, room).map(one => (
          <Box key={one.id} flexDirection="row" gap={1}>
            <Text color={COLOR[one.status]}>{SYMBOL[one.status]}</Text>
            <Text color={COLOR[one.status]}>{one.status.padEnd(7)}</Text>
            <Text dimColor>{formatDuration(now - one.since).padStart(7)}</Text>
            <Text wrap="truncate-end" bold={one.id === own?.id}>
              {folderName(one.cwd)}
              {one.id === own?.id ? ' (this one)' : ''}
            </Text>
          </Box>
        ))}
        {list.length > room && <Text dimColor>and {list.length - room} more</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, sessions)
    const own = await read($, self)
    // Nothing to show while this is the only session.
    if (!list.some(one => one.id !== own?.id)) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const max = await read($, limit)
    const running = list.filter(one => one.status === 'working' || one.status === 'waiting').length

    return (
      <Box>
        <Text dimColor>{summaryOf(list)}</Text>
        {running >= max && <Text color="yellow"> (limit {max})</Text>}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    // Only the person's own prompts, and not one typed over a running turn:
    // that session already counts.
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (isPerson && e.turnId === undefined) {
      const held = await nudge($, config, e.text)
      if (held !== undefined) return held
    }
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
