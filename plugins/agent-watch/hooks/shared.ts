import type { AgentRecord, AgentSelf, AgentStatus } from '../types'

export const HEARTBEAT_MS = 30_000
/** How often the other sessions' files are read between heartbeats. */
export const LOOK_MS = 10_000
/** A file whose heartbeat is older than this is a session that is gone. */
export const STALE_MS = 2 * 60_000
/** Ended and stale files are removed once they are this old. */
export const PRUNE_MS = 60 * 60_000

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
  const { id, cwd, status, since, heartbeat, prompted } = value as Record<string, unknown>
  const isRecord =
    typeof id === 'string' &&
    id !== '' &&
    typeof cwd === 'string' &&
    STATUSES.includes(status as AgentStatus) &&
    typeof since === 'number' &&
    typeof heartbeat === 'number'

  if (!isRecord) return undefined
  const record: AgentRecord = { id, cwd, status: status as AgentStatus, since, heartbeat }

  return typeof prompted === 'number' ? { ...record, prompted } : record
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

/** Idle or waiting longer than `idleMinutes`. */
export const isForgotten = (record: AgentRecord, now: number, idleMinutes: number): boolean =>
  (record.status === 'idle' || record.status === 'waiting') &&
  now - record.since > idleMinutes * 60_000

/** Other live sessions idle or waiting longer than `idleMinutes`. */
export const forgotten = (
  records: readonly AgentRecord[],
  selfId: string,
  now: number,
  idleMinutes: number,
): AgentRecord[] =>
  records.filter(one => one.id !== selfId && isForgotten(one, now, idleMinutes))

/**
 * The one session that sends the forgotten nudge, so it shows once and not in
 * every open session: the one the person prompted last (likely the one in
 * front of them), never one forgotten itself; then the latest state change,
 * then the lowest id.
 * Every session reads the same files, so they agree without talking.
 */
export const nudgerOf = (
  records: readonly AgentRecord[],
  now: number,
  idleMinutes: number,
): string | undefined =>
  records
    .filter(one => !isForgotten(one, now, idleMinutes))
    .sort(
      (a, b) =>
        (b.prompted ?? 0) - (a.prompted ?? 0) || b.since - a.since || (a.id < b.id ? -1 : 1),
    )[0]?.id

/** The session id only ever names a file inside the watch folder. */
export const isSafeId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id)

/** The toast at the limit. */
export const warningText = (name: string, running: number): string =>
  `Hey ${name}, be aware you are already running ${running} ${running === 1 ? 'agent' : 'agents'}.`

export type { AgentRecord, AgentSelf, AgentStatus }
