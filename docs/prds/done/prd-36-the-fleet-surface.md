# prd-36 — the fleet surface: one thing, two representations

> **Outcome:** shipped.
> **Kind: specifying** (`docs/prds/README.md`).
> The organism and the roster are already one thing pretending to be two — the fleet table's
> STATE column draws the scene's own glyphs at row scale, which makes the table the scene's
> legend. This PRD merges them into a single surface with two representations, toggled, sharing
> one selection; **the list is the floor and the art is the enhancement.** It also demotes the
> drawer to a peek and retires the focus trace panel, both superseded by prd-31's run view.
> Sequenced in stage 2, after prd-32 wave 1 (it consumes the tokens) and beside prd-30/prd-31.
> Decisions from `docs/design/ui-2.0-decisions.md` (D13, D18, D19, D21, D22).

## Problem

The main screen asks a person to read the same fleet twice. The scene shows lanes as threads —
alive, positioned by lifecycle, coloured by state — and immediately beneath it a table shows the
same lanes as rows with the same state, drawn with the same glyphs. Neither is wrong; together
they cost the entire viewport, and a laptop user scrolls past the spend ledger to reach anything
else.

Worse, they drift. Selection is shared but nothing else is: the table sorts by the derived fleet
while the scene positions by lifecycle, so "the third row" and "the thread on the left" are the
same lane with no visual correspondence beyond colour. A person learns two mental models for one
set of facts.

And the scene has a structural weakness the table quietly covers: it is a canvas. It cannot be
searched, copied, screen-read, or rendered usefully at forty lanes without becoming a hairball.
Every time the scene gets more ambitious — and prd-33 makes it an art piece — that weakness gets
larger. The table is the reason nobody has had to face it.

## Evidence

- **The table is already the scene's legend.** `packages/web/src/panels/fleet/index.tsx` renders
  the STATE column via `Sigil` from `packages/web/src/fleet/sigils.tsx` at `SIGIL_ROW_SIZE = 15`;
  the scene renders the same glyph alphabet at `SIGIL_SCENE_SIZE = 64`. One code path, two sizes.
- **Selection is already shared.** `SelectionProvider` (`packages/web/src/fleet/selection.tsx`)
  is consumed by the scene, the table, the drawer and the feed, with `MAIN_SELECTION` for the
  conductor — the merge inherits a working selection model rather than inventing one.
- **The vertical cost is measurable.** `Shell.tsx` gives the scene `min-h-[55vh]`; the table
  follows at full width; the three analytical panels only appear below both. On a 900px-tall
  laptop the ledger is off-screen at rest.
- **The drawer duplicates the run view.** `drawer/index.tsx` renders four tabs — ACTIVITY,
  CONVERSATION, WHY, TRACE — and prd-31 ruling 5's run view carries all four, durably, at an
  address. Two surfaces, one job.
- **The focus trace panel has no address.** `trace/FocusPanel.tsx` is reachable only from the
  drawer via `requestPanelFocus('trace')`; it renders a subset of what the run view shows and
  cannot be linked to.

## Success

1. One surface answers "who is alive". **Not met while** the scene and the roster occupy separate
   frames, or a person must consult both to answer one question.
2. The list never degrades. **Not met while** any quality level, still-motion setting, or machine
   makes finding a lane harder — the list representation is complete and usable in every one.
3. Switching representations is instant and lossless. **Not met while** selection, scroll or
   filter state is dropped by a toggle, or the switch costs a re-fetch.
4. Forty lanes stay legible. **Not met while** the list becomes unusable at fleet scale or the
   organism is the only way to find something.
5. Nothing is read twice. **Not met while** the drawer and the run view both claim to be where a
   lane is studied.

## Non-goals

- **Not the scene's art.** Material, growth, atmosphere, colonies and the renderer are prd-33's;
  this PRD owns the surface that contains the scene, its list twin, and the toggle between them.
- **Not a new selection model.** `SelectionProvider` stands.
- **Not the dock.** prd-32 ruling 5 and its S3 own the tabbed dock beneath this surface; the
  fleet is explicitly **not** one of its tabs, because it lives here.
- **Not the lab's arms strip.** prd-14 ruling 1's tension was ruled coexist-by-surface on
  2026-08-13: the lab's strip is *n* small organisms, this is one surface per colony. No wave of
  this PRD enters `packages/web/src/lab/`.

**Rejected alternatives.** *Threads label themselves and the list disappears* — the purest merge,
and it fails at fifteen lanes; a picture is not a list and pretending otherwise loses the roster
exactly when a busy fleet needs it. *A docked roster inside the scene frame* — both readings at
once, and it costs the horizontal room the organism needs plus a second scroll context inside a
canvas. *Leave them as siblings* — the status quo, which spends the viewport twice and lets the
two models drift.

