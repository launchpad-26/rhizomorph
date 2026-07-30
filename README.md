# The Observatory

Run `observatory` in any repo hosting a git-worktree agent swarm and get a
live, replayable dashboard at localhost — who's working, what's landing, and
what's about to collide. It discovers worktrees and branches (git), agent
panes (tmux), and workmux state if present, each source optional and each
degrading gracefully, and reflects reality within a couple of seconds via
polling. Read-only, always: it never sends keys, launches agents, or merges
anything — see [`docs/vision.md`](docs/vision.md) for the full pitch.

## Quickstart

Requires Node 22 and, for the git/tmux/workmux collectors to have anything to
report, a repo that already has worktrees and tmux panes running in it.

```sh
npm install
npm run build --workspace packages/web   # builds the dashboard once; observatory serves it statically
npx observatory <path-to-repo>           # boots collectors + API on http://127.0.0.1:4321
```

Then open the printed URL in a browser. Omit `<path-to-repo>` to watch the
current directory. Flags (`observatory --help` prints the same table):

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `4321` | Port to listen on |
| `--flatline-minutes <n>` | `5` | Minutes of silence before an agent is flatlined |
| `--poll-interval <ms>` | `2000`, minimum `250` | Collector poll cadence in ms |
| `--extra-sessions <dir>` | — | Extra Claude session-log dir to tail as a conductor (repeatable) |
| `--help`, `-h` | — | Show usage and exit |

The server serves API and static dashboard from one origin (no CORS), so
rebuild `packages/web` after front-end changes and restart `observatory` to
see them.

## Telemetry (the money layer)

Point a real `claude` process at this Observatory's built-in OTLP receiver and
its spend shows up live in the spend ticker and the worktree table's cost
column. Every lane needs `CLAUDE_CODE_ENABLE_TELEMETRY=1`, an OTLP/HTTP JSON
exporter aimed at the running server, and an
`OTEL_RESOURCE_ATTRIBUTES=lane=<handle>,role=<worker|conductor|auxiliary>` tag
so the event lands on the right row. Get the exact, export-ready env block for
any lane with:

```sh
observatory env <lane> [--role worker|conductor|auxiliary] [--port <n>]
eval "$(observatory env test-lane)"   # then launch claude in the same shell
```

`.workmux.yaml` already wires this into every worker lane automatically —
nothing to enable by hand for a worker. A conductor, or any lane whose Claude
Code session-log directory lives outside the worktrees this repo's
`sessionlog` collector would otherwise discover (a cross-filesystem or
cross-machine conductor, say), is picked up with the repeatable
`--extra-sessions <dir>` flag and attributed `role: conductor` automatically.
Full walkthrough — the cross-machine note, the subscription-dollars honesty
note, live proof of the `OTEL_RESOURCE_ATTRIBUTES` lane tag — lives in
[`docs/telemetry.md`](docs/telemetry.md).

## Architecture

Event-sourced core (`packages/core`), collectors + Fastify API + CLI
(`packages/server`), and a React + Tailwind + react-three-fiber dashboard
(`packages/web`) sharing one set of selectors between the live view and
replay. Full write-up in [`docs/architecture.md`](docs/architecture.md); the
product brief is in [`docs/prd0.md`](docs/prd0.md). See
[`docs/demo.md`](docs/demo.md) for the end-of-day demo script.

## Dashboard

A status bar along the bottom edge shows one dot per collector — Git, Tmux,
Workmux — plus an SSE dot for the stream connection itself; a dot dims when
that collector is disabled and glows magenta when it's erroring, so you can
tell "nothing to report" from "something's wrong" at a glance. Each panel
draws the same distinction for its own data: it says "Waiting for the
stream…" while the connection isn't up yet, and something more specific like
"No worktrees discovered yet" once connected but genuinely empty.

