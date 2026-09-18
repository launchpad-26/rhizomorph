# Watching the fleet

This is the read-only hand — collectors, receiver, server, UI. It never
writes to the repo you're watching, never sends a keystroke to an agent,
never merges anything. This page is what the picture on screen means.

## Which repositories are being watched

**Every one your agents are working in**, not the one you started in. The path
you pass is a pin, not a limit: it is watched first and it is what the scene
draws, and any other repository an agent of yours is running in is discovered
from the process table and watched on the same terms — its own recording, under
its own slug, in your own data directory.

A repository becomes watched by **an agent working in it**, and by nothing else.
There is no command that adds one, and a repo nobody is running anything in
produces no facts this design would record. Several worktrees of one repository
are one watched repository, not several: the grouping key is what `git` calls
the common directory, so a lane and its main checkout land together.

**The window draws one at a time and there is no picker yet.** Two surfaces
cover the rest:

- `rhizomorph doctor` names every repository it is watching, marks the pinned
  one, and counts the agents placed in each. It also counts the agents it could
  *not* place, rather than presenting a short list as complete.
- **The tray** carries alarms from anywhere. A lane that needs a person raises
  the badge whether or not its repository is the one on screen.

What is not there yet: a picker in the window, and any listing of another
repository's lanes by name.

