/** Where a session stands, as its status file says. */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'ended'

/** One session's status file, `~/.claude/agent-watch/<id>.json`. */
export type AgentRecord = {
  id: string
  cwd: string
  status: AgentStatus
  /** When the session entered `status`, ms since the epoch. */
  since: number
  /** The last time the session wrote its file, ms since the epoch. */
  heartbeat: number
}

/** This session's own status, the one it writes to its file. */
export type AgentSelf = {
  id: string
  status: AgentStatus
  since: number
  /** The status to return to once a wait on the person resolves. */
  before: AgentStatus | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-watch': {
      /** Every live session read from disk on the last refresh, this one too. */
      sessions: AgentRecord[]
      /** When `sessions` was read. */
      checkedAt: number
      self: AgentSelf | null
      /** The limit in force: the `/agents-limit` override, else the config. */
      limit: number
      /** This session's running background subagents (countSubagents only). */
      subagents: number
      /** `id:status:since` keys already nudged as forgotten. */
      nudged: string[]
      /** Strict mode: the prompt held back, waiting for a second Enter. */
      pendingConfirm: string | null
    }
  }
}
