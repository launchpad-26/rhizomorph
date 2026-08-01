# The Observatory

Run it in any repo hosting a git-worktree agent swarm and get a live,
replayable instrument at localhost — one glance answers "does anything need
me," and you can point at the looping agent, the frozen one, the waiting one,
the expensive one, and the one that wandered off its fence, without reading a
number. It discovers worktrees and branches (git), agent panes (tmux), and
workmux state if present, each source optional and each degrading
gracefully, and reflects reality within a couple of seconds via polling.
Read-only, always: it never sends keys, launches agents, or merges anything —
see [`docs/vision.md`](docs/vision.md) for the full pitch and
[`docs/prd3.md`](docs/prd3.md) for the visualization design rulings behind
what's on screen today.

![The fleet table, burn strip, scene and ledger against a busy 20-lane fleet — every lane healthy, ALL CLEAR](docs/screenshots/fixture-20-lane.png)

## Prerequisites

- **Node 22 or newer.** Enforced via `engines` in `package.json` — `npm
  install` will warn on an older Node.
- **git.** The Observatory watches a git working tree; the directory you
  point it at (default: cwd) must be one.
- **tmux — optional.** Without it, agent-status detection stays quiet (one
  `collector.disabled` event) and the fleet table, scene, and collisions
  panel all keep working off git alone.
