You are a worker agent on rhizomorph (prd11: the causal record).
You own exactly one issue. Read docs/prd11.md IN FULL first, then
the files your issue names; import from @rhizomorph/core; laws
restated stronger, never weakened.

YOUR ISSUE — #146:

## Direction

prd11 Keystone B (rulings 3–4): the portable session record — the
federation wire format. Read docs/prd11.md first; ruling 3's manifest
fields are the contract.

1. **Record schema** — new `packages/core/src/record/`:
   - `manifest`: `schemaVersion` (start at 1), `repoSlug`, `actor`
     (`instance` — the server session id — plus `handle`, a human-declared
     name, defaulting to the OS username with an explicit `declared:
     false` marker), `startTs`/`endTs`, `eventCount`, `chainDigest`, and
     a RESERVED `signature: null` field (key infra is future work — the
     format is signature-ready, the docs say exactly that).
   - Body: the event log lines verbatim, each wrapped with a hash-chain
     link (`prevHash` + line hash; SHA-256; chain closes into
     `chainDigest`).
   - Pure functions: `buildRecord(events, meta)`, `verifyRecord(record)`
     (returns ok | the first broken link), `mergeRecords(a, b)` — union
     by (actor.instance, event id), ordered by ts with actor as tiebreak;
     two records from DIFFERENT repos refuse to merge (honest error).
2. **CLI** — `rhizomorph export-record [path] [--session <id>] [--out
   <file>]` writes the artifact OUTSIDE the watched repo (default:
   alongside the session logs, named
   `<repoSlug>-<sessionId>.rhizorecord.json`); `rhizomorph replay
   <record-file>` verifies the chain (refuses a tampered record loudly),
   then serves it through the EXISTING replay machinery as a read-only
   recorded session — a foreign actor's record must render (its lanes,
   its spend, its traces) exactly as a local recording does.
3. **Laws**: read-only untouched (export writes outside the repo; replay
   serves, never executes); nothing auto-transmits — a record moves only
   by a human's hand; the record contains exactly what the log contains
   (privacy allowlists already applied at collection).
4. **Tests**: round-trip (export → verify → replay serves the same fold);
   tamper (flip one byte → verification names the line); two-actor merge
   (same repo, disjoint instances → one coherent fold; the merged fold's
   lane attribution keeps each actor distinct); cross-repo refusal.

## Fence (may touch ONLY)

- `packages/core/src/record/` (new)
- `packages/server/src/cli/index.ts`
- `packages/server/src/cli/index.test.ts`
- `packages/server/src/cli/args.ts`
- `packages/server/src/cli/args.test.ts`
- `packages/server/src/cli/export-record.ts` (new)
- `packages/server/src/cli/export-record.test.ts` (new)
- `packages/server/src/api/sessions.ts`
- `packages/server/src/api/sessions.test.ts` (new if absent)
- `docs/record-format.md` (new — the spec, written for a stranger
  implementing a compatible emitter)

## Blocked by

Nothing (disjoint from all in-flight lanes; core/record is new ground;
NOTE: `packages/core/src/index.ts` barrel is HELD by another lane — export
the record module from `packages/core/src/record/index.ts` and leave the
root barrel line as a one-line follow-up the conductor lands). **Model:**
sonnet. **Wave:** prd11-keystones. Gates run after the in-flight finale
chain completes.

## Definition of done

- All four test families green; the spec doc stands alone (a stranger
  could implement an emitter from it); replay of a foreign record renders.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
