# prd-33 — the living scene: procedurally alive, lawfully vibrant

> **Status:** proposed — owns THREE of the design charter's §8 pending rulings
> (`docs/design/charter.md`, PR #451): growth (§5), the ambient layer (§4) and ceilings (§4),
> each entering only through its named device; records the operator's coexist-by-surface ruling
> on the prd-14 ruling 1 tension — this PRD rules the observatory scene only. Gate: **wave 0 is
> #158's glance re-run, an operator act.** Milestone 19. Sequenced after prd-32 wave 1; forms
> are decided here and reviewed by the team. **Kind: specifying**
> (`docs/prds/README.md`); rulings 6–12 and the specification added 2026-08-15 from
> `docs/design/ui-2.0-decisions.md` (D24, D29–D36, D40). Citations verified at
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
device), so the law tests survive whatever the growth actually looks like when the design and
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

## Ruling 6 — status owns the living thread; category owns its material

The scene now carries two claims, and they never share a channel. **Status is the living thread
itself** — its hue and its brightness, exactly as law 9a and 9b already rule, entirely untouched
by this PRD. **Category (prd-32 ruling 8's tissue-derived family) rides the thread's material** —
the sheath around it, its nodes, its segment banding — never its living hue.

The reason is the glance protocol. A mark that is violet-because-planning *and* green-because-
working makes two claims in one channel, and a reader cannot know which one the colour is
answering. Splitting them by role rather than by shape is exactly what prd-07 ruling 2's
role/form split exists to permit: the law is written about *what a role may carry*, so the
material can be redrawn freely without touching the status vocabulary.

**The hard clause:** at every quality level and in the still composition, **status must remain
readable with the category material removed entirely.** If a person cannot tell working from
broken with the sheath switched off, the material has become load-bearing and the ruling has been
violated.

## Ruling 7 — the composition is colonies, and it is built for many from the first line

Threads grow from a central mass, as today — but the scene is composed as **a world that holds
several colonies**, because an organism is a person (`docs/design/ui-2.0-decisions.md`, the
reframe): the repo is the landscape, and a team is several colonies working it.

We ship watching one swarm, which renders as **one colony that looks complete on its own** — no
empty slots, no "waiting for teammates" scaffolding, nothing that reads as a missing feature. What
the ruling buys is that when the team layer lands (prd-37), **no redesign is required**: the
camera already frames a world rather than an object, spacing and depth already separate one colony
from another, and identity already has somewhere to attach.

## Ruling 8 — the material is living tissue, and the atmosphere is unmeaning by law

Threads are **translucent organic matter, lit from within**: a dense core with a soft edge,
overlaps that blend rather than stack, and a faint internal glow that is a property of the
material rather than a signal about state.

The atmosphere lands as four channels in the variation permission table, each **granted only
because it carries nothing** (ruling 2's device), each with a stated bound: **depth haze** ·
**ambient drift** (motes, spores) · **directional light** · **reactive ground** that breathes with
overall activity without encoding any particular fact.

The accompanying law, stated once and tested: **ambient never means.** No ambient property may
correlate with status, cost, attention, age, or any folded fact. The test is not "does it look
like it means something" but the stronger structural one — a rigged correlation between an
ambient channel and a lane's state must turn the suite red.

The reactive ground is the closest thing to a violation and therefore carries the tightest bound:
it may respond to *aggregate* liveliness only, never to any individual lane, and never to any
severity — a ground that darkened when something broke would be the alarm grammar leaking into
the substrate.

## Ruling 9 — growth is bud, reach, thicken; it gets its own class and its own budget

A lane appears as a **bud** at its colony's mass, **reaches** outward with a leading tip, and
**thickens** behind itself as work accumulates — growing continuously while it lives, so an
active fleet is always subtly in motion and a busy colony visibly swells over a session.

Growth becomes **the fifth motion class** with its own budget rather than borrowing structural's,
because its character is opposite to structural's: structural motion is a settling, discrete and
capped at two; growth is continuous, gentle, and correct across many threads at once. It opens
the set exactly the way prd-10 ruling 10 opened it for dissolution — **a typed cause** so a sixth
cannot be smuggled in, **hard caps stated as numbers**, and **every older cap untouched.**

## Ruling 10 — the motion caps rise, derived from measurement, and alarms are exempt

The event cap of five came from multiple-object-tracking research, and it is real: above roughly
five simultaneously-moving targets a viewer tracks none of them. But the cap was set against an
assumed event density that the instrument's own recordings can now falsify — **lanes run from
five minutes to two hours, so genuinely simultaneous events are rare**, and the cap is rarely the
thing limiting liveliness.

So the caps rise, under two conditions that keep the research honoured:

1. **The new numbers are derived, not guessed.** Before the amendment lands, the actual
   distribution of concurrent events is computed from recorded sessions — how often 2, 3, 5, 10
   events genuinely coincide — and the caps are set from that distribution with the reasoning
   written down. A cap chosen by measurement can be defended; one chosen by appetite cannot.
2. **Alarms are exempt and always win.** When more motion coincides than the budget allows, the
   alarm class is never the motion that gets dropped. A death is visible at any density — which
   is precisely the property the original cap was protecting, achieved by priority rather than by
   scarcity.

Ambient motion remains uncapped, as it always was: it carries nothing and demands no tracking,
and it is where the spectacle actually lives.

## Ruling 11 — the renderer is decided by measurement, not by appetite

ADR-0006 chose canvas 2D over WebGL, and the record is explicit that measurement killed the WebGL
option before it cost anything. That decision was taken against a flat-marks workload. The
workload this PRD creates — translucency, subsurface light, depth haze, drifting particles,
directional shading, continuous growth across many colonies — is precisely the class where the
trade changes.

**A spike decides it, before any texture work lands:** one honest implementation of the target
scene in both renderers, measured at 30 lanes with the full material load on the operator's own
machine and on the weakest machine we can find. Only measurement overturns measurement. If canvas
holds, the ambition is unchanged and the ADR stands; if it does not, a new ADR supersedes 0006
with the numbers in it.

**Nothing in waves 2 and 3 dispatches before the spike reports.**

## Ruling 12 — the still composition is designed, and idle is at rest rather than empty

**Reduced motion is not this scene with the animation removed.** It is a designed still
composition that carries every meaning through colour, position, form and density — reviewed and
glance-tested as its own artifact, because for some people it is the only version they will ever
see. It is also the version that renders when quality is dialled to its lowest (prd-35), so it
carries the instrument's whole job on a weak machine.

**Idle is a state with a picture.** A watched repo with nothing running shows its own past alive:
landed work as accumulated mass, past lanes as scars and residue, the substrate breathing. Idle
reads as *at rest*, never as broken and never as empty — and the list representation (prd-36) is
always there to say, in words, exactly what is and is not running.

## Ruling 13 — the supported size is a stated number, and the number is 90 threads

Added 2026-08-16 (#579). Ruling 11's spike reported, and it found a ceiling that has nothing to do
with the renderer it was run to decide: `layoutScene` + `sceneMarks` — the model stage, CPU,
**identical in both renderer arms and measured before any painter draws a pixel** — cost
14.6–16.5 ms of a 16.67 ms frame at 60 lanes × 3 colonies. ADR-0021's whole advantage is on the
other side of that line, so a renderer that cost literally nothing would still leave 180 threads
with no margin at all (`research/2026-08-15-renderer-spike.md`, §"The model floor").

**So this PRD states its size rather than discovering it in the field:**

| configuration | threads | supported |
|---|---|---|
| 1 colony × 30 lanes | 30 | **60 fps, comfortably** |
| 3 colonies × 30 lanes | 90 | **60 fps** — the shipped ceiling for ruling 7's several colonies |
| 3 colonies × 60 lanes | 180 | **30 fps.** Renders correctly; does not hold 60 |

Three things this ruling binds, so that the number is a commitment rather than an observation:

1. **The ceiling is a model-stage number, and the model stage is what a regression will show up
   in first.** A frame that got slower will *present* as a renderer problem and will not be one.
   `packages/web/src/scene/perf.test.ts`'s model-floor suite reports the three cells above every
   run — reported, never asserted, per #157's discipline.
2. **90 threads has headroom now, and did not before.** #579 baked the mass's contour in unit
   space and placed it by transform (`contour.ts`), which took the model stage to **0.67–0.79× of
   what ruling 11's spike measured** — on this repo's own rig, the three cells went 5.49 → 3.87,
   15.84 → 10.59 and 25.77 → 20.24 ms, with the mass's own builder falling from 1.47 ms to
   0.25 ms per colony. Ninety threads therefore sits at about two thirds of the frame with the
   painter still to run, where it previously sat at the edge of it.
3. **Raising the ceiling is a measurement, not a decision.** 180 threads is not a bug to be
   closed by relaxing this table; it is 30 fps until somebody moves the model stage again. The
   next candidate is already located and is *not* the mass: at 60 lanes the thread builder is the
   dominant term, and `research/2026-08-15-renderer-spike.md`'s response 2 — memoising a growing
   thread's full spine and re-truncating it per frame, so ruling 9's continuous growth and the
   spine cache can coexist — is the untaken one.

## The specification

Six answers per surface, per `docs/prds/README.md`. The scene is one surface; its regions are
specified as channels because that is the shape its laws take.

### S1 — the scene surface

**What and why.** The hero: a living picture of who is working, readable in three seconds without
a legend (the glance protocol's standing bar).

**States.**
- *live, one colony* — the ordinary case: one person's swarm, complete on its own.
- *live, many colonies* — several people (prd-37); depth and spacing separate them, each labelled
  by its owner's declared identity.
- *idle* — ruling 12's at-rest composition.
- *empty, nothing configured* — the demo fleet renders instead (prd-34 ruling 5), marked.
- *loading* — the fold is still building: the scene waits rather than animating an arriving fleet
  (a scene that grew as history loaded would be a lie about when things happened).
- *canvas unavailable* — the surface falls to the list representation and says so once
  (prd-36 S1); this is the floor the whole ambition rests on.
- *degraded* — a collector is down: threads render from what is known, and the honest gap is
  carried by the list and the status bar rather than by inventing a thread's state.
- *reduced motion / lowest quality* — ruling 12's still composition.
- *replay* — the scene folds to the scrub position; growth is positional rather than animated
  when scrubbing (a thread does not re-grow every time you drag).
- *demo* — permanent simulated chrome frames the surface.

**Channels and what may carry meaning.**

| channel | carries | permission |
|---|---|---|
| thread hue | status (law 9a) | **locked** |
| thread brightness | status salience (law 9b band) | **locked** — four numbers immovable |
| radial position | lifecycle (prd-6 r4) | **locked** |
| encoded width | work size (prd-6 r1) | **locked** |
| **sheath / nodes / banding** | **category** (ruling 6) | bounded by prd-32 ruling 8's caps |
| translucency, core density | nothing | material, bounded |
| depth haze | nothing | bounded by distance only |
| ambient drift | nothing | count and speed bounded |
| directional light | nothing | one direction, fixed |
| reactive ground | aggregate liveliness only | bounded; never per-lane, never severity |
| width jitter, wander, curl | nothing | existing table rows, unchanged |

**Data source.** The derived fleet (`buildFleet` in core) for every meaning-bearing channel; the
lane's own identity hash for variation seeds (never the clock); nothing else. **No ambient channel
reads the fold at all** — that is what makes "ambient never means" testable rather than aspirational.

**Interactions and keyboard path.** Camera pan, zoom-at-cursor and fit, as today. Selection shared
with the list (prd-36). Hovering or focusing a thread opens prd-30's disclosure card. The scene is
a canvas with a text equivalent — the list is that equivalent, and it is the accessible path
rather than an ARIA fiction over pixels.

**What would make it wrong.** Status unreadable with the category material removed · any ambient
channel correlating with a fact · a band number moved · growth that appears rather than grows ·
the reactive ground responding to severity · a frame budget claim that was asserted rather than
measured · a colony arrangement that only works for one.

**Acceptance criteria.**
- A rigged correlation between each ambient channel and lane state turns the suite red (one test
  per channel).
- Rendering with the category material disabled still yields correct status readings for every
  activity (a display-list assertion, not a screenshot).
- The four band numbers are asserted unchanged.
- Growth motion is typed by cause; a sixth motion class fails to compile.
- Frame time is **measured and reported** before and after each texture pass at 30 lanes, per
  #157's discipline — reported, never asserted, with the comparison made on one machine.
- The still composition is rendered and glance-tested as its own artifact.
- Two colonies render with correct per-colony attribution in a fixture.

## Sequencing (waves, each gated as ever)

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

## Amendment — the fruiting material (operator-directed, landed 2026-08-21)

Landed matter is a SECOND MATERIAL, never a status: the fruiting family
(spore-print magenta, `FRUIT_RAMP`/`PAPER_FRUIT`, H ≈ 335–341) is worn only
by returned matter — the persist strand and glyphs, the persisted seal, the
heart's growth rings, a landing's homecoming motes. Death still composts to
tissue. Law 9a and prd-10 ruling 11 are NAMED AND KEPT INTACT — the family
never joins the status vocabulary (as a status hue the arc is arithmetically
impossible: broken's 30° ∩ the accent's 60° leave 43.9°–235.5°), and the
ledger's LANDED chip stays done-green deliberately. Fences: the fruiting
fence (rgb-ε 12 to the frame palette's steps → returned-matter roles only,
never text/chip) landed before the first consumer; the two materials
partition by role, with the persist bytes held by the recipe≡constant pins.
Full text: docs/design-notes/palette-fruiting-material.md.

## Open questions

- **Fifth class or inside structural** — ANSWERED (charter §5 ruled it fifth-class; landed
  2026-08-21, professionalisation loop 2, first half): growth is its own `MotionClass` with its
  own budget (`GROWTH` in `motion.ts` — bud 350 ms → reach 1 400 ms, arrive window 0.2, swell
  ≤ 0.18 capped at 8 as cost-never-queue, width/warm envelopes exactly 1 at rest), the
  structural pause argument, and NO_MOVEMENT under reduced motion (appear full-length, warm
  in). No birth is ever queued — the cap is amplitude and cost, because a queued birth hides
  an existing lane. Thicken (the ruling's third verb) and typed causes land with the next
  loop. See docs/design-notes/growth-bud-reach-thicken.md.
- **Which channels get ambient rows first** — directional light landed first
  (2026-08-21, loop 5): one fixed axis (315°), a 3-stop LinearPaint on calm
  living ribbons, ALPHA-only (±0.12 of base — hue untouched, law 9a intact),
  flipped into ink-density on the presence carrier, alarm lanes excluded so
  nothing ambient touches the band. The ambient-never-means HARNESS landed
  with it (marks.test.ts: geometry-signed symmetry, screen-layer
  status-invariance, fixed counts) — each later channel adds its case. The
  subsurface underglow followed (loop 6, maximum quality) and the REACTIVE
  GROUND completed the family (loop 7): fog/vignette deepen on the pulse
  field's aggregate liveliness only — lane-swap and quiet-bytes invariance
  asserted. Ruling 8's four channels are all built. — the grant
  mechanism is ruled, the grants are not.
- **How ambient material behaves on light ground** — ANSWERED (light-mode wave, 2026-08-20,
  the second lander as this line predicted): ambient material is sampled from the frame's own
  palette rather than named constants — the depth fog tints toward the palette's deepest tissue
  step, the vignette toward the palette's own ground, the grain in the data register — and
  light-*material* marks (glow, motes) composite by the palette's severity carrier: additive
  ONE,ONE on the luminance-carried void (emission, byte-identical to what dark always did),
  source-over on presence-carried paper, where the same arithmetic would saturate to nothing —
  so on light ground a halo reads as a soft ink wash: presence, not emission. "Ambient never
  means" is untouched: the carrier decides *how* material composites, never *what* any channel
  says. Seam: `PanelView.lightBlend` in `scene/gl/frame.ts`; sampling in `scene/marks/ambient.ts`.
- **#244's final disposition** — ruling 4 proposes absorbed; the operator may
  accept-with-reasons at blessing instead.

> **Amendment (2026-08-21, loop 23 — the carrier decides how matter is drawn, first instance).**
> The light world's mass interior is engraved: a bounded, field-driven stipple
> (`mass-stipple`), paper only, dark byte-identical by law. This is exhibition
> II's stage 1 and the first per-theme MARK STYLE — the fact set is unchanged;
> what changed is how the paper carrier renders the same matter. See
> docs/design-notes/plate-engraved-mass.md.
