# prd-53 — the lab: the experiment is one fork, and the console stops lying about it

> **Outcome:** shipped 2026-09-11. Blessed by Lachlan Kelliher, 2026-09-07, in session. Milestone `prd53`. **Kind:
> specifying.** Drafted the same session.
> Completes prd-12 (the engine, shipped) and prd-14 (the console, ruled 2026-08-24, two issues
> open), and **resurrects prd-28 "the standing axis"**, whose paper — eight proposed rulings, nine
> issues #433–#441 — died in the 2026-08-19 deletion and 2026-08-21 re-upload together with
> `docs/vision-the-lab.md`. Both are recovered from the pre-deletion history at `19adcda8` and
> re-verified against this tree; the vision doc is restored beside this PRD as history. prd-28's
> numbers are **never reused**: each ruling below names the prd-28 ruling it carries or supersedes.
> Design authority: the shared artifact **The Lab Workspace**
> (`https://claude.ai/code/artifact/0d519088-3709-4262-896a-379cd6be5ab1`, *"proposed, nothing
> blessed"*, 2026-08-12) as it stands, succeeded by a design-spec artifact of this PRD's own,
> drawn between waves 2 and 3. Stage 2 — the R&D agent — is out, and says why.

## Problem

The lab reads as done, and it is not. That reading has a mechanism, and the mechanism is a loss
rather than a lie.

`docs/prds/done/prd-41-the-laboratory-is-confined-in-fact.md` sits in `done/`, marked SHIPPED,
with *the laboratory* in its title — and its own Non-goals say *"Not the lab's UI. prd-14 owns the
experiment console."* prd-12 says `shipped` of the engine. prd-14 says `ruled`. The one document
that held the lab's remaining work is absent from the repository entirely, and **six PRDs still
fence `packages/web/src/lab/` as "prd-28's territory"** — a fence around a ghost. Nothing is open
anywhere, so nothing looks unfinished.

What is unfinished is the half a person can see. The engine forks a lane into arms and restores
each into a worktree; that works and is law-tested. But an arm can hold only one run, so no arm
can ever reach the three completed runs the summary floor requires; the web launch splits an
n-arm experiment into n single-arm forks that the fold cannot regroup; no outcome travels on the
wire, so the comparison surface — built, mounted, tested — has never once rendered against a real
server. The operator can fork. The operator cannot read back a comparison, which is the sentence
prd-14's own Success section says it exists to make true.

And the lab was walled out of the one pass that took everything else to a professional bar: the
25-loop session of 2026-08-21 excluded `lab/**` by operator order and listed that exclusion under
its own honest gaps.

## Evidence

Verified on this tree at `7b3f331`, 2026-09-07. Line numbers are of that commit.

- **One dispatch per arm, no run dimension.** `packages/server/src/lab/fork.ts:302` —
  `for (let arm = 1; arm <= options.arms; arm += 1)` mints one `fork.dispatched` per arm.
  `packages/core/src/state.ts:712`: *"One arm per handle in practice."*
- **The web launch fragments the experiment.** `packages/server/src/api/lab.ts:712` calls the
  CLI with `'--arms', '1'` once per arm; line 671: *"Arms are independent forks (their own
  `forkId`, always arm 1 within it)."* Line 624 hardcodes the assumption in the stdout parser:
  `ARM_LINE_RE = /^ {2}arm 1 {2}(\S+)$/m`.
- **Two floors, counting different things.** `packages/server/src/lab/compare.ts:33`
  `MIN_ARMS_TO_RANK = 3` gates on **arms**; `packages/web/src/lab/compare/summarise.ts:36`
  `completedValues.length < 3` gates on **completed runs of one arm**. CLI and browser can report
  the same data differently. The **confound clause** — arms differing in model *and* brief — exists
  only in `packages/web/src/lab/types.ts` (`isCleanlyControlled`); `rhizomorph lab compare` has
  no confound voice at all.
- **No outcome on the wire.** `LabArmDTO` in `packages/server/src/api/lab.ts` is
  `{ arm, treatment, runs }`; `LabRunDTO` is `{ eventId, dispatchedAt, laneHandle, worktreePath }`.
  `packages/web/src/lab/adapters.ts` maps every run to `pending`, and hands every run in an arm
  the *same* arm-level outcome — right today, wrong the moment an arm holds two runs.
- **The comparison surface never renders in production.** `packages/web/src/lab/LabPage.tsx`
  mounts `ComparisonSurface` behind `experimentHasOutcome(experiment)`, which is always false
  against the real server. `docs/user-guide/the-lab.md` says so plainly; no status line does.
