# 0013. Every collector tick is bounded: a default exec timeout and a loop-level watchdog

- **Status:** accepted
- **Date:** 2026-08-10

## Context and Problem Statement

ADR-0004 gave collectors an injected `Exec` and noted, in its own Consequences,
a hole it did not close: `ExecOptions.timeoutMs` was plumbed into `execFile` but
no caller ever set it (#236). Combined with the poll loop's single-in-flight gate
(`tick()` returns the running promise) and its sequential `await` of every
collector, one wedged subprocess — a credential prompt, a `.git/index.lock` held
by a concurrent `git gc`, a hung `tmux capture-pane` — stalls *every* collector
permanently, and `stop()` awaiting the in-flight tick hangs graceful shutdown too.

A default `execFile` timeout alone does not close it: `execFile`'s timeout fires
only for a real child and only sends SIGTERM, and neither a JS-level hang nor a
stub `Exec` that never resolves goes through `execFile` at all.

## Considered Options

- **A — Default `execFile` timeout only.** Set a `timeoutMs` on collector exec.
- **B — Default exec timeout *and* a loop-level per-collector watchdog** that
  races each `poll` against a JS budget and abandons it on expiry.
- **C — Run collectors concurrently** so a slow one cannot block the others.
- **D — Fold timeouts into `withResilience`** so N timeouts disable + back off.

## Decision Outcome

Chosen: **B**. The watchdog is a JS race in `createPollLoop`, so it is independent
of child behaviour and covers every collector (including the raw `sessionlog` one
that `withResilience` does not wrap); the default exec ceiling is the belt that
reaps the real child. A per-collector in-flight guard skips a still-wedged
collector on later ticks, so the others poll at full speed and the error is
surfaced once per episode.

**A lost** because it cannot abandon a JS-level hang or the mandated
never-resolving stub, cannot stop a SIGTERM-ignoring child, and does not bound
the loop or `stop()`. **C lost** for now: it is a larger change to event ordering
and does not by itself bound a wedged poll or fix `stop()` — the watchdog would
still be required; kept as a non-goal. **D lost** as the primary mechanism:
`withResilience` detects failure via a `collector.disabled` event in the
*returned* result, which a never-returning poll cannot produce, and it wraps only
four of the collectors; escalating repeated timeouts into its
degrade→disable→backoff ladder is a coherent follow-up, not this decision.

## Consequences

- **Good.** One wedged child can no longer freeze the other collectors; `stop()`
  always completes; real hung children are reaped by the exec ceiling.
- **Good.** A timeout is a visible `collector.error`, not silence.
- **Bad.** A permanently-wedged collector re-errors on each fresh episode without
  backing off (no escalation to `collector.disabled` yet — option D, deferred).
- **Bad.** A legitimately slow tick on a very large worktree set could hit the
  tick budget; the value is chosen to avoid this at this tool's scale and is
  revisitable (see `docs/design-notes/collector-tick-budget.md`).
- **Neutral.** Two tunable constants and two injectable loop options added.
