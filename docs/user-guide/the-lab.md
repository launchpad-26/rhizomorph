# The lab

The lab is the instrument's separate, opt-in second hand — reachable only
from your own command line (`rhizomorph lab ...`), never from a server
route, a background poll, or (today) a UI button. Everything in
[watching.md](watching.md) and [replay.md](replay.md) runs the moment the
server starts; the lab does not run unless you type the command.

## What it's allowed to write

Refs under `refs/rhizomorph/`, the git objects those refs require, and
worktrees it creates itself under
`~/.local/share/rhizomorph/lab/worktrees/` — a sibling of the recording
directory, never inside the repo you're watching. It never pushes, merges,
or checks out/rewrites a branch that already exists. The one write that
lands outside those namespaces is never silent: pass `lab fork --launch` and
it hands the dispatch off to `workmux add` (the same command that starts
every other worker lane), and only because you typed the flag. Without it,
`fork` says so plainly (see below).

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

**What's landed today:** every arm produced by one `lab fork` call shares
the *same* treatment — the same `--model` and the same `--prompt-file`
across all of them. That makes today's fork a rigor tool for measuring
run-to-run variance under one configuration (the reason the floor is 3, not
1), not yet a way to compare genuinely different approaches side by side in
one experiment.

**What's ruled but not yet landed:** prd14 ruling 2 ("free-form arms") is
the design for each arm carrying its *own independent* model and brief
inside one experiment — `arm A opus / brief X`, `arm B sonnet / brief Y`,
etc. That's explicitly listed as an open, deferred item in
[`docs/prd14.md`](../prd14.md) ("Open, not ruled: Free-form per-arm
variation"), not something the CLI or the web console does yet.

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

A direct-URL route (`/lab`, no nav link from the main dashboard yet — see
[watching.md](watching.md#navigating-away)). **What's landed today (prd14
wave 1 — "the seam and the route"):** read-only listings of what the CLI has
already captured and dispatched — Checkpoints and Experiments, nothing else.
Its own header names the constitutional limit:

> "forked realities only — checkpoints you captured, and experiments forked
> from them. Never live fleet state."

Empty states are honest, not blank panels:

> "there are no checkpoints yet — capture one with `rhizomorph lab
> checkpoint <lane>`"
>
> "there are no experiments yet — fork a checkpoint with `rhizomorph lab
> fork <lane>`"

For each experiment it shows, it computes (never asks you to declare) which
dimension the arms differ on, in plain English: *"no arm varies from the
others"*, *"arms differ in model only"*, *"arms differ in brief only"*, or
*"arms differ in model and brief — a difference cannot be attributed to
either."*

**What's ruled but not yet landed in the web tab:** launching a fork from
the UI (checkpoint selection, arm configuration, and an estimate-and-confirm
dialog — prd14 ruling 4, since forking `n` arms multiplies real spend by
roughly `n`); the branching layout (a trunk-to-arms picture, prd14 ruling 1);
and the comparison surface itself (prd14 ruling 4's table/distribution view,
reusing prd16's recording machinery). All checkpoint/fork/compare *actions*
are CLI-only today. See [`docs/prd14.md`](../prd14.md)'s wave plan for the
order these are ruled to land in, and note its own open item: **#205 (the
fold-order divergence) remains explicitly unruled** — the lab must not be
read as having assumed a resolution to it.
