# The golden era corpus — provenance, redaction, and the blessing rule

> prd17 ruling 3, item 2. One small **real** recording per era, folded in CI by
> whatever the reducer has become; byte-identical state or the build fails.
> `fold.ts` explains what the corpus is for; this file is where each recording
> came from and what may be done to it.

## The files

| file | what it is |
|---|---|
| `fold.ts` | the registry and the fold. Pure: no `node:*`, no file access — core has no Node types in scope and must not grow any. |
| `corpus.ts` | binds each era's two files in as text, at import time, via Vite's `?raw`. |
| `raw.d.ts` | the one declaration that makes `?raw` typecheck here. |
| `eras.test.ts` | the CI law, and the fixture-hygiene sweep. Cannot write anything. |
| `era-N/recording.jsonl` | the recording: one event per line, as the log held it (post-redaction). |
| `era-N/session-state.snapshot.json` | the committed fold. **The permanent record.** |

## Why real recordings

`fixtures.ts` already tests what the reducer does with events *we* constructed
— which tests our reading of the contract, not the instrument. An era recording
is a slice of a log the instrument actually wrote, and it carries the shapes
nobody would think to write down. Era-1, for instance, is **not monotonic in
`ts`**: a `sessionlog` tail line lands beside a `tmux` poll from three seconds
earlier, exactly as `packages/server/src/log/session-log.ts` warns can happen.
A hand-written fixture smooths that away. A reducer change trips over it.

## The eras

### era-1 — `era-1/recording.jsonl`

| | |
|---|---|
| source | this repo's own live session log, `session-1785929533332.jsonl` |
| captured | 2026-08-06 |
| slice | lines **489–588** (0-based offset 488, width 100), contiguous |
| size | 100 lines, ~34 KB |
| families | **15** of this era's 25 (see `eras.test.ts` for the exact gap list) |
| span | `ts` 1785930239054 – 1785933927501, **non-monotonic in log order** |

What is in it, and why this window: the fleet mid-flight across four lanes —
eight commits landing on a single git poll, a worktree and a branch
disappearing together, two panes closing, `sessionlog` usage and tool activity
interleaved with an OTel span, cost and active-time reading. It was chosen as
the **smallest contiguous window in that log reaching 15 event families**, so
the corpus buys the most reducer coverage per committed byte.

It deliberately starts mid-session, so it holds no `session.started`. That is
what a slice is, and it is also the shape a replay prefix and a rotated tail
both have. A future era captured from a log's birth closes that gap; until then
`reduce.test.ts` covers the session arms directly and `eras.test.ts` states the
gap as an assertion rather than leaving it a silence.

