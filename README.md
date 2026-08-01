# The Observatory

Run it in any repo hosting a git-worktree agent swarm and get a live,
replayable instrument at localhost — one glance answers "does anything need
me," and you can point at the looping agent, the frozen one, the waiting one,
the expensive one, and the one that wandered off its fence, without reading a
number. It discovers worktrees and branches (git), agent panes (tmux), and
workmux state if present, each source optional and each degrading
gracefully, and reflects reality within a couple of seconds via polling.
Read-only, always: it never sends keys, launches agents, or merges anything —
see [`docs/vision.md`](docs/vision.md) for the full pitch,
[`docs/prd3.md`](docs/prd3.md) for the visualization design rulings behind
what's on screen, [`docs/prd4.md`](docs/prd4.md) for the operator-review
rulings that re-aimed the whole surface at a first-time viewer, not just the
person who built it (the **layman bar** — every screen below is written to
be readable by someone who has never seen this tool before), and
[`docs/prd5.md`](docs/prd5.md) for the rulings behind the scene's camera,
its motion, and the cord-cut described below, and [`docs/prd6.md`](docs/prd6.md)
for the rulings behind the scene's living cycle — absolute seed sizes,
lifecycle distance, the way severed work comes home, and the root-mass's own
drawer.

![The scene as the centerpiece — a busy 20-lane fleet, every thread live green but visibly different widths for visibly different output, ALL CLEAR above it](docs/screenshots/fixture-20-lane.png)

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
- The **scene**, the first thing under the two docked strips, shows a single
  lit mass (`main`) with nothing reaching out from it, and the **fleet table**
  right beneath it shows no rows at all — nothing dispatched yet.
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
[`docs/prd3.md`](docs/prd3.md) and [`docs/prd4.md`](docs/prd4.md). See
[`docs/demo.md`](docs/demo.md) for the falsifiable demo script.

## Dashboard

The curated, top-to-bottom hierarchy ([ruling 6](docs/prd3.md), reordered by
[prd4 ruling 2](docs/prd4.md)) answers, in order: *does anything need me* →
*what is it costing* → *what is the fleet doing* → *who is doing what* →
*what happened* → *where did this come from*. The scene moved up to third
place, directly under the two docked strips: it's big, bright and
self-explanatory, so a first-time viewer reads it before the reference
instruments beneath it.

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
- **Scene** (the centerpiece, [prd4 ruling 2](docs/prd4.md)) — the mycelium
  pulse-network ([ruling 28](docs/prd3.md)): root-mass at the center, one
  tendril per lane, pulses of light traveling along them for real events
  (commits, token bursts) — never invented, never on history. Four channels,
  each a different fact, none of them a decoration ([prd6 ruling 4](docs/prd6.md)
  fixed the one that used to be hardest to read):
  - **Thread width — how much a lane has produced**, on an absolute scale
    ([prd6 ruling 1](docs/prd6.md)): a 20K-token lane draws the same width
    whether it's alone or next to a 500K-token whale. Nothing balloons — the
    scale is capped.
  - **Distance from the mass — how far through its life a lane is**
    ([prd6 ruling 4](docs/prd6.md)): born close in, growing outward as it
    works, coming to rest at the rim when it retires. No legend needed —
    "closer to the middle" reads as "newer" on its own.
  - **Angle — identity**, stable for the whole session (a lane keeps its
    slot on the ring no matter how its status changes).
  - **Brightness — recency**: how long ago a lane last did something,
    independent of how far through its life it is.

  Looping, frozen, waiting, expensive, and off-fence lanes each read as an
  unmistakably different *shape* on their thread, not a color alone, and
  since prd4 the color carries real meaning too (see "The palette" below).
  Since prd5 it's also a place you can go: drag to pan, Ctrl/Cmd+wheel to
  zoom at the cursor, and a finished lane cuts loose from the mass rather
  than sitting there dyed a different color — see "The camera" and "The
  cord-cut and the way home" below. Since prd6, the root-mass itself is
  clickable: it opens the same drawer a lane does, on the conductor's own
  conversation (see "Lane drawer" below). Lazy-loaded behind an error
  boundary: if it breaks, the rest of the panel grid stands alone. A "Focus
  Scene" button fills the whole viewport with it.
