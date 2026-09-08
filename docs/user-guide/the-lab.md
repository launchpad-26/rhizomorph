# The lab

> **Every behavioural sentence on this page is a test.** The paragraphs below carry
> claim markers (invisible when rendered), and `packages/web/src/lab/the-lab-guide-law.test.ts`
> reads each one and asserts it against the code or the copy it describes — prd-43's
> *the claim is a test*, reaching the lab with prd-53 ruling 9. A sentence here that
> goes false fails the build; a paragraph that names a route, a status code, a flag or
> a ruling without a marker fails it too.

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
Launch panel's (prd14 ruling 2): one model field and one brief field per arm
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
> (prd53 ruling 6)`

Without `--launch`, nothing runs — the exact message: <!-- claim: no-launch-message -->

> "No tmux window was opened and no branch was created: prd12 ruling 1
> confines the laboratory's writes to refs/rhizomorph/, its own worktrees
> and its data dir, and 'workmux add' writes outside all three. Pass
> --launch to authorise that yourself."

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
an arm is summarised only once **3** of its runs have completed, and arms are
ranked only once there are **3** of them. Below the arm floor the CLI refuses to
rank at all and closes with the counterfactual clause — *what actually happened
is one observation, not a distribution*: <!-- claim: floors -->

> `<n> arm(s) — runs only. Ranking needs n >= 3 (prd12 ruling 4: a comparison
> below three arms reports what happened, never which arm was better).
> what actually happened is one observation, not a distribution.`

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

Six sections, in this order (prd53 rulings 4, 5, 7 and 8; the specification is
`docs/prds/prd-53-the-lab.md` and its companion artifact):

1. **The session axis** — the lab's own view of time: every checkpoint placed
   as a percentage of its session, computed from the checkpoint's cut byte
   over the transcript's length by exactly one function
   (`packages/web/src/lab/axis/position.ts`), which every surface that places a
   moment shares. A checkpoint whose length is unknown is drawn at the inset
   and named degraded. Seat a checkpoint and the frame below reads from it. <!-- claim: axis-one-function -->
2. **The frame** — one switch over five ways of looking at the seated moment:
   telemetry, cost, scene, divergence, footprint (keys 1–5). Telemetry and
   footprint have no lab route to read yet and **state that gap** in place
   rather than drawing a series from nothing. The scene position is the lane
   canvas (below). <!-- claim: frame-five -->
3. **Checkpoints** — every checkpoint this repo has captured, one row each.
4. **Launch** — the act itself: pick a checkpoint from the rows the engine
   actually holds, configure each arm's own model and brief, read the
   estimate, press the one button. There is no second dialog after that one
   (prd14 ruling 4 asks for one confirmation). <!-- claim: launch-one-confirmation -->
5. **Experiments** — one panel per experiment: the branching picture, the
   comparison surface, and Trace.
6. **Metrics** — spend and outcome across experiments, every figure with its
   basis beside it.

### The estimate and its basis

Before the button, the panel reads `/api/lab/estimate` and shows the number
*with its basis on screen*: the forked lane's own cost rate over the last
**hour**, multiplied by the spending lanes the launch would create (arms ×
runs — one lane is assumed to run about as long as the window the rate was
measured over). When the lane has no rate yet the panel says the rate cannot
be established, with the reason, and never shows a figure. <!-- claim: estimate-basis -->

**The panel's own gap, stated:** the Launch panel launches one run per arm
and sends no ceiling override today. Multi-run experiments and declared
overrides are the CLI's until the panel grows those two fields; when it does,
this sentence fails its test and is rewritten. <!-- claim: launch-panel-gap -->

### Refusals you will actually see

| code | when | what the message names |
|---|---|---|
| **400** | arms × runs above the ceiling | the number, whether it was the default or your override, and the exact `ceilingOverride` to pass |
| **400** | `runs` or `ceilingOverride` not a positive integer | which field, and the ruling that made it a field |
| **503** | the lab's CLI lock was held for 30 s | what the holder was doing |
| **409** | the server is replaying a recording | that there is nothing live to fork or measure |

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
and where dispatch stopped; the comparison surface lists failed arms as
present and excluded; Metrics books the spend that was real; the lane canvas
draws each one as a stub — named, and never counted as an organism. <!-- claim: partial-launch -->

### The comparison surface

`ComparisonSurface` renders against the live server now (prd53 ruling 3 put
the outcome on the wire, per run). A measure switch — cost, duration, commits,
verified — and a **Scoring** position that is disabled and says why: *Scoring —
no source yet*, because no field in the record holds a score and none is
fabricated. Each arm shows min · median · max over its completed runs, and
every individual run is shown at every n. <!-- claim: comparison-surface -->

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

### The lane canvas

The frame's scene position draws **n organisms, one per run** (prd53 ruling
5): each dispatch record the fold holds is exactly one organism, keyed by its
lane handle, and no count is ever synthesised. The root sits at the fork's
position on the session axis; thread width is booked cost on an absolute
scale; the node's ink is the verdict. This is a different surface from the
scene's own renderer, lawful beside it (charter §8), and it reads the scene's
palette only through public exports. <!-- claim: canvas-one-per-run -->

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
- **Every subprocess the fork module spawns is bounded at 5 s**
  (`FORK_EXEC_TIMEOUT_MS`, `packages/server/src/lab/fork.ts`) except the
  install, which carries its own longer ceiling; whether that number should
  be configurable, and whether the restore's `install` should default to off,
  are prd-41's *"No owner"* pair, **still unowned**. <!-- claim: fork-exec-ceiling -->

See [`docs/prds/prd-14-experiment-console.md`](../prds/prd-14-experiment-console.md)
for the order the console's first waves landed in, and
[`docs/prds/prd-53-the-lab.md`](../prds/prd-53-the-lab.md) for the rulings that
made the comparison real. **#205, the fold-order divergence, is ruled — append
order is the truth** (prd17's amendment of 2026-08-24), and the lab assumes
exactly that resolution and no other.
