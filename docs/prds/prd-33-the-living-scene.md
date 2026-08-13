# prd-33 — the living scene: procedurally alive, lawfully vibrant

> **Status:** proposed — owns THREE of the design charter's §8 pending rulings
> (`docs/design/charter.md`, PR #451): growth (§5), the ambient layer (§4) and ceilings (§4),
> each entering only through its named device; records the operator's coexist-by-surface ruling
> on the prd-14 ruling 1 tension — this PRD rules the observatory scene only. Gate: **wave 0 is
> #158's glance re-run, an operator act.** Milestone 19. Sequenced after prd-32 wave 1; forms
> iterate with hchristina on the charter companion at blessing. Citations verified at
> origin/main `e8fed56`.

## Problem

The charter calls the instrument a living thing, and the scene is the one place that claim is
tested by eye — and today the picture is lawful but inert at its edges. A new thread pops into
existence at full length and stretches; nothing grows. The field has no depth, no material, no
environmental life: every property that could carry atmosphere was locked down in rounds where
the danger was noise, and the locks worked — the scene stopped lying, and it also stopped
breathing. The dials document itself prices lawful vibrancy nobody has spent. And the deeper
problem is that nobody has re-checked the picture against a lay viewer since prd-10: the glance
protocol — the only test the laws cannot replace — has never been re-run, so the scene's marks
hold their places on seniority, not on re-scored evidence.

## Evidence

- **The ground is free.** `scene/**` is 38 files, and no open issue or PR writes to any of
  them.
- **#158 is open and has never been re-run since prd-10.** The protocol is in the issue; it is
  an operator act with a real lay viewer; it can CUT marks; its deliverable is a results table
  in `docs/` plus one issue per FAIL.
- **The law devices this PRD must enter through are all live:** prd-07 ruling 2's role/form
  split (`docs/design-notes/node-role-shape-split.md` — "the tests kept passing while the
  picture was redrawn underneath them"); prd-07 ruling 4's variation permission table
  (`scene/variation.test.ts:47` — "the channel table is law, not commentary"); prd-10 ruling
  10's amendment template (the typed `DissolutionCause`); the salience band (`CALM_CEILING`
  0.78 / `ALARM_FLOOR` 0.84, never spent — `palette-vibrancy-dials.md`); and the dials recipe
  (`ACTIVITY_TINT` 0.56/0.60/0.44, `CALM_BODY_FLOOR` 0.58).
- **#244 (prd-24): 65 jsdom `getContext()` misses on the canvas draw path** — the code this PRD
  would grow is the code the suite does not execute.

## Success

1. A thread grows — eases, buds, extends — instead of spawning at full length. **Not met
   while** growth motion exists outside a typed cause with caps stated as numbers, or any older
   cap moved.
2. The scene carries depth and material inside "ambient never means". **Not met while** any
   ambient channel carries meaning, or a mark's status can be guessed from an ambient property.
3. Vibrancy rises only through the dials. **Not met while** `CALM_CEILING` or `ALARM_FLOOR`
   moves, or chroma rises anywhere but `ACTIVITY_TINT` / `CALM_BODY_FLOOR`.
4. The frame budget holds, measured. **Not met while** a texture or detail pass ships without a
   before/after frame measurement (#157's discipline), or 60fps is asserted rather than shown.
5. The glance re-run happened first and its FAILs are the requirements. **Not met while** any
   visual issue of this PRD dispatches before #158's results table exists.

## Non-goals

- **Not the lab's surfaces — coexist by surface** (operator ruling, 2026-08-13, resolving the
  prd-14 ruling 1 tension): the lab ARMS strip is _n_ small organisms (PR #431 ruling 5) and
  the observability frame's scene position is one organism via the `scene/` renderer (ruling
  8) — different surfaces, different pictures, both lawful. This PRD rules the observatory
  scene only; the lab's strip and frame scene are #431's, and no wave of this PRD enters
  `packages/web/src/lab/`.
- **Not the tokens.** `scene/palette.ts`'s token side is prd-32's (per-theme tables); this PRD
  reads tokens and never writes them.
- **No new semantic hue; the tissue fence unchanged; the band unspent.** The three
  preservations the charter attaches to these pending rulings, restated as this PRD's own law.
- **Not the replay or tide surfaces, not the panels** — the scene canvas and its laws only.

**Rejected alternatives.** *Spending the band for vibrancy* — the six-hundredths gap between
0.78 and 0.84 IS the salience mechanism; `palette-vibrancy-dials.md` prices it as buying
vibrancy "with the one property the instrument cannot lose". *Writing the rulings in forms* —
prd-07 ruling 2 exists because that failed once; a scene-art PRD written in shapes strands its
law tests at the first redraw. *A rendering-stack rewrite for texture* — form is free under the
role/form split; the frame budget is the constraint, not the API. *Skipping the glance gate* —
the protocol is deliberately not automatable, and a scene PRD that ships without re-scoring its
marks is the seniority problem restated.

## What already exists (do not rebuild)

Four closed motion classes and the ALARM throb (`scene/motion.ts`), the degradation ladder, the
four-stage persistence machine (`scene/retire.ts`), the variation permission table, the role
vocabulary (~60 `MarkRole` members), and a dials document that already states the lawful recipe
with numbers. This PRD opens the set the way prd-10 ruling 10 opened it — by template — and
invents no new mechanism for anything the devices already govern.

## Rulings

Each is a **proposed** verdict with its reasoning; no operator has ruled on any of them.

## Ruling 1 — growth enters only through prd-10 ruling 10's template, written in roles

Threads grow organically — ease, bud, extend, never spawn-and-stretch. Whether growth is a
fifth motion class or lives inside structural's critically-damped envelope, it opens the set
exactly one way: a typed cause (so a sixth cannot be smuggled in), hard caps stated as numbers,
every older cap untouched. The ruling is written in roles, not forms (prd-07 ruling 2's
device), so the law tests survive whatever the growth actually looks like when hchristina and
the implementer find it.

## Ruling 2 — the ambient layer enters through the variation table, and ambient never means

Depth washes, iridescence, texture, environmental tint — legalised as new rows in the variation
permission table, granted only to channels that carry nothing, each with a stated bound. An
explicit **"ambient never means"** law lands with the family: no ambient property may correlate
with status, cost, attention or any folded fact. The tissue fence is unchanged; "no new
semantic hue" is preserved exactly — ambient colour is material, never vocabulary.

## Ruling 3 — ceilings rise via the dials; the band does not move

Vibrancy rises only through the lawful recipe of `palette-vibrancy-dials.md`: chroma via
`ACTIVITY_TINT`, floor via `CALM_BODY_FLOOR`. The 0.78/0.84 band does not move — charter §2.2
is the reason, and the dials doc already prices the alternative.

## Ruling 4 — detail passes inside the frame budget, and the #244 gap is decided, not inherited

Every texture and detail pass is measured before and after — 60fps held, #157's discipline. And
the draw-path testing gap is decided here rather than silently widened: **#244 is either
absorbed** — this PRD takes the seam-truthful canvas harness before its texture passes land —
**or accepted explicitly**, with reasons recorded at blessing. Proposed: absorbed; the PRD that
grows the untested path owes the path a test first. What is not on offer is growing 65 untested
draw sites into more.

## Ruling 5 — the gate: #158's glance re-run is wave 0, and its results are the requirements

An operator act with a real lay viewer, booked before any design freezes — not dispatchable to
an agent, not skippable for schedule. The results table plus one issue per FAIL **is** this
PRD's requirements list: a FAIL's remedy may be a redraw here, a CUT (the protocol allows it),
or an explanation that lands in prd-30's vocabulary instead — a mark that fails GLANCE may need
telling, not repainting.

## Sequencing (waves, each gated as ever)

Sequenced after prd-32 wave 1 (the tokens and mirrors this PRD reads). `scene/palette.ts`
tokens are read-only here. Marks may be CUT by wave 0's results — no wave below assumes a mark
survives.

0. **Wave 0 — the gate, an operator act:** **#158** booked and run; the results table and
   issue-per-FAIL are this PRD's requirements list.
1. **Keystone:** growth via the template — the law amendment, its design note, its restated
   tests, and the first growing thread.
2. Parallel, fenced apart: the ambient family and its "never means" law · the dials.
3. Detail and texture passes with frame measurements — the **#244** harness first, if absorbed.

Unfiled work implied, described not numbered: the growth amendment; the ambient rows and their
law; the dials turn; the texture passes; the canvas harness.

## Open questions

- **Fifth class or inside structural** — the growth envelope's home is decided with numbers in
  hand at the amendment, not here. Open, not ruled.
- **Which channels get ambient rows first** — hchristina and the table decide; the grant
  mechanism is ruled, the grants are not.
- **How ambient material behaves on light ground** — coordinated with prd-32's per-theme
  tables; whoever lands second rebases. Open, not ruled.
- **#244's final disposition** — ruling 4 proposes absorbed; the operator may
  accept-with-reasons at blessing instead.
