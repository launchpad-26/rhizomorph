# 0004. Collectors are pure folds over command output, behind an injected `Exec`

- **Status:** accepted (extended by ADR-0010)
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06. The contract landed 2026-07-30
> (`b635da6`, `845038c`) and states its own rationale in
> `packages/core/src/collector.ts`. Two of the three rejected options are cited;
> the third is marked below as having no evidence either way.

The instrument's facts come from other people's programs: `git`, `tmux`,
`workmux`, an OTel exporter, Claude Code's session logs. Every one of them is an
external process whose output is text, whose availability is not guaranteed, and
whose behaviour varies by version and platform.

The core risk of the whole product is therefore *mis-parsing real-world output*.
Any design that makes that hard to test is the wrong one, however elegant.

## Considered Options

- **A — Filesystem watchers** (inotify / fswatch / chokidar) reacting to change
  events.
- **B — Poll on an interval**, with collectors defined as
  `poll(prevSnapshot, ctx) → {nextSnapshot, events}` — pure logic over command
  *output text*, with the shelling-out pushed behind an injected `Exec`.
- **C — A JavaScript git implementation** (isomorphic-git or similar) instead of
  shelling out to `git`.

## Decision Outcome

Chosen: **B**. Collectors are pure functions over captured text. `Exec` is an
injected argv-only interface, so a test supplies fixture output and no binary
needs to exist.

`collector.ts` states the payoff in its own doc comment: *"That is what lets
collector tests run against captured fixtures with no git, tmux or workmux
present."*

**A was rejected by name, before any code.** prd0's non-goals list reads *"No
filesystem watchers — polling is honest work."* Polling also composes with the
event model: emit only diffs against the previous snapshot, so a quiet fleet
produces no events rather than a stream of no-ops.

A narrower option was also rejected inside the seam: **shell-string exec**.
`Exec` takes an argv array and never a shell string — "no quoting bugs, and
nothing in this app ever needs a shell." That single choice is why the observer
half has no command-injection surface at all.

**C — no evidence.** I searched the history and found nothing suggesting a JS git
library was ever weighed. It is listed here because a reader will wonder, not
because it was rejected. Treat this option as reconstructed, with no recorded
deliberation.

## Consequences

**Good.** Fixture-driven tests are what let five collectors be built in parallel
in a single wave. Every later capability fitted the same seam without changing
it: source-time emission (`64f86a1`), snapshot persistence and resume
(`3573504`, `fd0fe71`), retry and backoff (`f059d9b`).

**Good.** The contract is small enough to state in one line, so adding a seventh
collector is a known quantity: implement `poll`, declare capabilities
(ADR-0010), add fixtures.

**Bad — fixtures are only as representative as what was captured.** The suite
cannot discover output shapes nobody thought to capture. This has already cost
real defects: `git status --porcelain` C-quotes any path containing a space
(#237), and a tab in a tmux pane path throws the parser and kills the collector
(#242). Both are cases the fixtures simply do not contain.

**Bad — the seam has a hole the contract implies but does not enforce.**
`ExecOptions.timeoutMs` exists in the interface and is plumbed into `execFile`,
but **no caller sets it**, so one hung subprocess stalls the whole poll loop
permanently (#236). The contract offered the safety; nothing required it.

**Neutral.** Polling means latency is bounded by the interval (2s) rather than by
the filesystem, and load is proportional to worktree count rather than to change
rate. Both have been acceptable at the scale this runs at.