- **[workmux](https://github.com/raine/workmux) — optional.** Without it,
  the same graceful degradation applies to workmux-specific state (lane
  labels, pane↔worktree wiring, the WAITING pathology); nothing else is
  affected.

Neither tmux nor workmux is required to see a working dashboard. Run
`observatory doctor` (below) at any point to see exactly which of these are
missing and what that costs you.

**Platform support:** Linux is CI-verified on every push, WSL is first-class
and exercised daily, and macOS is expected to work (no platform-specific
code, paths go through `node:path`, and collectors degrade loudly rather
than fail silently) but is not CI-verified.

## Quickstart

```sh
git clone https://github.com/KelliherL/worktrees-challenge
cd worktrees-challenge
npm install
npm run build   # builds the dashboard once; the server serves it statically
npm start       # boots collectors + API on http://127.0.0.1:4321, watching the cwd
```

Then open the printed URL in a browser. To watch a different repo or pass
flags, forward them after `--`: `npm start -- <path-to-repo> --port 5000`.
Flags (`npm start -- --help` prints the same table):

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `4321` | Port to listen on |
| `--flatline-minutes <n>` | `5` | Minutes of silence before an agent is flatlined |
| `--poll-interval <ms>` | `2000`, minimum `250` | Collector poll cadence in ms |
| `--extra-sessions <path>[:<lane>]` | — | Foreign Claude session-log dir to tail as a conductor (repeatable). `<path>` is the dir of `*.jsonl` itself; `<lane>` defaults to `conductor`, `conductor-2`, … |
| `--fresh` | — | Start a new session instead of resuming the most recent one for this repo (default: resume if its newest event is under 4h old) |
| `--backfill` | — | Read session logs from the beginning instead of end-of-file — ingest history on purpose; expect a large first tick |
| `--help`, `-h` | — | Show usage and exit |

Two more keyboard shortcuts matter once the dashboard is open: press **`2`**
or **`3`** to load a synthetic fixture (a 20-lane healthy fleet, or a
staged fleet with one lane per pathology) without any swarm running at all —
see [`docs/demo.md`](docs/demo.md) for the full walkthrough — and press
**`1`** to return to the real, live collectors.

The server serves API and static dashboard from one origin (no CORS), so
rebuild `packages/web` (`npm run build`) after front-end changes and restart
`npm start` to see them.

**Not published to npm.** The obvious package name (`observatory`) is already
taken by an unrelated project on the public registry, so there is no `npx
observatory` yet — publishing under a different name is a later step, and
picking that name isn't this issue's call to make. The clone-and-run sequence
above is the only supported way to run this today.

## First run, nothing else set up

Point it at a fresh clone of some other repo — no worktrees beyond `main`, no
tmux session, no telemetry configured — and here's exactly what you get, not
a placeholder:

- The **attention strip** at the top reads `ALL CLEAR`, with an evidence line
  ("0 lanes · 0 branches · 0 files checked · collisions 0") rather than bare
  reassurance — every figure in it is something the fleet object already
  checked. `main` itself isn't a lane (a lane is a dispatched worktree), which
  is why a fresh clone with nothing but `main` checked out reads as zero.
- The **burn strip** shows `0` output tokens and the gap-voice line `NO COST
  FEED (OTel) — dollars unavailable — run: eval "$(observatory env <lane>)"`
  in place of a dollar figure, plus `CONDUCTOR NOT INSTRUMENTED` in place of
  an overhead ratio.
- The **fleet table** shows no rows at all — nothing dispatched yet — and the
  **scene** shows a single lit mass (`main`) with nothing reaching out from
  it.
- The **ledger** and **collisions** panel stay at their own honest-empty
  states ("collisions: 0 — checked 0 branches / 0 files") until something
  commits or two branches touch the same file.
- The **provenance bar** along the bottom shows one dot per collector (Git,
  Tmux, Workmux, Sessionlog, OTel) plus the SSE stream dot — a dot dims when
  its collector is disabled (nothing to report) and glows the broken hue when
  it's erroring, so "nothing to report" never looks like "something's
  wrong."

None of that is a bug. To tell "nothing to report" apart from "something's
actually wrong," run the one command that explains every gap at once:

```sh
node_modules/.bin/observatory doctor
```

It checks the Node version, that the target path exists and is a git repo,
that the web build is present, that the port is free, Claude Code session
logs, tmux/workmux on `PATH`, the telemetry env, and the lane manifest — one
`ok`/`warn`/`FAIL` line per check, each with its exact remedy:

```
[ok  ] Node v22.23.2 satisfies the required >=22
[ok  ] /path/to/worktrees-challenge exists and is a git repository
[ok  ] web build present at /path/to/worktrees-challenge/packages/web/dist/index.html
[ok  ] port 4321 is free
[ok  ] Claude Code session logs found at ~/.claude/projects
[ok  ] tmux found on PATH
[ok  ] workmux found on PATH
[warn] telemetry env is not set in this shell — spend stays at zero until you run `eval "$(observatory env <lane>)"` (see docs/telemetry.md)
[warn] no lane manifest at /path/to/worktrees-challenge/.swarm/lanes.json — dispatch has not written .swarm/lanes.json yet; off-fence detection stays unavailable until a dispatch runs

All required checks passed.
```

It exits non-zero only when the app genuinely cannot run at all (bad path,
not a git repo, no web build, port already taken) — everything else is a
`warn` that degrades gracefully rather than a reason to stop.

## Telemetry (the money layer)

Point a real `claude` process at this Observatory's built-in OTLP receiver and
its spend shows up live in the burn strip and the fleet table's `$` column.
Every lane needs `CLAUDE_CODE_ENABLE_TELEMETRY=1`, an OTLP/HTTP JSON
exporter aimed at the running server, and an
`OTEL_RESOURCE_ATTRIBUTES=lane=<handle>,role=<worker|conductor|auxiliary>,instance=<id>`
tag so the event lands on the right row — the receiver refuses any export
that doesn't carry the instance id of the Observatory it's meant for. With
the server already running (`env` reads that id from `/api/meta`, so it
refuses to print a block for a port nothing is listening on), get the exact,
export-ready block for any lane with:

```sh
node_modules/.bin/observatory env <lane> [--role worker|conductor|auxiliary|unattributed] [--port <n>]
eval "$(node_modules/.bin/observatory env test-lane)"   # then launch claude in the same shell
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
replay, plus one derived **fleet object** — the attention strip, fleet table,
burn strip and scene are four views of it and of nothing else. Full write-up
in [`docs/architecture.md`](docs/architecture.md); the product brief is in
[`docs/prd0.md`](docs/prd0.md), the visualization design rulings in
[`docs/prd3.md`](docs/prd3.md). See [`docs/demo.md`](docs/demo.md) for the
falsifiable demo script.

## Dashboard

The curated, top-to-bottom hierarchy ([ruling 6](docs/prd3.md)) answers, in
order: *does anything need me* → *what is it costing* → *who is doing what*
→ *what does it look like* → *what happened* → *where did this come from*.

- **Attention strip** (docked top) — calm state is `ALL CLEAR` with an
  evidence line (lanes · branches · files checked · collisions); alert state
  is `N NEED ATTENTION` with up to four named, click-to-jump chips (lane +
  why + how long), `+N` beyond that. At `NEEDS-YOU` and above the browser
  tab itself flips (`● N need you`, favicon swaps color) so the signal
  survives a background tab.
- **Burn strip** (docked top, beside the attention strip) — four numbers, no
  chrome: output tokens, dollars (once an `llm.cost` event is authoritative),
  burn rate, and the conductor/worker overhead ratio. Any missing piece
  speaks the gap voice instead of guessing (`NO COST FEED (OTel) — …`,
  `CONDUCTOR NOT INSTRUMENTED — …`).
- **Fleet table** — one dense row per lane: state, output tokens, `$`,
  request/tool counts, thread/subagent count, age, and fence status. The
  STATE column draws the scene's own glyph at row scale, so the table is its
  own legend — no separate key needed to read the scene.
- **Scene** — the mycelium pulse-network ([ruling 28](docs/prd3.md)):
  root-mass at the center, one tendril per lane, pulses of light traveling
  along them for real events (commits, token bursts) — never invented,
  never on history. Looping, frozen, waiting, expensive, and off-fence lanes
  each read as an unmistakably different behavior on their thread, not a
  color alone. Lazy-loaded behind an error boundary: if it breaks, the rest
  of the panel grid stands alone.
- **Ledger** — the deep per-branch/thread spend table the burn strip
  summarizes; cost and token totals, model, first/last seen, elapsed.
- **Collisions** — demoted to calm chrome until it matters: a real collision
  escalates straight to the attention strip, and the panel's own empty state
  carries evidence (`collisions: 0 — checked N branches / M files`) rather
  than bare reassurance.
- **Activity feed** — commits, landings, lane starts/stops, and collector
  events in one quiet, filterable-by-kind-and-by-lane stream (the old commit
  ticker's one kind grown into four).
- **Provenance bar** (docked bottom) — one dot per collector (Git, Tmux,
  Workmux, Sessionlog, OTel) plus the SSE connection dot; a dead collector
  escalates to the strip too, and speaks the same gap voice here.
- **Lane drawer** — click any fleet row to open it: vitals on top, an
  activity view (tool calls, files, commits) as the default reading, an
  expandable full transcript below it (live-tailing), and an **ATTACH**
  button that copies the exact `tmux`/`workmux` command for that lane to your
  clipboard — it never runs anything; interaction happens in your own
  terminal. Closing it (**Esc**, or the drawer's own close) always takes
  precedence over exiting panel focus.
- **Panel focus** — every panel has a "Focus" affordance that fills the view
  with just that panel; **Esc** restores it. No drag/resize/custom layouts
  (deferred per prd3).
- **Replay** — a full mode shift, not a tinted live view: the attention strip
  is replaced outright by a REPLAY banner (timestamp, session identity, an
  "Exit to live" button) in an ice-register frame, never a ladder hue, so a
  recording can never be mistaken for a live summons. The replay bar has a
  one-click **"Replay this session's birth"** button — it picks the recorded
  session with the most history and jumps straight into playback — plus a
  session dropdown, speed control (1x/4x/16x), and a scrubber; live and
  replay share one reducer, so every panel above freezes to the scrubbed
  instant exactly as it would live. See [`docs/demo.md`](docs/demo.md) for
  the full replay check.

| | |
|---|---|
| ![Staged pathology fixture — five lanes, five distinct pathologies, named in the attention strip and the fleet table's STATE column](docs/screenshots/fixture-pathology.png) | ![The lane drawer open on a frozen lane — vitals, activity timeline, and the ATTACH button](docs/screenshots/drawer.png) |
| ![A fresh clone's first live view — one lane, ALL CLEAR, honest empty states everywhere](docs/screenshots/live.png) | ![Replay mid-scrub at 16x — the REPLAY banner, ice-register frame, timestamp and session identity](docs/screenshots/replay.png) |

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

## License

[MIT](LICENSE)
