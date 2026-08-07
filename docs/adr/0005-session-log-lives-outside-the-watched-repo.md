# 0005. The session log lives outside the watched repo, and evidence is never edited in place

- **Status:** accepted
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06. Blessed 2026-07-30 (`9d32c5b`) in the
> pre-code architecture pass; the sidecar half landed 2026-08-04 (`ab28c2e`).
> Both rejected options are cited verbatim.

The instrument produces a durable artefact — an append-only JSONL log of
everything it observed. That log has to live somewhere, and the obvious place is
next to the thing it describes: a directory inside the watched repo, gitignored.

Two things make that obvious place wrong. The repo belongs to someone else's
work (ADR-0001), and a log stored inside a repo full of autonomous agents is a
log those agents can edit.

## Considered Options

- **A — A gitignored directory inside the watched repo**, e.g.
  `<repo>/.rhizomorph/`.
- **B — A user-level data directory**, `~/.local/share/rhizomorph/<repo-slug>/`.
- **C — B for the log, but store mutable metadata (a session's label) as a field
  inside the log itself.**

## Decision Outcome

Chosen: **B**, with a sidecar for mutable metadata.

Logs are written to `~/.local/share/rhizomorph/<repo-slug>/session-<ts>.jsonl`.
A session's operator-assigned label lives beside it in
`session-<id>.label.json`, not inside the log.

**A was rejected explicitly**, and the reasoning is quoted in
`architecture.md:60`: *"The read-only promise means we don't even add a
gitignored directory to the target repo."* The blessed decisions log records the
trade in the same breath — *"purist read-only, slightly less discoverable"* —
which is the honest version: this costs discoverability and buys an unqualified
promise.

**C was rejected** for a different reason, recorded when the sidecar landed: a
label is mutable, and the log is evidence. Putting an editable field inside an
append-only record would mean *"evidence that can be edited after the fact isn't
evidence."* The sidecar keeps the mutable thing mutable and the immutable thing
immutable.

## Consequences

**Good.** The read-only promise needs no asterisk. Nothing the instrument does
appears in the watched repo's working tree, its `.gitignore`, or its status
output — which also means the instrument never shows up in its own collision
matrix.

**Good.** Logs survive the worktree. A lane can be removed, a branch deleted, a
worktree pruned, and the record of what happened there is untouched.

**Bad — discoverability, as recorded at the time.** A user who wants to find
their logs must know about `~/.local/share/rhizomorph/`. Nothing in the repo
points at them.

**Bad — the log path is now a second thing that must be canonicalized.** The
lab's containment law compares paths against this root, and macOS resolves
`/var` → `/private/var`, which produced a bug fixed four separate times
(`1612a14`, `664a286`, `7a9219d`, `f01a41b`).

**Neutral.** `<repo-slug>` derivation becomes a compatibility surface: it must
match how Claude Code slugs the same path, and it currently does not — the `.`
→ `-` mapping is missing, so a dotted worktree path silently resolves to a
nonexistent directory (#243).
