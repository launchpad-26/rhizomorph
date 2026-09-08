# prd-54 — the lab, stage two: the R&D hand is the operator's own, and the workspace becomes one

> **Status:** proposed — drafted 2026-09-08 from a live walkthrough of the Stage 1 console at
> `37f5f63f` (prd-53 waves 1–5, seeded with a real 2 × 3 experiment) and from
> `docs/vision-the-lab.md`'s Stage 2. **Kind: specifying** — a stranger will build the R&D surface
> and the redesigned workspace without the author in the room, so each surface answers the six
> questions. Not blessed. Awaits Lachlan Kelliher's word; the `prd54` milestone exists only after it.
> Design authority: prd-53's companion artifact *The Lab, Specified* for Stage 1, succeeded for
> Stage 2 by this PRD's companion artifact *The Lab, Stage Two*
> (https://claude.ai/code/artifact/f7cf1730-e99e-4fb9-8d37-1bf571b6984d), drawn alongside this
> draft from the same walkthrough: today's console as it renders, then every surface's states.

## Problem

Stage 1 is built and honest, and the console now shows a real comparison for the first time since
the lab was written. It is also a wall of text with a small drawing at the right edge, and it
cannot do three of the things the vision said the lab is for.

- **There is no R&D hand.** The vision's Stage 2 — an agent that reads what went wrong, groups it by
  shape, and proposes experiments varying exactly one thing — is constitutionally blocked inside the
  instrument (ADR-0008: nowhere to put a credential) and was named for a future PRD. This is that
  PRD. The operator already has an agent with credentials: their own `claude` command line.
- **Trace cannot read the files the lab already knows.** The walkthrough's Trace read *"NO SESSION
  LOG for w5-sweep"* for the parent and *"404"* for the arm — yet the checkpoint event carries the
  parent's `sessionFile` and cut byte, and every dispatch record carries the arm's worktree. Trace
  asks the fleet's transcript route, which only knows lanes the sessionlog collector attributed. The
  divergence position inherits the gap. Telemetry and footprint state theirs in place.
- **Measuring has no control.** `POST /api/lab/measure` exists and works (the walkthrough's outcomes
  arrived through it) but nothing on the page calls it; the guide says so. Launch cannot set runs per
  arm or declare a ceiling override; the model is a free-text field.
- **The workspace is not one.** One long vertical stack: axis, frame, checkpoints (twice — as a
  table and again as launch step 1), launch, a branching drawing 460 px tall for two dashed lines,
  every run's identical note repeated six times, Trace controls a screen below the frame that reads
  them, Metrics at the bottom. The lane canvas is pinned to the right edge whenever the fork is late
  in the session. The playhead label overflows the viewport. Every state is honest; the page does not
  invite anyone to use it.

## Evidence

- **The R&D shape was named and left open.** `docs/vision-the-lab.md` (recovered history) §"What has
  to be added" and prd-53's Open questions: *"the R&D agent is a lane, not a feature of the app… with
  their own credentials in their own shell… Open, not decided."*
- **The instrument already spawns the operator's tools as an explicit act.** `server/src/lab/fork.ts`
  shells out to `workmux add` and `workmux path` (`exec('workmux', …)`), and ADR-0001 counts a UI
  button as explicit human invocation. A headless agent call is the same shape.
- **The console has no credential and must not grow one.** `process.env` across
  `packages/server/src` yields `PORT` and `OUT_DIR` (prd-53 Non-goals, re-verified).
- **Trace's data path is the fleet's.** `web/src/lab/trace/TraceDiff.tsx` reads
  `transcriptUrl(lane, 0)`; `server/src/api/transcript.ts` resolves a lane through
  `log/transcript-attribution.ts` and answers *NO SESSION LOG* / 404 otherwise. Meanwhile
  `core/src/events/lab.ts:38-43` carries `sessionFile`, `sessionCutByte`, `sessionDigest` on the
  checkpoint, and the fork CLI prints each run's restored session path.
- **The measure route has no caller in the web tree.** `grep requestMeasure packages/web/src`
  (non-test) finds the definition in `web/src/lab/measure.ts` and nothing else.
- **The launch panel sends one run per arm and no override.** `docs/user-guide/the-lab.md`'s
  `launch-panel-gap` claim, asserted by `the-lab-guide-law.test.ts`.
- **The model is free text.** `web/src/lab/launch/LaunchPanel.tsx:228-231`: an `<input>` with
  placeholder *"model (default if blank)"*. `settings/registry.ts` has no entry naming a model.
- **The playhead label clips.** Live measurement 2026-09-08: the playhead group's right edge at
  2004 px in a 1910 px viewport, checkpoint at 100 % of session.
- **The branching drawing is out of proportion.** `viewBox 0 0 480 120` scaled to 1842 × 461 px for
  two arms; runs are not drawn (the layout predates prd-53 ruling 1).

## Success

1. An operator picks a model from a list they own, presses one button, and within the lab's own page
   reads patterns and proposals the R&D hand produced — with the model, the cost, and the corpus
   digest beside them. **Not met while** the instrument holds a credential, or the call is anything
   but an explicitly invoked spawn of the operator's own CLI.
2. A proposal becomes an experiment through the launch the lab already has, with one confirmation.
   **Not met while** the R&D surface can dispatch anything on its own.
3. Trace and divergence read for a forked run whose arm never launched. **Not met while** any lab
   surface depends on the fleet's transcript attribution.
4. The whole lab fits one working screen: axis and frame stay in view while the operator reads
   Compare, Trace or Metrics for the selected experiment. **Not met while** the frame that reads
   divergence is a scroll away from the control that produces it.
5. Runs per arm, the ceiling override, and measuring are controls on the page. **Not met while** the
   CLI can do a thing the console describes and cannot.

## Non-goals

- **Not a fifth hand in the constitution.** The instrument does not gain inference. It spawns the
  operator's agent as it spawns `workmux add`, and the ADR that records that (ruling 1) records what
  it does *not* permit: no key, no token, no provider call from `packages/server/src`.
- **Not a ranking, at any n, ever.** The R&D surface proposes and compares against what actually
  happened; it names no winner (prd-12 ruling 4, prd-14 ruling 3, prd-53 Non-goals).
- **Not the observatory's scene.** The lane canvas grows; it does not become `scene/` (charter §8).
- **Not the tracker by default.** Reading closed issues is network egress and is a second, separately
  declared act (ruling 2), off unless the operator turns it on for this repo.

**Rejected alternatives.** *An API key in settings* — the constitution prices a power at an ADR, and
this one has been refused since ADR-0008; the operator's CLI already holds the key. *The R&D agent
as a swarm lane writing events* (the vision's shape) — right in spirit, but a long-lived lane for a
one-shot read is a scheduler for a query; a headless call with the same credentials and a fixed
output schema gives the same events with none of the lane's lifecycle. *Rebuild the lab page as a
new route* — the laws, tests and fences of Stage 1 are the asset; the workspace is rearranged
around them, not replaced.

## What already exists (do not rebuild)

`server/src/lab/{checkpoint,restore,fork,compare}.ts` and their namespace law; `api/lab.ts`'s five
routes and `runCli` seam; `core/src/lab/laws.ts` (floors, `isCompletedVerdict`, confound voice);
`core/src/events/lab.ts` (additive lab events, `upcast`); `web/src/lab/{axis,frame,compare,trace,
metrics,canvas,launch,branching}/` and every law under them; `settings/registry.ts`'s declared
preferences and `non-negotiables.ts`; `recordings/capabilityRead.ts` and the mutating-modules law;
`spark/Sparkline.tsx` (zero imports); core's `selectFilesTouchedByBranch` and `selectCollisionMap`;
the fold's OTEL readings per lane.

## Rulings

## Ruling 1 — the R&D hand is the operator's own agent CLI, spawned as an explicit act, and the instrument holds no credential

`rhizomorph lab rd <lane> --model <m> [--corpus local|local+tracker] [--max-turns n]` spawns the
operator's `claude` in print mode (`claude -p … --output-format json --model <m>`) with the corpus in
the prompt and no tools granted, reads the JSON result, validates it against a fixed schema (ruling
3), and records `rd.patterns` and `rd.proposal` events through the recorder with provenance: model,
`total_cost_usd` and `duration_ms` from the CLI's own result, prompt digest, corpus digest, the
operator's `claude --version`. `POST /api/lab/rd` is a `gated-mutation` reached through `runCli`
(route-class count rises by one). The binary is resolved on the server's PATH under the name the
operator declares (`lab.agentCommand`, default `claude`); absent, the surface says *"no `claude` on
this machine's PATH — the R&D hand is your CLI, installed by you"* and offers nothing else. A new
ADR records the boundary: *the instrument may spawn the operator's own tools as an explicit act; it
never holds or forwards a credential; a spawned tool's egress is the operator's, declared on the
control that invokes it.* The R&D hand's cost is booked as spend with its basis, like a fork's.

## Ruling 2 — the corpus is local first, and the tracker is a second declared act

The corpus the hand reads is what the record already holds: the recordings' `fork.measured`
verdicts and details, `docs/research/*-retro.md` and `docs/review/*.md` in the watched repo, and the
lab's own experiments. Reading closed issues through the operator's `gh` is a separate control
(*"read the tracker with my gh"*), off by default, repo-scoped in settings, and its use is recorded
on the `rd.patterns` event (`corpus: 'local+tracker'`). The surface prints which corpus produced a
pattern beside the pattern.

## Ruling 3 — patterns are grouped by shape, a single occurrence is held back by schema, and a proposal varies exactly one thing

The hand's output schema is fixed and validated before anything is recorded: `patterns[]` with a
`shape` sentence, the source items, a `count`, and `heldBack: count < 2`; `proposals[]` each naming
one pattern, one `varies` dimension (`model | brief | checkpoint | gate`), 2–3 arms differing only in
that dimension, and a `checkpointPick` with the chosen checkpoint and every considered-and-rejected
one with its reason. A proposal against a held-back pattern, or one varying two things, fails
validation and is recorded as `rd.refused` with the reason — the surface shows the refusal, never a
patched proposal. Copy carried from The Lab Workspace: *"1 issue · not yet a pattern — testing a shape
that may not recur spends real money."*

## Ruling 4 — a proposal dispatches through the launch the lab already has, and an override is never re-attributed

*Restore n arms* and *restore and run* on a proposal call `POST /api/lab/launch` with the proposal's
arms and checkpoint; the estimate and its one confirmation apply unchanged (prd-14 ruling 4). If the
operator changes the checkpoint pick before launching, an `rd.override` event records it; the
resulting experiment carries `proposalId` and the surface says *"operator override — the choice is
never re-attributed to the agent"*. The counterfactual is drawn as Compare's runs against the source
item's own observation, labelled *what actually happened*, as one observation, never a spread.

## Ruling 5 — the model list is the operator's, declared once, read everywhere

`settings/registry.ts` gains `lab.models` (repo scope, kind `record`-of-strings; seeded from the
models the fleet has observed on its lanes plus the three aliases `opus`, `sonnet`, `haiku`). The
launch panel's arm model becomes a select over that list with an *other…* escape to free text; the
R&D control's model dropdown reads the same entry. A model the list does not hold is still legal on
the CLI — the list is a convenience, not a gate (it is not a non-negotiable and never narrows one).

## Ruling 6 — the lab reads its own files

`GET /api/lab/transcript?lane=<handle>` (gated-read) serves the parent's transcript from the
checkpoint's `sessionFile` up to `sessionCutByte`, digest-checked, and an arm's from the session file
under its own worktree's project directory — resolved from the dispatch record, never from fleet
attribution. An arm whose session has not grown past the cut reads *"not launched — its restored
session ends where the parent's was cut"*, not 404. Trace, divergence, and the R&D counterfactual
read this route; `no-persistence-law` still holds (read, never written). Telemetry and footprint get
their routes the same wave: `GET /api/lab/telemetry?lane&atByte` slices the fold's OTEL readings at a
byte; `GET /api/lab/footprint?lane` returns `selectFilesTouchedByBranch ∩ selectCollisionMap`. The
frame's two stated gaps close.

## Ruling 7 — the launch tells the whole truth, and measuring is a control

The launch panel gains *runs per arm* and *ceiling override*, sends them, and the estimate reads
arms × runs. Each experiment panel gains *measure* with a gate command field (default: the repo's
verify command) that calls `POST /api/lab/measure` behind one confirmation naming how many worktrees
the gate will run in. The guide's `launch-panel-gap` claim is rewritten to say what is now true, and
its test fails until it is.

## Ruling 8 — the workspace is one working screen

Two regions. A **left rail** lists checkpoints (one row each — the launch's step 1 reuses the rail's
selection instead of repeating the table) and experiments (one row each with arms · runs · verdict
counts). The **stage** keeps the session axis and the frame pinned at the top; below them, the
selected experiment's Compare, Trace and Metrics are tabs, not a stack, and the Trace control is
inside the frame's divergence position as well as the tab. The branching drawing shrinks to a
header glyph that draws runs, not arms. The lane canvas gets the stage's full width, and when the
fork sits past 60 % of the session the fan opens leftward so the root is never at the edge. A run's
identical notes collapse to one line per arm (*"3 runs · all passed · nothing booked under cost"*).
The playhead label flips to the left of the line when it would leave the viewport. Everything stays
dark-first on the D26 ice palette; figures stay mono; borders quieten to hairlines with one raised
surface for the selected experiment.

## Ruling 9 — every new surface's empty, partial and held-back states are drawn before its live state

R&D: no `claude` on PATH · no corpus (a repo with no retros and no measured experiment) · corpus read,
no pattern recurs (every item held back) · the hand refused (schema) · the hand ran and cost is booked
· proposal launched partially (ruling 7 of prd-53). Trace: not launched · parent cut mid-tool-call
(prd-53 residual, still unowned — the surface says so). Each drawn in the companion artifact, each an
acceptance criterion below.

## Ruling 10 — the guide law follows every claim here

`docs/user-guide/the-lab.md` gains the R&D section and the rewritten launch, measure and Trace
paragraphs, each marked; `the-lab-guide-law.test.ts` asserts each against code as Stage 1's did. A
sentence about Stage 2 that is not a test does not land.

## The specification

### S5 — R&D

**What it shows and why.** Left: patterns by shape, count and corpus, the held-back ones drawn
dimmer with their sentence; right, for the selected pattern: its proposals (one dimension varied,
arms listed, the checkpoint pick with what it rejected), the estimate, the two authorisation buttons,
and *against what actually happened* once an experiment exists. Top: the R&D control — model
dropdown (ruling 5), corpus switch (ruling 2), *read and propose* button, and the provenance line of
the last run (model · cost · turns · corpus digest · `claude --version`).

**Every state.** *No CLI:* the control is disabled with the PATH sentence. *No corpus:* *"nothing to
read yet — a retro, or a measured experiment, is where a pattern comes from."* *All held back:* the
patterns list with every row dim and *"no pattern recurs — nothing is proposed."* *Refused:* the
schema reason, verbatim, and the raw result offered as a download-free `<details>`. *Live:* as
above. *Launched:* the proposal row links to its experiment. *Partial launch:* prd-53 ruling 7's
copy. *Replay:* the tab is disabled as the lab is. *Demo:* none — no fixture invents patterns.

**Data source per field.** Patterns and proposals: `rd.patterns` / `rd.proposal` events (fold).
Cost, turns: the CLI's JSON result, recorded on the event. Counterfactual baseline: the source item's
`fork.measured` (or the retro's stated figure, quoted as text when no measurement exists — never
converted to a number). **Gap:** a retro with no measurable figure yields a baseline of *"no measured
baseline — the retro's own words"*.

**Interactions and the keyboard path.** `↑`/`↓` patterns; `Enter` selects; `Tab` to proposals;
`Enter` on a proposal opens the launch review prefilled; `Esc` back. The model dropdown is a native
`<select>`.

**What would make it wrong.** A proposal varying two things · a held-back pattern with a proposal · a
number in the counterfactual that the record does not hold · an override attributed to the agent · a
credential anywhere in `packages/server/src` · the hand running without a click.

**Acceptance criteria.** With no `claude` on PATH the control is disabled and the sentence renders ·
a schema-invalid result records `rd.refused` and renders the reason · a single-occurrence pattern
renders held back and carries no proposal · a proposal's arms differ in exactly one dimension (a
mutation adding a second goes red) · launching a proposal produces an experiment carrying
`proposalId` · changing the pick records `rd.override` · the provenance line's cost equals the
event's · `process.env` in `packages/server/src` still yields exactly two names.

### S1′ — the workspace (rearranged)

**What it shows and why.** Rail and stage (ruling 8). The stage's top never scrolls away.

**Every state.** *No checkpoints:* the rail says how to capture one; the stage shows the axis empty
with the sentence. *Checkpoints, no experiments:* rail lists them; the stage's frame reads *seat the
playhead*. *Experiment selected:* tabs live. *Partial:* the rail row carries *2 of 3 arms*. *Loading /
error:* per region, never conflated (Stage 1's law).

**Acceptance criteria.** The playhead label's right edge ≤ viewport width at 100 % (executed in a
DOM test with a forced width) · the canvas root's x ≤ 40 % of width when the fork is ≥ 60 % of
session · no run note appears more than once per arm · the checkpoint table renders once · Compare,
Trace and Metrics are `role="tablist"` with arrow-key movement · every Stage 1 law still passes.

### S2′ — launch and measure

**Acceptance criteria.** The model field is a `<select>` whose options equal `lab.models` plus
*other…* · `runs` and `ceilingOverride` are sent when set (the guide's claim flips and its test with
it) · the measure button calls `/api/lab/measure` with the field's command after one confirmation
naming the worktree count · a launch above the ceiling renders the server's refusal verbatim.

### S3′ — Trace over the lab's route

**Acceptance criteria.** An arm never launched renders *not launched* (executed against a fixture
whose session ends at the cut) · the parent reads from `sessionFile` at the cut byte with the digest
checked (a mutation altering one byte before the cut reddens) · divergence populates without opening
the Trace tab · the fleet transcript route is imported by nothing under `web/src/lab/` (grep law).

## Sequencing (waves, each gated as ever)

`scene/`, `tide/`, `replay/`, `recordings/` are not entered. `server/src/lab/` is entered only by the
R&D engine (wave 3), fenced to a new module. `docs/design-notes/lab-launch-ceilings.md` stays
prd-50's.

**Wave 0 — operator acts.** Bless. Draft the ADR (ruling 1) for the trunk. Decide whether the
tracker corpus (ruling 2) ships in this PRD or is parked.

**Wave 1 — the launch tells the whole truth.** `settings/registry.ts` (+ `lab.models`, seeded),
`web/src/lab/launch/` (select, runs, override), `web/src/lab/measure-control/` (new) mounted by the
experiment panel, `api/lab.ts` only if the estimate needs a field. Law: the guide's claims for
launch and measure flip from gap to fact.

**Wave 2 — the lab reads its own files. Parallel, fenced apart:** `server/src/api/lab-transcript.ts`
(new) + `web/src/lab/trace/` reading it · `server/src/api/lab-series.ts` (new: telemetry, footprint)
+ `web/src/lab/frame/` positions 1 and 5. Law: nothing under `web/src/lab/` imports the fleet
transcript route.

**Wave 3 — the R&D engine.** `server/src/lab/rd.ts` (new) + `cli/lab-rd.ts` (new), `core/src/lab/rd.ts`
(schema, held-back rule), `core/src/events/lab.ts` (+ `rd.*`), `state.ts`/`reduce.ts` folds,
`api/lab.ts` (+ `/api/lab/rd`, route-class count +1), the ADR. Laws: schema refuses two-dimension and
held-back proposals; `process.env` count unchanged; the CLI is spawned with `-p` and no tools.

**Wave 4 — the R&D surface.** `web/src/lab/rd/` (new) + `LabPage.tsx` tab. Law: no dispatch except
through `/api/lab/launch`; override recorded.

**Wave 5 — the workspace.** `web/src/lab/LabPage.tsx`, `web/src/lab/rail/` (new), `frame/`, `axis/`
(label flip), `canvas/` (fan direction), `branching/` (runs drawn, glyph size), `compare/`
(per-arm note collapse). Laws: the S1′ criteria. Last because it re-lays the ground the other waves
mount into.

**Wave 6 — the sweep.** Guide, guide law, architecture section, roadmap, the design-spec artifact's
"as shipped" note.

**Unfiled work implied, described not numbered:** atomic launch (prd-53 open); recursive forking; a
scoring measure (still no source; the R&D hand's proposals are judged by the gate, not scored).

## Open questions

- **Is spawning `claude -p` an ADR-0001 act or a new power?** This PRD argues the former (ruling 1)
  by analogy to `workmux add`. If the cohort reads it as a new power, the ADR is where the argument
  is had, and the PRD waits. Open, not ruled.
- **Where does the R&D hand run when the console is on a shared host?** The server's PATH is the
  host's, not the viewer's. On the team server (prd-51) the R&D control must be disabled for viewers
  who are not the host operator. Open, not ruled.
- **Should the tracker corpus ship at all?** Ruling 2 makes it a declared act; the cohort may prefer
  it parked until the local corpus proves itself. Open, not ruled.
- **Does the R&D hand get its own budget ceiling?** `--max-turns` bounds turns, not dollars. A
  per-call dollar ceiling in the same family as the launch ceiling (configurable, declared, recorded)
  is the obvious shape. Open, not ruled.
