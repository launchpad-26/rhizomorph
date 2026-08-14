# 0009. A session is one portable, hash-chained file — and there is no protocol

- **Status:** accepted
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06. Landed 2026-08-04 (`49904bc`,
> `635fcd6`, `6b106ba`). All three rejected options are cited from
> `docs/record-format.md`.

A recorded session should be shareable — with a teammate, with a cohort, with
someone debugging a swarm they did not run. "Shareable" is where observability
tools usually grow a server: an account, an upload endpoint, a retention policy.

That direction is closed here by ADR-0001 and by the product's central promise
that nothing leaves the machine. The question is what shareability can mean
without any of it.

## Considered Options

- **A — A federation protocol**: server-to-server exchange, or a shared database
  both instances read.
- **B — One self-contained file** carrying everything needed to verify and
  replay it, moved by whatever means the user already has.
- **C — B, but omit the signature field** until signing is actually built.

## Decision Outcome

Chosen: **B**. A record is a single JSON file containing the session's events
verbatim, chained by SHA-256: each entry's digest covers the previous digest and
the raw line, with a genesis digest binding the chain to `schemaVersion`,
`repoSlug` and `actor.instance`.

**A was rejected by name**, and `docs/record-format.md` states it as a
constraint rather than a limitation: *"no protocol, no server-to-server call, no
shared database… A record moves the way a screenshot does — and that is a law,
not a limitation."*

**C was rejected** in favour of reserving `signature` as `null` today, so that
signing can be added without a breaking schema migration. The reservation is
strict: a reader MUST treat a non-null `signature` as a parse *failure*, not an
unknown field to skip — a stranger's emitter claiming a signature format this
reader does not understand is an integrity-relevant fact, not a cosmetic one.

A third option was rejected in the chain's construction: **re-serializing each
line**. The chain covers the line's *verbatim* bytes, so it works over opaque
text and a foreign event schema can reuse the format without this reader
understanding its payloads.

## Consequences

**Good.** A record verifies anywhere, including in a browser, because `core` has
no host dependencies (ADR-0003). Verification is a pure function over bytes.

**Good.** The format is honest about what the chain proves: nothing was altered
or reordered *since the emitter wrote it*. It does not prove who wrote it — that
is what `signature` is reserved for, and the doc says so rather than implying
more.

**Bad — it exposed that "portable" was not true yet.** A record that resolved
conversations live from `~/.claude/projects` at replay time was not portable at
all. prd16's transcript capture (`9162ea8`) exists because this decision made the
gap visible.

**Bad — the record is not the whole dashboard.** Three surfaces read state the
event log never sees (`/api/lanes`, `/api/transcript/:lane`, OTel attribution),
so a record replays the fold faithfully but not every panel. Replay reports
`available: false` for those honestly — see ADR-0002's consequences.

**Neutral.** Sharing is a file transfer, so the security model is whatever the
user's file transfer is. That is deliberate: there is no upload to secure.

## Clarified by #292

The text above is left as decided. #292 supersedes **one** aspect of it: the
description of a record as containing the session's events *verbatim*, and the
rejection of "re-serializing each line". The emitter does now re-serialize, but
not where this note first claimed. The parsing happens *upstream of* the record
builder, on the export paths: `parseJsonl` in `packages/core/src/jsonl.ts` on
the CLI path, and `parseEventLenient` in `packages/web/src/replay/api.ts` on the
web path, each running every log line through the *current* event schema before
`buildRecord` is called. `buildRecord` itself
(`packages/core/src/record/build.ts:58`) serializes the validated events it is
handed — it parses nothing. So a record's body is built from parsed events
rather than copied out of the log file's bytes. The consequence is deliberate:
parsing drops keys the schema does not declare, so the schema acts as an
allowlist at build time, which is what lets a field the schema no longer
declares — `pane.activity.preview`, removed by #292 — be stripped out of a
record built from a pre-change log.

What this note does **not** overturn is the reason the chain was built over
opaque bytes. Each link's digest still covers `line` as text this reader need
not understand, so a compatible emitter with a different event schema can reuse
the record format unchanged. That property survives, and both halves are stated
in [docs/record-format.md](../record-format.md), in two different places: what
a record is *filtered by* is Law 3, and what the chain is *over* — `line` as
opaque bytes, whatever an emitter puts there — is the "How `line` is produced"
subsection under `body`. Records already written are never rewritten; they keep,
and verify against, the lines they were built with.
