# 0001. Read-only observer, amendable only by explicit invocation

- **Status:** accepted (amended by ADR-0001a and ADR-0001b — see Consequences)
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06 from git history and PRD text. The
> decision was made 2026-07-30 (`a14a615`) and amended 2026-08-04 (`017f5ee`) and
> 2026-08-06 (`c3e3e9c`). Decision and rejected alternatives are both cited; no
> part of this record is inferred.

The instrument watches a repo where autonomous agents are working. It reads git
state, tmux panes, workmux state and session logs — all of it belonging to
someone else's live work.

Anything that writes to that repo can corrupt work in flight, and worse, can do
so invisibly: an operator debugging a swarm cannot tell an agent's mistake from
the observatory's. A tool that watches agents has to be trustworthy in exactly
the way the agents are not.

## Considered Options

- **A — Read-only, absolutely and forever.** Never write anything, anywhere.
- **B — Read-only by default, with mutations behind a flag.**
- **C — Read-only over the watched repo, with additional powers granted one at a
  time, each explicitly invoked by a human and each fenced by its own test.**

## Decision Outcome

Chosen: **C**.

The observer never mutates the watched repo. Further powers are granted as
named "hands", and each grant is an amendment on the record, not a loosening:

1. **The observer** (prd0, `a14a615`) — reads only.
2. **The laboratory** (prd12, `017f5ee`) — may create worktrees and refs, but only
   under `refs/rhizomorph/`, only from an explicit CLI invocation, never from a
   collector or a background poll.
3. **The recorder** (prd16, `c3e3e9c`) — writes session logs, but only outside the
   watched repo (see ADR-0005).

**A** was rejected because the fork/checkpoint spike proved a genuinely valuable
capability was reachable, and an absolute ban would have forfeited it for a rule
rather than a reason.

**B** was rejected as the shape that erodes: a flag makes mutation a
configuration detail, so nothing structural stops the next feature adding
another. prd12 ruling 1 states the constraint as *"the read-only constitution is
AMENDED, not dissolved"* — each new power costs a documented amendment.

Two narrower options were rejected inside the amendments. The lab writing into
the watched repo was rejected in favour of `refs/rhizomorph/` plus lab-owned
worktrees. Framing rotation as *new* authority was rejected on the grounds that
prd16 ruling 2 makes explicit: *"the observer has always written its own
recording; what changes is who decides when a recording ends."*

`cb4d133` later rewrote the public claim to *"state the three hands, not one
blanket read-only claim"* — the honest version of a promise that had been
amended twice.

## Consequences

**Good.** The trust story is specific and checkable rather than a slogan. Each
hand ships its own enforcing test: `server/src/lab/namespace-law.test.ts`,
`server/src/recorder/namespace-law.test.ts`, `web/src/drawer/readonly.test.ts`.

**Bad — the enforcement is convention, not structure.** The law tests are
source-text greps, and they are real maintenance load: four commits were needed
to fix path canonicalization in the lab law alone (`1612a14`, `664a286`,
`7a9219d`, `f01a41b`). Worse, a grep cannot see a dynamic import — `api/lab.ts`
reaches the lab through `await import('../cli/index.js')`, and
`walkSourceFiles(SERVER_SRC, [LAB_DIR])` excludes the lab directory from the
walk, so the "sole importer" law passes while the boundary is crossed. Tracked
as issue #245.

**Bad — the amendment outran the fence.** The laboratory is reachable from an
unauthenticated HTTP route (`POST /api/lab/launch`), which is exactly the
"explicitly invoked by a human" condition the amendment was granted under.
Tracked as issue #234.

**Neutral.** Every future capability that wants to write must argue for a fourth
hand in public, which is the intended friction.