## What already exists (do not rebuild)

The glyph alphabet (`fleet/sigils.tsx`) and its two scales. `SelectionProvider` and
`MAIN_SELECTION`. The derived fleet from `@rhizomorph/core`'s `buildFleet` (moved to core in
#246), which both representations read. `PanelFrame`'s collapse/focus chrome and the
`usePanelCollapsed` persistence idiom. The fleet table's row verbs (`f`, `a`) and its honest-gap
columns.

## Rulings

## Ruling 1 — one surface, two representations, and the list is the floor

The scene and the roster become one panel that renders **either** the organism **or** the list,
switched by one control and one keystroke, sharing selection, filter and scroll intent.

**The list is the floor.** It is complete — every lane, every column, every honest gap — at every
scene quality level, in still-motion mode, on a machine that cannot hold a frame budget, and when
the canvas fails to initialise entirely. The organism is the enhancement: richer, more beautiful,
and never the only way to find a lane. This is what makes prd-33's ambition safe to pursue — the
art can be as expensive as it likes because navigation does not depend on it.

**The toggle is chrome, not status** (the same posture prd-32 ruling 4 takes for the theme
switch): it is remembered per repo, it never changes on its own, and no fleet condition may flip
it. An instrument that switched to the list because something broke would be an instrument
hiding its own scene at the moment a person most wants to look at it.

## Ruling 2 — the drawer becomes a peek, and the run view is where a lane is studied

The drawer stops being a four-tab reader and becomes **a peek**: the lane's vitals, its latest
activity, and one line of why — with exactly one action, *open the run view*. Click to glance,
click again to study.

The reason is not tidiness. Two surfaces rendering the same four tabs is how they drift, and the
drawer's version is the weaker one by construction: it is transient, it has no address, it cannot
be linked in a review, and it dies with the worktree. prd-31 ruling 5's run view is durable and
deep-linkable. Keeping both means maintaining the worse one forever.

**The focus trace panel is cut** in the same motion, for the same reason: it renders a subset of
the run view's trace column and cannot be linked to.

## Ruling 3 — the two-representation idiom is the house pattern, and it is written once

Organism ⇄ list is the first instance of a pattern the instrument now uses deliberately: **one
surface, two representations, one toggle, shared state.** prd-31's trace (tree ⇄ gantt) and the
history surface (by session ⇄ by lane) are the same shape.

It lands as one small shared component rather than three implementations, so the keyboard
behaviour, the persistence key shape, the toggle chrome and the "state survives the switch"
guarantee are written once and cannot drift. A fourth instance is a row in its registry, not a
new pattern.

## The specification

Six answers per surface, per `docs/prds/README.md`.

### S1 — the fleet surface

**What and why.** The hero of the main screen: who is alive, in whichever representation suits
the moment.

```
┌─ FLEET ───────────────────── [◉ organism] [ list ] ─┐
│                                                     │
│            (threads growing from colonies)          │
│                                                     │
└─────────────────────────────────────────────────────┘
        ⇅  one keystroke, state preserved
┌─ FLEET ───────────────────── [ organism] [◉ list ] ─┐
│ ◉ 519-migrate    working   4m12s   $0.31 est   2f   │
│ ○ 520-connect    waiting  12m03s   $1.04 est   0f   │
│ ✕ 521-topup      broken    1m44s   $0.02 est   1f   │
└─────────────────────────────────────────────────────┘
```

**States.**
- *live* — both representations render the current fleet.
- *empty, repo watched* — the organism shows the repo's own past as dormant structure (prd-33);
  the list says no lanes are running, names the repo, and gives the last activity time. Neither
  reads as broken.
- *empty, nothing configured* — the demo fleet renders instead (prd-34), marked simulated.
- *loading* — the fold is building: the list renders progressively; the organism waits rather
  than animating a fleet that is still arriving.
- *error* — the canvas failed to initialise: **the surface falls to the list and says so once**,
  in law 12's voice, without offering to retry silently. The list is the floor; this is the case
  it exists for.
- *degraded* — a collector is down: rows carry their honest gaps per column; the organism draws
  what it has.
- *replay* — both follow the scrub position; the toggle still works.
- *demo* — simulated chrome frames the whole surface, not the individual lanes.

**Data source.** `buildFleet` from `@rhizomorph/core` for both representations — one derived
fleet, two renderings, so a divergence is impossible by construction. Manifest data from
`GET /api/lanes` for fences and dispatch metadata.

