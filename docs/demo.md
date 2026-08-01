# Demo script — the ruling-25 checks

prd3 [ruling 25](prd3.md) defines the demo as four falsifiable checks, not a
narrated tour: GLANCE, PATHOLOGY, SCENE, MODE. Each one has a pass condition
and a failure condition below — run them in order, on the fixtures built for
exactly this purpose, and you need no live swarm to do it.

## Setup

```sh
git clone https://github.com/KelliherL/worktrees-challenge
cd worktrees-challenge
npm install
npm run build   # builds packages/web
npm start       # boots collectors + server on http://127.0.0.1:4321
```

Open the printed URL, full-screen it. Everything below is driven by three
keyboard shortcuts — no swarm, no telemetry, no setup beyond this:

| Key | Source | What it loads |
|---|---|---|
| `1` | `live` | The real collectors, watching whatever repo you pointed `observatory` at |
| `2` | `fleet20` | A synthetic 20-lane fleet, every lane healthy — [ruling 22](prd3.md)'s scale test |
| `3` | `pathology` | A synthetic fleet with exactly one lane per pathology, calm neighbours around them |

(Keys are ignored while typing in a form field.) Two more keys matter for the
checks below: **Esc** — closes the lane drawer if one is open, otherwise
exits panel focus if a panel is focused, otherwise does nothing (shell-level
precedence: drawer first, then focus) — and clicking a fleet-table row, which
opens that lane's drawer (vitals, activity, transcript, an **ATTACH** button
that copies a tmux/workmux command to your clipboard and never runs it).

If you'd rather run this against a real swarm: point `npm start -- <path>` at
a repo with worktrees and tmux panes going (see the README's ["worktrees-challenge
context"](../README.md#the-worktrees-challenge-context) section for
`workmux` setup), then use key `1` instead of `2`/`3` throughout. Telemetry
(the burn strip's dollar figures) needs each lane's env set before `claude`
launches — see [`docs/telemetry.md`](telemetry.md); without it the checks
below still pass on tokens alone, since the burn strip's gap voice
(`NO COST FEED (OTel) — dollars unavailable — run: …`) is itself part of the
honest-empty-state design, not a failure.

## Check 1 — GLANCE

> "From a 3-second look at a busy fleet, answer: anything need me? how many
> lanes working? rough cost?" — passed by Lachlan **and** ideally one
> non-Lachlan viewer.

1. Press **`2`** to load the 20-lane fixture.
2. Look away from the screen, then look back for a 3-second glance at the top
   of the dashboard only — the attention strip and burn strip. Don't scroll,
   don't read the fleet table row by row.
3. Answer, from that glance alone:
   - **Anything need me?** The attention strip's pill: `ALL CLEAR` (with its
     evidence line — "N lanes · M branches · K files checked · collisions 0")
     or `N NEED ATTENTION` with named chips.
   - **How many lanes are working?** Either the calm evidence line's lane
     count, or a glance at the fleet table's row count.
   - **Rough cost?** The burn strip's leading output-token figure, and the
     `$` figure beside it once cost is authoritative.

**What you should see:** all three answers land inside the 3 seconds, without
needing to hover, scroll, or open anything.

**What failure looks like:** hesitating past the glance, misreading `ALL
CLEAR` as an alarm state (or vice versa), or needing to read individual fleet
rows to get a lane count. `ALL CLEAR` next to a nonzero collision count would
also be a failure — but per [ruling 22/g5](prd3.md), the ladder floor makes
that combination structurally unrepresentable in the data the strip reads, so
it should never be reachable from a real bug in this area.

## Check 2 — PATHOLOGY

> "On the staged fixture, point at the looping, frozen, waiting, expensive,
> and off-fence lanes within seconds."

1. Press **`3`** to load the staged-pathology fixture. The attention strip
   should read `5 NEED ATTENTION` with five chips.
