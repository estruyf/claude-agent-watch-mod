# Agent Watch

A Claude Code mod that keeps the number of running Claude Code sessions under a limit.

Run a few sessions side by side and it's easy to lose count, or to forget the one that has been sitting on a permission prompt for twenty minutes. Agent Watch:

1. **Counts every Claude Code session you have open**, across terminals and the desktop app.
2. **Warns you on prompt submit** when you're at or over the limit (default 3):
   `Hey Elio, be aware you are already running 3 agents.`
3. **Shows which sessions are waiting on you or sit idle**, so you find the ones you forgot.

## Screenshot

<!-- TODO: replace with a real screenshot: docs/screenshot.png -->
> Screenshot placeholder. Until there's a real one, here is a live session from testing (terminal, trimmed to fit):

```text
❯ /agents-list
  ⎿  agent-watch: Agent Watch: 1 working · 1 waiting · 1 idle (limit 2).
╭──────────────────────────────────────────────────────────────────────────╮
│ 2 of 2 running · 1 working · 1 waiting · 1 idle                        ✕ │
│ ◆ waiting     <1m agent-watch                                            │
│ ○ idle        <1m docs (this one)                                        │
│ ● working     <1m claude-agent-watch-mod                                 │
╰──────────────────────────────────────────────────────────────────────────╯
1 working · 1 waiting · 1 idle (limit 2)
──────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────
                         agent-watch: Hey eliostruyf, be aware you are already running 2 agents.
```

## Install

In Claude Code:

```text
/plugin marketplace add estruyf/claude-agent-watch-mod
/plugin install agent-watch@agent-watch-mod
```

Or from a shell:

```sh
claude plugin marketplace add estruyf/claude-agent-watch-mod
claude plugin install agent-watch@agent-watch-mod
```

Restart your Claude Code sessions afterwards. Every session needs the plugin to be counted, since each session reports itself.

## Update

```text
/plugin marketplace update agent-watch-mod
/plugin update agent-watch@agent-watch-mod
```

Or `claude plugin marketplace update agent-watch-mod && claude plugin update agent-watch@agent-watch-mod`, then restart your sessions.

## Use it

| What | Where |
| --- | --- |
| `3 working · 1 waiting · 2 idle` | The band above the prompt, while other sessions are open. It adds `(limit 3)` in yellow once you reach the limit, and hides when this is your only session or a survey is showing. |
| The warning toast | On prompt submit, when the *other* sessions that are working or waiting reach the limit. A prompt typed while this session's own turn is already running doesn't warn, since that session is counted already. |
| `/agents-list` | Opens a pane listing every session with its folder, status and time in that state: waiting first, then idle (longest first), then working. |
| `/agents-limit <n>` | Overrides the limit for every session (stored in the plugin's store). `/agents-limit` shows the current limit, `/agents-limit reset` goes back to the configured one. |
| The forgotten nudge | A toast when another session has been idle or waiting on you longer than `idleMinutes`, once per session per state change. |

> Why `/agents-list` and not `/agents`? `/agents` is Claude Code's built-in command for managing subagents, and plugins can't take over a built-in's name.

### Session states

| State | When | Counts toward the limit |
| --- | --- | --- |
| Working | A turn is running (`prompt.submit`, `turn.start`) | yes |
| Waiting | Blocked on you: a permission prompt (`classic.PermissionRequest`), a permission notification (`classic.Notification`) or an `AskUserQuestion` | yes |
| Idle | `turn.complete` fired and no new prompt since | no, only shown in the band, the pane and the forgotten nudge |
| Removed | `session.end` (including `/exit` and `/clear`), or no heartbeat for 2 minutes | no |

Subagent turns don't change the state. A permission prompt raised by a subagent does make the session *waiting*, because it blocks on you all the same.

## Configure

| Option | Default | What it does |
| --- | --- | --- |
| `limit` | `3` | How many other sessions may be working or waiting before the warning shows. |
| `idleMinutes` | `30` | When another session counts as forgotten. |
| `strict` | `false` | At the limit, hold the prompt instead of only warning. The prompt goes back in the box; press Enter again to send it anyway. |
| `countSubagents` | `false` | Also count this session's running background subagents (via `$.agent.list()`). |
| `name` | `""` | The name the warning greets you with. Empty uses `$USER`. |

Set them in Claude Code with `/plugin configure agent-watch@agent-watch-mod`, or from a shell:

```sh
claude plugin configure agent-watch@agent-watch-mod            # show the options and which are set
echo '{"limit":"4","strict":"true"}' | claude plugin configure agent-watch@agent-watch-mod --values-stdin
```

Both write `pluginConfigs["agent-watch@agent-watch-mod"].options` in your user settings. Restart your sessions to apply.

A `/agents-limit` override wins over the configured `limit` until you run `/agents-limit reset`.

## How it works

Every session runs its own copy of the mod and writes its own status file:

```text
~/.claude/agent-watch/<session-id>.json     (under $CLAUDE_CONFIG_DIR when that is set)
{ "id": "...", "cwd": "/path/to/project", "status": "working", "since": 1790966403720, "heartbeat": 1790966433720 }
```

- **One file per session**, not a shared store, so sessions never overwrite each other.
- **Heartbeat every 30 s** (`$.clock.every`) rewrites the file. The other sessions' files are read every 10 s so the band stays current.
- Files with a heartbeat **older than 2 minutes** are ignored, so a crashed session drops out by itself.
- On `session.end` the file is marked `ended`. `$.fs` has no delete, so ended and stale files older than an hour are removed with `rm -f` (on systems without `rm` they're only ignored).
- Runtime values (the session list, this session's status, the limit, what has been nudged) live in `$.state`, so a hot reload keeps them.

## Develop

```sh
git clone https://github.com/estruyf/claude-agent-watch-mod
cd claude-agent-watch-mod
claude plugin validate plugins/agent-watch     # the manifest and the hooks module
claude plugin validate .                       # the marketplace
claude plugin test plugins/agent-watch         # 27 tests
claude --plugin-dir plugins/agent-watch        # run it; saving a file hot-reloads it
```

To try options without touching your settings:

```sh
claude --plugin-dir plugins/agent-watch \
  --settings '{"pluginConfigs":{"agent-watch@inline":{"options":{"strict":true,"limit":1}}}}'
```

Layout:

```text
.claude-plugin/marketplace.json      the marketplace, listing ./plugins/agent-watch
plugins/agent-watch/
  .claude-plugin/plugin.json         manifest and userConfig
  hooks/hooks.json                   names the hooks module
  hooks/register.tsx                 every hook: registry, nudge, pane and band
  hooks/shared.ts                    pure helpers (parsing, counting, sorting, formatting)
  types/index.d.ts                   the $.state contract
  tests/*.test.ts                    claude plugin test
```

`.claude-plugin/types/` inside the plugin is written by Claude Code each time it loads the mod and is git-ignored. `tsc -p plugins/agent-watch` type-checks against it once the mod has loaded once.

## License

MIT
