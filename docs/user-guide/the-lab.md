# The lab

> **Every behavioural sentence on this page is a test.** The paragraphs below carry
> claim markers (invisible when rendered), and `packages/web/src/lab/the-lab-guide-law.test.ts`
> reads each one and asserts it against the code or the copy it describes — prd-43's
> *the claim is a test*, reaching the lab with prd-53 ruling 9. A sentence here that
> goes false fails the build; a paragraph, a quoted message or a table that names a
> route, a status code, a flag or a ruling without a marker fails it too — and a quoted
> message is held to the source text, word for word. <!-- claim: law-itself -->

The lab is the instrument's separate, opt-in second hand — reachable only by
an explicit human act, and there are exactly two of those: your own command
line (`rhizomorph lab ...`), or the Launch panel's button on `/lab`, which
reaches that same CLI in-process through `POST /api/lab/launch`
(`packages/server/src/api/lab.ts`) — the route calls the CLI's `runCli` and
never imports the lab's own modules, so there is one implementation of every
lab act and the HTTP surface cannot grow a second one. Never a background
poll, and never a route an always-on process could trigger. prd12 ruling 1's
own amended text settles the button: *a UI button is an explicit human
invocation and is permitted* — what the ruling confines is the lab's
**writes**, not which finger starts them. Everything in [watching.md](watching.md)
and [replay.md](replay.md) runs the moment the server starts; the lab does not
run unless you ask it to. <!-- claim: explicit-hand -->

## Your first experiment, end to end

Three commands, in this order: `rhizomorph lab checkpoint` captures a lane as it
stands, `rhizomorph lab fork` restores several arms from that capture, and
`rhizomorph lab compare` tables what the arms did. They are **three separate
explicit acts**. Nothing chains them for you, nothing schedules the next one, and
the namespace has no entry point but the one you type — which is why the lab can
be opt-in at all, and why every step below is something you did rather than
something that happened. <!-- claim: walkthrough-three-acts -->

### 1. Capture a checkpoint

```sh
rhizomorph lab checkpoint <lane> --path <worktree>
```

It prints the checkpoint id, the lane, the snapshot ref and sha, and the byte the
session transcript was cut at — the coordinates every later step is expressed in.
Take one when the lane is at a point you would want to return to; you cannot fork
from a moment you never captured.

### 2. Fork arms from it

```sh
rhizomorph lab fork <lane> --arms 3 --runs 1 --path <worktree>
```

