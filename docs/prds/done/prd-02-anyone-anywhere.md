# PRD 2 — Anyone, Anywhere

> **Status:** blessed by Lachlan, 2026-07-31. Scope set by three code audits
> answering his four questions and one acceptance test.
> **Outcome:** shipped.

## One-liner

Make the Rhizomorph's numbers mean what they say, make every agent's identity
impossible to confuse, and make a stranger on a fresh machine able to run it by
reading the README and nothing else.

## Why this before more features

prd1's money layer works — on this machine, in this session, with the operator's
knowledge in the room. Audited against a stranger's reality, three of its
foundations do not hold:

- **The totals are not a live gauge.** The sessionlog collector reads every log
  from byte 0 on first sight, so a fresh boot ingests days of history (852M
  tokens observed). Worse, emitted events are stamped with the *poll* clock
  rather than the log line's real time, so that history lands inside the
  five-minute rate window and `$/hr` spikes on boot — and replay compresses the
  past into a single instant. Every restart writes another full copy of history
  into a new session file.
- **Identity collides silently.** `lane` is a bare string used as a map key with
  no host, repo, or instance qualifier: two conductors both called `conductor`
  merge into one row. The OTLP receiver accepts any POST with no auth and no
  repo check, so a second repo on the same box bleeds into whichever Rhizomorph
  is listening. Role is inferred from the literal string `'conductor'`, and
  extra-session conductors are named *positionally*, so reordering flags renames
  lanes. Every git worktree — **including the main one** — is hard-coded
  `role: 'worker'`, so a conductor at the repo root is booked as worker spend.
- **Threads are invisible and branch cost is structurally impossible.**
  `query_source` (main vs subagent) collapses to `worker` and is never stored;
  `isSidechain` sits in the session log unparsed. OTel cost events carry no
  branch or worktree, and sessionlog never emits cost — so the ledger's COST
  column can only ever show tokens.

And the acceptance test fails outright: **the only documented run command,
`npx rhizomorph`, installs an unrelated package of that name from the public
registry.** There is no clone URL, no `engines`, no LICENSE, no CI, no
`build`/`start` script, and no way to diagnose a broken setup.

## Rulings

| Question | Ruling |
|---|---|
| Install target | Clone + one setup command now; publishing is a later prd |
| Session scope | **Current run only**; history opt-in via a backfill flag and replay |
| Environments | WSL **and** Linux/macOS native, both first-class |
| Identity | **Explicit at source, namespaced by instance** — nothing inferred from slugs, paths, or magic strings |
| Restart | **Resume the run** — persist offsets, continue the recent session; no duplicates, no gap |
| Threads | **Sub-rows under the parent lane** — the lane stays the unit of work |

## Scope

**A — numbers that mean something.** Start at end-of-file, backfill only on
request. Carry the source's real timestamp. Resume a run across a restart by
persisting collector offsets. Deduplicate a request seen by two collectors.

**B — identity that cannot collide.** Every run has an instance id; the receiver
records it and refuses or namespaces foreign traffic. Identity is declared at the
source, never inferred. An unidentified repo-root session is `unattributed` and
shown as a setup gap, not silently filed as a worker. Lane × role is queryable.

**C — cost that reaches the rollups; threads that are visible.** Join cost to
branch and worktree so the ledger shows dollars. Parse the thread markers both
collectors already receive, and surface per-thread sub-rows under their lane.

**D — the stranger test.** A run command that exists. `rhizomorph doctor` that
says exactly what is missing. Loud failures instead of silent ones (missing web
build, port in use, non-git directory, all five collectors in the status bar).
A README that starts with `git clone`. No personal paths or names in shipped UI.
CI that clones clean, installs, builds, tests, and boots.

## Non-goals

Publishing to npm (needs a name — the obvious one is taken). The visualization
design study, which moves to prd3: a number nobody can trust is not worth
visualising.

## Definition of demo

A person who has never seen this repo, on a machine that has never run it,
following only the README: reaches a live dashboard whose spend starts at zero,
whose conductor and workers are separately and correctly labelled, and whose
per-branch ledger shows real dollars — with every stumble along the way recorded
and fixed.
