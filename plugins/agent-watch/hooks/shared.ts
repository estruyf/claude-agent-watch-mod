import { atom } from 'claude-code'

import type { AgentRecord, AgentSelf, AgentStatus } from '../types'

export const PANE = 'agent-watch'
export const HEARTBEAT_MS = 30_000
/** A file whose heartbeat is older than this is a session that is gone. */
export const STALE_MS = 2 * 60_000
/** Ended and stale files are removed once they are this old. */
export const PRUNE_MS = 60 * 60_000

export const sessions = atom({ plugin: 'agent-watch', key: 'sessions' } as const, [])
export const checkedAt = atom({ plugin: 'agent-watch', key: 'checkedAt' } as const, 0)
export const self = atom({ plugin: 'agent-watch', key: 'self' } as const, null)
export const limit = atom({ plugin: 'agent-watch', key: 'limit' } as const, 3)
export const subagents = atom({ plugin: 'agent-watch', key: 'subagents' } as const, 0)
export const nudged = atom({ plugin: 'agent-watch', key: 'nudged' } as const, [])
export const pendingConfirm = atom(
  { plugin: 'agent-watch', key: 'pendingConfirm' } as const,
  null,
)

export type Options = {
  limit: number
  idleMinutes: number
  strict: boolean
  countSubagents: boolean
  name: string
}

export const readOptions = (options: Readonly<Record<string, unknown>>): Options => ({
  limit: positive(options.limit, 3),
  idleMinutes: positive(options.idleMinutes, 30),
  strict: options.strict === true,
  countSubagents: options.countSubagents === true,
  name: typeof options.name === 'string' ? options.name.trim() : '',
})

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const STATUSES: readonly AgentStatus[] = ['working', 'waiting', 'idle', 'ended']

/** Parses a status file's text; undefined for anything that is not one. */
export const parseRecord = (text: string): AgentRecord | undefined => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { id, cwd, status, since, heartbeat } = value as Record<string, unknown>
  const isRecord =
    typeof id === 'string' &&
    id !== '' &&
    typeof cwd === 'string' &&
    STATUSES.includes(status as AgentStatus) &&
    typeof since === 'number' &&
    typeof heartbeat === 'number'

  return isRecord
    ? { id, cwd, status: status as AgentStatus, since, heartbeat }
    : undefined
}

export const isStale = (record: AgentRecord, now: number): boolean =>
  now - record.heartbeat > STALE_MS

/** Live: not ended and heard from within the last two minutes. */
export const isLive = (record: AgentRecord, now: number): boolean =>
  record.status !== 'ended' && !isStale(record, now)

/** Ended or stale, and old enough to remove from disk. */
export const isPrunable = (record: AgentRecord, now: number): boolean =>
  (record.status === 'ended' || isStale(record, now)) && now - record.heartbeat > PRUNE_MS

/** Only working and waiting sessions count toward the limit. */
export const isActive = (status: AgentStatus): boolean =>
  status === 'working' || status === 'waiting'

export type Counts = { working: number; waiting: number; idle: number }

export const countOf = (records: readonly AgentRecord[]): Counts => ({
  working: records.filter(one => one.status === 'working').length,
  waiting: records.filter(one => one.status === 'waiting').length,
  idle: records.filter(one => one.status === 'idle').length,
})

/** The other live sessions working or waiting: what the limit compares. */
export const othersActive = (records: readonly AgentRecord[], selfId: string): number =>
  records.filter(one => one.id !== selfId && isActive(one.status)).length

/** Waiting first, then idle, each longest first, then working. */
export const sortForPane = (records: readonly AgentRecord[]): AgentRecord[] => {
  const rank = (status: AgentStatus) =>
    status === 'waiting' ? 0 : status === 'idle' ? 1 : status === 'working' ? 2 : 3

  return [...records].sort(
    (a, b) => rank(a.status) - rank(b.status) || a.since - b.since,
  )
}

export const folderName = (cwd: string): string =>
  cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

export const formatDuration = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`

  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** The key a forgotten nudge is remembered by: once per session per state. */
export const nudgeKey = (record: AgentRecord): string =>
  `${record.id}:${record.status}:${record.since}`

/** Other live sessions idle or waiting longer than `idleMinutes`. */
export const forgotten = (
  records: readonly AgentRecord[],
  selfId: string,
  now: number,
  idleMinutes: number,
): AgentRecord[] =>
  records.filter(
    one =>
      one.id !== selfId &&
      (one.status === 'idle' || one.status === 'waiting') &&
      now - one.since > idleMinutes * 60_000,
  )

/** The session id only ever names a file inside the watch folder. */
export const isSafeId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id)

export type { AgentRecord, AgentSelf, AgentStatus }
