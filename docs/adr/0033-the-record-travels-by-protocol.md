# 0033. The record travels by a versioned protocol, keyed on position — amends ADR-0009

- **Status:** proposed (with prd-51; becomes accepted when prd-51 is blessed)
- **Date:** 2026-09-03
- **Amends:** ADR-0009 (its rejection of option A, "a federation protocol … or a shared database
  both instances read"), and `docs/record-format.md` Law 2 ("Nothing auto-transmits"). ADR-0009's
  chosen option — one portable, hash-chained file — is **not** changed; the chain, the manifest,
  `signature: null` and the verifier all stand.

## Context and Problem Statement

ADR-0009 decided that a session is one self-contained file and that there is no protocol: *"no
protocol, no server-to-server call, no shared database… A record moves the way a screenshot does —
and that is a law, not a limitation."* It gave its reason plainly in the Consequences: *"there is
no upload to secure."* That was 2026-08-06, when the product's central promise was that nothing
leaves the machine.

prd-37 reframed the promise as "nothing leaves the team", prd-48 measured what a team server would
cost and whether a shipper could be lossless, and prd-51 now builds it. Something therefore has to
carry a member's ledger to a server the team runs. The question this record answers is *what* —
and the executed spikes narrow it more than the design brief expected:

- Keying the wire on the event id, the key `mergeRecords` shipped with, silently discarded 74.5 %
  of a real ledger, because event ids restart on session resume
  (`docs/research/2026-08-28-shared-record-s2-shipper.md` §schema defect).
- Shipping the ledger's raw bytes put a field the current schema no longer declares —
  `pane.activity.preview`, real terminal text — on 30,627 wire events and 0 record lines (same
  note, §veil). The record's schema allowlist (ADR-0009 "Clarified by #292") protects the
  *record*, not the wire.
- A record rebuilt from server rows after five kinds of chaos closed to the **identical
  `chainDigest`** as one built from the file — but only because both sides re-serialize through
  the same schema (same note, §crown).

## Considered Options

- **A — Keep 0009 as written; share records by hand.** A team view then exists nowhere, because no
  machine holds the team's facts. This is the status quo prd-37's problem statement names.
- **B — A federation protocol: server-to-server exchange or a shared database both instruments
  read.** 0009's option A. Every instrument becomes a server with an inbound port and a peer list.
- **C — A versioned client→server ingest protocol carrying re-serialized record lines, keyed on
  ledger position, into one team server that owns storage.** The local instrument remains
  outbound-only; the record format is unchanged; the server can re-export any actor's record and
  verify it.
- **D — C, but keyed on event id** (the briefed design) or **carrying raw log bytes** (the first
  spike build).

## Decision Outcome

Chosen: **C**, as executed in prd-48's S2 lineage and bound by prd-51 rulings 3 and 4.

```
POST /v1/rhizomorph/ingest            x-rz-ingest-key: rzk_…
{ protocolVersion: 1, project, actorInstance, batch: [ { n, line } … ] }
202 { accepted, journalSeq }          only after the journal write is durable
```

- **`n` is the 1-based position of the line in the source ledger.** Dedup and ordering key on
  `(project, actorInstance, n)`. The lossless invariant is *no gaps and no duplicates in `n`*.
  Arrival order is not an invariant, because a legitimate gap repair violates it.
- **`line` is the line `buildRecord` would serialize** — re-serialized through the current event
  schema on the shipper, never copied from the log file. This is what makes the server-side
  re-export byte-identical and what keeps a removed field off the wire.
- **The protocol version is on every request**, and a server refuses a version it does not speak,
  by name, with the remedy stated. The protocol must outlive the storage topology beneath it
  (the metamorphosis's fourth proto-law); the version field is how.
- **The ack means the batch is in a durable journal.** Anything less is a lie about durability —
  one 500-line batch per process death, executed. The fold into storage is asynchronous and keyed
  the same way, so a replayed batch is absorbed, never doubled.

**B was rejected** for the reason 0009 gave and one more: a peer list on every instrument is N
inbound ports and N retention policies, and the veil becomes unenforceable once words are on N
disks (the design brief's §3B). **D was rejected by execution**: 74.5 % loss under the id key;
30,627 undeclared-field leaks under raw bytes.

**What 0009 keeps.** The record is still one self-contained file; the chain still covers `line` as
opaque bytes so a compatible emitter with a different schema can reuse the format; `signature` is
still reserved `null`; a record still moves by hand when a human wants it to. What changes is one
sentence — records *also* travel by this protocol, from a member's machine to the team's server,
when that member has enabled the fifth hand (ADR-0034). `docs/record-format.md` Law 2 is amended
in prd-51 wave 1 to say so.

## Consequences

**Good.** The server holds the ledger, not a model of it: `line` is stored verbatim beside the
folded columns, so any actor's stream can be re-exported as a portable record and verified with
the shipped `verifyRecord`. The noticeboard never becomes evidence the ledger did not produce.

**Good.** Losslessness is a property that can be checked, not argued: the local export's digest
equals the server's re-export's digest, or it does not.

**Good.** The veil is a property of the wire, not of the code: the bytes that cross are exactly a
record's body, and a capture can be grepped for what must not be there.

**Bad.** There is now an upload to secure. The security posture moves from "nowhere to put a
credential" to "one credential, bounded" — ADR-0034 carries that argument; this record only names
the cost.

**Bad.** Two machines on different builds re-serialize through different schemas. The server
stores `line` as it arrived and folds what its own schema understands; a line it cannot fold is
kept as an unknown line and folded on the next upgrade. This is the migration seam `upcast()`
used to be, moved to the fold and made rebuildable rather than reintroduced as a parser stage.

**Neutral.** `mergeRecords` (`packages/core/src/record/merge.ts`) remains the merge rule for
records that meet by hand; the server's cross-actor order is the same rule applied to rows.