- **Fleet table** — one dense row per lane: state, output tokens, `$`,
  request/tool counts, thread/subagent count, age, and fence status. The
  STATE column draws the scene's own glyph *and* the scene's own hue at row
  scale, so this table is the scene's legend for both shape and color — no
  separate key needed to read the picture above it. Its own footer names
  three keyboard verbs: `n`/`Shift+n` jumps the shared selection to the
  next/previous lane that needs you, `f` focuses the table full-screen, and
  `a` copies that lane's attach command — see "Keyboard reference" below
  for the full set, scene included.
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
- **Lane drawer** — click any fleet row to open it. The main, largest section
  is the **conversation** ([prd4 ruling 4](docs/prd4.md)): the same thing
  you'd see sitting at that agent's own terminal — user turns marked with a
  `›` prompt, assistant prose in the page's own type, tool calls as quiet
  one-line bullets between them (`● Read — path/to/file`, `⎿ result, …+2K
  more` when a result was cut). It tails the session log live and follows the
  bottom until you scroll up, at which point it pauses and says so. Above it:
  vitals (state, output, cost, age, fence, worktree). Below it, an **ATTACH**
  button that copies the exact `tmux`/`workmux` command for that lane to your
  clipboard — it never runs anything; interaction happens in your own
  terminal. Closing it (**Esc**, or the drawer's own close) always takes
  precedence over exiting panel focus. **Click the root-mass and the same
  drawer opens on the conductor** ([prd6 ruling 5](docs/prd6.md)) — the same
  frame, the same conversation view, the same copies-never-executes ATTACH,
  just with main's own vitals up top (branch, worktrees landed, commits
  observed on it) instead of a lane's. An un-instrumented conductor says so
  in the gap voice rather than showing an empty pane.
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

### The palette — the fleet table teaches it, the scene speaks it

[prd4 ruling 3](docs/prd4.md) gives every state a real color, not just a
glyph. Six hues, each meaning exactly one thing everywhere in the app:

| Hue | Means | Where you'll see it |
|---|---|---|
| Green | Productive | `WORKING` (bright) and `done` (dimmer) — the same green at two brightnesses |
| Amber | Blocked on a human | `waiting` (muted, benign) and `NEEDS-YOU`/`WAITING` pathology (incandescent) — again one scale, two brightnesses |
| Red | Dead | `FROZEN` only — red never means anything softer than that |
| Cyan | Notice/anomaly | `EXPENSIVE`'s chevrons — something changed, nobody is summoned |
| Ice (blue-grey) | Structure, nothing to say | `idle`, `unknown`, and all of the chrome |

You don't need this table to read the app: the **fleet table's STATE column
is the legend**, in both senses. It draws the scene's own glyph (a coil for
LOOPING, a severed bar for FROZEN, a raised hand for WAITING, a radial burst
for EXPENSIVE, fence posts and a barb for OFF-FENCE) at row scale next to the
plain-English word, in the same hue the scene paints that lane's thread with.
Learn a pathology from a row and you already know what it looks like — and
what color it is — in the picture above.

Brightness, not color exclusivity, is what marks an alarm: a calm lane may
wear its hue at a healthy brightness (no more "too dark to read" fleet), but
only a `NEEDS-YOU`/`FROZEN` mark reaches the band of luminance above it — so
a summons is always the brightest thing on the screen, never merely "also
colored." One lane at a time takes the spotlight; every other lane recedes
around it rather than being drowned in more color.

### Parked lanes — acknowledged, never hidden

[prd4 ruling 5](docs/prd4.md): sometimes a worktree is deliberately shelved
rather than abandoned — a spike, an idea kept for later — and the Observatory
needs to say so without treating it as a bug. An operator (never this
read-only instrument) declares that by adding `"parked": true` to that lane's
entry in `.swarm/lanes.json`:

```json
{
  "version": 1,
  "lanes": [
    { "handle": "60-shelved-idea", "branch": "60-shelved-idea", "fence": ["packages/web/src/panels/shelved/**"], "parked": true }
  ]
}
```

A parked lane renders a dimmed `PARKED` in the fleet table's STATE column —
visible, never hidden — and is exempt from the FROZEN and inferred-WAITING
alarms and skipped by the attention ladder, since silence in a lane you
parked on purpose isn't news. Everything else about it (output, cost, age,
fence compliance) keeps reading its real telemetry: parked mutes the alarm,
never the evidence.

### The camera — drag, zoom, and a way home

