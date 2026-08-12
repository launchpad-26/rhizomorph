# 0016. A worktree is proven gone by git's own `prunable` flag, not by probing for ENOENT

- **Status:** accepted
- **Date:** 2026-08-12

## Context and Problem Statement

#241: a worktree deleted outside rhizomorph (`rm -rf`, or by hand) keeps
rendering as healthy. The issue as filed assumed `git worktree list
--porcelain` cannot detect a deleted worktree ("git does not verify path
existence for `list`, only for `prune`") and proposed detecting it via ENOENT
on the per-worktree `git status --porcelain` call instead. prd-22 ruling 3
requires the fold to distinguish "gone" from "unchanged" and flags the
honest event shape as needing a decision, speculating it's "likely a new
event type."

## Considered Options

- **A** — Detect ENOENT from the `git status --porcelain` `ExecResult` (the
  issue's own suggested fix) and treat that as proof of absence.
- **B** — Stat the worktree path directly (`node:fs`) from the collector,
  bypassing the `Exec` seam.
- **C** — Trust `git worktree list --porcelain`'s own `prunable` annotation
  (already parsed by `parse-worktrees.ts`, already fetched every poll, no
  extra exec) as the "gone" signal, and skip `git status` entirely for a
  worktree it names.

## Decision Outcome

Chosen: **C**.

Verified against git 2.49.0: once a worktree's directory is deleted
out-of-band, `git worktree list --porcelain` marks it `prunable gitdir file
points to non-existent location` on the very next call — no probe, no delay.
A **locked** worktree (`git worktree lock`) whose directory is deleted stays
`locked` with no `prunable` line at all — exactly the "genuine transient, do
not flap" case ruling 3's rejected alternative (dropping carry-forward
outright) worries about, and git already encodes that distinction.

**A was rejected, and verified wrong by experiment**: a missing `cwd` and a
missing `git` binary raise the identical Node error
(`Error: spawn git ENOENT`, `code: 'ENOENT'`, `path: 'git'`,
`syscall: 'spawn git'`). `ExecResult.errorMessage`/`code` cannot distinguish
them. The issue's own diagnosis of `git worktree list`'s behavior does not
hold against the git version this repo runs; building the fix on ENOENT
would have made "a worktree was deleted" indistinguishable from "git itself
is gone" — the collector's own top-level disabled-latch case.

**B was rejected**: a direct filesystem stat in the collector breaks
ADR-0004's contract (a pure fold over `Exec`'d command text) and cannot be
driven by a fixture in tests — the exact failure mode ADR-0004 exists to
prevent.

No new event type was needed: `worktree.removed` (existing, `{ path }`
payload, unchanged) already means "an entity proven absent is dropped and
its removal is an event." Reusing it for a still-listed-but-`prunable`
worktree required no schema or reducer change, so prd17 ruling 3.2's golden
era corpus (byte-identical fold of real recordings) is untouched.

## Consequences

- **Good.** Zero new exec calls — `prunable` is a field the collector
  already fetches and parses every poll, on the one command it was already
  running.
- **Good.** A locked-but-currently-unreachable worktree (removable media
  unplugged, mid-operation) is not misreported as gone — for free, because
  git's own prunable computation already excludes locked worktrees.
- **Bad.** This relies on a git behavior — `prunable` appearing immediately,
  with no grace period, in `list --porcelain` — that git does not document as
  a stability guarantee. A future git release could add a grace period or
  change when the annotation appears. The collector only reads the boolean,
  never the reason string, which limits but does not eliminate that
  exposure; a git-version compatibility test is not in scope here.
- **Neutral.** A worktree `prunable` for a reason other than "directory
  gone" (e.g. a broken `.git` file with the directory otherwise intact) is
  treated identically to fully gone — indistinguishable to rhizomorph, and
  arguably correct, since git itself would also refuse to treat it as a
  live worktree.
