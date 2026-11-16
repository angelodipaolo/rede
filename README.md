# Margin

Margin is a local code review tool. You review a git diff in the browser, leave
comments on lines, and a coding agent (Claude Code, Codex, or anything with a
shell) answers in the same threads. Everything runs on your machine, on
127.0.0.1. Nothing goes to GitHub or the cloud.

## Install

Requires Node.js 22.5 or later and git.

```sh
npm install && npm run build && npm link
```

`npm link` puts the `margin` command on your PATH.

## Use

Run these inside a git repository:

```sh
margin              # review uncommitted changes (staged + unstaged + untracked)
margin main         # review this branch against main, including uncommitted changes
margin -c HEAD~1    # review one commit (also: margin commit <rev>)
margin a..b         # review a range
margin -w           # always review uncommitted changes
margin --no-open    # print the URL only
```

`margin` with a clean working tree on a feature branch opens a branch review
against the default branch (origin/HEAD, else main or master).

The review opens at `http://127.0.0.1:<port>/r/<review-id>`. The diff refreshes
live while files change, so you can review while an agent keeps writing code.
Uncommitted reviews have three views: all changes, staged, and unstaged.

Other commands: `margin status`, `margin list`, `margin stop`.

## Connect an agent

Agents use the `margin` CLI. No MCP server is needed.

```sh
margin setup        # install the Margin skill for Claude Code and Codex
```

`setup` writes `~/.claude/skills/margin/SKILL.md` and
`~/.codex/skills/margin/SKILL.md` (it respects `CLAUDE_CONFIG_DIR` and
`CODEX_HOME`). Then tell the agent "connect to margin" (or use `/margin` in
Claude Code). `margin guide` prints the same instructions, so you can also paste
them into any agent.

The agent loop:

```sh
margin wait                      # blocks until you comment; no tokens used while it waits
margin reply 12 <<'EOF'          # answer thread 12 (markdown on stdin)
The cache is invalidated in `src/cache.ts:88`, ...
EOF
margin wait                      # and again, until you say stop
```

Agent commands:

| Command | What it does |
| --- | --- |
| `margin wait [--timeout <sec>]` | Long poll. Prints new threads with diff context and the conversation. Default timeout 100 s. |
| `margin reply <id> [-m <text>] [--resolve]` | Reply. Reads stdin when `-m` is absent. Never resolves unless `--resolve`. |
| `margin comment <path>[:<line>[-<end>]] [--old] [--staged\|--unstaged]` | Start a thread (review findings). Without a line: a file-level thread. |
| `margin diff [--stat] [--staged\|--unstaged]` | Print the exact diff the reviewer sees. |
| `margin threads [--all\|--pending]`, `margin show <id>` | Read threads. |
| `margin resolve <id>`, `margin release` | Resolve a thread; give back claimed threads. |

All agent commands take `--as <name>` (default: `$MARGIN_AGENT`, else `claude`
inside Claude Code, `codex` inside Codex, else `agent`), `--review <id>`
(default: every review for `wait` and `threads`, the most recently opened review
for `comment` and `diff`), and `--json`.

When `wait` hands a thread to an agent, the thread shows as "working" for that
agent. If the agent does not reply within 15 minutes, or runs `margin release`,
the thread goes back to "pending". A new message from you on a working thread
is delivered again to the same agent.

Codex runs commands in a sandbox. Margin talks to a server on 127.0.0.1, so
the margin commands need network access (approve them, or allow network in
your sandbox settings).

## Storage

Margin keeps its data in `.git/margin/` of each repository (for a linked
worktree: in that worktree's git directory). It is never committed.

- `margin.db`: reviews, threads, messages, viewed state (SQLite, built into Node).
- `server.json`: pid, port and build of the running server. A newer `margin`
  build replaces an older running server on the same port.
- `server.log`: server output.
- `snapshot.index`, `staged.index`: private git index files used to snapshot
  the working tree. Your real index is never written.
- `objects/`: git objects written by snapshots. Margin never adds objects to
  your repository's object store; it empties this directory at start when it
  holds more than about 20,000 objects. Safe to delete while no server runs.

## Design notes

- **One small server per repository**, started on demand by any `margin`
  command and detached. It binds 127.0.0.1 on a random port, rejects foreign
  `Host` headers (DNS rebinding) and foreign `Origin` on writes, and exits by
  itself after 30 minutes without a browser, a waiting agent or a request
  (`MARGIN_IDLE_TIMEOUT` in seconds). No runtime dependencies.
- **Every side of a diff is a git tree.** The working tree is snapshotted into
  a private index: `git status` (with the untracked cache) finds changed paths,
  `git add` stages only those, `git write-tree` makes the tree. New objects go
  to `.git/margin/objects`, with the repository's objects as an alternate. A
  snapshot of a 10,000-file repository takes about 40 ms. While a browser has
  a review open, the server snapshots every 2 s and pushes `diff-changed` over
  SSE when the diff changes.
- **Hunks load on demand.** GET review returns file metadata only (from
  `git diff-tree --raw --numstat`); the UI asks for hunks with
  `POST /api/reviews/:id/hunks`. Per-file results are cached by blob pair, so
  an edit to one file does not re-diff the others. `node
  --experimental-transform-types test/perf/scale.ts` measures a 1,500-file
  diff in a 10,000-file repository.
- **Threads follow the code.** Each thread stores the commented lines and some
  context. When the code moves, the thread moves; when the lines change or the
  file leaves the diff, the thread is marked outdated and keeps its last
  position; it comes back when the code does. Renames are followed.
- **Viewed state** is tied to a fingerprint of the file's diff. When the file
  changes after you viewed it, Margin shows "changed since viewed" and can show
  only the new changes.
- **Agents use a CLI, not MCP.** Any agent with a shell can use it, and
  `margin wait` blocks in a plain HTTP long poll, so a waiting agent spends no
  tokens.

## Development

```sh
npm run build:server   # bundle src/cli/main.ts to dist/cli.js
npm run build:web      # build the UI to dist/web
npm test               # vitest; tests create temporary repositories
npm run typecheck
```

Environment variables for development: `MARGIN_PORT` (fixed server port),
`MARGIN_ALLOW_ORIGIN` (extra allowed origins, comma-separated, for a dev
server such as `http://localhost:5173`), `MARGIN_IDLE_TIMEOUT` and
`MARGIN_CLAIM_TIMEOUT` (seconds).