Each arm is a restored worktree with a synthesized session, and the arm count and
run count are the defaults described under [Forking arms](#forking-arms) below. A
bare `fork` dispatches nothing: it writes only inside the lab's own namespaces,
prints in full why no tmux window was opened and no branch was created, and names
`--launch` as the flag that would authorise otherwise. That flag is **off by
default**, and it is off because turning it on is the one thing here that writes
outside the confinement. <!-- claim: walkthrough-no-launch-default -->

### 3. Compare the arms

```sh
rhizomorph lab compare <fork-id> --path <worktree>
```

**You never have to find a fork id.** The fork you just ran ends by printing the
exact compare invocation for it — the subcommand, the id it minted and the
`--path` you gave it — so step 3 is a line you copy rather than one you assemble.
Run `compare` against an id that was never forked and it does not merely say no:
it names `rhizomorph lab fork <lane>` as the step to run first, or tells you to
check the id. Each end of the walkthrough points at the other.
<!-- claim: walkthrough-next-step -->

Then open `/lab` in the browser for the same experiment as a workspace — the
arms, their traces, their spend and the comparison surface, described from
["The `/lab` web tab"](#the-lab-web-tab) onward.

## What it's allowed to write

Refs under `refs/rhizomorph/`, the git objects those refs require, and
worktrees it creates itself under
`~/.local/share/rhizomorph/lab/worktrees/` — a sibling of the recording
directory, never inside the repo you're watching. It never pushes, merges,
or checks out/rewrites a branch that already exists. A restored tree's
`npm install` always runs with `--ignore-scripts` (prd41 ruling 1): a
checkpoint is data, never code that runs on restore. The one write that lands
outside those namespaces is never silent: pass `lab fork --launch` and it
hands the dispatch off to `workmux add` (the same command that starts every
other worker lane), and only because you typed the flag — or because you
pressed the Launch panel's own button, which passes `--launch` for you, once,
on your say-so. Without either, `fork` says so plainly (below). <!-- claim: writes-confined -->

## Checkpoints

Snapshot a lane's live workspace and session position — tracked-modified,
staged, and untracked files folded into one commit via a temp-index recipe,
**working tree byte-for-byte untouched**:

```sh
rhizomorph lab checkpoint <lane> [--path <dir>] [--captured-by dispatch|gate|operator]
```

Prints, e.g.:

```
checkpoint <checkpointId> captured for lane "<lane>" — refs/rhizomorph/checkpoints/<id> @ <sha12>, session cut at byte <n>
```

A checkpoint is coordinates, not content: the ref, the head sha, the event
index, and the byte the session transcript was cut at. Since prd-53 the
console's read of a checkpoint also carries the transcript's total byte length,
so a moment can be placed as a fraction of the session — and when that length
cannot be read the field is null and the surface says *degraded* rather than
inventing a position. <!-- claim: checkpoint-coordinates -->

## Forking arms

```sh
rhizomorph lab fork <lane> [--at <checkpointId>] [--model <m>] [--prompt-file <f>]
                          [--arms <n>] [--runs <r>] [--ceiling-override <n>]
                          [--fork-id <id>] [--arm-number <k>] [--path <dir>] [--launch]
```

**An experiment is one fork, and an arm holds r runs** (prd53 ruling 1). An
arm is one treatment — a model and a brief; a run is one restored reality of
it. `--arms` defaults to **3** (prd12 ruling 4's floor for a comparison) and
`--runs` to **1**; three runs of one arm is what a per-arm summary needs
(below). `--fork-id` dispatches into an existing experiment instead of minting
a new one, and `--arm-number` names which arm this call is — the plumbing the
web launch uses to dispatch an n-arm experiment as n calls that share one
fork id, so the record holds one experiment, never n single-arm ones. Every
run is its own worktree and its own lane handle; a first run's paths elide the
run suffix, so every single-run fixture that ever existed still resolves. <!-- claim: one-fork-r-runs -->

Each run is restored from the checkpoint with its own Claude Code session (the
parent's conversation cut at the checkpoint, digest-verified, every absolute
path into the parent worktree rewritten to the arm's own tree) and, by default,
its own `npm install` run (`--no-audit --no-fund --ignore-scripts`), so each
arm is genuinely ready to work rather than just restored. <!-- claim: run-restored -->

**What the CLI's fork does:** every arm produced by one `lab fork` call
shares the *same* treatment — the same `--model` and the same
`--prompt-file` across all of them. That makes the CLI's fork a rigor tool
for measuring run-to-run variance under one configuration, rather than a way
to compare genuinely different approaches side by side in one experiment.
Free-form arms — each arm carrying its own model and brief — are the web
Launch panel's (prd14 ruling 2): one model select and one brief field per arm
row (`packages/web/src/lab/launch/LaunchPanel.tsx`). Mind which hand dispatched
an experiment before you read its comparison. <!-- claim: cli-shares-treatment -->

### The launch ceiling

A launch may create at most **8** spending lanes — arms × runs — by default
(prd53 ruling 6; the reasoning against prd-50's fixed sibling is
`docs/design-notes/lab-launch-ceiling-arms-runs.md`). The ceiling is
configurable per launch, never per config: `--ceiling-override <n>` on the CLI,
`"ceilingOverride": n` in the launch body, and the override is recorded on
every `fork.dispatched` event the launch produces. The refusal names both the
number and the override, so your next command is in the message rather than
in this page: <!-- claim: launch-ceiling -->

> `refusing to dispatch 9 spending lane(s) (3 arm(s) × 3 run(s)): the launch
> ceiling is 8 (the default) — pass --ceiling-override 9 to authorise exactly
> this many; the override is recorded on every fork.dispatched it produces
> (prd53 ruling 6)` <!-- claim: ceiling-refusal-quote -->

Without `--launch`, nothing runs — the exact message: <!-- claim: no-launch-message -->

> "No tmux window was opened and no branch was created: prd12 ruling 1
> confines the laboratory's writes to refs/rhizomorph/, its own worktrees
> and its data dir, and 'workmux add' writes outside all three. Pass
> --launch to authorise that yourself." <!-- claim: no-launch-quote -->

— followed by the exact command line to run each arm yourself, and a hint
for comparing them once they have.

## Comparing arms

```sh
rhizomorph lab compare <fork-id> [--verify <cmd>] [--no-verify] [--json] [--path <dir>]
```

Prints a table — `arm`, `run`, `lane`, `treatment`, `verified`, `cost`,
`duration`, `commits` — verified against `--verify` (default `npm test`) in
each run's worktree, `--no-verify` to skip and report every run `not-run`.
**This is a table, never a visualization** (prd12 ruling 6). `--json` prints
the same comparison as a document; it is what the console's measure route
reads back. <!-- claim: compare-table -->

**Two floors, two denominators, one implementation** (prd53 ruling 2, in
`packages/core/src/lab/laws.ts`, read by the CLI and every web surface alike):
an arm is summarised only once **3** of its runs have completed — and a run is
**completed** when a gate has judged it, pass or fail; a `not-run` verdict and an
unjudged run are not (ruling 2's amendment of 2026-09-08, after the wave-3 review
found three surfaces counting three different things) — and arms are ranked only
once there are **3** of them. Below the arm floor the CLI refuses to
rank at all and closes with the counterfactual clause — *what actually happened
is one observation, not a distribution*: <!-- claim: floors -->

> `<n> arm(s) — runs only. Ranking needs n >= 3 (prd12 ruling 4: a comparison
> below three arms reports what happened, never which arm was better).
> what actually happened is one observation, not a distribution.` <!-- claim: rank-refusal-quote -->

At three or more arms it shows a *distribution* — verified count, cost and
duration spread (min/median/max), one line per arm once any arm holds more
than one run — and closes with the same sentence every time: *no winner is
named: prd12 ruling 4 reports distributions, and the choice stays yours.*
There is no "leading arm" marker anywhere in this output, on purpose. <!-- claim: no-winner -->

When the arms differ in more than one dimension the table says so before any
number, in the one voice core owns: *these arms differ in model and brief — a
difference cannot be attributed to either.* The console's attribution line
speaks the same sentence, because both read `confoundVoice` from core. <!-- claim: confound-voice -->

## Measuring from the console

Measuring is a write, not the read it resembles (prd53 ruling 3): it runs the
gate in every run's worktree. So `POST /api/lab/measure` is a gated mutation —
capability token required, like launch — that runs `lab compare --json --verify`
through the CLI and records one `fork.measured` event per run, with the
verdict, the command that judged it, and the source (`measure-route`). The body
is `{ "forkId": "<id>", "verifyCommand"?: "<cmd>" }`. Its refusals: **400** for a
malformed body (a fork id or a command that begins with `-` is refused as a
flag in disguise), **404** for a fork the record does not hold, **503** when the
lab's CLI lock could not be taken in time, and **409** on a server that is
replaying a session record, where there is nothing live to measure. <!-- claim: measure-route -->

Every experiment panel on `/lab` carries a **measure** control (prd-55 ruling
7): a gate command field, defaulting to `npm test` — the CLI's own `--verify`
default — and a *measure* button that asks once, naming how many worktrees the
gate will run in (one per run of every arm), before anything is sent. When the
measurement returns the page re-reads its experiments, so the verdicts reach
Compare and Metrics without a reload; a refusal is printed verbatim, in the
panel. <!-- claim: measure-control -->

A run nobody has measured reads, everywhere in the console, as *not measured
yet — no outcome is invented in its place*; a `not-run` verdict reads the
same, because in neither case did a gate judge the run. A measured run reads
*passed npm test (measure-route)* or *failed …* with the gate's own detail. <!-- claim: not-measured-voice -->

### The CLI lock

Every request that reaches the laboratory serialises through one process-wide
lock — one lab CLI call in flight at a time, because each one installs and
restores the process's stderr capture and runs real `git worktree add` against
the same parent repo. A caller waits up to **30 s** (prd-50 ruling 1's fixed
ceiling: a bound on waiting, never softened) and is then refused with **503**,
naming what it waited on. <!-- claim: cli-lock -->

## The `/lab` web tab

**Lab** is an entry in the primary nav on every surface (see
[watching.md](watching.md#the-primary-nav)) — the one exception being a
loaded recording, where it renders as a disabled entry carrying its reason
(*"unavailable during replay — the lab forks live checkpoints, and this
session is history"*) rather than quietly disappearing. Its own header names
the constitutional limit: *"forked realities only — checkpoints you captured,
and experiments forked from them. Never live fleet state."* <!-- claim: nav-and-header -->

Two regions, not six sections stacked in one column (prd-55 ruling 8; Stage 1's
own specification is `docs/prds/done/prd-53-the-lab.md`, the rearrangement's is
`docs/prds/done/prd-55-the-lab-stage-two.md`, both with their companion artifacts): a
**rail** and a **stage**. <!-- claim: workspace-regions -->

**The rail** lists every checkpoint and every experiment this repo has
captured, one row each — the whole record at a glance, and the only place
either is listed. Selecting a checkpoint row seats the playhead; the launch's
own step 1 reuses that same rail selection rather than repeating a table of
checkpoints a second time. An experiment's row carries its own arms · runs ·
verdict counts, and a partial launch's row says how many of the requested arms
actually dispatched. <!-- claim: rail-rows -->

**The stage** keeps its own top pinned — the session axis and the frame never
scroll away:

**The session axis** — the lab's own view of time: every checkpoint placed
as a percentage of its session, computed from the checkpoint's cut byte
over the transcript's length by exactly one function
(`packages/web/src/lab/axis/position.ts`), which every surface that places a
moment shares. A checkpoint whose length is unknown is drawn at the inset
and named degraded. Seat a checkpoint and the frame below reads from it. <!-- claim: axis-one-function -->

**The frame** — one switch over five ways of looking at the seated moment:
telemetry, cost, scene, divergence, footprint (keys 1–5). Telemetry (1)
and footprint (5) read the lab's own routes the moment a checkpoint is
seated: a lane the fold has never seen, or a byte past the session's
length, is refused by name, and an empty reading draws its own sentence
too — refused and empty are sentences of their own, never blanks. The
scene position is the lane canvas (below). <!-- claim: frame-five -->

Below the pinned top, one experiment's reading at a time: **Compare, Trace,
Metrics and R&D** sit in a `role="tablist"`, never a stack, sharing one
roving-tabindex keyboard path (←/→ moves, Home/End jump to the ends) —
switching between four readings of the same experiment costs a keystroke,
never a scroll. R&D sits last in the strip, and unlike the other three it is
also reachable the moment a checkpoint is seated, before any experiment
exists at all: the operator's hand reads retros and reviews too, not only a
selected experiment's own record. <!-- claim: stage-tablist -->

**Launch** — the act itself: pick a checkpoint from the rows the engine
actually holds — the rail's own selection, never a table of its own — give
each arm its own model — from this repo's list, or typed under *other…* —
and its own brief, set runs per arm and a ceiling override if you mean more
than the defaults, read the estimate, press the one button. There is no second dialog after that one
(prd14 ruling 4 asks for one confirmation). <!-- claim: launch-one-confirmation -->

**Compare** is the comparison surface (below); **Trace** and **Metrics** are
each described in their own sections below; **R&D** — the operator's own
agent — has a section of its own next.

### The estimate and its basis

Before the button, the panel reads `/api/lab/estimate` and shows the number
*with its basis on screen*: the forked lane's own cost rate over the last
**hour**, multiplied by the spending lanes the launch would create (arms ×
runs — one lane is assumed to run about as long as the window the rate was
measured over). When the lane has no rate yet the panel says the rate cannot
be established, with the reason, and never shows a figure. <!-- claim: estimate-basis -->

**Runs and the ceiling, from the panel** (prd-55 ruling 7): the Launch panel
carries *runs per arm* and *ceiling override*, and each travels in the launch
body only when set — a blank field sends no key, so the server's defaults (one
run; the ceiling of 8) rule. With runs set, the estimate is asked for arms ×
runs and its basis line says how many spending lanes it counted. The model is a
select over this repo's own list (`lab.models`, prd-55 ruling 5) plus
*other…*, which takes a typed name and adds it to the list for the next launch
— a list, never a gate: a name the list does not hold is still legal on the
CLI, and only the server's grammar refuses one. This paragraph replaced the
panel's stated gap the day the fields landed, as that gap said it would. <!-- claim: launch-panel-gap -->

### Refusals you will actually see

| code | when | what the message names |
|---|---|---|
| **400** | arms × runs above the ceiling | the number, whether it was the default or your override, and the exact `ceilingOverride` to pass |
| **400** | `runs` or `ceilingOverride` not a positive integer | which field, and the ruling that made it a field |
| **503** | the lab's CLI lock was held for 30 s | what the holder was doing |
| **409** | the server is replaying a recording | that there is nothing live to fork or measure |
<!-- claim: refusal-table -->

The panel prints the refusal it received verbatim in its own status line;
nothing is softened or summarised on the way. <!-- claim: refusals-verbatim -->

### Empty, failed, and partial — first-class states

Empty states are honest, not blank panels, and a failed read is never conflated
with a successful read of zero rows: *"there are no checkpoints yet — capture
one with `rhizomorph lab checkpoint <lane>`"*, *"there are no experiments yet —
fork a checkpoint with `rhizomorph lab fork <lane>`"*, and on a failed read
*"the lab cannot see its experiments — `<the read's own failure detail>`"*. <!-- claim: empty-states -->

A **partial launch** is a state of its own (prd53 ruling 7): a grouped launch
is n sequential CLI calls with no atomicity, so *arm 2 failed to restore, arms
1 and 3 already spent money* can happen. The panel names the arm that failed
and where dispatch stopped, and reads *k of N requested arms dispatched* with
N the count that was asked for — never rebuilt from what came back; the
comparison surface lists failed arms — the one that failed, and every one
after it that was never attempted — as present and excluded; Metrics books
the spend that was real; the lane canvas draws each one as a
stub — named, and never counted among its ribbons. <!-- claim: partial-launch -->

### The comparison surface

`ComparisonSurface` renders against the live server now (prd53 ruling 3 put
the outcome on the wire, per run). A measure switch — cost, duration, commits,
verified — and a **Scoring** position that is disabled and says why: *Scoring —
no source yet*, because no field in the record holds a score and none is
fabricated. Each arm shows min · median · max over the values its completed runs
have under the measure, stated as *n=k of N completed* — the floor itself never
moves with the measure, and three judged runs with nothing booked say so rather
than showing a `$0` — and every individual run is shown at every n. <!-- claim: comparison-surface -->

For each experiment it computes (never asks you to declare) which dimension
the arms differ on: *no arm varies from the others*, *arms differ in model
only*, *arms differ in brief only*, or the confound sentence above.

### Trace

Trace diffs an arm's transcript against its parent's from the fork point:
same, diverged, added, absent — read from both transcripts on demand, aligned
by content because byte offsets do not survive the path-rewritten copy, and
**stored nowhere**: nothing Trace reads is written back, cached, or persisted. <!-- claim: trace-no-persistence -->

### Metrics

Every figure carries its basis in the DOM beside it — spend per experiment
with the arm floor it was booked against, rates over the window they were
measured in — and a number without a basis is a law failure, not a style
choice. With no experiments it says so in the same words as the experiments
panel. <!-- claim: metrics-basis -->

### The R&D hand

The lab's fourth reading is not a fifth constitutional hand — it is the same
second hand (prd12 ruling 1) reaching a tool the operator already owns, the
same shape as `lab fork --launch` reaching `workmux add`. `rhizomorph lab rd
<lane> --model <m> [--corpus local|local+tracker] [--max-turns n]` and the R&D
control's own *read and propose* button both spawn the operator's own `claude`
in print mode with the corpus in the prompt and no tools granted; the button
reaches `POST /api/lab/rd`, a gated mutation through the same `runCli` seam
every lab write goes through, so there is one implementation of the act
whichever hand invokes it. Nothing under `packages/server/src` reads, stores
or forwards a credential of its own — the operator's CLI is already
authenticated, by the operator, before this instrument ever runs — and
`docs/adr/0048-the-instrument-spawns-the-operators-own-tools-as-an-explicit-act.md`
records the boundary in full (prd-55 ruling 1). Every run's provenance — the
model, the CLI's own cost and duration, the prompt digest, the corpus digest,
`claude --version` — is booked on the `rd.patterns` / `rd.proposal` /
`rd.refused` event it produced and printed beside the control, so the figure a
reader sees is never re-derived from anything but the hand's own report. <!-- claim: rd-explicit-act -->

The binary is resolved on the server's own PATH under the name the operator
declares (`lab.agentCommand`, default `claude`); absent, the control is
disabled and says so, character for character: <!-- claim: rd-no-cli -->

> no claude on this machine's PATH — the R&D hand is your CLI, installed by you <!-- claim: rd-no-cli-quote -->

The control itself is a model select over this repo's own list (`lab.models`,
prd-55 ruling 5 — the same list the launch panel reads), a checkbox for
whether the hand may also read the tracker, and the *read and propose*
button. The hand never runs without a click: no effect posts to
`/api/lab/rd` on mount or on any prop change, only the button's own
`onClick`. <!-- claim: rd-control -->

**The corpus is local first** (prd-55 ruling 2): what the record already
holds — every `fork.measured` verdict, every retro and review this repo's own
`docs/research/` and `docs/review/` carry, and the lab's own past
experiments. Reading closed issues through the operator's own `gh` is a
second, separately declared act — `lab.rdCorpus`, off by default, repo-scoped
in settings — and its use is recorded on the run (`corpus: 'local+tracker'`).
A `gh` read that fails is refused by name rather than silently dropped: the
corpus falls back to what the record already holds and the run says why the
tracker half is missing. The control prints which corpus produced each
pattern beside the pattern, read off the pattern's own source items rather
than the run's own choice, since one pattern can draw on fewer sources than
the run asked for. <!-- claim: rd-corpus -->

**Patterns are grouped by shape, and a single occurrence is held back**
(prd-55 ruling 3): fewer than two source items and the pattern renders
dimmer, with its own count and the reason, never a proposal beside it — <!-- claim: rd-pattern-floor -->

> 1 issue · not yet a pattern — testing a shape that may not recur spends real money <!-- claim: rd-held-back-quote -->

— and when every pattern the hand grouped is held back, the whole list says
so once:

> no pattern recurs — nothing is proposed. <!-- claim: rd-nothing-proposed-quote -->

A repo with nothing to read yet — no retro, no measured experiment — says so
before anything else:

> nothing to read yet — a retro, or a measured experiment, is where a pattern comes from. <!-- claim: rd-no-corpus-quote -->

**A proposal names one pattern, one varying dimension, and 2–3 arms differing
only in that dimension** — model, brief, checkpoint or gate, never two at
once and never a dimension other than the one the proposal declares. Zero
varying dimensions is a replication, not a confound, and passes clean. The
checkpoint pick names its own choice and every checkpoint it considered and
rejected, with the reason. A proposal against a held-back pattern, one
varying more than one dimension, or one varying the wrong dimension is
refused rather than patched — the surface shows the reason and offers the
hand's own raw JSON as a download-free `<details>` beside it, when the
refusal came from the route itself; a refusal this surface catches on its own
defensive re-check says plainly that it was caught here instead, since there
is genuinely no raw text for that case. <!-- claim: rd-patterns -->

**A proposal dispatches through the launch the lab already has** (prd-55
ruling 4): *restore n arms* and *restore and run* open the same launch
review, prefilled with the proposal's own checkpoint and every arm's model,
and carry the proposal's id so the resulting experiment's `fork.dispatched`
record holds `proposalId` durably — not only for the browser session that
launched it. If the operator changes the checkpoint pick before launching,
the launch route itself records `rd.override`, naming both checkpoints, and
the surface says so in the same words every time: <!-- claim: rd-launch-review -->

> operator override — the choice is never re-attributed to the agent <!-- claim: rd-override-quote -->

Once an experiment exists, the panel draws it *against what actually
happened* — the source item's own measured observation, stated as one
observation, never a spread. A retro with no measured figure of its own
reads as text, never a fabricated number:

> no measured baseline — the retro's own words <!-- claim: rd-baseline-quote -->

**The keyboard path**: `↑`/`↓` move the patterns list, `Enter` opens a pattern
or a proposal (a native button's own behaviour — nothing here re-implements
it), `Tab` reaches the proposal panel in DOM order, `Esc` closes the launch
review; the model field is a native `<select>` and no label anywhere is a
`title` attribute. <!-- claim: rd-keyboard -->

**Refusals from `POST /api/lab/rd` itself**: **400** for a malformed body — an
empty lane, a model the grammar refuses, or a corpus other than `local` or
`local+tracker`, each naming the ruling that made it a field; **503** when the
lab's CLI lock could not be taken inside the same 30 s ceiling every other lab
write waits on; **409** on a server that is replaying a session record, where
there is nothing live for the hand to read. <!-- claim: rd-refusals -->

**The hand's cost is not yet booked as `llm.cost`.** Every `rd.*` event
carries the CLI's own `total_cost_usd` on its provenance, and every figure the
R&D control prints is read from that provenance — but `packages/core/src/
events/telemetry.ts`'s `TELEMETRY_SOURCES` still names only `sessionlog` and
`otel`, neither of which is true of a CLI this instrument spawned itself, so
none of it reaches Metrics' own spend figures yet. Stated here rather than
silently left for a reader to notice missing (#430). <!-- claim: rd-cost-gap -->

### The lane canvas

The frame's scene position draws **n ribbons, one per run** (prd53 ruling 5,
prd-55 ruling 11): each dispatch record the fold holds is exactly one ribbon,
keyed by its lane handle, and no count is ever synthesised. The root sits at
the fork's position on the session axis; ribbon width is booked cost on an
absolute scale; the tip's ink is the verdict. It is a Canvas 2D drawing
painted with the scene's own **six pure brushes** — geometry, palette,
ribbon, contour, motes and heart — rather than a second, lesser renderer of
the lab's own: a different picture of a different subject, lawful beside the
scene (charter §8), reading it through those public exports and
never its fold. <!-- claim: canvas-one-per-run -->

## Residuals — with owners, or honestly without (prd53 ruling 10)

- **Five `lab/` files fail on native Windows**, each on
  `.windows-known-failures` with its cause class: line endings (two), the
  `npm.cmd` spawn, drive-letter canonicalisation, and 8.3 temp-directory
  names. **Owner: prd-25's Windows work**, not the lab's paper. <!-- claim: windows-five -->
- **The mid-tool-call cut is unhandled.** A checkpoint captured while the
  parent session is inside a tool call restores a transcript that ends
  mid-call, and the harness may not resume it cleanly. Nothing in the
  restore path looks for a tool-call boundary. **Unowned**, open since the
  fork spike of 2026-08-04; the failure is stated here so nobody discovers it
  as a surprise. <!-- claim: mid-tool-call-unowned -->
- **Every subprocess the fork module spawns is bounded, by a ceiling sized to
  what it waits for** (`packages/server/src/lab/fork.ts`): the git plumbing and
  `workmux path` get 5 s (`FORK_EXEC_TIMEOUT_MS`), because five seconds of a
  plumbing call means wedged; `workmux add` gets 120 s
  (`FORK_LAUNCH_TIMEOUT_MS`), because it runs the new worktree's own configured
  setup — an `npm ci` in this repo — and a five-second ceiling killed every
  launch mid-install; the restore keeps its own longer one. Whether those
  numbers should be configurable, and whether the restore's `install` should
  default to off, are prd-41's *"No owner"* pair, **still unowned**. <!-- claim: fork-exec-ceiling -->

See [`docs/prds/done/prd-14-experiment-console.md`](../prds/done/prd-14-experiment-console.md)
for the order the console's first waves landed in, and
[`docs/prds/done/prd-53-the-lab.md`](../prds/done/prd-53-the-lab.md) for the rulings that
made the comparison real. **#205, the fold-order divergence, is ruled — append
order is the truth** (prd17's amendment of 2026-08-24), and the lab assumes
exactly that resolution and no other.
