> **Recovered history — read the note before the document.** This file was written 2026-08-12 and
> revised 2026-08-13 (commit `19adcda8` in the repository's pre-deletion history). It was lost in
> the 2026-08-19 deletion and 2026-08-21 re-upload, together with prd-28 "the standing axis" and its
> nine issues, and restored on 2026-09-07 beside `docs/prds/prd-53-the-lab.md` — verbatim save one edit: the glob
> packages/*/src in "What has to be added besides the UI" is de-backticked so the repository's
> citation law does not read it as a path — which
> re-verified its claims and carries the rulings. **Nothing here is a commitment** — it never was —
> and three weeks of rulings have moved under it: prd-41 confined the lab and fixed its ceilings;
> prd-14 ruling 5 made a comparison a recording; charter §8 ruled the scene question
> *coexist-by-surface*; #205 fold-order is ruled (append order is the truth), so its "remains
> unruled" is stale; prd-50 fixed the lock ceiling; and prd-53's build waves (2026-09-07 to 09-08) made Stage 1 real —
> one fork per experiment with r runs per arm, a per-run outcome on the wire behind a gated
> measure route, the lab's own session axis and five-position frame, a comparison that renders
> against the live server, Trace, Metrics, and the lane canvas — so "What has to be added
> besides the UI" below is history, not a list. Its line-numbered citations are of the tree on
> 2026-08-13 and are kept as they stand: they are provenance, not directions. Where it and prd-53
> disagree, prd-53 is the record. The visual companion it names is the shared artifact
> *The Lab Workspace*.

# Vision — the lab you can fork

> A feature-scale dreaming doc, in the spirit of [vision.md](vision.md): **nothing
> here is a commitment.** It exists so the whole idea can be held in one place,
> before anything is scoped or sequenced. Written 2026-08-12 from an operator
> brief and a working HTML prototype.
>
> Visual companion: **[The lab workspace](https://claude.ai/code/artifact/0d519088-3709-4262-896a-379cd6be5ab1)**
> — all five screens, structure from the prototype, paint from `theme.css`.

## Where the idea came from

The balcony answers *"which lanes are alive, stuck, or lying?"* It does not answer
the question that follows about ten seconds later: **"would this have gone better
another way, and can I find out without losing the run I'm watching?"**

The engine for that already exists and has for weeks. prd12 built it — checkpoint
a lane, fork it into arms, restore each into its own worktree, compare them into a
table that refuses to rank. prd14 then built a surface onto it, and the surface
*lists* things: a checkpoint table, a launch panel, one branching SVG per
experiment, a comparison underneath (`web/src/lab/LabPage.tsx:236-277`). Every
experiment is its own island with its own local geometry.

What is missing is somewhere to **stand in time**. The operator arrives with a
position — *"twenty minutes ago, before the summariser first ran"* — and the
console has no way to point at it. A checkpoint is rendered as a row in a table
when it is really a coordinate on an axis.

The other half came from the retros. Every closed issue carries one as a comment,
and reading nine of them in a row, the same failures are visibly the *same shape*
wearing different clothes: an emitting step running ahead of the step that
sanitises, three times, three different emitting steps, the gate correct every
time. That recurrence is the most valuable thing in the corpus and it is invisible
to the instrument best placed to test it.

The Etude spike (`docs/research/2026-08-08-etude-and-the-lab.md`) is the third
input, and it graded honestly: its best transferable idea is **label provenance as
a typed field that cannot lie** — validation that *refuses to construct* a proxy
label claiming verification. Not its ranking, not its judge. That one idea is load
bearing below.

## What we want to exist

Scrub a live lane back to any earlier moment. Fork it there into n arms, vary one
thing per arm, let them run, and read what happened — on one screen, one
horizontal axis, four regions that all resolve position through the same scale.
Never touching the lane you were watching.

Then the second half, which only makes sense once the first exists: an agent that
reads the retro corpus, groups it by **the shape of what went wrong** rather than
the issue that closed it, and says *"this has now happened three times."* For each
recurring shape it proposes tests that vary exactly one thing, picks the
checkpoint to fork from and **defends the position** (*"the last checkpoint before
the summariser first runs — forking after it would bake in the ordering the test
is trying to change"*), and dispatches through the same fork machinery a human
uses. It proposes and reports. It never decides.

## The honesty spine

This is the soul of the thing, and it is why the feature is worth building at all.
The lab is a measurement instrument pointed at a process with real run-to-run
variance, spending real money. Its entire value rests on refusing to say more than
it knows:

1. **Never name a winner.** Nothing sorted by value, nothing badged as leading.
2. **Refuse to summarise below the floor** (n=3 completed runs per arm) — show the
   individual runs and say why. Never a point estimate in the gap.
3. **A spread is a range**, min–median–max, every run plotted.
4. **State what varies**, computed from the arms: one dimension → comparable; two
   → no comparative claim; none → replicate runs, not a comparison.
5. **Never invent an outcome.** Unmeasured is `not-run` and says *"not measured
   yet — no outcome is invented in its place"*.
6. **Reference the transcript, never copy it.**

Laws 1–4 already exist in `compare/summarise.ts` and `compare/attribution.ts`,
already stricter than prd12 ruling 4 requires. They get **extended, never
loosened** — and they belong in the data layer, not the view, so the R&D half
inherits them instead of re-deriving them.

To that spine the counterfactual adds one more, which is the easiest thing in this
whole feature to get wrong: *what actually happened is a single observation, not a
distribution. An arm whose spread contains it has not beaten it.*

## What this is never

- **Not a conductor.** Nothing merges, nothing lands, nothing is chosen for the
  operator.
- **Not live fleet state.** Forked realities only; the existing law test stands.
- **Not a ranking**, at any n, ever. A "leading" badge is a verdict the moment it
  is screenshotted, and a verdict is what this data cannot support.
- **Not a new design language.** The **lane canvas is the only genuinely new UI**
  — everything else, the scrub track included, has a primitive already. Where the
  system lacks something, extend it in its own idiom rather than inventing beside
  it.
- **Not portable.** A checkpoint is machine-local coordinates. An exported record
  narrates an experiment and cannot re-open it. Unchanged here.

## What has to become true first

Two of prd14's own rulings are, in production, **unreachable rather than
unbuilt**, and neither is a UI problem: an arm can only ever hold one run, so the
summary floor can never be cleared; and an arm's outcome has no field to travel
in, so the comparison surface is dark on a real machine. Both are stated with
their evidence under *What has to be added besides the UI* — the point here is
that **no amount of surface work reaches them.** Build the axis first and you get
a beautiful instrument over a data layer that structurally cannot summarise.

And one thing is genuinely unknown rather than merely unbuilt: **there is no
judged score in the record.** Telemetry and cost exist; "scoring" does not. Either
that measure is sourced from something the log already holds, or it ships absent
and says so. It must not be closed by fabricating a number.

## The two stages, and why the order is not negotiable

**Stage 1 is the whole manual loop** — Workspace, Compare, Trace, Metrics. It
stands alone: a human can fork, run and compare with no agent involved.

**Stage 2 is R&D**, and it depends on Stage 1 existing. The agent's proposals land
on Stage 1's axis and are read through Stage 1's Compare. Built first, or in
parallel, R&D has nowhere to dispatch to — which makes it a mock, not a feature.

## What the surfaces are

Stage 1's four, sharing the axis: the **Workspace** (scrub track, observability
frame — one switch over chart, scene, divergence and footprint — lane canvas,
modify-workflow), **Compare** (arms of one experiment side by side, every spread
recomputed when the measure switches), **Trace** (per-step diff against the
parent — `same`/`diverged`/`added`/`absent`, the parent read and never copied),
and **Metrics** (KPIs each with a basis line, distributions on a shared scale,
the verification & provenance table).

Stage 2 adds one: **R&D** — patterns by shape, the held-back single occurrence,
proposals varying exactly one thing, the agent's checkpoint pick with what it
rejected, and the counterfactual.

The empty, partial and held-back states are **first-class on every one of them**,
not a polish pass at the end. They carry most of the feature's honesty, and they
are exactly where a naive implementation quietly lies.

Nothing here is scoped or sequenced. That comes later, on its own terms.

## The observability frame

The Workspace's second region, and the longest argument in this document. It is
one exclusive switch over five ways of looking at the selected arm at the
playhead — two chart series, plus three drawings that are not charts. Most of
what follows is about the third of those, because putting the observatory's own
scene inside the lab contradicts a standing ruling and that contradiction should
be argued in the open rather than discovered in a diff.

**The observatory's own scene belongs in the observability frame — which asks
for prd-14 ruling 1 to be reversed.** Ruling 1 declined the garden metaphor for
the lab because *"the observatory's scene is a growth metaphor… that is a story
about **one** timeline"*, and gave the lab a trunk-and-arms grammar of its own
instead. The premise is the part to challenge. The observatory's scene has never
been one timeline: it is *n* lanes off one root mass — twenty in the shipping
build — which is structurally the same picture as three arms off one checkpoint.
The scene was already the branching form, and ruling 1 built a second grammar to
say what the first was already saying.

What ruling 1 got right survives, and is answered by construction rather than by
a new grammar. Its real objection was vocabulary — *"withering means something
else on an abandoned arm than it does on a finished lane"*. True, and fixed by
hue: a dead arm's cord goes necrotic grey with a **broken** tip, a finished arm
keeps a living cord and seals its tip in **done**'s dim green. Law 9a already
separates them, so withering is never asked to carry two meanings. Ruling 1's
other half — *"reuse, do not fork: no second renderer, no new hue"* — is not
merely kept but is the argument: reversing the ruling is what makes the reuse
total instead of partial. A ruling to that effect is **proposed, not assumed**.

Its placement inside the frame is the same argument twice. The chart says what
an arm has cost by the playhead; the scene says how far it got by the playhead.
Same instant, same reading, so they are one frame — and only one of them may
draw past it. A rate is a recorded number and can be dashed into the future; a
shape is not, so reach is **truncated at the playhead, never extrapolated**. An
arm that stopped early is simply a shorter cord, with no ghost of what it would
have become, and arms that fork *after* the playhead are absent rather than
dimmed. Splitting the two halves into separate regions hides both that they
share a reading and that they disagree about the future for a principled reason.

**How the scene is drawn, and why almost none of it is new.** The renderer is
`scene/` — `ribbon.ts`, `contour.ts`, `motes.ts`, `retire.ts`, `palette.ts` —
not a second one. Three properties are load-bearing and each is a construction
rather than a convention:

- **Colour is computed, never picked.** A living cord is `ICE_200` mixed
  `ACTIVITY_TINT` of the way toward its activity hue, using palette.ts's own
  dials (0.56 working, 0.44 done). Arm A reads mint and arm B a greyer green
  because they are one construction at two dials, not two decisions. This is
  what makes "reuse, do not fork" checkable: `palette.test.ts` already holds
  every one of those constants against `theme.css`.
- **Selection is luminance, never hue** (law 9a). The selected arm keeps its own
  state colour and gains an `ICE_050` core down the middle of the cord. It gets
  brighter; it does not change what it means.
- **Reach is a truncation, not a fade.** Each cord is a cubic split at
  `t = reach`, so the curve drawn *is* the arm's path so far. A faded full curve
  would be a projection wearing a style, which is the thing this frame exists
  not to do.

**The playhead crosses what is on the axis and stops at what is not.** The chart
and divergence are indexed by session position, so the white rule runs through
them. Scene and footprint are not — a card's width is not time — so the rule
terminates at the border above them and resumes below the region. When an
on-axis view is selected, the off-axis container is not merely empty but gone,
so the rule runs the region's full height again rather than stopping at nothing.

The frame carries **one exclusive switch of five positions** — telemetry, cost,
scene, divergence, footprint. Every position answers the same question, *what is
this frame showing?*, so exactly one is selected and the row behaves like every
other switch in the lab. Telemetry and cost are two series of one chart; the
other three are other drawings. Splitting the row into a measure set plus
independent view toggles was tried and rejected: they are genuinely different
kinds of choice, but one row that behaves two ways costs the reader more than
the distinction is worth, and a frame showing four things at once is not a
frame.

Scoring is not offered here: nothing sources an eval score today, and the one
place that absence should be declared is Compare's measure switch, where arms
are actually held against each other — declaring it twice reads as two missing
features rather than one.

The five positions:

- **Telemetry** / **Cost** — two series of the one chart, solid to the playhead
  and dashed after, with the parent lane ghosted behind.
- **Scene** — the experiment as one organism, above. Shape and reach.
- **Divergence** — the running share of steps that have left the parent behind:
  the same `same`/`diverged`/`added`/`absent` diff Trace reads row by row,
  accumulated instead. It answers the experiment's own question — *where did
  these stop being the same run?* — and it is indexed by session position, so
  it sits **on** the axis. It reads 0% at the fork by construction, never by
  measurement. A dead arm's line **ends** rather than dashing: dashed means
  "has not happened yet", and a dead arm has no future to leave unread.
- **Footprint** — which files each arm touched, and which files more than one
  arm touched. A trajectory through the *codebase* rather than through time, so
  it has no axis and sits in the off-axis half. **A shared file here is overlap,
  not conflict**: in the observatory two live lanes editing one file is a
  warning somebody must resolve, but arms forked from one checkpoint were never
  going to merge, and importing that alarm vocabulary would raise a warning this
  surface has no grounds to raise.

Both new ones are sourceable today: divergence from the diff Trace already
computes, footprint from `selectFilesTouchedByBranch` intersected by
`selectCollisionMap`. **Neither needs engine work** — they are readings of
material the fold already holds.

### What this frame needs ruled

Two things, both proposed here and neither assumed:

1. **Reverse prd-14 ruling 1.** Its vocabulary objection survives and is
   answered by hue; its "reuse, do not fork" half is not merely kept but is the
   argument for reversal. What does not survive is the premise that the
   observatory's scene tells one timeline. Because the log is append-only, this
   is a new record superseding the old, not an edit to it.
2. **What the scene labels its strands with when no measure is showing.** The
   exclusive switch means cost is not selected while the scene is. It currently
   carries whichever measure was last shown and says so on its basis line. The
   alternative is dropping the figures entirely, which loses the reading that
   earned the scene its place in this frame — same instant, same measure, two
   ways of looking. Carrying a hidden selection is a small lie of omission;
   dropping the figures is a real loss. Neither is obviously right.

A third is inherited rather than created: **eval scoring has no source**, so it
appears once, disabled, in Compare's measure switch — and nowhere else. Either a
scorer lands first or the switch position does not (ruling 5).

## What can be built on what is already integrated

More than expected. Checked in the tree, 2026-08-12 — the structural bet this
feature makes is **already how the app works**:

- **The experiment is already derived, not stored.** Core folds `fork.checkpoint`
  and `fork.dispatched` into `SessionState.forks` with a `byFork` index
  (`core/src/reduce.ts:124-126`, `core/src/state.ts:565`), and
  `server/src/api/lab.ts:135` already groups arms by `forkId`. There is no
  experiment record to remove and none to add.
- **A checkpoint is already a coordinate.** `fork.checkpoint` carries `sessionFile`,
  `sessionCutByte`, `sessionDigest`, `snapshotSha`, `headSha`
  (`core/src/events/lab.ts:34-52`). "% of session" is arithmetic over what is
  recorded; nothing new has to be captured to put a checkpoint on an axis.
- **The scrub track has a primitive.** `replay/Scrubber.tsx` takes
  `{ start, end, value, onChange, chapterMarkers }` — plain numbers, no fleet, no
  session coupling — and `replay/usePlayback.ts` is a fleet-free clock.
  Checkpoints become chapter markers. **The trap:** do not reach for
  `useReplaySession`, which rebuilds the whole `Fleet` per seek (prd21 measured
  26–318 ms) and would put live fleet state in the lab, which the law forbids.
  Take the two primitives, not the hook above them.
- **The scene's renderer is already the scene's renderer.** `scene/` holds
  `ribbon.ts`, `contour.ts`, `motes.ts`, `retire.ts` and `palette.ts`, and
  `ACTIVITY_HUE`/`ACTIVITY_TINT` are the only place a lane's activity becomes a
  colour. Scoping it to one experiment is a different *subject*, not a different
  renderer — which is why reversing prd-14 ruling 1 costs no code.
- **Divergence and footprint need no new engine.** The step diff Trace reads row
  by row is the same one divergence accumulates, and
  `selectFilesTouchedByBranch` (`core/src/selectors/touches.ts`) intersected by
  `selectCollisionMap` (`selectors/collisions.ts`) is the whole of footprint.
  Both are readings of material the fold already holds.
- **The observability frame has a chart.** `spark/Sparkline.tsx` and
  `spark/bucketize.ts` have **zero imports** — pure and self-contained. Solid-to-
  playhead, dashed-after and a ghosted parent series are three calls to the same
  component, not a new chart.
- **Trace has most of its furniture.** `trace/` already holds `TraceGantt`,
  `TraceRow`, `FocusPanel`, `EmptyTrace`, `glyphs` and `format`. `TraceGantt` is
  lane-shaped (it takes core's `SessionState` and `selectLaneInteractionViews`),
  so the rows, glyphs and inspector reuse cleanly while the arm-vs-parent diff
  needs its own model mapping.
- **Reading the parent at a position is already a route.**
  `GET /api/transcript/:lane?offset=N` (`server/src/api/transcript.ts`) is
  byte-offset addressed, which is exactly the shape `sessionCutByte` is in, and
  `drawer/useTranscript.ts` consumes it over an injected `FetchLike`. The
  reference-never-copy law is satisfied by machinery that exists.
- **Cost is already sourced.** `core/src/selectors/spend.ts` and
  `spend-cursor.ts`, plus the `panels/burn` and `panels/ledger` surfaces, are
  where the cost measure, the estimate's basis and Metrics' spend KPI come from.
- **The lab's own seam is live.** `GET /api/lab/checkpoints`, `/experiments`,
  `/estimate` and the token-gated `POST /api/lab/launch` all exist
  (`api/lab.ts:639-671`), and the estimate route already answers
  `available: false` with a reason rather than a fabricated number.
- **The engine is whole**: capture, restore with absolute-path rewriting and
  `npm install`, fork, and compare-with-verify — all in `server/src/lab/`, all
  fenced by `namespace-law.test.ts`.

## What has to be added besides the UI

Four things, none of them a screen, and the first two are what make the surfaces
capable of telling the truth at all:

1. **Repeat runs per arm — an engine change.** `dispatchFork` mints one
   `fork.dispatched` per arm (`server/src/lab/fork.ts:287-289`), so no arm can
   ever reach the three completed runs the floor requires. Until the engine
   dispatches *r* runs per arm, Compare is honest and permanently empty, and the
   spread the CLI prints is across *arms* — run-to-run variance confounded with
   treatment by construction. `LabRun[]` already anticipates the list shape
   (`web/src/lab/types.ts:66-83`), so this is engine and event work, not a
   re-typing.
2. **One implementation of the floor, in `core`.** The number 3 exists twice with
   **different denominators**: `MIN_ARMS_TO_RANK = 3` counts *arms*
   (`server/src/lab/compare.ts:33`), `summariseArm` counts *completed runs*
   (`web/src/lab/compare/summarise.ts:36`). The same data can therefore be
   reported differently by the CLI and the browser. The law functions are pure and
   zod-only, so they qualify for `core` (ADR-0003) and both surfaces should
   consume one copy. This is the "laws in the data layer" requirement stated as
   the concrete de-duplication it actually is.
3. **An outcome with provenance, on the wire.** `LabArmDTO`
   (`server/src/api/lab.ts:69-73`) has no `outcome` field, so `adapters.ts:59`
   maps every run to `pending` and the comparison surface is dark on a real
   machine. The field carries *how* it was measured as a typed value — the Etude
   note's discipline — and `not-run` is one of its legal values. Lab events extend
   additively; prd17's lenient parse and `upcast()` keep older recordings
   readable.
4. **A measuring route, which is a write and not a read.** Outcomes come from
   `server/src/lab/compare.ts` *running* a verify command in each arm's worktree.
   Triggering that from the browser is a new mutating route behind the capability
   token and `mutation-guard.ts` (ADR-0012). Permitted — ADR-0001 counts a UI
   button as explicit human invocation — but it must not be mistaken for the
   read-only listing it resembles.

And one thing that is **not** an addition to this app at all:

**Stage 2 has no runtime here, and that is a constitutional fact rather than a
gap in the build.** There is no inference capability anywhere in
packages/*/src — the only matches for a provider are the pricing table and OTEL
fixtures — and nothing reads the issue tracker (zero `gh` or `api.github` calls).
An agent that reads retros and proposes tests needs a model call, which needs a
credential, and ADR-0008's posture is that there is deliberately nowhere to put a
secret. Reading the tracker is network egress from a localhost-only instrument.
Either is a new power, and the constitution prices a power at a public argument
and a new ADR — never a config flag.

There is a shape that avoids both, and it is worth weighing before anyone argues
for a fifth hand: **the R&D agent is a lane, not a feature of the app.** It runs
as one of the swarm lanes the operator already drives, with their own credentials
in their own shell, and writes its patterns and proposals into the event log as
lab events. The Lab then *renders* them read-only, exactly as it renders
checkpoints it did not create — and it still dispatches through Stage 1's fork
machinery, because that is something a lane can already invoke. The instrument
stays credential-free and the constitution is untouched. Open, not decided.

## The quieter vision

An ugly surface that refuses to name a winner beats a gorgeous one that ranks. If
the axis is beautiful and the laws leak into the view where the next surface has
to re-derive them, we lost the part that mattered. If it is the reverse — the
spine is right and the scrub track is plain — we can still ship that and it is
still worth having.
