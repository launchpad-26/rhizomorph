# The lab

The lab is the instrument's separate, opt-in second hand — reachable only by
an explicit human act, and there are exactly two of those: your own command
line (`rhizomorph lab ...`), or the Launch panel's button on `/lab`, which
reaches that same CLI in-process through `POST /api/lab/launch`
(`packages/server/src/api/lab.ts`). Never a background poll, and never a
route an always-on process could trigger. prd12 ruling 1's own amended text
settles the button: *a UI button is an explicit human invocation and is
permitted* — what the ruling confines is the lab's **writes**, not which
finger starts them (below). Everything in [watching.md](watching.md) and
[replay.md](replay.md) runs the moment the server starts; the lab does not
run unless you ask it to.

## What it's allowed to write

Refs under `refs/rhizomorph/`, the git objects those refs require, and
worktrees it creates itself under
`~/.local/share/rhizomorph/lab/worktrees/` — a sibling of the recording
directory, never inside the repo you're watching. It never pushes, merges,
or checks out/rewrites a branch that already exists. The one write that
lands outside those namespaces is never silent: pass `lab fork --launch` and
it hands the dispatch off to `workmux add` (the same command that starts
every other worker lane), and only because you typed the flag — or because
you pressed the Launch panel's own button, which passes `--launch` for you,
once, on your say-so. Without either, `fork` says so plainly (see below).

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

## Forking arms

```sh
rhizomorph lab fork <lane> [--at <checkpointId>] [--model <m>] [--prompt-file <f>] [--arms <n>] [--path <dir>] [--launch]
```

Restores `--arms` (default **3** — prd12 ruling 4's floor for a real
comparison) independent worktrees from one checkpoint, each with its own
Claude Code session (the parent's conversation cut at the checkpoint,
digest-verified, every absolute path into the parent worktree rewritten to
the arm's own tree) and, by default, its own `npm install` run
(`--no-audit --no-fund`), so each arm is genuinely ready to work rather than
just restored.

**What the CLI's fork does:** every arm produced by one `lab fork` call
shares the *same* treatment — the same `--model` and the same
`--prompt-file` across all of them. That makes the CLI's fork a rigor tool
for measuring run-to-run variance under one configuration (the reason the
floor is 3, not 1), rather than a way to compare genuinely different
approaches side by side in one experiment.

**Free-form arms landed in the web console, not in this command.** prd14
ruling 2's design — each arm carrying its *own independent* model and brief
inside one experiment, `arm A opus / brief X`, `arm B sonnet / brief Y` — is
what the `/lab` tab's Launch panel already does: one model field and one
brief field per arm row, edited independently, with no shared "experiment
knob" at all (`packages/web/src/lab/launch/LaunchPanel.tsx`, and
`LaunchRequest.arms` carries them per arm over the wire). `lab fork` has not
caught up — it still reads one `--model` and one `--prompt-file` for the
whole call — so mind which hand dispatched an experiment before you read its
comparison.

Without `--launch`, nothing runs — the exact message:

> "No tmux window was opened and no branch was created: prd12 ruling 1
> confines the laboratory's writes to refs/rhizomorph/, its own worktrees
> and its data dir, and 'workmux add' writes outside all three. Pass
> --launch to authorise that yourself."

— followed by the exact command line to run each arm yourself, and a hint
for comparing them once they have.

## Comparing arms

```sh
rhizomorph lab compare <fork-id> [--verify <cmd>] [--no-verify] [--path <dir>]
```

Prints a table — `arm`, `lane`, `treatment`, `verified`, `cost`, `duration`,
`commits` — verified against `--verify` (default `npm test`) in each arm's
worktree, `--no-verify` to skip and report every arm `not-run`. **This is a
table, never a visualization** (prd12 ruling 6).

**What it will tell you, and won't:**

- Below three arms, it refuses to rank at all:
  > `<n> arm(s) — runs only. Ranking needs n >= 3 (prd12 ruling 4: a
  > comparison below three arms reports what happened, never which arm was
  > better).`
- At three or more, it shows a *distribution* — verified count, cost/duration
  spread (min/median/max) — and closes with:
  > "no winner is named: prd12 ruling 4 reports distributions, and the
  > choice stays yours."

There is no "leading arm" marker anywhere in this output, on purpose — a
verdict is exactly what run-to-run variance data cannot support.

## The `/lab` web tab

**Lab** is the third entry in the primary nav, on every surface (see
[watching.md](watching.md#the-primary-nav)) — the one exception being a
loaded recording, where it renders as a disabled entry carrying its reason
(*"unavailable during replay — the lab forks live checkpoints, and this
session is history"*) rather than quietly disappearing. Its own header names
the constitutional limit:

> "forked realities only — checkpoints you captured, and experiments forked
> from them. Never live fleet state."

Three sections, in this order — prd14 wave 5 assembled the earlier waves into
one instrument, so the seam and the route (wave 1), launch (wave 2), the
branching layout (wave 3) and comparison (wave 4) now read together here:

1. **Checkpoints** — every checkpoint this repo has captured, one row each:
   lane, checkpoint id, when it was taken, and who took it.
2. **Launch** — the act itself: three steps, and exactly one of them writes
   anything. Pick a checkpoint from the rows the engine actually holds (never
   a typed-in moment), configure each arm's own model and brief, then review the
   estimate `/api/lab/estimate` returns *with its basis on screen* and press
   the single launch button beside it. There is no second dialog after that
   one — prd14 ruling 4 asks for one confirmation, because forking `n` arms
   multiplies real spend by roughly `n`.
3. **Experiments** — one panel per experiment: the computed dimensions line,
   the branching layout (prd14 ruling 1's trunk-to-arms picture, drawn as SVG,
   each arm running/finished/dead), the arm list with each arm's own
   treatment, and the comparison beneath it.

Empty states are honest, not blank panels — and a failed read is never
conflated with a successful read of zero rows:

> "there are no checkpoints yet — capture one with `rhizomorph lab
> checkpoint <lane>`"
>
> "there are no experiments yet — fork a checkpoint with `rhizomorph lab
> fork <lane>`"
>
> "the lab cannot see its experiments — `<the read's own failure detail>`"

For each experiment it shows, it computes (never asks you to declare) which
dimension the arms differ on, in plain English: *"no arm varies from the
others"*, *"arms differ in model only"*, *"arms differ in brief only"*, or
*"arms differ in model and brief — a difference cannot be attributed to
either."*

**The comparison surface is built and mounted — and never renders against the
real server.** `ComparisonSurface` is wired in for real (prd14 ruling 4's
table/distribution view, reusing prd16's recording machinery) and draws
whenever an arm carries a measured outcome; but `LabExperimentDTO`
(`packages/server/src/api/lab.ts`) has no `outcome` field at all today, so
every arm the live server answers with reads as still running, and every
experiment panel closes with the honest line instead of a comparison:

> "still running — no arm has a measured outcome yet, so there is nothing
> honest to compare"

That is not the adapter papering over a gap — an arm nobody has measured is,
honestly, still running, and
[`packages/web/src/lab/adapters.ts`](../../packages/web/src/lab/adapters.ts)
says exactly that in its own words. What it does mean is practical:
`rhizomorph lab compare` is still the only way to actually see a comparison.
Checkpointing and comparing remain CLI-only *actions*; launching is not, any
more.

See [`docs/prds/prd-14-experiment-console.md`](../prds/prd-14-experiment-console.md)'s wave plan for the
order these landed in, and note what became of the open item this page used
to flag: **#205, the fold-order divergence, is ruled — append order is the
truth** (prd17's amendment of 2026-08-24), and the lab assumes exactly that
resolution and no other.
