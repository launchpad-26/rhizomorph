# The portable session record — federation wire format

> prd11 Keystone B (rulings 3–4). This document is the spec: everything a
> stranger needs to write an independent, compatible emitter or reader,
> without reading this repo's source. Background and motivation:
> `docs/prds/done/prd-11-causal-record.md`.

## What this is

A **session record** is one JSON file that carries a whole Rhizomorph
session — the same event log a live dashboard folds — plus enough identity
and integrity metadata that it can be handed to a stranger, on a different
machine, and replayed with confidence that nothing in it was altered after
the fact.

It is deliberately the *only* artifact prd11's federation story needs: no
protocol, no server-to-server call, no shared database. A record moves the
way a screenshot does — copied, emailed, committed to a wiki page, whatever a
human chooses — and that is a law, not a limitation (see "Laws" below).

## Top-level shape

```jsonc
{
  "manifest": { /* Manifest, below */ },
  "body": [ /* RecordLink[], below */ ]
}
```

Nothing else is present at the top level. A reader encountering unknown
top-level keys should ignore them (forward-compatible), but MUST NOT infer
meaning from them — they are not part of this schema.

## `manifest`

| Field          | Type                | Meaning |
|----------------|---------------------|---------|
| `schemaVersion`| positive integer    | `1` today. A future incompatible revision bumps this; a reader that doesn't understand a version should refuse, not guess. |
| `repoSlug`     | non-empty string    | Identifies the repo this session watched — the join key `mergeRecords` refuses across. Opaque to a stranger's emitter: use whatever stable identifier your own tooling derives (this codebase's own emitter uses a sanitized repo basename plus a short hash of its absolute path — see `packages/server/src/log/paths.ts`'s `repoSlug`). |
| `actor`        | `Actor` object      | Who recorded this. See below. |
| `startTs`      | integer, epoch ms   | The earliest event's timestamp in `body`. |
| `endTs`        | integer, epoch ms   | The latest event's timestamp in `body`. |
| `eventCount`   | non-negative integer| `body.length`. |
| `chainDigest`  | 64-char lowercase hex| Where the body's hash chain closes. See "The hash chain". |
| `signature`    | `null`               | **Reserved.** Always `null` today. Key infrastructure (who may sign, how a reader verifies a signature, key distribution) is explicit future work — this field exists now so a signed record never needs a breaking schema migration to grow one. A reader MUST treat any non-null value here as a parse failure, not an unknown field to skip, since a stranger's emitter claiming a signature format this reader doesn't understand is a integrity-relevant fact, not cosmetic. |

### `Actor`

```jsonc
{
  "instance": "1770000000000",
  "handle": "alice",
  "declared": true
}
```