2. Within a few seconds, point at (by name, in the strip or the fleet table's
   STATE column) all five:

   | Pathology | Lane | What names it |
   |---|---|---|
   | LOOPING | `41-retry-parser` | Repeating tool cycle, evidence like `Edit→Bash→Read ×6, no commit` |
   | FROZEN | `42-otel-receiver` | `no events for Nm` — total silence, pane heartbeats included |
   | WAITING | `43-drawer-attach` | `workmux reports waiting` — a raised-hand glyph, distinct from frozen |
   | EXPENSIVE | `44-scene-pulses` | Burn far above the fleet median (visibly the white-hot thread in the scene) |
   | OFF-FENCE | `45-ledger-subrows` | `touching 46-spend-selectors` — a trespass with a named victim |

3. Confirm the fleet table's STATE column alone is enough to name each one —
   it draws the scene's own glyph at row scale ([graft g1](prd3.md)), so the
   table doubles as the legend; you shouldn't need to open a drawer to tell
   WAITING from FROZEN.

**What you should see:** all five named without hunting, each backed by an
evidence string, not a bare label ([graft g4](prd3.md)).

**What failure looks like:** needing the drawer (or a hover tooltip) to
distinguish two pathologies that should already read apart at a glance; the
EXPENSIVE lane's white-hot thread outshining a needs-you/broken sigil
elsewhere in the scene (a regression in the [EXPENSIVE-recede scar,
graft g6](prd3.md)); or the fixture showing a count other than five.

## Check 3 — SCENE

> "A first-time viewer explains the encoding within 30 seconds, no legend."

1. With any fixture loaded (`2` or `3` both work — `3` gives more to look at),
   hand the screen to someone who hasn't seen the Observatory before. Show
   them the SCENE panel only — collapse or ignore the rest.
2. Give them 30 seconds of silent looking, then ask what they're looking at.

**What you should see:** an explanation that covers, unprompted: threads
reaching out from a central mass are lanes/agents; brightness and traveling
pulses are activity (commits, tokens); a stuck or orbiting pulse, a dark
thread, or a white-hot thread each mean something is off; a lane's position
doesn't drift once you've noticed it (a lane keeps its angular slot for the
session — [graft g7](prd3.md)).

**What failure looks like:** silence past 30 seconds; a guess about the wrong
axis (e.g. "the length means how long it's been running," which it doesn't);
or needing the mycelium metaphor explained before it clicks.

## Check 4 — MODE

> "Shown a replay mid-scrub, the viewer says 'this is the past' unprompted."

1. Press **`1`** to return to live, then click **"Replay this session's
   birth"** in the replay bar. Bump the speed to **16x** and let it run a few
   seconds, then scrub by hand to a moment mid-session.
2. Show the screen, mid-scrub, to a first-time viewer with no context.

**What you should see:** they say "this is the past" (or an equivalent)
without being asked whether it's live — driven by the REPLAY banner that
has structurally replaced the attention strip ([ruling 16](prd3.md): replay
is a full mode shift, not a tinted live view — the two are mutually
exclusive in the shell, never stacked), its ice-register frame/tint rather
than a ladder hue, the visible timestamp and session identity, and the
scrubber itself.

**What failure looks like:** they ask "is this live?"; they mistake the
banner for an ordinary status line; or the attention strip is visible at the
same time as the replay banner (a regression — the two must never render
together, since a live summons rendered over a recording is exactly the
failure ruling 16 exists to prevent).

## If something degrades

- **No workmux installed:** one `collector.disabled` event, agent-status
  detection goes quiet (WAITING becomes unavailable, flagged rather than
  guessed), everything else keeps working — the gap voice
  (`packages/web/src/app/StatusBar.tsx`) says so in the provenance bar.
- **The scene errors:** the error boundary drops it; the fleet table and the
  rest of the panel grid stand alone; PATHOLOGY and GLANCE still pass off the
  table alone (see Check 2, step 3).
- **No lane manifest:** OFF-FENCE detection is unavailable, named as a gap
  rather than silently absent — `observatory doctor` has its own
  `lane-manifest` check for this.
- **No telemetry env set on any lane:** the burn strip shows output tokens
  only, with `NO COST FEED (OTel) — dollars unavailable — run: eval
  "$(observatory env <lane>)"` in place of a dollar figure — say so out loud,
  same empty-state discipline as every other gap.
