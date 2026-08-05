# Demo script — the ruling-25 checks

prd3 [ruling 25](prd3.md) defines the demo as four falsifiable checks, not a
narrated tour: GLANCE, PATHOLOGY, SCENE, MODE. Each one has a pass condition
and a failure condition below — run them in order, on the fixtures built for
exactly this purpose, and you need no live swarm to do it.

Every check below is now run against [prd4 ruling 1](prd4.md), the **layman
bar** (a standing ruling): a first-time viewer — layman, even though the
product targets developers — should understand what is going on, what things
mean, and what to do next. GLANCE and SCENE in particular ask for a
non-Lachlan, first-time viewer explicitly, not just the person who built the
tool checking their own work.

## Setup

```sh
git clone https://github.com/KelliherL/rhizomorph
cd rhizomorph
npm install
npm run build   # builds packages/web
npm start       # boots collectors + server on http://127.0.0.1:4321
```

Open the printed URL, full-screen it. Everything below is driven by three
keyboard shortcuts — no swarm, no telemetry, no setup beyond this:

| Key | Source | What it loads |
|---|---|---|
| `1` | `live` | The real collectors, watching whatever repo you pointed `rhizomorph` at |
| `2` | `fleet20` | A synthetic 20-lane fleet, every lane healthy — [ruling 22](prd3.md)'s scale test |
| `3` | `pathology` | A synthetic fleet with exactly one lane per pathology, calm neighbours around them |

(Keys are ignored while typing in a form field.) Two more keys matter for the
checks below: **Esc** — closes the lane drawer if one is open, otherwise
exits panel focus if a panel is focused, otherwise does nothing (shell-level
precedence: drawer first, then focus) — and clicking a fleet-table row, which
opens that lane's drawer: vitals on top, then one tabbed body beneath it —
**ACTIVITY, CONVERSATION, WHY, TRACE** — opening on **ACTIVITY** by default
(an operator ruling, #164: the activity ledger tells you whether the
conversation is worth reading before you commit to it). **CONVERSATION** is
a click away, and is the same thing you'd see at that agent's own terminal,
tailing live. An **ATTACH** button below the tabs copies a tmux/workmux
command to your clipboard and never runs it.

If you'd rather run this against a real swarm: point `npm start -- <path>` at
a repo with worktrees and tmux panes going (see the README's
["Prerequisites, restated"](../README.md#prerequisites-restated) section for
`workmux` setup), then use key `1` instead of `2`/`3` throughout. Telemetry
(the burn strip's dollar figures) needs each lane's env set before `claude`
launches — see [`docs/telemetry.md`](telemetry.md); without it the checks
below still pass on tokens alone, since the burn strip's gap voice
(`NO COST FEED (OTel) — dollars unavailable — run: …`) is itself part of the
honest-empty-state design, not a failure.

## Check 1 — GLANCE

> "From a 3-second look at a busy fleet, answer: anything need me? how many
> lanes working? rough cost?" — passed by Lachlan **and**, per [prd4 ruling
> 1](prd4.md)'s layman bar, a non-Lachlan, first-time viewer explicitly
> invited to try it too, not merely a nice-to-have.

1. Press **`2`** to load the 20-lane fixture.
2. Look away from the screen, then look back for a 3-second glance at the top
   of the dashboard only — the attention strip and burn strip (the scene, now
   the centerpiece directly beneath them, is fair game too — a first-time
   viewer's eye goes there first). Don't scroll, don't read the fleet table
   row by row.
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
   it draws the scene's own glyph, in the scene's own hue, at row scale
   ([graft g1](prd3.md); hue since [prd4 ruling 3](prd4.md)), so the table
   doubles as the legend for shape *and* color; you shouldn't need to open a
   drawer to tell WAITING (amber, a raised hand) from FROZEN (red, a severed
   bar) — color and silhouette agree, on purpose.

**What you should see:** all five named without hunting, each backed by an
evidence string, not a bare label ([graft g4](prd3.md)).

**What failure looks like:** needing the drawer (or a hover tooltip) to
distinguish two pathologies that should already read apart at a glance; the
EXPENSIVE lane's white-hot thread outshining a needs-you/broken sigil
elsewhere in the scene (a regression in the [EXPENSIVE-recede scar,
graft g6](prd3.md)); or the fixture showing a count other than five.

## Check 3 — SCENE

> "A first-time viewer explains the encoding within 30 seconds, no legend." —
> [prd4 ruling 1](prd4.md) requires this viewer be a genuine layman, not
> someone already fluent in the rest of the dashboard.

1. With any fixture loaded (`2` or `3` both work — `3` gives more to look at),
   hand the screen to someone who hasn't seen the Rhizomorph before. Show
   them the SCENE panel only — it's the first thing under the top dock now
   ([prd4 ruling 2](prd4.md)), so this is naturally what they see first
   anyway; collapse or ignore the rest of the page regardless.
2. Give them 30 seconds of silent looking, then ask what they're looking at.

**What you should see:** an explanation that covers, unprompted: threads
reaching out from a central mass are lanes/agents; a thicker thread has
produced more, and a thin one hasn't produced much yet ([prd6
ruling 1](prd6.md) — thread width is absolute, so a thick thread stays thick
even next to a whale); a thread's distance from the mass is how far along
it is — close in is newer, out at the rim means it's finishing or already
done ([prd6 ruling 4](prd6.md)); brightness and traveling pulses are
activity (commits, tokens); green threads are getting on with it, amber
ones are stopped and waiting on a person, a hollow red mark is dead ([prd4
ruling 3](prd4.md)'s law 9a — hue is meaning, and each hue means one
thing); a stuck or orbiting pulse, a dark thread, or a white-hot thread each
mean something is off; a lane's position doesn't drift once you've noticed it
(a lane keeps its angular slot for the session — [graft g7](prd3.md)); and,
since [prd7](prd7.md) redrew every thread as a filled ribbon rather than a
stroked line, a thread that visibly narrows to nothing partway along itself
reads as *cut* (FROZEN) and one that draws down to a sharp needle near its
tip reads as *burning hot* (EXPENSIVE) — both without any icon glued onto
the line, because the line's own width is now doing the talking. The centre
itself should read as one soft, organic surface — not a target made of
rings — that a first-time viewer describes as a single blob rather than a
stack of circles.

