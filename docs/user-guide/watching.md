# Watching the fleet

This is the read-only hand — collectors, receiver, server, UI. It never
writes to the repo you're watching, never sends a keystroke to an agent,
never merges anything. This page is what the picture on screen means.

## The scene

The centerpiece, directly under the docked attention/burn strips: a
root-mass at the center, one tendril per lane, pulses of light traveling
along them for real events (commits, token bursts) — never invented, never
replayed on top of history.

Four channels, each a fact:

- **Thread width** — how much a lane has produced, on an absolute, capped
  scale. A 20K-token lane draws the same width whether it's alone or next to
  a 500K-token whale.
- **Distance from the mass** — how far through its life a lane is: born
  close in, growing outward as it works, resting at the rim when it
  retires.
- **Angle** — identity, stable for the whole session.
- **Brightness** — recency: how long ago a lane last did something.

Click the scene, or tab to it, to give it keyboard focus: drag pans,
Ctrl/Cmd+wheel zooms at the pointer, `1` fits the whole network, `0` resets
the camera, `+`/`-` step the zoom. A plain scroll is left alone — the page
scrolls past the canvas as if it weren't there. A finished lane cuts loose
from the mass (the "cord-cut") and settles into a small, permanently dimmed
scar near the rim rather than just changing color — the scar keeps the
lane's name and output figure, and never disappears (`Hide finished` only
toggles it out of the picture, and always shows its own count).

## The fleet table

One dense row per lane: STATE, output tokens, `$`, request/tool counts,
thread/subagent count, age, fence status. The STATE column draws the
scene's own glyph *and* hue at row scale — it's the scene's legend, so
there's no separate key to learn.

STATE words you'll see, and what each tooltip (hover the cell) says:

| Word | Meaning | Tooltip |
|---|---|---|
| `working` | active within the last window | *"active within the last window"* |
| `done` | finished — worktree landed or agent declared done | *"finished — worktree landed or agent declared done"* |
| `idle` | quiet, past the idle threshold | *"quiet, past the idle threshold"* |
| `unknown` | no work signal yet | *"no work signal yet"* |
| `PARKED` | operator declared this lane parked in `.swarm/lanes.json` | *"parked — declared in .swarm/lanes.json; alarm inferences suppressed, other evidence unaffected"* |
| `LOOPING` | a repeating cycle with no commit | the detector's own evidence, e.g. `a→b→a ×4, no commit` |
| `FROZEN` | total silence, including the pane | `no events for <span>` |
| `WAITING` | see below | the detector's own evidence line |
| `EXPENSIVE` | burning far above the fleet's median | `<n> out-tok/min, <x>× fleet median` |
| `OFF-FENCE` | touching files inside another lane's declared fence | `touching <victim> — <files>` |

A pathology tooltip is never a bare label — it's always the detector's own
evidence sentence. If a lane carries more than one pathology at once, the
tooltip appends `· +N more: <...>`. An inferred (rather than declared)
pathology gets an inline `~` marker, tooltip *"inferred from a weaker
signal"*.

Colour is never the only carrier of a state: six hues, one meaning each
(green = productive, amber = blocked on a human, red = dead — `FROZEN`
only, cyan = notice, ice = structure/nothing-to-say), and only a
`NEEDS-YOU`/`FROZEN` mark reaches the brightest band — a summons is always
the brightest thing on the screen.

### What WAITING actually means

`WAITING` is one word wearing two brightnesses, and it's worth knowing which
one you're looking at:

- **A real WAITING pathology** — bright amber, glows, ranks `needs-you`.
  Fires either because workmux itself reported the lane's `agent.status` as
  `waiting` while its worktree is still present (evidence: `workmux reports
  waiting <span>`), or because it's *inferred*: the lane has gone quiet for
  at least 75 seconds of no real work **and** its tmux pane has still
  repainted within the last 45 seconds (evidence: `quiet <span>, pane still
  alive`) — the classic "stopped working while its terminal kept moving"
  shape. `FROZEN` always takes precedence over inferred WAITING: total
  silence, including the pane, is never also read as a raised hand.
