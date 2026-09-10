# 0046. The ingest journal is a CRC-framed two-line append log

- **Status:** proposed (prd-51 ruling 4, recorded on the prd-51 wave-3 ingest build)
- **Date:** 2026-09-09

## Context and Problem Statement

prd-51 ruling 4 makes the ingest 202 mean one thing: the batch is in a durable
journal. The measured alternative — accept fast into memory — lost exactly one
500-line batch when the server died after its 202, and ack-after-`writeSync`+`fsyncSync`
lost none in 75 kills across 1,129,197 lines
(`docs/research/2026-08-29-shared-record-s2-ack-after-journal.md`).

The ruling names the fsync and leaves the format open, and one clause makes the
format a real decision rather than a detail: *"a torn tail on the journal is
legal only at EOF and reads as never-acked; a parse failure anywhere earlier
aborts loudly."* Those are two different verdicts on what a naive reader sees as
one observation — an unreadable record. A format that cannot separate them
cannot implement the ruling.

The journal is also the only durable thing between the HTTP route and the fold
worker, so its bytes are a contract between two subsystems and will outlive both
implementations.

## Considered Options

- **A — plain JSONL, one line per batch.** The repo's own ledger format.
- **B — a two-line frame: an ASCII header carrying `seq`, byte length and CRC-32, then the JSON.**
- **C — a binary length-prefixed record** (varint length, payload, checksum), WAL-style.
- **D — SQLite as the journal.**

## Decision Outcome

Chosen: **B.**

A truncated last line and a corrupted interior line are the same observation
under **A** — a line that will not parse — so A cannot express the ruling's two
verdicts without guessing. The byte length in the header is what makes the tear
decidable: the reader knows exactly where the next record begins, so "the
failure is followed by more bytes" is a fact rather than an inference. The CRC
separates a torn write from a flipped byte, which is the same distinction one
layer down.

**C** decides the same question equally well and loses on inspectability: the
journal is the artefact an operator reads at 3 a.m. after a crash, and `head -2`
on a text frame answers "what was the last thing this server promised" with no
tooling. The repository already pays this cost deliberately for the ledger.

**D** loses on the ruling itself. A second database on the ack path adds a
durability configuration to reason about beside `synchronous_commit`, on the one
path whose whole point is that its guarantee is simple enough to be checked. It
also adds a dependency to a package whose ADR-0043 records `postgres` as the
only one it adds.

**A** additionally loses a smaller thing worth naming: `seq` has to live
somewhere, and in A it lives inside the payload, where a torn write can eat it.

## Consequences

- The reader is more code than a `split('\n')`, and it is code that must be
  tested at byte positions rather than at record boundaries. The fault-point
  harness carries that cost.
- Rotation is out of scope for v1 (ruling 4), so a long-lived server's journal
  grows without bound. Recorded here as a known debt, said in
  `packages/team/src/journal/journal.ts` where a reader looks for it.
- The format is versioned by its `RZJ1` magic, so a later change is a new magic
  and an explicit refusal rather than a misparse.
- `zlib.crc32` fixes a Node floor. It exists from Node 20.15 / 22.2 and this
  repo's `engines` already requires `>=22.22.2`, so nothing moves.
- A journal written by this build is readable by nothing else. That is intended:
  it is an internal durability buffer, not an export format. The export format
  is the record, and it is unchanged.