**What failure looks like:** silence past 30 seconds; a guess about the
wrong axis (e.g. "distance means how important the lane is," or "a thicker
thread means it's working harder right now" rather than "it's produced
more" — both swap a lifecycle/output fact for an activity one); needing the
mycelium metaphor explained before it clicks; needing the color explained as
anything other than what it visibly is (green = good, amber = needs a
person, red = dead); or the centre reading as a faceted, geometric shape
rather than an organic one (a regression — [prd7 ruling 5](prd7.md) requires
one smooth contour, not a crystal).

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

## The camera, the cord-cut, and pause — what you can *do*

The four checks above establish that the scene reads correctly at a
glance. prd5 (`docs/prd5.md`) added things to actually *do* with it, once
you're looking, and prd6 (`docs/prd6.md`) added two more — the root-mass
now visibly grows, and the root-mass itself is something you can click — a
first-time reader should come away knowing all of it exists, not just what
the picture means.

### Drive the camera

1. With any fixture loaded, click once inside the scene panel to give it
   focus (or tab to it) — this matters, because `1`/`0`/`+`/`-` mean
   something else on the rest of the page (switching the driving log)
   until the scene itself has focus.
2. Drag to pan. Hold Ctrl (or Cmd on a Mac) and scroll to zoom in on
   whatever's under your pointer — the point you're pointing at stays put
   as the picture scales around it. A trackpad pinch does the same thing.
3. Press **`1`** to zoom-to-fit the whole network, **`0`** to reset, or use
   the four buttons in the scene's bottom-right corner (**−**, **+**,
   **Fit**, **Reset**) if you'd rather click than type.
4. Drag or zoom the network mostly out of the visible panel, and watch for
   a **Recenter** button to fade in, bottom-right — click it to come back.
   It's the one thing that appears only when you'd actually need it.

