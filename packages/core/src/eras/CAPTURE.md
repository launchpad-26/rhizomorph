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

### era-2 — `era-2/recording.jsonl`

| | |
|---|---|
| source | this repo's own live instrument session log |
| captured | 2026-09-07 |
| slice | lines **0–452** (0-based), contiguous, from the log's own birth |
| size | 453 lines, ~218 KB |
| families | **18** distinct types in the slice; **9** of them close gap-list families era-1 left open (see `eras.test.ts` for the exact remaining gap) |
| span | `ts` 1788757348268 – 1788758720748 |

What is in it, and why this window: it opens on `session.started` — this log's
birth, which era-1 deliberately holds none of, since it starts mid-session —
and closes on `summons.cleared`: a lane frozen long enough to raise a summons,
then recovered, clearing it. In between: the wave-2 operator route driven for
real (`operator.ack`/`.verdict`/`.note`), a tmux socket missing at startup —
`collector.degraded` twice each on two collectors, and then
`collector.disabled` **re-announced on every poll for the rest of the window**,
45 times each and 90 in all (corrected in review of #279, which measured them;
"twice each" was true of `degraded` and wrong by 22.5x for `disabled` —
2 per collector against 45, 4 total against 90) — seven
`judge.finding` records, and a worktree whose git status came back
listing 500 deleted files (a real, unexplained-but-genuine `worktree.dirty`
shape nobody would think to write by hand).

The cost of that storm is worth stating rather than leaving for a reader to
discover: those 90 events are **19.5% of the committed bytes** (42,407 of
217,739), and only the last one per collector survives into the fold, because
`collectorDisabled` overwrites `state.collectors[collector]`. So 88 of the 90
contribute nothing but `eventCount` and `lastEventTs`. They are kept because the
window is contiguous and a real slice is not edited — not because each one earns
its bytes.

It was chosen from the full Pareto frontier of contiguous windows against the
ten gap-list families this log can close: the smallest window closing all ten
is 660 lines (~300 KB), but the tenth, `collector.error`, fires only once,
~200 lines past this window's own close, and reaching it would nearly double
the committed bytes for one single-fire family — not worth it by the same
"most families per committed byte" test era-1's own note applies.
`collector.error` is therefore left out **on purpose**, not missed; see
`eras.test.ts`'s gap-list comment for the rest of what's still absent and why.

**Four of the nine closed families fold real state for the first time in this
corpus:** `session.started`, `collector.degraded`, `collector.disabled`,
`judge.finding`. The other five — `operator.ack`/`.verdict`/`.note` and
`summons.raised`/`.cleared` — are additive-only in the reducer today (prd17
ruling 1, #219: every one of that ruling's eight families returns `state`
unchanged), so their presence here proves the union accepts them and the
recording is understood, not that folding one changes anything yet.

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
| `payload.lane` (**era-2 only**) — a `summons.raised`/`.cleared` diagnostic that mostly carries a short lane handle, but the raiser sometimes reports the lane as its full worktree path instead; a real inconsistency in what it emits, not a capture artifact | same host-home substitution as the path fields above |
| a tool-activity `filePath` into the CLI's own scratchpad directory (**era-2 only**) — the dirname *slugifies* the worktree path: every `/` and `_` becomes `-` | the same host-home prefix, dash-encoded: `-home-<user>-<org-dir>-` → `-repo-` |

The three id pools are **injective**: two redacted values are equal exactly
when the originals were, so every dedup and join the reducer performs
(`requestId` cross-collector dedup, the `sessionId` place join) behaves on the
redacted log as it did on the real one. That is why they are numbered pools
rather than one fixed placeholder each.

**Redact by scanning the whole file for the path's literal text, in whatever
encoding it appears — never only by walking the field list above.** era-2 is
why: the field list doesn't name `payload.lane`, and it never fired for
era-1, but this log's raiser puts a full path there some of the time. And the
same path leaks a *second* time from an unrelated field, dash-encoded rather
than slash-encoded, which no `/home/`-substring guard would catch either — the
same lesson AGENTS.md already states for guards in general: "the path and its
encoding are one edit." The field-name table above still documents *what*
gets touched for a reviewer's sake; it must not be read as exhaustive of
*where*. era-2's redaction pass applied both substitutions as plain text
replacements over the raw file rather than a key-by-key JSON walk, precisely
so a value sitting in an unlisted field, or encoded differently, still gets
caught.

`eras.test.ts` re-checks the result structurally on every run — no host home,
no NUL byte, no email outside `example.com`, no trace of the source repo's real
basename, no era-1 capture-host username, and no dash-slugged home,
newline-terminated JSONL with no blank lines — over both the recording **and**
its snapshot, and over **both the raw bytes and the JSON-decoded strings**,
keys included (#279). Same grep-law discipline as
`collectors/otel/fixture-hygiene-law.test.ts`.

That decoded pass is not belt-and-braces. A host path written with standard
JSON `\u` escapes is still a leak, still valid JSON, and `JSON.parse` hands the
original back — and because prd17 ruling 1's families are additive-only in the
reducer, such a leak never reaches the fold, so the snapshot's byte-equality
assertion cannot see it either. Both halves of the law missed it until #279's
review. Percent-encoded forms are deliberately NOT covered: `%2Fhome%2Fx` is a
different string rather than another spelling of this one, and this is a text
law, not a decoder chain.

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