[prd5 ruling 2](docs/prd5.md): the scene is a place you navigate, not a
picture that sits still. Click or tab into it first — the keys below are
scoped to a focused scene, on purpose (see "Keyboard reference"):

- **Drag** (left or middle button) pans.
- **Ctrl/Cmd + scroll** zooms at the pointer — the point under your cursor
  stays under it. A trackpad pinch arrives the same way (it's a ctrlKey
  wheel stream under the hood), so pinch-to-zoom works with no separate
  handling.
- **A plain scroll is not the camera's** — the scene sits in a page you can
  scroll past, so an unmodified wheel scrolls the page exactly as if the
  canvas weren't there.
- **`1`** zooms to fit the whole network in view; **`0`** resets to the
  start position; **`+`/`-`** step the zoom. The same four actions sit as
  on-canvas buttons bottom-right (**−**, **+**, **Fit**, **Reset**), so a
  trackpad-only reader never needs the keyboard.
- **Recenter** fades in automatically, in the same corner, whenever you've
  panned or zoomed the network out of view entirely — a click brings it
  back. It never appears at any other time, so it can't blink into view at
  the moment you'd have looked away.
- The zoom range is deliberately bounded (0.4×–6×): further out and the
  threads go sub-pixel; further in and you're looking at a gradient, not a
  network.

### The cord-cut and the way home — a finished lane leaves the network, honestly

[prd5 ruling 3](docs/prd5.md): when a lane finishes — workmux declares it
`done`, or its worktree is removed — its thread doesn't just change color.
It **cuts loose**: the thread goes slack at the root, the freed end springs
back toward its own node, and what's left settles into a small, permanently
dimmed **scar** near the rim, carrying the lane's name and its output
figure for the rest of the session. It's a roughly 1.4-second sequence, not
a jump-cut, so you can watch a lane stand down rather than just noticing it
vanished.

[prd6 ruling 2](docs/prd6.md) gave that moment somewhere to go. Real
mycelium doesn't just sever a spent hypha — it reabsorbs it, translocating
its substance back through the network, which is exactly what a merge is.
So as the cord parts, a short stretch of light travels back down the
severing thread **into the root-mass**, and the mass itself **thickens** —
visibly bigger by the end of a long session than it was at the start,
because that work is part of `main` now. A scar at the rim isn't a dead
end; it's what's left after the lane's substance has already gone home.

- **A scar never disappears, and it keeps its size** ([prd6 ruling 1](docs/prd6.md)
  overrules prd5's "a scar is a mark, so it's the same size for every
  lane" — the rim is where a session's finished work is on display, so a
  lane that did more work leaves a visibly bigger scar). It's dim — well
  below a living lane's floor — but never zero, because invisible
  completion looks exactly like a bug. The fleet table still lists the
  lane too; only the scene's own picture is affected by anything below.
- **The root-mass only grows this way.** It thickens by up to 30% over a
  session, on the same absolute, capped scale seeds use — never by more,
  however many whales land — and nothing about it looks like motion; you
  notice it's bigger, you never catch it growing.
- **Hide finished** (top-right of the scene) toggles scars out of the
  picture if a long session has accumulated a lot of them — it always
  shows its own count (`Hide finished · 12`), so "hidden" never reads as
  "gone," and it's remembered across reloads. Hiding a scar never shrinks
  the root-mass back down — the work still happened.

A lane you've parked on purpose (see "Parked lanes" above) scars the same
way, just without the animation — there's no "moment" a standing
declaration can play back.

### Germinating seeds — a returning lane grows from where it left off

[prd6 ruling 3](docs/prd6.md): dispatch the same handle again after it's
retired — a re-dispatch, not a new lane — and its thread doesn't sprout from
a stranger's spot on the other side of the ring. It **germinates from its
own dormant seed**: same angle, same seat, and it starts already as big as
the seed it grew from, because the worker returning is the same one that
did that earlier work. A retired lane's seat is held for exactly this — the
scene remembers where a lane worked, even mid-session, so the ring never
re-spaces itself out from under you just because a handle came back.

### Motion, pause, and reduced motion

[prd5 ruling 4](docs/prd5.md): the scene breathes gently and pulses on real
events, but every bit of that motion is budgeted, not decorative:

- **Ambient** life (the root-mass's slow breath) is subtle by design — at
  most 3% — because it's meant to sit at the edge of your attention and be
  ignorable, not a fidget you have to consciously tune out.
- **Event** motion (a pulse traveling to say a commit landed, tokens
  arrived) is capped at five pulses moving at once — the point past which
  people stop being able to track individual moving things anyway. A busier
  moment doesn't spawn a sixth pulse; it folds the overflow into one
  pulse carrying a count, the same "coalesced, never invented" rule the
  scene already applies to traffic.
- **Structural** motion (a lane appearing, reflowing, or cutting loose) is
  the one deliberately larger movement, and it never bounces — a spring
  that recoiled would read as "this failed," which is never true of a
  lane finishing its work.
- An unanswered summons's pulse also **ages**: the longer a lane has been
  waiting on you, the slower and brighter it throbs — insistent, never
  frantic (see "Amber ages with attention" below).

**Pause motion** (top-left of the scene) stops all of that outright — every
ambient and event animation freezes at the instant you press it, and it
says so in words (`Motion paused`), not just by looking different. This
exists because WCAG's accessibility rules require a way to stop
self-starting motion that runs more than a few seconds, and a scene that
breathes forever without one fails that outright. The one exception: a
cord-cut already in flight finishes and settles rather than freezing
half-severed, since a half-cut thread is still a true picture of what's
happening and a half-grown one would not be.

If your system is set to reduce motion (`prefers-reduced-motion`), the
scene keeps every color and brightness change but drops travel and
scale — camera flights become instant jumps, pulses stop moving without
disappearing, and the cord-cut swaps straight to its finished state in
place rather than visibly retracting.

### Amber ages with attention

[prd5 ruling 5](docs/prd5.md): a `NEEDS-YOU` chip in the attention strip
tells you *how long* it's been true, and that duration changes how
insistent it reads — a summons that just fired reads at the quieter end of
amber, the same one a benign wait already wears; past two minutes it's at
full needs-you brightness; past ten, it adds a slow, deliberate pulse and
brightens the age figure itself. What never changes is *which rung* it's
on — age makes the same fault read more urgently, it never promotes a
lane to a worse one, and `BROKEN`/`NOTICE` chips are unaffected regardless
of age.

### Keyboard reference

Three independent registers, scoped by *where* you are rather than one
global keymap — a key means one thing while the scene has focus and can
mean something else everywhere else on the page:

| Key | Scope | What it does |
|---|---|---|
| `1` / `2` / `3` | Page (scene unfocused) | Switch the driving log: live / 20-lane fixture / pathology fixture |
| `1` | Scene (focused) | Zoom to fit the whole network |
| `0` | Scene (focused) | Reset the camera |
| `+` / `-` | Scene (focused) | Step the zoom in/out |
| `n` / `Shift+n` | Page (global) | Jump the shared selection to the next/previous lane that needs you |
| `f` | Fleet table (a lane in hand) | Focus the fleet table full-screen |
| `a` | Fleet table (a lane in hand) | Copy that lane's tmux/workmux attach command |
| `Esc` | Page (global) | Close the lane drawer, then exit panel focus — never both at once |

Click the scene once, or tab to it, to put the first three rows in scope;
click anywhere else (or press Esc) to give `1`/`2`/`3` back to the page.
Every key here is ignored while you're typing into a form field.

| | |
|---|---|
| ![Staged pathology fixture — five lanes, five distinct pathologies, each a different hue and shape, named in the attention strip and the fleet table's STATE column](docs/screenshots/fixture-pathology.png) | ![The lane drawer's conversation view — a real session's turns and tool calls, CLI-style, with the ATTACH button below](docs/screenshots/drawer.png) |
| ![The live view against this project's own real, in-progress build swarm — this very docs lane WORKING beside a sibling lane that's already landed and scarred, not staged](docs/screenshots/live.png) | ![Replay mid-scrub at 16x — the REPLAY banner, ice-register frame, timestamp and session identity](docs/screenshots/replay.png) |
| ![The scene paused — the pause button pressed, "Motion paused" stated in words, camera and hide-finished controls visible](docs/screenshots/paused.png) | ![A rim of scars, each sized to the lane's own output — the root-mass visibly thicker for having taken all of that work home](docs/screenshots/scars.png) |
| ![MAIN's own drawer, open on the conductor's real conversation — clicked like any lane, vitals up top, ATTACH honestly reporting no pane on record](docs/screenshots/main-drawer.png) | |

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