**Interactions and keyboard path.** A single control switches representation; one keystroke does
the same. Selection is shared: selecting a lane in the list highlights its thread and vice versa.
The list keeps its existing row verbs; the organism keeps its camera (pan, zoom, fit). The toggle
is reachable by keyboard and announces which representation is active. The surface never steals
focus on a state change.

**What would make it wrong.** A lane visible in one representation and absent from the other · a
toggle that a fleet condition can flip · selection lost across a switch · the list omitting a
column because the organism shows it · a canvas failure leaving a blank frame.

**Acceptance criteria.**
- Both representations render from the same `Fleet` object; a test asserts the set of lane ids is
  identical.
- Selecting in one selects in the other (both directions).
- Toggling preserves selection, scroll position intent and any filter.
- Simulating a canvas initialisation failure falls to the list and renders one honest line.
- At forty lanes the list renders every lane; a test asserts no lane is dropped or virtualised
  out of the accessibility tree.
- The toggle's persistence is per repo, not global.

### S2 — the peek (formerly the drawer)

**What and why.** A fast glance without leaving the fleet.

**Contents.** Vitals (state, elapsed, branch, model) · the latest activity line · one line of why
(prd-30's condition, label and why only) · **one action: open the run view**.

**States.** *nothing selected* (renders nothing at all — it is not a panel) · *selected, live* ·
*selected, finished* (the peek says the lane is finished and the action still opens its durable
run view) · *replay* · *demo*.

**Data source.** The fold. **The peek never fetches** — the transcript request that today fires
when the drawer's conversation tab opens moves to the run view with it.

**Interactions.** `Escape` closes it; the action navigates; keyboard-reachable throughout.

**What would make it wrong.** Any tab returning · a transcript fetch from the peek · the peek
rendering something the run view does not.

**Acceptance.** A test asserts the peek issues no `/api/transcript` request; a test asserts it
renders at most the four elements above.

### S3 — the two-representation component

**What and why.** Ruling 3's idiom, written once.

**Contract.** Takes: two render functions, a persistence key, a scope (repo or machine), labels,
and a keystroke. Guarantees: state outside the representations survives the switch; the toggle is
keyboard-operable and announces the active representation; the preference persists at the
declared scope; no representation may be selected automatically by application state.

**Registered instances.** fleet (organism ⇄ list) · trace (tree ⇄ gantt, prd-31) · history (by
session ⇄ by lane, prd-31 ruling 8).

**What would make it wrong.** A fourth instance implemented independently · a toggle driven by
anything but a person.

**Acceptance.** A law test enumerates the registered instances and fails on a toggle implemented
outside the component — the same posture as the mutating-calls law.

## Sequencing (waves, each gated as ever)

`packages/web/src/lab/` is prd-28's territory; no wave of this PRD enters it. Every wave consumes
prd-32 wave 1's tokens and therefore follows it.

> **Note (2026-09-08, prd-53 wave 5):** prd-28's paper died in the 2026-08-19 deletion and its
> number is retired, never reused. The fence stands; the territory's owner is prd-53
> (`docs/prds/prd-53-the-lab.md`). The sentence above is kept as written — a number is an identity.

1. **Keystone:** the two-representation component (S3) and the fleet surface's frame — the
   organism and the existing table mounted inside it, sharing selection, with the toggle and its
   persistence. No visual change to either representation yet; this is the container.
2. Parallel, fenced apart: the list representation's own pass (columns, density, honest gaps on
   the new registers) · the canvas-failure floor and the empty/idle states.
3. The peek — the drawer's four tabs removed, the single action added, the focus trace panel
   deleted. **Sequenced after prd-31's run view exists**, because the action must have somewhere
   to go.

Unfiled work implied, described not numbered: the removal of `FocusPanel` and its
`requestPanelFocus('trace')` channel once nothing calls it; `PanelGrid`'s curated-order tests
rewritten for a fleet that is no longer one of its rows.

## Open questions

- **Which keystroke toggles representation** — grouped with the app's other single-key verbs at
  dispatch. Open, not ruled.
- **Whether the list gets sort controls** — today it is pre-sorted by the derived fleet's own
  ranking, and a user sort would be a second ranking with no evidence behind it. Proposed: no
  sort; open, not ruled.
- **Whether the peek survives at all once the run view is fast** — it may prove redundant. Kept
  for now because a glance and a study are different acts.
- **Whether the organism ever renders inline in the list** (a per-row sigil is already the case;
  a per-row sparkline of that lane's life is not). Open, not ruled.