- **"Waiting-benign"** — the muted end of the same amber, no live pathology,
  tooltip just *"stopped"*. This is what a lane reads as when workmux's last
  report was `waiting` but the worktree itself is already gone — a lane that
  has simply stopped, not one asking for you.

Either way, WAITING means the agent is blocked on a human — you — not that
something is broken.

## Honest-gap voices

When a fact isn't available, the UI says so in words instead of guessing or
showing a bare zero (law 12). Exact strings you may see:

- `NO COST FEED (OTel) — dollars unavailable — run: eval "$(rhizomorph env <lane>)"`
- `NO LANE MANIFEST (.swarm/lanes.json) — off-fence detection unavailable — run: dispatch.sh (writes the fence manifest)`
- `NO FENCE FOR N/M LANES — those lanes cannot be judged off-fence`
- `UNATTRIBUTED SPEND (N lanes) — burn has no declared owner`
- `CONDUCTOR NOT INSTRUMENTED — overhead ratio unknowable` (burn strip) / `— orchestration overhead unknowable` (fleet-level gap)
- `<COLLECTOR> COLLECTOR DISABLED — <reason> — run: rhizomorph doctor`
- `NO TRACE TELEMETRY — no trace telemetry from this lane — see docs/telemetry.md.` (per-lane, in the drawer's TRACE tab)

Each one names what's missing, why, and the exact command that fixes it —
see [troubleshooting.md](troubleshooting.md) for the ones you'll hit most on
a first run.

## The lane drawer

Click any fleet row (or the root-mass itself, for the conductor's own view)
to open it. Vitals sit fixed above one tabbed body, in this order:

1. **Activity** — the default tab on open. The activity ledger, so you can
   judge whether the conversation is worth reading before committing to it.
2. **Conversation** — the same thing you'd see sitting at that agent's own
   terminal: user turns marked with a `›` prompt, assistant prose in the
   page's own type (not a wall of monospace), tool calls as quiet one-line
   bullets (`● Read — path/to/file`, `⎿ result, …+2K more` when truncated).
   Tails the session log live; scroll up and it pauses and says so
   (`paused ▴`) rather than yanking you back down.
3. **Why** — every file this lane has touched against its declared fence, a
   click-through into Activity's own reading of any trespass.
4. **Trace** — the beta waterfall, when OTel spans are wired in for that
   lane (see [`docs/telemetry.md`](../telemetry.md#enabling-beta-traces)).
   It's a real, expandable per-interaction tree when spans exist; a lane
   with zero recorded spans shows the honest gap above (`NO TRACE
   TELEMETRY …`), not a blank panel.

Below all of it, an **ATTACH** button copies the exact `tmux`/`workmux`
attach command to your clipboard — it never runs anything. **Esc** closes
the drawer (before it ever exits panel focus).

## Keyboard reference

| Key | Scope | What it does |
|---|---|---|
| `1` / `2` / `3` | Page (scene unfocused) | Switch the driving log: live / fixtures |
| `1` | Scene (focused) | Zoom to fit the whole network |
| `0` | Scene (focused) | Reset the camera |
| `+` / `-` | Scene (focused) | Step the zoom in/out |
| `n` / `Shift+n` | Page (global) | Jump the shared selection to the next/previous lane that needs you |
| `f` | Fleet table (a lane in hand) | Focus the fleet table full-screen |
| `a` | Fleet table (a lane in hand) | Copy that lane's tmux/workmux attach command |
| `Esc` | Page (global) | Close the lane drawer, then exit panel focus — never both at once |

Every key is ignored while you're typing into a form field.

## Navigating away

There is no visible nav bar linking to `/recordings` or `/lab` from the main
dashboard today — both are direct-URL routes with a `← balcony` link back.
See [sessions.md](sessions.md) for `/recordings` and
[the-lab.md](the-lab.md) for `/lab`.