A **spend ticker** panel shows the live token/dollar total, the $/hour burn
rate, the worker/conductor/auxiliary split with the orchestration overhead
ratio (conductor tokens ÷ worker tokens — prd1's headline number) picked out
on its own, and per-lane mini-bars; it shows tokens only, with copy saying so
outright, until a real `llm.cost` event has arrived — no invented dollars.
The worktree table gains a **Cost** column alongside it (dollars once OTel's
`cost_usd` is authoritative for that worktree, otherwise the raw token count)
and a **Model** badge (the dominant model by tokens spent in that worktree).

The replay bar has a one-click **"Replay this session's birth"** button — it
picks the recorded session with the most history and jumps straight into
playback, no picker required. A **session** dropdown next to it lists every
recorded session if you'd rather choose by hand. See
[`docs/demo.md`](docs/demo.md) for the full replay walkthrough.

## The worktrees-challenge context

This repo is also the build log for a day of running several coding agents
across git worktrees at once — the Observatory is the app that day built, and
its first real subject was its own construction. Skills for driving that
workflow (`tmux-driver`, `workmux`) live in `.claude/skills/`
(`.agent/skills` is a symlink to the same directory; recreate it with
`ln -sfn ../.claude/skills .agent/skills` if it goes missing).

**tmux and workmux setup:**

```sh
brew install tmux      # macOS
sudo apt install tmux  # Debian/Ubuntu
```

`workmux` lives at [github.com/raine/workmux](https://github.com/raine/workmux);
install it from there, following that README, then confirm with
`workmux --version`.

Recommended `~/.tmux.conf` for pane navigation and worktree-friendly splits:

```tmux
unbind C-b
set -g prefix C-space
bind Space send-prefix

set -g mouse on

# Move between panes with Ctrl-h/j/k/l, no prefix needed.
# The is_vim guard passes the key through to vim when vim has focus,
# so the same keys move between vim splits and tmux panes.
# See github.com/christoomey/vim-tmux-navigator
is_vim="ps -o state= -o comm= -t '#{pane_tty}' \
    | grep -iqE '^[^TXZ ]+ +(\\S+\\/)?g?(view|n?vim?x?)(diff)?$'"
bind-key -n 'C-h' if-shell "$is_vim" 'send-keys C-h' 'select-pane -L'
bind-key -n 'C-j' if-shell "$is_vim" 'send-keys C-j' 'select-pane -D'
bind-key -n 'C-k' if-shell "$is_vim" 'send-keys C-k' 'select-pane -U'
bind-key -n 'C-l' if-shell "$is_vim" 'send-keys C-l' 'select-pane -R'

# New panes and windows open in the current pane's directory rather than
# wherever you started tmux. Matters once you are in a worktree.
bind-key '"' split-window -v -c '#{pane_current_path}'
bind-key % split-window -h -c '#{pane_current_path}'
bind-key c new-window -c '#{pane_current_path}'
```

Reload without restarting: `tmux source-file ~/.tmux.conf`. Once agents are
running in several worktrees, these workmux keys are worth adding too:

```tmux
bind-key -T prefix C-s display-popup -h 30 -w 100 -E "workmux dashboard"
bind-key -T prefix Tab run-shell "workmux last-agent"
bind-key -n M-j run-shell "workmux sidebar next"
bind-key -n M-k run-shell "workmux sidebar prev"
bind-key -n M-1 run-shell "workmux sidebar jump 1"
bind-key -n M-2 run-shell "workmux sidebar jump 2"
bind-key -n M-3 run-shell "workmux sidebar jump 3"
```

## Skills layout

Skills live in `.claude/skills/`. `.agent/skills` is a symlink to it, so both
paths resolve to the same directory and either tool convention finds the same
skills:

```
.claude/skills/          <- the real directory
.agent/skills -> ../.claude/skills
```

Git stores the symlink, so a fresh clone gets it for free. Check with
`ls -l .agent/`.

| Skill | What it covers |
|---|---|
| `tmux-driver` | Finding sessions, windows and panes; capturing output; sending keys to an interactive program and verifying it fired |
| `workmux` | `workmux add/list/merge/remove`, talking to agents in other worktrees, and configuration |

`workmux` is a CLI that must be installed separately; the skill is a reference
for driving it, not a copy of it.
