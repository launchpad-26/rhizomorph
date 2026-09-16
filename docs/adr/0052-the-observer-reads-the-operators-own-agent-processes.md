# 0052. The observer reads the operator's own agent processes, and never signals one — amends ADR-0001

- **Status:** proposed (prd-57 ruling 1)
- **Date:** 2026-09-15
- **Amends:** [ADR-0001](0001-read-only-observer-as-a-constitution.md). The observer's **scope**
  widens from the watched repo to the operator's own agent processes wherever they run; the
  observer's **restrictions** gain one clause — it never signals a process. ADR-0001's rule that a
  further power is an amendment on the record, not a loosening, is what this record obeys.

## Context and Problem Statement

ADR-0001 chose option C: read-only over the watched repo, with additional powers granted one at a
time as named hands. Every grant since has widened what the instrument may **write**. This one
widens what it may **read**, which that record never had occasion to bound.

The instrument's world model was inherited from its first harness: a lane is a worktree with a
pane, and liveness is the pane's text changing. A developer running an agent in a plain terminal
has no pane, so the instrument sees nothing true about them. The one witness that exists before any
configuration, and regardless of how anything was launched, is the operating system's process
table.

Reading it is looking, not touching — but it is looking at more than a repo. A constitution that
says "read-only over the watched repo" does not license reading a process that is not in it, and
the honest move is to say so and bound it rather than to let a collector quietly do it.

The bounding is not theoretical. `packages/server/src/collectors/sessionlog/process-probe.ts`
already reads `/proc` today for one narrow purpose, and its sibling test already states four laws
over it — read-only with no signal idiom, argv-plus-cwd identity, unknown is never death, other
users invisible. Those laws were written for a probe consulted at a stall. Promoting the process
table to a first-class witness makes them constitutional rather than local.

## Considered Options

- **A — Widen the observer's scope to the operator's own agent processes**, with a signature-only
  law, an argv/env law, and a never-signal law.
- **B — A launcher wrapper** (`rhizomorph run <cmd>`) that captures everything it launches.
- **C — Telemetry only**, no process table: the instrument sees what is configured to tell it.
- **D — Kernel-level tracing** — ptrace, eBPF, loader preloading.

## Decision Outcome

Chosen: **A**.

The observer reads the operator's own processes through the platform's read-only process interface.
It admits a process as an actor **only** when its argv matches a known agent signature; it records
pid, dialect, start time, placement, CPU and RSS deltas, and parentage among matched actors; and it
records **nothing else** — never argv beyond the match, never environment, never a process that is
not a signature match. Placement is derived from the process's working directory, canonicalised by
the primitive in `packages/server/src/paths/containment.ts` before it leaves the collector.

**It never sends a signal of any kind.** Not `kill`, not `SIGSTOP`, and specifically not signal 0 —
the usual POSIX liveness idiom — because that is a call *at* the observed process and a recycled pid
answers it happily. `packages/server/src/collectors/sessionlog/process-probe.ts` states the same
rule in its own words and its test greps the file for the idiom; this record makes that a property
of the instrument rather than of one file.

**B lost** because it demands the user change how they launch, which is the dependency this decision
exists to remove. A wrapper is a workflow to adopt; the process table is already there.

**C lost** because nothing appears before a configuration act, and an un-instrumented harness stays
invisible forever. It also inverts the product's own claim: the instrument would be telling the
operator what they had already told it.

**D lost** without a spike as root-adjacent and the opposite of read-only in spirit. A decision to
trace would be a different constitution, not an amendment to this one.

## Consequences

**Good.** A lane no longer needs a pane. The instrument works in any terminal, and a missing
multiplexer stops being a missing lane.

**Good.** Crash becomes distinguishable from stall. Until now the transcript organ could say a lane
had gone quiet and could not say why; the process table answers the half the transcript cannot see.

**Good.** The signature law is structural rather than advisory. A screenshot listing an operator's
unrelated processes would be a trust incident, and the only defence that survives a future
contributor is one the build enforces.

**Bad.** The trust claim is larger and has to be stated carefully. "Read-only over the repo you
point it at" was easy to explain; "read-only over the repo, plus the agent processes you are
running" is not, and every user-facing sentence that says the former becomes false in the commit
that makes the latter true.

**Bad.** The process interface differs per operating system, and each leg is a source of platform
bugs. This is the least portable thing the repo will have shipped. It is mitigated by the capture
rule — a leg lands behind real captured output, never a man page — and by hooks, which make the
table a confirmation rather than the sole source once a harness is enlisted.

**Bad.** Windows does not expose another process's working directory without native calls into the
target. The Windows leg can match argv and cannot attribute placement, and must declare that gap
rather than guess at it.

**Neutral.** `SECURITY.md`'s "never sends a keystroke" gains a sibling sentence rather than a
correction. The existing hands — laboratory, recorder, concierge, shipper — are unchanged, and this
record grants no new write of any kind.