- **Measuring has no route.** Four routes are registered — `GET /api/lab/checkpoints`,
  `/experiments`, `/estimate`, `POST /api/lab/launch` — all contract-tested. The compare engine
  (`packages/server/src/lab/compare.ts`, which runs `--verify` in each arm's worktree) is CLI-only.
- **The seam that closes the fragmentation already exists, unexposed.** `DispatchForkOptions.forkId`
  (`fork.ts:66-67`, *"for deterministic tests"*) is injectable; `packages/server/src/cli/lab-fork.ts`
  has no flag for it.
- **`compare/artifact.ts` is called from nowhere.** Exported, tested, zero production callers —
  the gap prd-14 ruling 5 (#213, #214) exists to close.
- **The engine is not native-Windows clean.** `.windows-known-failures` carries five `lab/` files
  with their cause classes: `checkpoint.test.ts`, `fork.test.ts` (line endings),
  `namespace-law.test.ts` (*"npm is npm.cmd on win32"*), `paths.test.ts` (drive letters),
  `restore.test.ts` (8.3 temp-dir names).
- **The lab's documents do not describe the console.** `docs/architecture.md` has no prd-14
  section — its walkthrough runs prd13→prd15. `docs/roadmap.md` omits prd-46 through prd-52.
  `docs/design-notes/lab-launch-ceilings.md:14` still says *"Raise it if a real workflow needs
  more"* — the sentence prd-50 was blessed to correct. No law checks any lab sentence against
  behaviour; the laws check paths exist, the CLI is listed, and routes are counted.
- **The lab has no path into the scene, by law.** `packages/web/src/lab/no-live-fleet-law.test.ts`
  forbids every fleet and scene import save one palette constant. The lab draws its own SVG.
- **prd-28's evidence, three weeks on, is unchanged.** Every item above that prd-28 cited at
  `beb4524` on 2026-08-13 holds at `7b3f331` on 2026-09-07 with the same line numbers ±3.

## Success

1. **One web launch of n arms × r runs folds to one `forkId` and reads back as one experiment.**
   Not met while `POST /api/lab/launch` mints a `forkId` per arm.
2. **CLI and browser summarise the same arm identically, from one law in `packages/core`.** Not met
   while the number 3 exists twice with two denominators, or while the CLI table can rank arms that
   differ in two dimensions without saying so.
3. **An outcome arrives on the wire, per run, stating how it was measured; an unmeasured run says
   *"not measured yet — no outcome is invented in its place."*** Not met while `adapters.ts` maps
   every run to `pending`.
4. **The comparison surface renders against the real server.** Not met while `experimentHasOutcome`
   is always false on a live fleet. This is prd-14's own Success sentence — *"read back a
   comparison"* — and the moment "done" becomes true.
5. **A checkpoint is a position on one horizontal scale, and every lab surface resolves position
   through that scale.** Not met while a checkpoint renders only as a table row.
6. **A launch above the ceiling refuses, naming the number and the override.** Not met while
   arms × runs is unbounded.
7. **A partial launch is a named state, not a silent one.** Not met while an experiment whose arm 2
   failed to restore reads as three healthy arms, or as nothing.
8. **The lab's documents say what its code does, and a law holds them to it.** Not met while
   `docs/architecture.md` has no console section, or while any behavioural sentence in
   `docs/user-guide/the-lab.md` has no test that could contradict it.

## Non-goals

- **Stage 2, the R&D agent — out entirely.** Constitutional, not schedule: an agent that reads
  retros and proposes tests needs a model call, which needs a credential, and ADR-0008's posture
  is that there is deliberately nowhere to put one — `process.env` across `packages/server/src`
  yields exactly `PORT` and `OUT_DIR`. A power costs a public argument and an ADR, never a flag.
  The shape that avoids the block is named in Open questions.
- **Not a ranking, at any n, ever.** A "leading" badge is a verdict the moment it is
  screenshotted. Refused three times already (prd-12 ruling 4, prd-14 ruling 3, ADR-0010 D).
- **Not whole-instrument scrubbing.** The axis is the lab's own view (ruling 4).
- **Not the persistence slice.** #213 and #214 stay prd-14's, fenced and sequenced (ruling 3).
- **Not the fixed lock ceiling.** #236–#238 stay prd-50's; `lab-launch-ceilings.md` is theirs
  while open (ruling 6).
- **Not `scene/`, `tide/`, `replay/`, `recordings/`.** Read, imitated, never entered.
- **Not portable checkpoints, and not a dollar cap.** prd-14 ruling 4's posture unchanged.
- **Not native-Windows repair.** Named (ruling 10), owned by prd-25's Windows work.
- **Not the judge.** Its 2026-08-04 "queued rulings" are unverified from this tree and belong to
  prd-11's lineage.

**Rejected alternatives.** *Absorbing #213/#214 and #236–#238* — two live, blessed milestones, and
one PR = one (milestone, wave); fencing and sequencing is how prd-31 handled prd-28 and it worked.
*Amending prd-14* — it is a ruled document with two open issues; growing a five-wave programme
inside it hides the programme. *Reusing the number 28* — a number is an identity, not a slot;
seven live documents cite the dead one and each gets a dated note pointing here. *One branching
scene* — prd-14 ruling 1's trunk-and-arms picture cannot show n parallel realities honestly;
charter §8 already ruled coexist-by-surface. *A fixed arms × runs ceiling* — see ruling 6 for why
it is not prd-50's sibling.

## What already exists (do not rebuild)

- **The engine is whole** — `packages/server/src/lab/checkpoint.ts`, `restore.ts`, `fork.ts`,
  `compare.ts`, `paths.ts` — 339 tests across 32 files, fenced by `namespace-law.test.ts`, whose
  live half really forks and walks the filesystem. `--ignore-scripts` on restore is in place and
  regression-tested against a real `postinstall` escape.
- **The experiment is derived, not stored.** `fork.checkpoint` / `fork.dispatched` fold into
  `SessionState.forks` with `byFork` and `byLane` (`packages/core/src/reduce.ts`, `appendIndexed`).
- **A checkpoint is already a coordinate.** `fork.checkpoint` carries `sessionCutByte`,
  `sessionDigest`, `eventIndex`, `snapshotSha`, `headSha` (`packages/core/src/events/lab.ts`).
  %-of-session is arithmetic over what is recorded.
- **The console is mounted.** `/lab` at `packages/web/src/App.tsx`; checkpoints table, `LaunchPanel`
  with free-form per-arm model and brief, the branching SVG, `ComparisonSurface` behind its gate.
- **The scrub track has prior art.** `packages/web/src/replay/Scrubber.tsx` takes plain numbers;
  `packages/web/src/replay/usePlayback.ts` is a fleet-free clock — wall-clock-shaped, so imitated
  inside `web/src/lab/`, never imported. **The trap:** `useReplaySession` rebuilds the whole `Fleet`
  per seek and would put live fleet state in the lab, which `no-live-fleet-law.test.ts` forbids.
- **The frame has a chart.** `packages/web/src/spark/Sparkline.tsx` + `bucketize.ts`.
- **Trace has its furniture** — `packages/web/src/trace/` (prd-31 restyled it; landed).
- **Reading the parent at a position is a route.** `GET /api/transcript/:lane?offset=N` is
  byte-offset addressed — exactly `sessionCutByte`'s shape.
- **The additive-field convention.** A bare `.optional()` on the zod schema plus the lenient-parse
  boundary — `packages/core/src/events/beacon.ts`, `git.ts`, `system.ts`, `telemetry.ts` all do it.
  `upcast()` (`packages/core/src/events/upcast.ts`) is identity today and exists for reshaping.
- **The gated-mutation pattern.** `POST /api/lab/launch` reaches the engine through
  `runCli(['lab', 'fork', …])` via a dynamic `import('../cli/index.js')` — never an import of
  `lab/`; `ROUTE_CLASSES` in `packages/server/src/api/index.ts` classifies it `gated-mutation`.
- **The confound predicate.** `isCleanlyControlled` in `packages/web/src/lab/types.ts` — moves,
  not rewritten.

## Inherited constraints — restated, not re-decided

- **prd-12 ruling 1 + ADR-0001:** two hands; the lab writes only under `refs/rhizomorph/*`, its
  own worktrees, and (ADR-0032) the harness's own projects tree for a synthesized session.
- **The lab has no clock** — no polling, no auto-refresh in the engine.
- **The lab tab shows forked realities only** (`no-live-fleet-law.test.ts`).
- **New event payloads are closed** (`no-open-payload-law.test.ts`); lab events extend additively.
- **`cli/index.ts` is the sole importer of `server/src/lab/`** (`namespace-law.test.ts`).
- **#205 fold-order is ruled** — append order is the truth. prd-28 said "stays unruled"; that
  constraint is dropped.
- **Charter §8's coexist-by-surface record (2026-08-13)** stands: the arms strip is n small
  organisms; the frame's scene is one organism through `scene/`. Cited, never re-argued.

## Rulings

## Ruling 1 — the experiment is one fork, and an arm holds r runs

*(Carries prd-28 ruling 1; amends its mechanism.)* The keystone. `forkDispatchedPayloadSchema`
gains `run: z.number().int().positive().optional()`, read everywhere as `run ?? 1` — the codebase's
own additive convention, **not** `upcast()`. `ForkState` gains `byArm`, keyed `${forkId}#${arm}`,
beside `byFork` and `byLane`; the *"one arm per handle in practice"* comment dies with the fact.
Worktree paths and lane handles become run-aware and **elide `-run-1`**, so every existing
single-run fixture path still holds and the new grammar appears only where runs are real.

The fragmentation closes at its existing seam: `lab fork` gains `--fork-id` (exposing
`DispatchForkOptions.forkId`) and `--arm-number` (valid with `--arms 1`), and `launchExperiment`
mints one `forkId` and passes both on each per-arm `runCli` call. `ARM_LINE_RE` parses the real
arm number. Free-form per-arm treatment (prd-14 ruling 2) survives inside the one fork. **Until
this lands, Compare is honest and permanently empty.**

## Ruling 2 — one floor and one confound clause, in core, and every surface reads the same function

*(Carries prd-28 ruling 2; widens it.)* The two floors are both right about different questions:
**completed runs per arm** gate a summary; **arms** gate a cross-arm claim. Both move into
`packages/core/src/lab/` as pure zod-only laws (ADR-0003-eligible), together with the confound
predicate — so `rhizomorph lab compare` gains the voice the browser already has and stops printing
a ranked spread across arms that differ in model *and* brief. The counterfactual clause rides
here: what actually happened is one observation, not a distribution, and an arm whose spread
contains it has not beaten it. Extends prd-12 ruling 4; never loosens it.

> **Amendment (the wave-3 review, ruled by Lachlan Kelliher 2026-09-08):** a run is **completed**
> when a gate has judged it — `pass` or `fail`. A `not-run` verdict (the gate never ran) and an
> unjudged run are not completed. Whether a value is booked under a given measure never enters the
> floor; it enters the spread's *n*, stated beside it. The predicate is core's `isCompletedVerdict`
> (`packages/core/src/lab/laws.ts`), and every surface — the CLI, Compare, Metrics — counts with it;
> `packages/web/src/lab/floor-agreement-law.test.ts` holds them to one answer. Before this amendment
> the ruling named the denominator and left it undefined, and the three surfaces fed one
> `canSummariseArm` three different counts: an arm whose gate failed on every run read as
> summarisable in Metrics and the CLI and as *too few runs to summarise* in Compare, on one page.

## Ruling 3 — an outcome is per run, typed with its provenance, and measuring is a write

*(Carries prd-28 ruling 3; corrects its placement.)* `outcome` lands on `LabRunDTO`, not
`LabArmDTO` — `adapters.ts` hands every run the same arm-level outcome, which is wrong the moment
ruling 1 lands. Provenance is typed: source plus verified, the Etude discipline — validation that
refuses to construct a proxy label claiming verification. `not-run` is legal and voiced.

Measuring runs a real command in an arm's worktree, so `POST /api/lab/measure` is a
**`gated-mutation`**: a new `ROUTE_CLASSES` row, reached through `runCli` and never an import.
`route-class-law.test.ts`'s pinned count rises by exactly one. A contract test proves the gate.

**Sequencing note, recorded on #213:** this ruling lands before prd-14 w1 dispatches. #213 saves a
comparison as a versioned artifact; frozen on today's arm-level outcome, it would need a v2 the
month after it shipped.

## Ruling 4 — the axis is the lab's own view

*(Carries prd-28 ruling 4 unchanged.)* %-of-session is arithmetic over `sessionCutByte` and
`eventIndex`; checkpoints are chapter markers — coordinates, not rows. One scale resolves position
for the scrub track, the observability chart and the lane canvas; the modify-workflow region is
deliberately off-axis. `Scrubber` and `usePlayback` are imitated inside `web/src/lab/` — zero edits
to `tide/` or `replay/`. Settles prd-14's open question: the axis scrubs the lab's own view, never
the whole instrument.

## Ruling 5 — the lane canvas is n organisms

*(Carries prd-28 ruling 5; now cites rather than argues.)* An experiment is n parallel realities,
and n small organisms say that honestly where one branching scene cannot — charter §8's
coexist-by-surface record, 2026-08-13. Growth truncates at the playhead, never extrapolated;
dashed-after-playhead is the shared grammar; selection is carried by luminance on the ice ramp,
never a hue of its own (law 9a). Arms are forkable: the geometry is recursive, grouping on forkId.

## Ruling 6 — a launch has a ceiling on arms × runs, it is configurable, and the refusal names the number and the override

*(Carries prd-28 ruling 6, kept against prd-50's precedent — and says why.)* Above a default,
the launch — route and CLI alike — refuses, naming the number and the override that would permit
it. The override is a **declared act**: a flag on the launch, echoed in the refusal, recorded on
the `fork.dispatched` event. Never a silent config.

prd-50 ruling 1 fixed `LAB_CLI_LOCK_CEILING_MS` because it bounds a **wait**: raising it hides
spend behind latency, which is a rebuilt queue. This ceiling bounds **machine load** — worktrees ×
installs × live agents — which differs by an order of magnitude between a laptop and a twenty-core
box, so one fixed number is wrong on both. That is the distinction, and it answers prd-50's own
open question (*"whether the rest of the ceiling family follows this verdict"*): no, and here is
the line. The rationale lands in `docs/design-notes/lab-launch-ceiling-arms-runs.md`;
`lab-launch-ceilings.md` is prd-50's while #237 and #238 are open.

## Ruling 7 — empty, partial and held-back states are first-class, and a partial launch is one of them

*(Carries prd-28 ruling 7; extends it.)* Specified per surface with their copy, not a polish pass:
below-floor arms show their runs and say why; unmeasured outcomes say what was not measured; the
scoring measure appears **once, disabled, in Compare's measure switch — and nowhere else**
(*"Scoring — no source yet"*). Declaring one absence twice reads as two missing features.

The new state: a grouped launch is n sequential CLI calls with no atomicity. *"Arm 2 failed to
restore; arms 1 and 3 already spent money"* was an acceptable outcome for n independent forks and
is a **partial experiment** for one. It is named, rendered on every surface, and its spend is real
spend (prd-28's *"a fork's spend is real spend"*). This ruling names the state; it does not make
the launch atomic — see Open questions.

## Ruling 8 — the observability frame is one switch over five ways of looking, and its scene position is the charter's, not a reversal

*(Supersedes prd-28 ruling 8's reversal ask; new record, the log is append-only.)* The Workspace's
second region carries one exclusive switch of five positions — telemetry, cost, scene, divergence,
footprint. Telemetry and cost are two series of one chart, solid to the playhead, dashed after,
parent ghosted. Scene is the experiment as one organism through `scene/`'s own renderer, scoped to
one experiment, reach truncated at the playhead — lawful alongside ruling 5's arms strip because
charter §8 already ruled *"different surfaces, different pictures, both lawful."* Divergence is the
running share of steps that have left the parent, 0 % at the fork by construction, a dead arm's
line ending rather than dashing. Footprint is which files each arm touched and which more than one
touched — overlap, never conflict, because arms forked from one checkpoint were never going to
merge. Neither new view needs engine work.

## Ruling 9 — the lab's documents are part of its surface

*(New.)* `docs/architecture.md` gains the console section it has never had. `docs/user-guide/the-lab.md`
covers the 400 and 503 refusals an operator actually sees and the estimate's basis. `docs/roadmap.md`
gains prd-46 through prd-53. The six ghost fences — *"prd-28's territory"* in prd-30, 31, 32, 34,
35 and 36 — each get a dated note pointing here; `charter.md`'s citation likewise.
`packages/web/src/lab/branching/perf.test.ts`'s stale *"deliberately not mounted"* is corrected.
`docs/vision-the-lab.md` is **restored as recovered history** under a header naming its source
commit, its date, and what has changed since.

And a law, because prd-43's *the claim is a test* has never reached the lab: one assertion per
behavioural sentence in `docs/user-guide/the-lab.md`. The user guide is currently more honest than
the status lines; a law is what keeps it that way.

## Ruling 10 — the residuals have owners, or say plainly that they do not

*(New.)* Five `lab/` files on `.windows-known-failures`, cause class each — **owner: prd-25's
native-Windows work, not this PRD.** The fork spike's open item, a checkpoint captured mid-tool-call
restoring into a session the harness may not resume — **unowned**, with the failure stated.
prd-41's *"No owner"* pair, `FORK_EXEC_TIMEOUT_MS` and the `install: false` default — **still
unowned.** A residual with a false owner is worse than one honestly without.

## The specification

Four surfaces share one axis; each answers six questions. The design-spec artifact draws every
state named here, one panel per surface, and its acceptance criteria are the wave-3 issues'
definitions of done.

> **Amendment — the design-spec artifact exists (2026-09-08, wave 3).** Drawn as *The Lab, Specified*:
> https://claude.ai/code/artifact/bd82d5d7-cff2-44fe-910e-3ebdb9840780 — the instrument's own palette and
> type, one session axis repeated at the head of every surface, every S1–S4 state with its verbatim
> copy, each acceptance criterion a test. Its URL is on #325–#328 as their definition of done. Two
> corrections landed there with wave 3's code, as its own rule requires: S3 draws its own rows (the
> instrument's trace furniture is span-typed and a transcript step is not a span), and S3 aligns the
> parent and the arm by *content* with paths masked, because the arm's session is a path-rewritten
> copy and byte offsets do not carry across it — the parent is still read, never copied. Built
> without hchristina's hand, by ruling; to be shown to her before it is cited as authority. The scoring measure is absent from all four except where ruling 7 places it.

### S1 — the Workspace

**What it shows and why.** One horizontal scale — the session — with the scrub track above,
checkpoints as chapter markers on it, the observability frame (ruling 8's five-position switch)
resolving position through the same scale, the lane canvas (ruling 5) beneath, and the
modify-workflow region deliberately off-axis. It exists so the operator can *stand in time* —
*"twenty minutes ago, before the summariser first ran"* — instead of reading a checkpoint as a row.

**Every state.** *Live:* the track advances; the playhead crosses what is on the axis and stops at
what is not. *Empty:* *"there are no checkpoints yet — capture one with `rhizomorph lab checkpoint
<lane>`."* *Loading:* the track drawn, markers absent, no fabricated positions. *Error:* *"the lab
cannot see its checkpoints — `<the read's own failure detail>`"* — a failed read is never a
successful read of zero rows. *Degraded:* a checkpoint whose session file has moved reads as a
marker with its reason, not as absent. *Replay:* the Lab entry is disabled with its reason
(*"unavailable during replay — the lab forks live checkpoints, and this session is history"*).
*Demo:* the shipped fixtures hold no checkpoints; the empty state is the demo. *Partial launch:* a
fork whose arms did not all dispatch is drawn with its failed arms named at the fork marker.

**Data source per field, and the honest gap.** Position: `fork.checkpoint.sessionCutByte` over the
session's byte length, `eventIndex` as the tie-break. Cost series: `core/src/selectors/spend.ts`.
Telemetry series: the lane's OTEL readings already in the fold. Divergence: Trace's own diff,
accumulated. Footprint: `selectFilesTouchedByBranch` ∩ `selectCollisionMap`. **Gap:** there is no
judged score in the record; the scene position labels its strands with the last-shown measure and
declares it on the basis line (see Open questions).

**Interactions and the keyboard path.** Click a marker to seat the playhead; `←`/`→` step markers;
`Home`/`End` to first/last; `1`–`5` select the frame's position; `Esc` clears selection
(the instrument's one way out of every narrowed view). The fork-from-here action is on the seated
marker and nowhere else.

**What would make it wrong.** A playhead that dashes a *shape* into the future · a marker placed by
wall-clock rather than by byte offset · two surfaces disagreeing about where 46 % is · a checkpoint
the read failed on rendered as "no checkpoints" · the scene position extrapolating reach.

**Acceptance criteria.** Every lab surface reading %-of-session calls one function (grep law) ·
the playhead at byte *b* renders at the same x in track, chart and canvas (`toStrictEqual` on the
computed x) · a failed `GET /api/lab/checkpoints` renders the error copy, never the empty copy ·
the Lab nav entry is disabled with its reason while a recording is loaded · a partial fork renders
its failed arm count at the marker.

### S2 — Compare

**What it shows and why.** The arms of one experiment side by side, each arm's runs as individual
points with min–median–max, every spread recomputed when the measure switches, and the dimensions
line computed from the arms — *"arms differ in model only"* — never declared. It exists to answer
*would this have gone better another way* without ever saying which way was better.

**Every state.** *Live:* runs arrive; the spread widens honestly. *Below the floor:* *"1 of 3 runs
completed so far — too few completed to summarise yet"* — the individual runs shown, the summary
refused, the refusal a rendered state on the shared scale. *Replicates:* *"no arm varies from the
others — these are replicate runs, not a comparison."* *Confounded:* *"arms differ in model and
brief — a difference cannot be attributed to either."* *Unmeasured:* *"not measured yet — no
outcome is invented in its place."* *Empty:* *"there are no experiments yet — fork a checkpoint
with `rhizomorph lab fork <lane>`."* *Error:* the read's own detail. *Partial launch:* the failed
arm is present in the arm list with its failure, and excluded from every spread with that stated.
*Scoring:* one disabled position, *"Scoring — no source yet."*

**Data source per field.** Cost: the arm lane's own booked spend (`spend.ts`). Duration: dispatch to
last event. Commits: `countCommits` in the arm's worktree. Verified: `outcome.verified` with its
`source`. **Gap:** eval score — no source; the disabled switch position is the honest gap.

**Interactions and the keyboard path.** Measure switch by `Tab` into it and `↑`/`↓`; an arm's
row expands to its runs on `Enter`; `Esc` collapses. No sort control exists — *"a sorted table is a
ranking whether or not it says so."*

**What would make it wrong.** A point estimate in the below-floor gap · any sort by value · a badge,
a colour, an order that marks one arm as leading · the actual run drawn as a distribution · a
`pending` where the truth is `not-run`.

**Acceptance criteria.** With two completed runs the summary is absent and the refusal copy present ·
with three it is present and carries min, median and max · arms in identical treatment render the
replicate copy · arms differing in two dimensions render the confound copy **in the CLI table too**
· rows are in arm order regardless of value (a mutation that sorts by cost goes red) · an
unmeasured run renders `not-run` copy, never a number.

### S3 — Trace

**What it shows and why.** An arm's steps against its parent's from the checkpoint forward,
each classified `same` / `diverged` / `added` / `absent`, the parent read at its byte offset and
never copied. It exists to show *where* an arm left the parent behind, step by step.

**Every state.** *Live:* rows append as the arm runs. *At the fork:* every row `same` by
construction. *Dead arm:* rows end; nothing dashes. *Empty:* the arm has no steps yet — *"no steps
recorded — the arm has not begun."* *Parent unreadable:* *"the parent's transcript cannot be read
at byte `<n>` — `<detail>`"*; the arm's own rows still render. *Replay:* disabled with the Lab's
reason. *Partial launch:* a failed arm has no trace and says so.

**Data source per field.** The arm's steps from its own session file; the parent's from
`GET /api/transcript/:lane?offset=<sessionCutByte>`. **Gap:** the definition of a *step* for
divergence purposes is the implementer's to propose (Open questions).

**Interactions and the keyboard path.** `↑`/`↓` rows; `Enter` opens the focus panel for one step;
`Esc` back. Reuses `packages/web/src/trace/`'s furniture — `TraceGantt`, `TraceRow`, `FocusPanel`.

**What would make it wrong.** Copying transcript text into the lab's own store · a `diverged` at
the fork row · a dead arm dashing forward · a parent read failure rendering as `absent` rows.

**Acceptance criteria.** Row 0 is `same` for every arm · a dead arm's last row has no successor ·
the parent is fetched by byte offset (the request carries `offset=`) · no lab source file contains
transcript text (grep law) · a failed parent read renders its copy and the arm's rows remain.

### S4 — Metrics

**What it shows and why.** Every number with its basis line — *"booked $10.50 from each arm lane's
own recorded rate"* — distributions on a shared scale across experiments, and the verification and
provenance table. It exists so a KPI cannot be read without the sentence that says where it came
from.

**Every state.** *Live:* figures update; basis lines persist. *Below the floor:* an empty track
labelled *"refuses to summarise"* on the same scale as its neighbour — a rendered refusal, not a
missing row. *No rate:* *"the lane's recent rate cannot be established — no cost has been booked to
it in the last hour."* *Unmeasured:* the provenance table shows `not-run` with no value beside it.
*Empty:* no experiments — the same copy as S2. *Partial launch:* the experiment's row states
*"2 of 3 arms dispatched"* and its spend is the spend of the two.

**Data source per field.** Spend: `spend.ts`, per arm lane. Rate: the last hour's booked spend.
Verification: `outcome.verified` and `outcome.source`. **Gap:** no scoring column exists; none is
drawn.

**Interactions and the keyboard path.** `Tab` through experiments; `Enter` on a row opens its
Compare. No controls that change a number.

**What would make it wrong.** A figure with no basis line · a total that includes an unmeasured
arm as zero rather than excluding it with a note · a below-floor experiment omitted rather than
drawn refusing.

**Acceptance criteria.** Every rendered figure has an adjacent basis element (DOM law) · a
below-floor experiment renders a track with the refusal copy · a partial experiment's spend equals
the sum of its dispatched arms only · `not-run` rows carry no numeric cell.

## Sequencing (waves, each gated as ever)

`scene/`, `tide/`, `replay/` and `recordings/` are not entered by any wave. `packages/core/src/fleet/`
is read, never rewritten. `docs/design-notes/lab-launch-ceilings.md` is prd-50's until #237 and
#238 close. `packages/web/src/recordings/` is #214's fence. Every wave consumes ruling 1.

**Wave 0 — operator acts, booked, not dispatchable.** Bless this document. Name The Lab Workspace
as the design authority as it stands and this PRD's spec artifact as its successor. Clear the
critical-path blocker on another lane: **#220** (prd-30 w1, assigned to ciaran-slow, no branch,
blocks #214 on `recordings/`) — check for in-flight work first, then take it with a comment.

**Wave 1 — the Keystone.** `prd53 w1: an experiment is one forkId, and an arm holds r runs
addressable from outside dispatchFork` (ruling 1). One lane, opus. Fence: `packages/core/src/events/lab.ts`
+ test, `packages/core/src/state.ts`, `packages/core/src/reduce.ts`, `packages/server/src/lab/fork.ts`
+ test, `packages/server/src/lab/paths.ts` + test, `packages/server/src/cli/lab-fork.ts` + test,
`packages/server/src/cli/index.ts`, `packages/server/src/api/lab.ts` + test. The old-behaviour
tests rewritten in the same commit: the fixture in `api/lab.test.ts` where two runs share one
`worktreePath` (illegal, not stale, once runs are real), the `arm 1` parser tests, the literal
worktree paths (they survive via elision and gain `run > 1` cases). `namespace-law.test.ts` must
pass **unchanged**. Nothing above this is honest until it lands.

**Wave 2 — parallel, fenced apart:** `prd53 w2: one floor and one confound clause live in core, and
both surfaces read them` (ruling 2 — `packages/core/src/lab/` new, `packages/server/src/lab/compare.ts`
+ test, `packages/web/src/lab/compare/summarise.ts` + test) · `prd53 w2: a measured outcome is typed
and travels per run over a gated route, and a launch above the ceiling refuses by name and override`
(rulings 3 and 6 — `packages/server/src/api/lab.ts` + test, `packages/server/src/api/index.ts`,
`packages/server/src/api/route-class-law.test.ts`, `packages/web/src/lab/adapters.ts` + test,
`packages/web/src/lab/types.ts`, `packages/contract/src/lab-measure.contract.test.ts` new,
`docs/design-notes/lab-launch-ceiling-arms-runs.md` new). The ceiling rides the launch-path lane
because a third lane on `api/lab.ts` is a collision the fence lint would refuse.

**Between waves 2 and 3 — the design-spec artifact.** Four surfaces, six answers each, every
state in this specification drawn, ruling 7's partial launch included. Its acceptance criteria are
wave 3's definitions of done.

**Wave 3 — parallel, fenced apart:** `prd53 w3: the workspace scrubs the lab's own axis, and the
frame is one switch over five` (rulings 4, 8 — `packages/web/src/lab/axis/` new,
`packages/web/src/lab/frame/` new, `packages/web/src/lab/LabPage.tsx` + test) · `prd53 w3: Compare
renders a real per-run distribution, and every state it can be in is first-class` (ruling 7 —
`packages/web/src/lab/compare/ComparisonSurface.tsx`, `compare.ts`, their tests) · `prd53 w3: Trace
diffs an arm against its parent, read and never copied` (`packages/web/src/lab/trace/` new) ·
`prd53 w3: Metrics states the basis of every number` (`packages/web/src/lab/metrics/` new).
LabPage's wiring of Compare belongs to the workspace lane; Compare's fence is `compare/` alone.

**Wave 4 — the lane canvas.** `prd53 w4: the lane canvas draws n organisms from real multi-run
experiments` (ruling 5). One lane, opus. `packages/web/src/lab/canvas/` new; `branching/` retired
or reused, decided on the issue. Last of the surfaces: the only genuinely new UI.

**Wave 5 — the sweep, last.** `prd53 w5: the lab's documents say what its code does` (rulings 9,
10). `docs/architecture.md`, `docs/user-guide/the-lab.md`, `docs/roadmap.md`, `docs/vision-the-lab.md`,
the six ghost-fence notes and `charter.md`'s, `packages/web/src/lab/branching/perf.test.ts`, and the
user-guide law. A sweep that runs earlier re-lays ground the other waves are about to dig.

**Unfiled work implied, described not numbered:** the R&D lane (Open questions); the judge lineage
(prd-11's); native-Windows `lab/` (prd-25's); the mid-tool-call cut; `FORK_EXEC_TIMEOUT_MS` and the
`install: false` default; atomicity of a grouped launch; recursive forking of an arm (the Workspace
draws it; nothing rules it).

## Open questions

- **Where a scoring measure could ever be sourced from.** Telemetry and cost exist in the record;
  "scoring" does not, and `docs/record-format.md` has no field for it. It must not be closed by
  fabricating a number. Open, not ruled.
- **Should a grouped launch be atomic?** Ruling 7 names the partial state; it does not prevent it.
  If real experiments show partial launches are common, a follow-up rules whether the launch
  rolls back or the state stays first-class. Open, not ruled.
- **What a step is, for divergence.** Trace classifies steps; the unit is the implementer's to
  propose against the session format. Open, not ruled.
- **What the scene labels its strands with when no measure is showing.** Carrying the last-shown
  measure is a small lie of omission; dropping the figures loses the reading that earned the scene
  its place. Open, not ruled.
- **The canvas frame-budget measurement's form.** The 16.67 ms budget and the ratios-not-absolutes
  discipline are inherited; the measurement's shape is the implementer's. Open, not ruled.
- **Stage 2 as a lane, not a feature.** An R&D agent that reads the retro corpus, groups failures by
  shape, and proposes tests varying one thing is constitutionally blocked *inside the instrument*.
  The shape that avoids the block: it runs as one of the swarm lanes the operator already drives,
  with their credentials in their shell, writing its patterns and proposals into the event log as
  lab events the Lab renders read-only — and dispatches through ruling 1's fork machinery, which a
  lane can already invoke. Named for a future PRD. Open, not ruled.
- **Does a multi-run fixture ship where a user can select it?** The same question prd-52 answered
  *no* for colonies, for the same reasons; asked here separately because a lab demo has no
  teammate-scaffolding concern. Open, not ruled.

## Recovered history

`docs/vision-the-lab.md` and prd-28 were written 2026-08-12/13 and lost 2026-08-19. Both are
recovered from the fossil clone's history at `19adcda8`. The vision doc is restored beside this PRD
under a header stating exactly that; prd-28 is not restored — its content lives here, re-verified,
and its number stays dead. The seven documents that still cite prd-28 are corrected in wave 5.