**Re-blessed 2026-09-05 (#281, ADR-0037).** `AgentState` gained `witness` and
`dissent`. Every era-1 agent folds to `witness: "workmux"`, `dissent: null`,
because era-1 predates the second witness — every `agent.status` on that log was
signed `workmux`, and the fold now says so instead of assuming it. No other key
moved (checked by diff). The reducer change is `agentStatus` in `reduce.ts`; the
new fold is the correct meaning of the old log because it records who spoke,
which the old log already knew.

**Re-blessed 2026-09-05 (#283).** `SessionState` gained the `declared` slice
(prd-27 ruling 3). Era-1 predates beacons, so it folds to `declared: {}` and no
other key moved (checked by diff). The reducer change is the `beacon.received`
arm; the new fold is the correct meaning of the old log because that log
contains no beacon and now says so.

**Re-blessed 2026-09-07 (prd-53 ruling 1, wave 1).** `ForkState` gained the `byArm`
index — the r runs of one arm, keyed `armKey(forkId, arm)` — beside `byFork` and
`byLane`. Era-1 predates the laboratory, so it folds to `byArm: {}` and no other
key moved (checked by diff). The reducer change is the `fork.dispatched` arm
(`forkDispatched` in `reduce.ts`, which now also reads a record's `run ?? 1`);
the new fold is the correct meaning of the old log because that log contains no
dispatch, and now says so under one more name.

**Re-blessed 2026-09-08 (prd-53 ruling 3, wave 2).** `ForkState` gained `measurements`
and `latestOutcomeByLane` — every `fork.measured` verdict, with the newest per run
indexed. Era-1 predates the laboratory, so both fold empty and no other key moved
(checked by diff: two new keys, plus the comma the line before them needed). The reducer change is the new `fork.measured`
arm; the new fold is the correct meaning of the old log because that log contains
no measurement, and now says so where a measurement would go.

## Redaction

A real slice, mechanically redacted. Every field the reducer reads is
**byte-identical from the capture** unless listed below — including all
timestamps, ids, hashes, shas, token counts, dollars, lane and branch names,
statuses, file paths *inside* the repo, trace/span ids and commit messages
(this repo's own public git log).

Replaced:

| field | with |
|---|---|
| `payload.path` · `worktreePath` · `repoPath` · `currentPath` · `filePath` · `files[].path` (absolute ones) | host home → `/repo`, then the watched repo's basename → `rhizomorph`, so `/home/<user>/worktrees-challenge__worktrees/191` → `/repo/rhizomorph__worktrees/191`. Applies to the **relative** worktree paths workmux reports too (`../rhizomorph__worktrees/190`). |
| `payload.author` | `{ name: "Era Author", email: "author@example.com" }` |
| `payload.preview` (pane content) — **era-1 only**; `preview` was removed from the `pane.activity` schema in #292, so nothing captured after it can carry the field | `"<pane content elided>"` |
| `payload.detail` (agent status line) | `"<agent detail elided>"` |
| `payload.title` (tmux pane title — a hostname) | `"host"` |
| `payload.sessionId` (agent CLI session UUIDs) | `00000000-0000-4000-8000-0000000000NN` |
| `payload.requestId` | `req_TEST00000000000000000N` |
| `payload.toolUseId` | `toolu_TEST000000000000000N` |

The three id pools are **injective**: two redacted values are equal exactly
when the originals were, so every dedup and join the reducer performs
(`requestId` cross-collector dedup, the `sessionId` place join) behaves on the
redacted log as it did on the real one. That is why they are numbered pools
rather than one fixed placeholder each.

`eras.test.ts` re-checks the result structurally on every run — no host home,
no NUL byte, no email outside `example.com`, no trace of the source repo's real
basename or the operator's username, newline-terminated JSONL with no blank
lines — over both the recording **and** its snapshot. Same grep-law discipline
as `collectors/otel/fixture-hygiene-law.test.ts`.

## Re-deriving a capture

The capture script is not checked in — it reads a private corpus (the
operator's own `~/.local/share/rhizomorph`), the same reason
`collectors/sessionlog/fixtures/CAPTURE.md` gives for its own recipe. The
recipe is small enough to restate:

1. Read a real `session-<ts>.jsonl`, dropping blank lines.
2. Pick the slice: for era-1, the smallest contiguous window reaching the most
   event families (scan every `(offset, width)` and take the fewest bytes at the
   highest family count).
3. Redact per the table above, key by key, **preserving key order**.
4. Write one JSON object per line, compact separators, UTF-8, trailing newline.
5. Bless the snapshot (below) and commit both files together.

A re-run against a fresh corpus reproduces an *equivalent* file — the same
shapes, not the same bytes, since the source slice differs. That is fine: an
era is a recording, and replacing it is capturing a new era, not editing this
one.

## The blessing rule

**A snapshot is the permanent record. Updating one is a deliberate act with a
stated reason, never automatic.**

Three things hold that line:

- **The test suite cannot write a snapshot at all.** There is no file handle in
  `eras.test.ts` to misuse: the bytes arrive as `?raw` text and the comparison
  is plain string equality. No flag, no environment variable, no accident.
- The comparison is deliberately **not** `expect(...).toMatchFileSnapshot(...)`.
  `vitest -u` rewrites those, and `-u` is something people run to fix an
  unrelated snapshot — the permanent record must not be collateral damage of
  that habit.
- Blessing is a command a human types, from the repo root, outside vitest:

```sh
npx tsx -e '
  import { readFileSync, writeFileSync } from "node:fs"
  import { ERAS, foldEraRecording, canonicalStateJson } from "./packages/core/src/eras/fold.ts"
  for (const era of ERAS) {
    const dir = "packages/core/src/eras/"
    const folded = canonicalStateJson(foldEraRecording(readFileSync(dir + era.recordingFile, "utf8")).state)
    writeFileSync(dir + era.snapshotFile, folded, "utf8")
    console.log("blessed", era.name)
  }
'
npm test        # must be green before committing
```

(The one-liner imports `fold.ts`, not `corpus.ts`: `tsx` has no `?raw` loader,
which is a happy accident — the blessing path and the reading path cannot get
tangled.)

A commit that changes a `*.snapshot.json` must say **which reducer change moved
the fold, and why the new fold is the correct meaning of that old log**. If the
answer is "the reducer changed and the test went red", the snapshot is not the
thing to change.