**On Windows, only the repository you started in is watched.** The platform does
not report another process's working directory, so agents are identified and not
placed, and nothing can be discovered from them. `doctor` says so and counts
them rather than reporting an empty machine — see
[troubleshooting](troubleshooting.md#it-is-only-watching-one-repository).

## The fleet surface

*Who is alive* is one surface with two representations and one toggle (prd-36
ruling 1, #555/#562): **Organism** — the scene — and **List** — the fleet
table — one shown at a time, under a single `Fleet` heading. The toggle
switches them, and so does `v`; nothing else may, because no representation
is ever selected for you by application state. Until #555 the two cost the
viewport twice, the scene hero-sized above and the table full-width beneath
it, which is the layout this page used to describe.

**The list is the floor**, said in that direction deliberately: it is
complete and usable at every scene quality, in still mode, and on a machine
that cannot hold a frame budget. The organism is the enhancement. So when the
canvas does not come up, the organism arm falls to the list and says so once,
rather than leaving a blank frame where the fleet was:

> `ORGANISM UNAVAILABLE — the canvas did not come up, so the picture cannot
> be drawn. The list below carries every lane, complete; nothing else on the
> page is affected.`

It does not flip the toggle to get there — a canvas failure that rewrote your
remembered choice would be hiding the scene on the next reload of a machine
where it had since recovered. The choice is not remembered *yet*, and the
component says so in its own words rather than implying otherwise: a reload
lands back on the organism until `appearance.fleetRepresentation` is declared
in `settings/registry.ts` (`packages/web/src/fleet/TwoRepresentations.tsx`
carries that gap in its own voice).

## The scene

The organism representation: a root-mass at the center, one tendril per lane,
pulses of light traveling along them for real events (commits, token bursts)
— never invented, never replayed on top of history.

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

The list representation, and it carries no heading or frame of its own — the
surface above carries both. One dense row per lane: STATE, output tokens,
`$`, request/tool counts, thread/subagent count, age, fence status. The STATE
column draws the scene's own glyph *and* hue at row scale — it's the scene's
legend, so there's no separate key to learn.

Hover a STATE cell and you never get a bare label. Every explanation in the
instrument is assembled in one place and in one order —
`<reason> — <fact> <elapsed> ago · <remedy>`
(`web/src/disclosure/vocabulary.ts` over `selectLaneCondition`,
`packages/core/src/selectors/condition.ts`) — so a working lane's tooltip
reads, in full:

> `active within the last window — a tool call, model request or status
> update landed inside the working window 12s ago · nothing to do — this lane
> is getting on with it`

The table below gives the first two parts of that sentence for each word; the
third is the remedy, and a condition with nothing to do states why it has
none rather than going blank.

| Word | Reason | Evidence behind it |
|---|---|---|
| `working` | active within the last window | a tool call, model request or status update landed inside the working window |
| `done` | finished | the agent declared done — or, when the lane is gone, the worktree landed and was removed |
| `idle` | quiet, past the idle threshold | no tool call, model request or status update has landed since the idle threshold passed |
| `unknown` | no work signal yet | no request, tool call or status update has reached this lane |
| `PARKED` | stood down by the operator, not silent by accident | the lane manifest declares it parked — alarm inferences suppressed, other evidence unaffected |
| `LOOPING` | stuck in a repeating tool cycle with nothing landing behind it | the detector's own line, e.g. `a→b→a ×4, no commit` |
| `FROZEN` | gone silent — no events of any kind | `no events for <span>` |
| `WAITING` | stopped, waiting on a human to answer | `workmux reports waiting <span>`, or `quiet <span>, pane still alive` when inferred — see below |
| `EXPENSIVE` | burning tokens far faster than the rest of the fleet | `<n> out-tok/min, <x>× fleet median` |
| `OFF-FENCE` | touching files outside its declared fence | `<n> files outside fence — <path> → <victim>`, `+N more` past the first few |

A lane that finished without ever saying so still reads `done`, but for a
different reason — *finished, but never said so* — with the geography as its
evidence: the worktree is clean and ahead of main, and the pane likely died
right after its last commit landed.

If a lane carries more than one pathology at once, the fact grows a
`· +N more: <...>` clause rather than dropping the quieter ones. An inferred
(rather than declared) pathology wears an inline `~` on its evidence, and the
mark carries its own tooltip: *"inferred from a weaker signal"*.

Colour is never the only carrier of a state: five hues, one meaning each
(green = productive, amber = blocked on a human, red = dead — `FROZEN`
only, cyan = notice, ice = structure/nothing-to-say), and only a
`NEEDS-YOU`/`FROZEN` mark reaches the brightest band — a summons is always
the brightest thing on the screen. The scene's magenta is not a sixth: it is
the fruiting *material* (`scene/palette.ts`'s `FRUIT_RAMP`), worn only by
matter that returned, and a magenta status chip would be
[a fifth status hue by the back door](../design-notes/palette-fruiting-material.md).

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
- **"Waiting-benign"** — the muted end of the same amber, with no live
  pathology behind it. This is what a lane reads as when workmux's last
  report was `waiting` but the worktree itself is already gone — a lane that
  has simply stopped, not one asking for you. Its tooltip is no longer the
  bare word *"stopped"*: since #560 every STATE cell speaks the disclosure
  shape above, reason and evidence included.

Either way, WAITING means the agent is blocked on a human — you — not that
something is broken.

## Honest-gap voices

When a fact isn't available, the UI says so in words instead of guessing or
showing a bare zero (law 12). A representative sample, not an enumeration —
the fleet speaks more of these than are listed here, and an unlisted string
is not a bug:

- `NO COST FEED (OTel) — dollars unavailable — run: eval "$(rhizomorph env <lane>)"`
- `NO LANE MANIFEST (.swarm/lanes.json) — off-fence detection unavailable — run: your dispatch tooling — writes .swarm/lanes.json, not part of this repo (see docs/user-guide/troubleshooting.md)`
- `NO FENCE FOR N/M LANES — those lanes cannot be judged off-fence — run: your dispatch tooling — writes .swarm/lanes.json, not part of this repo (see docs/user-guide/troubleshooting.md)`
- `UNATTRIBUTED SPEND (N lanes) — burn has no declared owner — run: eval "$(rhizomorph env <lane> --role worker)"`
- `CONDUCTOR NOT INSTRUMENTED — overhead ratio unknowable` (burn strip, no remedy suffix — `packages/web/src/panels/burn/format.ts`) / `CONDUCTOR NOT INSTRUMENTED — orchestration overhead unknowable — run: rhizomorph --extra-sessions <dir>:conductor` (fleet-level gap)
- `<COLLECTOR> COLLECTOR DISABLED — <reason> — run: rhizomorph doctor`
- `<COLLECTOR> COLLECTOR DEGRADED — <last error, or "retrying after failures"> — run: rhizomorph doctor` — the honest middle (#304): a collector still trying, which is the voice a flaky feed actually speaks in
- `NO TRACE TELEMETRY — no trace telemetry from this lane — see docs/telemetry.md.` (per-lane, wherever a trace is drawn — the run view's trace column, the dock's own trace panel)

Each one names what's missing, why, and what closes it — usually a command you
can paste. Two exceptions, both deliberate. The burn strip's conductor gap has
no remedy suffix at all, because it is a one-line cell with no room for one;
the fleet-level gap for the same fact carries the command. And the two manifest
gaps name *tooling* rather than a command, because `.swarm/lanes.json` is
written by whatever dispatch tooling you run, which lives outside this repo —
until #63 they claimed to be a command, `run: dispatch.sh`, and sent readers
hunting for a script this repo has never contained.

Most of these are transcribed from `buildGaps`
(`packages/core/src/fleet/gaps.ts`); the conductor gap's burn-strip form comes
from `CONDUCTOR_NOT_INSTRUMENTED_GAP`
(`packages/web/src/panels/burn/format.ts`), and the trace gap from
`packages/web/src/trace/EmptyTrace.tsx`. None of the three are checked against
this list by any test, so treat a mismatch as this list being stale, not the
UI being wrong. See [troubleshooting.md](troubleshooting.md) for the ones
you'll hit most on a first run.

## The peek

Click any lane — a fleet row, a scene node, a strip chip; they all write the
one selection — and the peek opens on the right with the fleet still visible
behind it. Since #562 (prd-36 ruling 2/S2) it is four things and one action:
vitals, the latest activity line, one line of why, and *open the run view*.
The shortness is the ruling rather than a simplification of it, and the peek
issues no request at all — it reads the same fold every other surface reads,
so its top line and the run view's cannot be different events.

- **latest** — the single most recent thing this lane did to the repo (a tool
  call, a file change, a commit), or `nothing recorded` when the fold has
  none for it.
- **why** — the condition's label and reason, and deliberately not the remedy
  or the evidence: those are the run view's, and a peek carrying the remedy
  would be inviting you to act on a glance.

Clicking the root-mass opens the same peek for the conductor — the
orchestrator's own vitals, and `/lane/main` as the one action.

**Esc** closes the peek (before it ever exits panel focus). The ATTACH
command is no longer a button here: it is the fleet table's `a` verb, over
the same clipboard path this panel used to call, which is where a hand
already is when it wants one.

## The run view

`/lane/:handle` — the deep-linkable page for one lane, and where the peek's
one action goes. The four tabs the drawer used to carry live here now, laid
out side by side rather than stacked behind one another, because two surfaces
rendering the same four tabs is how they drift and the drawer was the weaker
one by construction: transient, unlinkable in a review, and dead the moment
`workmux merge` removed the worktree.

- **The outcome and the spine** — what this piece of work did, with the
  evidence for it, above the derived phase spine of the run and its
  interaction cards.
- **Conversation** — the same thing you'd see sitting at that agent's own
  terminal: user turns marked with a `›` prompt, assistant prose in the
  page's own type (not a wall of monospace), tool calls as quiet one-line
  bullets (`● Read — path/to/file`, `⎿ result, …+2K more` when truncated).
  Tails the session log live; scroll up and it pauses and says so
  (`paused ▴`) rather than yanking you back down.
- **Trace** — beside the conversation, not behind it: the beta waterfall,
  when OTel spans are wired in for that lane (see
  [`docs/telemetry.md`](../telemetry.md#enabling-beta-traces)). A real,
  expandable per-interaction tree when spans exist; a lane with zero recorded
  spans shows the honest gap above (`NO TRACE TELEMETRY …`), not a blank
  panel.
- **Spend and activity** — the burn broken out, beside the activity ledger
  the peek's one `latest` line is folded from.
- **Why** — every file this lane has touched against its declared fence, a
  click-through into the ledger's own reading of any trespass.

**And it reads after the lane is gone**, which is the expensive half of the
ruling and the whole reason the tabs moved here. The page has two feeds: the
loaded recording's fold, and `/api/lane-index/:handle` — every recording this
lane ever appears in, read from the logs and the captured transcripts beside
them, never from a worktree. So a lane `workmux merge` deleted last week
still renders every region. A handle neither feed knows says so in two
sentences (`NO LANE "<handle>" IN THIS SESSION …`, then the server's own
account of what it searched) rather than showing you an empty page. **Esc**
returns to the balcony.

## Keyboard reference

| Key | Scope | What it does |
|---|---|---|
| `1` / `2` / `3` | Page (scene unfocused) | Switch the driving log: live / fixtures |
| `1` | Scene (focused) | Zoom to fit the whole network |
| `0` | Scene (focused) | Reset the camera |
| `+` / `-` | Scene (focused) | Step the zoom in/out |
| `v` | Fleet surface | Switch the representation: organism ⇄ list |
| `n` / `Shift+n` | Page (global) | Jump the shared selection to the next/previous lane that needs you |
| `f` | Fleet table (a lane in hand) | Focus the fleet table full-screen |
| `a` | Fleet table (a lane in hand) | Copy that lane's tmux/workmux attach command |
| `Esc` | Page (global) | Close the peek, then exit panel focus — never both at once |

Every key is ignored while you're typing into a form field.

## The primary nav

Since #549 (prd-32 ruling 10) the same five-entry nav rides at the top of
every surface — Observatory · Recordings · Lab · Connect · Settings, real
`<a href>`s — and the one exception is stated rather than hidden: while a
recording is loaded, Lab renders as a disabled entry carrying its reason
(*"unavailable during replay — the lab forks live checkpoints, and this
session is history"*), never as an entry that quietly vanished. See
[sessions.md](sessions.md) for `/recordings` and [the-lab.md](the-lab.md) for
`/lab`.
