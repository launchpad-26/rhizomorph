# prd11 — the causal record: provenance, the portable session record, and
> **Outcome:** shipped.

# the road to the forest

The product direction, ruled by the operator 2026-08-04: rhizomorph's
ultimate goal is **the forest** — a multiplayer instrument with persistent
knowledge of every coworker's swarm on a shared repo. Everything in this
prd is built so that goal is a merge, not a rewrite. The do-now cut:
**causality** (why did this code happen), **the record** (a portable,
integrity-checked session artifact — which IS the federation wire format),
and two commissioned spikes (the fork checkpoint; the semantic judge).

## Rulings

1. **Provenance joins at FILE granularity in v1, and says so.** The chain
   we can prove today: a lane's transcript moment → its tool call
   (`toolUseId`) → the file it touched (`filePath`) → the commit that
   landed that file (`commit.landed.files`) → the branch/prd that ordered
   it. Hunk-level attribution needs patch capture we do not store; it is
   named future work, never faked by proximity.
2. **`tool.activity` gains `filePath?` and `toolUseId?`** — additive, from
   the sessionlog's own tool_use blocks (Edit/Write/Read carry file_path;
   Bash does not and stays null). `toolUseId` is also the join key to
   `trace.span.toolUseId`, marrying the causal chain to the waterfall for
   free.
3. **The record is federation-first from its first field.** One portable
   file: a manifest (schema version, repo slug, ACTOR identity — the
   instance id plus a human-declared handle — time range, event count), the
   full event log, and a per-line hash chain closing in a manifest digest.
   Integrity-checked now, signature-READY (the manifest reserves the
   field; key infrastructure is future work, stated). Two actors' records
   for the same repo must be mergeable by construction: every event
   already carries its instance; the reducer already survives unknown
   types; ordering is per-actor append-only, cross-actor by timestamp
   with actor as tiebreak.
4. **Export and import are CLI acts**: `rhizomorph export-record` writes
   the artifact; `rhizomorph replay <record>` serves a foreign record
   read-only through the existing replay machinery — a stranger's session,
   replayed on your instrument, is the forest's first handshake and it
   must work this week.
5. **The WHY surface**: the lane page and drawer gain a provenance view —
   pick a file the lane touched, see the tool calls that touched it and
   the transcript moments around them, and the commits that landed it.
   Reads existing records + the new fields only; honest gaps where
   history predates the fields.
6. **Spikes commissioned** (research notes, verdict-led): (a) the fork
   checkpoint format — workspace snapshot mechanics via git, session
   context via the record + `claude --resume` semantics, what a
   checkpoint contains, restore mechanics, non-determinism posture;
   (b) the semantic judge — intent-collision detection design, model/cost
   budget, and the false-positive discipline (the second-reader
   literature from the Mission 04 research applies).
7. **Laws untouched**: read-only stands (export writes OUTSIDE the watched
   repo; import serves, never executes); nothing leaves the machine —
   a record moves only by a human's hand; privacy allowlists carry into
   the record unchanged (it contains exactly what the log contains).

## Implementation waves

Keystone A (core, now): ruling 2's additive fields + sessionlog
extraction + census/fixture/reduce fan-out. Keystone B (parallel, now):
ruling 3–4's record schema (`packages/core/src/record/`), export/import
CLI, hash chain + tests incl. a tamper test and a two-actor merge test.
Then: the provenance selector + WHY surface (after the in-flight lanes
free the barrels); the spikes run as agents alongside. The semantic judge
and the fork build as their own prds once their spikes report.