| Field      | Type            | Meaning |
|------------|-----------------|---------|
| `instance` | non-empty string| The identity of the *process* that recorded this — stable for the life of one session, unique enough that two different actors' records for the same repo never collide on it. This codebase's own emitter uses its server session id (the same id `/api/meta` publishes, and the join key `mergeRecords` dedupes events on alongside each event's own id). |
| `handle`   | non-empty string| A human-readable display name for the actor. |
| `declared` | boolean         | `true` when a human explicitly supplied `handle` (e.g. `rhizomorph export-record --handle alice`); `false` when it is just a default (this codebase's emitter defaults to the OS username) that nobody vouched for. A reader rendering actor identity should treat `declared: false` as "best guess," not a claim. |

## `body`

An array of **links**, one per event-log line, in the order the log was
appended:

```jsonc
{
  "line": "{\"id\":\"evt-000001\",\"ts\":1770000000000,\"source\":\"system\",\"type\":\"session.started\",\"payload\":{...}}",
  "prevHash": "fe6e549e50125ffcb96e3c040b3ffa8b88a54f32ac79d8d6b32cbd7c719b73eb",
  "hash": "49efbc4aee9c4d71666cca169fd8f1a97e5c2e21690e869a8c6d19801f418d7c"
}
```

| Field      | Type                  | Meaning |
|------------|-----------------------|---------|
| `line`     | string                | One event's text. The format constrains nothing about its shape: the chain hashes it as **opaque bytes**, so any emitter may produce it however it likes. Rhizomorph's own CLI and web emitters re-serialize it from the parsed event rather than copying the log file's bytes — see "How `line` is produced", below. |
| `prevHash` | 64-char lowercase hex | The previous link's `hash`, or the chain's **genesis** digest for the first line (`body[0]`). |
| `hash`     | 64-char lowercase hex | `sha256hex(prevHash + line)` — see below. |

An empty session (`eventCount: 0`) has `body: []` and `chainDigest` equal to
the bare genesis digest (no links to chain).

### How `line` is produced

This codebase's emitter parses each log line through the event schema on its
**read** path, before a record is built: `parseJsonl`
(`packages/core/src/jsonl.ts`) when exporting from the CLI, `parseEventLenient`
(`packages/web/src/replay/api.ts`) when exporting from the browser. The record
builder itself (`packages/core/src/record/build.ts`) parses nothing — it
serializes the validated events it is handed, with the same serializer the
session log uses. For a line the current schema wrote, the log's text and the
re-serialized text are the same; for an older line carrying a field the schema
no longer declares, they are not, because parsing drops undeclared keys — so
the schema acts as an allowlist on the way into a new record (see "Laws").
Records already on disk are never rewritten: they keep, and verify against, the
lines they were built with.

None of that is required of *your* emitter. In this codebase, one line is one
JSON object matching the envelope `{ id, ts, source, type, payload }` (see
`docs/architecture.md`), but this format does not require that shape — the hash
chain covers `line` as opaque text, so a compatible emitter for a different
event schema can reuse this exact record format unchanged.

## The hash chain

All hashing is **SHA-256** (FIPS 180-4) over UTF-8 bytes, rendered as a
64-character lowercase hex string. There is no salt, no HMAC key, no
signature yet (see `signature` above) — this chain proves *nothing was
altered after export*, not *who* produced it (that's what the reserved
`signature` field is for, once it exists).

**Genesis.** The chain's starting digest binds it to this record's identity,
so tampering with `schemaVersion`, `repoSlug`, or `actor.instance` invalidates
the chain even if every line is byte-for-byte untouched:

```
genesis = sha256hex(`rhizomorph-record:${schemaVersion}:${repoSlug}:${actor.instance}`)
```

(The literal string is `rhizomorph-record:1:repoSlug-value:instance-value`,
colon-joined, no extra whitespace.)

**Each link**, in order:

```
link[0].prevHash = genesis
link[i].prevHash = link[i-1].hash              (i > 0)
link[i].hash      = sha256hex(link[i].prevHash + link[i].line)
```

String concatenation, not JSON — `prevHash` and `line` are joined as plain
text before hashing.

**Closing the chain.** `manifest.chainDigest` equals `link[n-1].hash` (the
last link's hash), or `genesis` itself when `body` is empty.

### Verifying a record

A reader should:

1. Recompute `genesis` from the manifest's own `schemaVersion`/`repoSlug`/
   `actor.instance`.
2. Walk `body` in order, recomputing each `prevHash` and `hash` as above and
   comparing against what's stored. The **first** link where either check
   fails is where the chain broke — name it (1-based line number) in any
   error surfaced to a human, rather than a generic "invalid record."
3. Confirm the final computed hash equals `manifest.chainDigest`.
4. Only once the chain is intact: parse every `line` **leniently**, not
   strictly. A line matching a known event type and shape folds into a real
   event. A line whose envelope (`id`/`ts`/`source`/`type`) parses but whose
   `type` this era has never heard of, or whose payload shape a later era
   widened, is **counted and preserved verbatim, not folded** — this is an
   *unknown*, not a failure: the chain already proved that byte-for-byte
   text is untouched, and refusing the whole record over one line from a
   newer era would throw away everything else it carries. Only a line with
   no usable envelope at all — not JSON, or missing a `ts` — is a hard
   failure: the chain vouching for that means the emitter wrote garbage, not
   a later era.

   Then confirm `manifest.eventCount === body.length` and
   `manifest.startTs`/`endTs` match the minimum/maximum timestamp across
   *both* folded events and preserved unknowns — an unknown's `ts` still
   counts toward the range, since leaving it out would make an honest
   manifest look tampered with. These three fields aren't covered by the
   hash chain itself (the chain's genesis only binds
   `schemaVersion`/`repoSlug`/`actor.instance`), so this second pass is what
   catches a manifest edited to lie about them without touching a single
   body line.

**What a successful verify promises, and what it doesn't.** `{ ok: true }`
means the chain is intact and every line in `body` is at least a
recognizable event envelope — it does **not** mean every line was
understood. A record can verify successfully and still carry lines from an
era this reader has never seen: integrity and comprehension are different
questions, and this format's chain answers only the first. A verifying
reader should surface that gap rather than stay silent about it — the count
of unknown lines and the distinct `type` values seen is enough for a human
to know a newer instrument wrote lines this reader can't fold. What still
fails outright: a broken hash chain, a line with no usable event envelope at
all, or a manifest whose `eventCount`/`startTs`/`endTs` don't match the
body.

This repo's implementation (`packages/core/src/record/verify.ts`) returns
`{ ok: true }` — with optional `unknown`/`unknownVoice` fields present only
when the body held lines it could not fold, absent when there were none —
or one of three discriminated failures (`chain-broken`, `malformed-line`,
`manifest-mismatch`) naming where it broke; a from-scratch reader only
needs to reproduce the passes above, not that exact return shape.

## Worked example

Two events, SHA-256 by hand-verifiable tooling (`sha256sum`, `openssl dgst
-sha256`, any language's standard library):

```jsonc
// events, in order
{"id":"evt-000001","ts":1770000000000,"source":"system","type":"session.started","payload":{"sessionId":"1770000000000","repoPath":"/home/alice/rhizomorph","repoName":"rhizomorph"}}
{"id":"evt-000002","ts":1770000001000,"source":"workmux","type":"agent.status","payload":{"handle":"12-auth","status":"working"}}
```

With `repoSlug = "rhizomorph-a1b2c3d4"` and
`actor = { instance: "1770000000000", handle: "alice", declared: true }`:

```
genesis = sha256hex("rhizomorph-record:1:rhizomorph-a1b2c3d4:1770000000000")
        = fe6e549e50125ffcb96e3c040b3ffa8b88a54f32ac79d8d6b32cbd7c719b73eb
```

The full record:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "repoSlug": "rhizomorph-a1b2c3d4",
    "actor": { "instance": "1770000000000", "handle": "alice", "declared": true },
    "startTs": 1770000000000,
    "endTs": 1770000001000,
    "eventCount": 2,
    "chainDigest": "779bed2ccbe4a2b4297a153445d660c088a016a31258d9ff7703aed3d57c1eba",
    "signature": null
  },
  "body": [
    {
      "line": "{\"id\":\"evt-000001\",\"ts\":1770000000000,\"source\":\"system\",\"type\":\"session.started\",\"payload\":{\"sessionId\":\"1770000000000\",\"repoPath\":\"/home/alice/rhizomorph\",\"repoName\":\"rhizomorph\"}}",
      "prevHash": "fe6e549e50125ffcb96e3c040b3ffa8b88a54f32ac79d8d6b32cbd7c719b73eb",
      "hash": "49efbc4aee9c4d71666cca169fd8f1a97e5c2e21690e869a8c6d19801f418d7c"
    },
    {
      "line": "{\"id\":\"evt-000002\",\"ts\":1770000001000,\"source\":\"workmux\",\"type\":\"agent.status\",\"payload\":{\"handle\":\"12-auth\",\"status\":\"working\"}}",
      "prevHash": "49efbc4aee9c4d71666cca169fd8f1a97e5c2e21690e869a8c6d19801f418d7c",
      "hash": "779bed2ccbe4a2b4297a153445d660c088a016a31258d9ff7703aed3d57c1eba"
    }
  ]
}
```

Flip a single character anywhere in either `line` (without also updating its
`hash`) and step 2 above fails at that link — try it.

## Merging two actors' records

Two records for the *same* `repoSlug` — recorded by two different actors, or
the same actor's overlapping re-exports — can be folded into one coherent,
replayable event stream:

- **Refuse across repos.** Different `manifest.repoSlug` values is an honest
  error, never a best-effort guess at reconciling unrelated histories.
- **Dedup by `(link.hash, actor.instance)` — the chain link, not the event.**
  An event id identifies nothing on its own *and nothing in a pair either*: the
  id counter is per-run and restarts when a session resumes, so one actor's own
  log repeats `evt-000001` (fifteen times, in the ledger prd-48's shipper spike
  measured). A chain link cannot collide that way, because its hash covers the
  line's content **and** its position in the chain — two distinct events are two
  distinct links even when every field matches, and the same event re-exported
  from the same start is the same link.

  This is a **correction**, not a restatement. Until #173 this section said the
  key was `(actor.instance, event.id)` "because an event id is only ever unique
  within one actor's own log". The first half was right and the parenthetical
  was wrong, and a reader implementing the documented rule would have built a
  merge that silently discarded real events — 74.5% of one measured ledger.

  The cost of keying on the chain: two exports of the same actor that begin at
  **different first events** are different chains from their genesis on, so
  their overlap does not dedup. An export beginning mid-log is a different
  artifact, and calling its events the same ones is precisely the guess the old
  key was making.

  Unknown lines (from a newer era this reader cannot fold) dedup by the same
  rule. A link exists whether or not the line parses, so they need no exemption.
- **Order per-actor append-only, cross-actor by timestamp with `actor.instance`
  as the tiebreak.** Concretely: repeatedly take whichever of the two
  streams' next unconsumed event has the earlier `ts` (comparing
  `actor.instance` lexicographically on a tie), but never reorder two events
  that came from the *same* actor relative to each other — even if that
  actor's own timestamps aren't perfectly monotonic (collectors can report
  a source's own clock, and a tail line can occasionally be older than the
  line above it).

This repo's reference implementation is
`packages/core/src/record/merge.ts`'s `mergeRecords`; a merge does not mint a
new hash-chained record (a chain is one actor's own artifact — merging two
would require signing over events neither actor actually produced), so its
output keeps both source manifests for provenance rather than fabricating a
third.

## Producing and consuming a record with this CLI

```sh
# Write a portable record for the most recently recorded session:
rhizomorph export-record [path] [--session <id>] [--out <file>] [--handle <name>] [--force]

# Verify + serve one, read-only, through the normal dashboard:
rhizomorph replay <record-file> [--port <n>]
```

`export-record` writes the artifact **outside** the watched repo — by
default alongside that repo's own session logs, named
`<repo-slug>-<session-id>.rhizorecord.json`. An explicit `--out` that
already exists is refused unless `--force` is passed (a directory there is
refused outright — `--force` cannot help); the flagless default path is
regenerable and always refreshes, so `--force` without `--out` only earns a
warning. `replay` verifies the chain
first and refuses loudly (exit code 1, no server started) if it's broken,
then boots the same dashboard the live command uses, pointed at the record's
own events instead of a watched repo — a foreign actor's record renders its
lanes, its spend, and its traces exactly as a local recording would, because
it is folded by the very same reducer.

## Laws

These aren't implementation details — they're the contract a compatible
emitter or reader must also honor:

1. **Read-only, both directions.** Exporting a record never touches the
   watched repo (it can only be written *outside* it); replaying a record
   never executes anything — no collector runs, nothing is written back into
   the record file itself.
2. **Nothing auto-transmits.** A record moves from one machine to another
   only by a human's hand — there is no push, no server-to-server exchange,
   no background sync. This format's whole design (one self-contained file)
   exists so that stays true by construction.
3. **A record is never enriched.** Nothing reaches a record that the log did
   not already contain — no lookups, no re-reading of the repo, no facts
   added at export time. That is all this law requires of a compatible
   emitter; how it produces each `line` is its own business.

   **How Rhizomorph's own emitters go further**, which anyone sharing a
   record written by *this* tool should know: a record is not a byte copy of
   the log either. The CLI and web export paths parse each line through the
   *current* event schema and re-serialize the validated event (see "How
   `line` is produced"), so that schema is an allowlist applied at build
   time. A field the schema no longer declares (e.g. `pane.activity.preview`,
   removed by #292) cannot ride an old log line into a new record. Records
   already written are not rewritten — they keep, and verify against, the
   lines they were built with, which is why a removal has to be caught at
   build time or not at all. Treat this as a thin boundary, not a strong
   one: everything the current schema *does* declare is exported as logged.
   If a fact isn't safe to export, it was never safe to log in the first
   place.
4. **Append order is the truth, per actor.** A record's `body` is ordered, and
   that order *is* the fact: a reader folds `body` in the order it is written,
   and MUST NOT re-sort it by `ts` to decide what the session's state became.
   Timestamps are for navigating time — a scrubber, a window, "what did this
   look like at 14:03" — never for deciding what happened after what. A
   collector may report a *source's* own clock, so one actor's timestamps are
   not guaranteed monotonic, and a ts-sort therefore reorders events that actor
   emitted in a definite order.

   This is the ruling on #205 (operator, 2026-08-24, option 1 — "append order
   is the truth"), taken after a fixture proved the alternative was not
   theoretical: live folding in arrival order and replay folding in timestamp
   order yielded two different states from one recording — on last-write-wins
   fields, on create-vs-delete ordering, and on first-sighting order. This
   repo's own replay honours it unconditionally:
   `packages/web/src/replay/replayFold.ts` (`buildSessionIndex`, `foldFrom`,
   `foldUpTo`) folds the log's own order everywhere and keeps a ts-sorted copy
   for time navigation only. `docs/adr/0002-one-reducer-for-live-and-replay.md`'s
   2026-08-24 amendment records the defect this ruling closed.

   **Cross-actor order is a different question**, and merging is the only place
   it arises: two actors' clocks are not comparable, so `mergeRecords`
   interleaves by `ts` with `actor.instance` as the tiebreak while never
   reordering two events from the same actor (see "Merging two actors' records"
   above). Causality across actors, for a future multi-instrument "forest", is
   anchored on the commit DAG (`commit.landed.parents`) rather than on wall
   clocks.