**What failure looks like:** pressing `1` switches the driving log instead
of fitting the camera (the scene didn't have focus); zooming moves the
picture rather than the point under your cursor; Recenter never appears no
matter how far you pan away, or appears when the network is already in
view.

### Drive the TIDE dock

The bottom transport bar (present in both live and replay) carries a sparse
**chapter-mark lane** above the scrubber — one mark per lane-born, landed,
gate-held, or attention-summons moment, plus session boundaries. This is
what's left of prd13's dock after the operator cut its per-lane density
band outright (*"get rid of the working green strips entirely"*, 2026-08-06)
— marks, an axis, and the transport, nothing else.

1. Hover a mark, or a coalesced cluster (drawn as `×N` under density). A
   card appears after a short pause (the "the label appears as you linger"
   idiom), naming who/what/when for every member — it's portaled straight
   to the page body, so it can't be clipped or buried by anything else on
   screen.
2. Click a mark to seek straight to that moment.
3. With the dock focused, hold **Shift** and scroll to zoom the mark lane
   in — the timestamp under your cursor stays under it, exactly like the
   scene's own Ctrl/Cmd+scroll zoom. A still bracket appears on the
   scrubber below, showing where your zoomed window sits against the whole
   session. This never restricts what the scrubber itself can reach — it
   stays full-range, always.
4. Press **`[`** / **`]`** to step to the neighbouring chapter without
   touching the mouse.

**What you should see:** a hover card appears within a beat of pausing over
a mark, legible and never clipped by anything else on the page; zooming
keeps the point under your cursor fixed; the scrubber underneath is
unaffected by how zoomed the mark lane is.

**What failure looks like:** a hover card clipped or invisible; zoom moving
the wrong point under the cursor; the scrubber's own reachable range
shrinking because the mark lane zoomed.

### Browse the recordings library

Every server run auto-records from the moment it starts (see
[Trust](../README.md#the-recorder--the-observers-own-second-hand-narrower-than-either-prd16-ruling-2)
in the README) — `/recordings` is where you manage what's piled up.

1. Open `/recordings` in the browser (or navigate there from the app).
2. Confirm it's a plain, honest table: title (a label if you set one, else
   an auto-title derived from that session's own events), lanes, landed,
   duration, tokens, cost. It never shows live fleet state — this is a
   library, not a second dashboard.
3. Rename a recording in place. Confirm the balcony's own session picker
   (the replay dropdown) reflects the new name without a reload.
4. Open one in replay, or export it (`rhizomorph export-record`'s own
   output) to hand to someone else.

**What failure looks like:** the page shows anything that looks like a live
lane's current state rather than a recorded fact; a rename doesn't show up
elsewhere in the app; export produces nothing or something unreadable by
`docs/record-format.md`'s own verifier.

### Watch a lane cut loose, and come home

The two fixtures (`2`/`3`) don't include a finished lane of their own —
they're built to stay a fixed, reproducible scale test and pathology set.
To see the cord-cut itself: let a real swarm run under `1` (live) until a
lane lands (workmux marks it `done`, or its worktree is removed), or read
[`docs/architecture.md`](architecture.md#the-cord-cut-102-ruling-3) for the
stage-by-stage description backed by `retire.test.ts`. What you're looking
for: the thread goes slack, one last swell of the ribbon's own width runs
back down it into the root-mass — the lane's substance going home, told as
matter moving through the hypha rather than a light travelling on top of it
(since [prd7 ruling 3](prd7.md) — [prd6 ruling 2](prd6.md) is the fact,
unchanged) — the mass bulges gently where it arrives and settles back
([prd7 ruling 5](prd7.md)), the freed end springs back to its own node with
no bounce, and what's left settles into a small, permanently dimmed mark
near the rim — never gone, never re-lit, and **sized to that lane's own
output**
([prd6 ruling 1](prd6.md): a lane that did more work leaves a visibly
bigger scar, which overrules prd5's "a scar is a mark, so it's the same
size for every lane"). The **hide finished** button (top-right of the
scene, appears once at least one lane has finished) toggles those marks
out of the picture and always shows its own count, so "hidden" is never
mistaken for "gone" — the fleet table keeps listing the lane regardless of
the toggle, and the root-mass never shrinks back down when you hide its
scars.

Over a longer session, compare the root-mass at the start and the end:
it's visibly thicker once a few lanes have landed, because every one of
them sent its work home into it ([prd6 ruling 2](prd6.md)) — you notice
it's bigger, you never catch it growing.

**What failure looks like:** a finished lane's thread stays attached to
the mass with only its color changed; a scar fades away entirely over
time, or every scar reads as the same size regardless of how much its lane
produced; the root-mass never visibly thickens no matter how much has
landed; the hide-finished button doesn't show a count, or shows one that
doesn't match the fleet table's finished-lane total.

If the same handle is dispatched again after landing, its new thread
**germinates from the seed it left behind** — same angle, same seat,
already as big as what it grew from — rather than sprouting somewhere new
and re-spacing the whole ring ([prd6 ruling 3](prd6.md)). There's no key to
force this on the shipped fixtures; it's mentioned here so you know what
you're looking at if you see it on a real swarm.

### Every lane hand-grown, none of them lying

Look closely at either fixture (`2` is the easier read — twenty healthy
lanes side by side) and no two threads bend the same way, even though
several are close in output and lifecycle. That is deliberate
([prd7 ruling 4](prd7.md)): each thread's gentle wander is seeded from a
hash of **that lane's own name**, never from the clock, so it is bounded —
it can nudge a thread sideways a little and make its width wobble a few
percent, and it can never move where a thread sits on its lifecycle, what
hue it wears, or the width that encodes its output, because those are the
facts every other rule in this app depends on.

**What you should see:** reload the page (or press `2` again) and the same
twenty lanes bend exactly the same way — same session, same picture, every
time, including under replay recorded on a different machine.

**What failure looks like:** the fleet redrawing with different bends on a
reload with no new data; two lanes with very different output or age
looking identical because the wander swallowed the real difference; or a
thread's wander being large enough that its lifecycle distance becomes hard
to read.

### Click MAIN

1. With any fixture loaded (or live), click the root-mass at the centre of
   the scene — the same click a lane's node takes.
2. Confirm the same drawer opens, on **`Main — the conductor`**: vitals
   (branch, landings, commits home, output, `$`, overhead) instead of a
   lane's, then the same tabbed body (opening on ACTIVITY, CONVERSATION a
   click away, tailing the conductor's own session), then the same
   copies-never-executes ATTACH ([prd6 ruling 5](prd6.md)).

**What you should see:** a hovered root-mass shows a pointer cursor, same
as a lane node; the drawer that opens is visually identical in frame and
layout to a lane's, just with main's own facts in the vitals grid; an
un-instrumented conductor says so in words (`conductor not instrumented —
its burn is unknown, not zero`) rather than showing an empty conversation
or a `$0.00` that would disagree with the burn strip four inches away.

**What failure looks like:** clicking the mass does nothing; the fleet
table grows a `MAIN` row (it must not — main is a pseudo-lane, deliberately
not one of `fleet.lanes`); the drawer shows a blank conversation instead of
naming the gap.

### Pause the scene

1. With any fixture loaded, click **Pause motion** (top-left of the
   scene).
2. Confirm two things: the label changes to **Resume motion** and a
   `Motion paused` line appears beside it in words — and the scene's own
   ambient breath and event pulses visibly stop moving.
3. Click it again to resume.

This exists because WCAG 2.2.2 requires a way to stop content that starts
moving on its own and runs longer than five seconds — an always-breathing
scene without this button would fail that outright. **What you should
see:** nothing in the scene moves while paused, except a cord-cut already
under way, which finishes and settles rather than freezing half-severed
(a deliberate exception — a half-cut thread is still a true picture of
what happened; a half-grown one would not be). If your system has
`prefers-reduced-motion` set, the same idea applies automatically: color
and brightness still change, but nothing travels or changes size.

### Amber ages with attention

On the pathology fixture (`3`), the `WAITING` chip is fresh, so it reads
at the quieter end of amber — the same shade a benign wait wears. There's
no way to fast-forward a fixture's clock to see the escalation live, but
the rule is: past two minutes unanswered a `NEEDS-YOU` chip reaches full
needs-you brightness, and past ten minutes it adds a slow pulse and
brightens its own age figure. The severity rung never changes with age —
only how insistently the same rung reads.

### Orientation extras

- **`n`** / **`Shift+n`** (anywhere on the page, no focus needed) jumps the
  shared selection to the next/previous lane that needs you, worst rung
  then oldest first — the same thing a click on that lane would do
  (opens the drawer, spotlights the scene, highlights the table row).
  Nowhere to jump to flashes the attention strip once rather than doing
  nothing visibly.
- **`f`** / **`a`**, with a lane focused or selected in the fleet table,
  focus the table full-screen or copy that lane's tmux/workmux attach
  command to your clipboard — the table's own footer names both.

## If something degrades

- **No workmux installed:** one `collector.disabled` event, agent-status
  detection goes quiet (WAITING becomes unavailable, flagged rather than
  guessed), everything else keeps working — the gap voice
  (`packages/web/src/app/StatusBar.tsx`) says so in the provenance bar.
- **The scene errors:** the error boundary drops it; the fleet table and the
  rest of the panel grid stand alone; PATHOLOGY and GLANCE still pass off the
  table alone (see Check 2, step 3).
- **No lane manifest:** OFF-FENCE detection is unavailable, named as a gap
  rather than silently absent — `rhizomorph doctor` has its own
  `lane-manifest` check for this.
- **No telemetry env set on any lane:** the burn strip shows output tokens
  only, with `NO COST FEED (OTel) — dollars unavailable — run: eval
  "$(rhizomorph env <lane>)"` in place of a dollar figure — say so out loud,
  same empty-state discipline as every other gap.
- **A lane is parked:** ([prd4 ruling 5](prd4.md)) it shows a dimmed `PARKED`
  in the STATE column instead of a pathology, stays off the attention ladder
  entirely, and is exempt from FROZEN/WAITING even at any age — this is a
  declaration an operator made in `.swarm/lanes.json` (`"parked": true`),
  never something the read-only Rhizomorph decided on its own.
- **The conductor isn't instrumented:** ([prd6 ruling 5](prd6.md)) clicking
  MAIN still opens the drawer — it says `conductor not instrumented — its
  burn is unknown, not zero` in the vitals and conversation, rather than a
  blank pane or a `$0.00` that would disagree with the burn strip.
