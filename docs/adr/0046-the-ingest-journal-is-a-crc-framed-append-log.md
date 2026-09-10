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

### What the writer does with a torn tail

Deciding the tear is half the contract; the other half is what happens next.
**A torn tail is truncated away when the journal is opened for append**, and the
truncation is `fsync`ed before the first record is written. It is not left in
place to be appended past.

Leaving it is the option this repository shipped first, and it is unsafe for a
reason particular to a chained log: the torn record was assigned `lastSeq + 1`
before it was cut off, so the next append is assigned the same `seq` and is
written at the torn record's own offset boundary. The reader then sees a CRC
mismatch with bytes following it, which is the reader's `corrupt` verdict — so a
state ruling 4 calls legal becomes a permanent refusal, the complete records
ahead of the tear stop being readable through the normal path, and the server
cannot boot again. Repairing at open costs nothing that was ever acked, because
a torn record is by construction one no 202 was written for.

The repair is the *writer's*, not the reader's. `readJournal` still reports the
tear and still returns the records before it; the fold reads a torn journal
without changing a byte of it.

## Consequences

- The reader is more code than a `split('\n')`, and it is code that must be
  tested at byte positions rather than at record boundaries. The fault-point
  harness carries that cost.
- Rotation is out of scope for v1 (ruling 4), so a long-lived server's journal
  grows without bound. Recorded here as a known debt, said in
  `packages/team/src/journal/journal.ts` where a reader looks for it.
- The journal file is mutated at open, not only appended to: a torn tail is
  truncated away before the first append. That is the one write to this file
  that is not an append, it is bounded to bytes no ack was ever written for,
  and it is the price of the tear being decidable rather than fatal.
- The format is versioned by its `RZJ1` magic, so a later change is a new magic
  and an explicit refusal rather than a misparse.
- `zlib.crc32` fixes a Node floor. It exists from Node 20.15 / 22.2 and this
  repo's `engines` already requires `>=22.22.2`, so nothing moves.
- A journal written by this build is readable by nothing else. That is intended:
  it is an internal durability buffer, not an export format. The export format
  is the record, and it is unchanged.
