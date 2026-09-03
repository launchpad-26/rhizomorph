# s7-archive-tombstone — closing S7's "silent" caveat without touching retention.ts

Lane s7-archive-tombstone, prd-48 (#172) research-spike fleet, wave 4.
Follow-on to `docs/research/2026-08-28-shared-record-s7-retention.md` (read-only
reference, not edited by this lane). S7 found: after seal → archive → prune, a
lane with **no** captured-transcript sidecar (`transcripts/<id>/manifest.json`)
vanishes from the lane index entirely (`LaneHistoryLoss.silent`), while a lane
**with** a sidecar reads as a named gap via `missingRecordingGap()`. prd-44 #38
ruled a pruned lane must always read as pruned — never as if it never existed.
This lane asks: can an **archive step** close that gap by writing a minimal,
honest "tombstone" manifest — same shape and same path a real transcript
capture already uses — **without editing `retention.ts` or `paths.ts`**?

Box: macOS (darwin 25.5.0), node v22.22.2. Single machine, single lane, no
other concurrent process observed touching the fake data root used here.

## What ran

Build area: a scratch spike directory outside this checkout (gitignored /
outside git entirely), containing five throwaway glue scripts
(`build-fake-data.mjs`, `verify-gz.mjs`, `check-lane-index.mjs`,
`plan-and-prune.mjs`, `tombstone-write.mjs`) and a handful of disposable fake
data-root copies, one per scenario below. Nothing under this repo's own
tracked tree was read or written except this one markdown file. No real
machine's `~/.local/share/rhizomorph` was touched, read, or referenced by any
script — every session, lane handle and event in this experiment is
fabricated from scratch.

1. **Fabricate.** `build-fake-data.mjs` writes a synthetic session directory
   with **2 sessions, each hosting exactly 1 lane** (mirrors S7's two
   "silent"-relevant cases directly, by name):
   - session `1700000000000`, lane `266-wizard` — the **control**: an
     `llm.usage` + `tool.activity` event pair (cribbed from this repo's own
     `packages/core/src/eras/era-1/recording.jsonl` fixture shape — same event
     schema, fabricated ids/timestamps), plus a hand-written
     `transcripts/1700000000000/manifest.json` in the exact
     `TranscriptCaptureManifest` shape `transcript-capture.ts` produces for a
     **real** capture (`captured: true`, `complete: true`).
   - session `1700000100000`, lane `scratch-407` — the **regression**: the
     same event shape, but **no** `transcripts/` directory at all — the
     "silent" case S7 named, reproduced from scratch rather than copied from
     any real box. [EXECUTED]
2. **Seal.** The real, unmodified CLI entrypoint, using #170's
   `RHIZOMORPH_DATA_DIR` override (no `HOME`-swap needed, unlike S7 which
   predates it):
   `RHIZOMORPH_DATA_DIR=$FAKEROOT npx tsx packages/server/src/index.ts export-record $REPO --session <id> --handle spike-operator`
   for both session ids. `--handle spike-operator` was required — omitting it
   stamps the record's `actor.handle` with the real OS username via
   `os.userInfo()`, which is exactly the leak this repo's own sanitisation
   rule warns about; caught before anything was written into this doc.
   [EXECUTED]
3. **Archive + verify.** `gzip -9 -k` each `.rhizorecord.json`, then
   `verify-gz.mjs` (`gunzip` → `JSON.parse` → the real, unmodified
   `verifyRecord()` from `packages/core/src/record/verify.ts`). Both sessions'
   archives verified `{"ok":true}`. [EXECUTED]
4. **Tombstone write** — the one step with no shipped implementation, written
   as throwaway spike glue (`tombstone-write.mjs`), run **before** pruning:
   reads the still-present `session-<id>.jsonl`, calls the real, unmodified
   `allAttributedLanes()` (`packages/server/src/log/transcript-attribution.ts`
   — the exact function a real transcript capture already uses to decide which
   lanes a session named), and for each lane it names, writes a
   `TranscriptCaptureManifest`-shaped `manifest.json` at the same path
   (`transcriptCaptureDir(sessionDir, sessionId)/manifest.json`,
   unmodified `paths.ts` helper) a real capture would use — but with
   `captured: false` on every lane and a `reason` string stating plainly that
   this is a tombstone, not a real capture. [EXECUTED, once per scenario below]
5. **Prune.** `plan-and-prune.mjs` calls the real, unmodified
   `readRetentionPlan` / `voiceRetentionPlan` / `applyRetentionPlan` from
   `packages/server/src/log/retention.ts`, with `maxAgeMs: 0` and `nowMs` set
   10 minutes ahead of wall-clock so both fabricated sessions (whose `mtime`
   is "just now") are unambiguously candidates — no need to wait out a real
   age window for a 2-line fabricated log. [EXECUTED]
6. **Pruned-reads-as-pruned.** `check-lane-index.mjs` calls the real,
   unmodified `readLaneIndex()` from `packages/server/src/log/lane-index.ts`
   over the pruned fake dir and prints both lanes' entries.  [EXECUTED]
7. **Five scenarios**, same fabricated starting data each time, to isolate
   exactly what the tombstone step changes:
   - **A — no tombstone** (S7's finding, re-run from scratch): seal → archive
     → prune → read. [EXECUTED]
   - **B — with tombstone**: seal → archive → **tombstone** → prune → read,
     plus a plan/voice check both immediately before and immediately after the
     tombstone write, to show composition with `retention.ts`'s grammar
     directly rather than asserting it. [EXECUTED]
   - **C — crash simulation**: same as B, but after the tombstone write
     succeeds, the `manifest.json` is truncated to half its byte length
     (`python3` truncation, not a real `SIGKILL`) — the shape a `writeFile`
     interrupted mid-write leaves on POSIX (no `rename`-based atomicity in
     this spike's glue) — then prune runs as normal. [EXECUTED]
   - **D — no archive of any kind**: seal is skipped entirely (no
     `export-record`, no `gzip`, no tombstone) and prune runs directly against
     the raw fabricated logs, to test the residual failure mode named in the
     issue (a session pruned before any archive step ever touches it).
     [EXECUTED]
   - **E — multi-lane session, one lane uninstrumented**: session
     `1700000100000` additionally carries a `worktree.discovered` event for a
     non-main worktree on branch `ghost-lane`, and **no telemetry naming that
     branch** — so the index carries two lanes for that session while
     `allAttributedLanes` can attribute only one. Then seal → archive →
     tombstone → prune → read, exactly as in B. This is the scenario that
     produced falsifier verdict 5. [EXECUTED]

## Results

**Scenario A — no tombstone (S7's finding, reproduced from scratch).**
Dry-run (`voiceRetentionPlan`, before prune):

```
2 recordings older than 0 ms would be removed, freeing 1646 bytes; 0 would stay
lane 266-wizard loses 1 of its 1 recording — its WHOLE recorded life (1700000000000)
lane scratch-407 loses 1 of its 1 recording — its WHOLE recorded life (1700000100000)
  and scratch-407 has no captured transcript beside it, so that part of its life will not read as pruned — it will simply be absent
```

`plan.lanes`: `266-wizard: silent=false`, `scratch-407: silent=true` — exactly
S7's split. After `applyRetentionPlan` (`bytesFreed: 1646`, both `.jsonl`
removed), `readLaneIndex()`:

```
lane 266-wizard: present
  partialVoice: 1 session of this lane's 1 could not be read (1700000000000) — this reading is
  partial, and the gap is where those sessions were
  session 1700000000000 recordingPresent=false gap="RECORDING MISSING for session 1700000000000 —
  this lane's captured transcript is beside it but its event log is not, so the part of
  "266-wizard"'s life that ran in that session cannot be read here — what is shown is the rest of it"
lane scratch-407: ABSENT from index
unreadableSessionIds: [ '1700000000000' ]
```

`scratch-407` is gone — `index.lanes.filter(l => l.handle === 'scratch-407')`
is empty and `unreadableSessionIds` never names `1700000100000`. This is
byte-for-byte the same shape S7 found on a real (copied) data directory,
reproduced here entirely from fabricated data. [EXECUTED]

**Scenario B — with tombstone.** The tombstone written for session
`1700000100000` (lane `scratch-407`):

```json
{
  "sessionId": "1700000100000",
  "capturedAt": 1788398110005,
  "complete": false,
  "totalBytes": 0,
  "lanes": [
    {
      "lane": "scratch-407",
      "claudeSessionId": "00000000-0000-4000-8000-0000000000b2",
      "captured": false,
      "bytes": 0,
      "reason": "TOMBSTONE for \"scratch-407\" — no transcript capture ever ran for this session; this manifest exists only to prove the session (and this lane's presence in it) was real before its event log was archived and pruned, so the lane index can still name a gap here rather than showing nothing at all"
    }
  ],
  "attributedFrom": "tombstone"
}
```

**621 bytes** on disk, for a session naming one lane (measured directly with
`wc -c`; a real capture's manifest for the same one-lane session,
`captured: true`, is 308 bytes — the tombstone costs roughly 2x a real
capture's manifest for the same lane count, entirely from the longer `reason`
string). [EXECUTED]

Composition with `retention.ts`'s own grammar, shown rather than asserted —
`voiceRetentionPlan` / `plan.lanes` for the **same session directory**,
immediately before and immediately after the tombstone write, prune not yet
applied either time:

| | before tombstone | after tombstone |
|---|---|---|
| `plan.lanes` for `scratch-407` | `silent=true` | `silent=false` |
| extra `voiceRetentionPlan` line | `"...has no captured transcript beside it, so that part of its life will not read as pruned — it will simply be absent"` | *(line absent)* |

Nothing in `retention.ts` changed between the two calls — the flip is
`planRetention`'s own `silent: lost.some(slice => slice.transcript === null)`
line (`retention.ts:186`) reading a `transcript` field that is no longer
`null`, because `lane-index.ts`'s `sliceFor` (unmodified) now finds a
`capturedLane` entry from the tombstone the same way it would from a real
capture. [EXECUTED]

After `applyRetentionPlan` (same `bytesFreed: 1646`), `readLaneIndex()`:

```
lane 266-wizard: present
  partialVoice: 1 session of this lane's 1 could not be read (1700000000000) — ...
  session 1700000000000 recordingPresent=false gap="RECORDING MISSING for session 1700000000000 — ..."
lane scratch-407: present
  partialVoice: 1 session of this lane's 1 could not be read (1700000100000) — this reading is
  partial, and the gap is where those sessions were
  session 1700000100000 recordingPresent=false gap="RECORDING MISSING for session 1700000100000 —
  this lane's captured transcript is beside it but its event log is not, so the part of
  "scratch-407"'s life that ran in that session cannot be read here — what is shown is the rest of it"
unreadableSessionIds: [ '1700000000000', '1700000100000' ]
```

`scratch-407` now reads identically in shape to `266-wizard`:
`recordingPresent: false`, the exact same `missingRecordingGap()` sentence
template (the reader cannot tell from this output whether the underlying
sidecar was a real capture or a tombstone — the gap wording is generic to
"this lane's captured transcript is beside it", which is literally true of a
tombstone too), and `partialVoice` naming the loss. `unreadableSessionIds` now
correctly names both pruned sessions. [EXECUTED]

**Scenario C — crash mid-tombstone-write.** The manifest was truncated from
621 to 310 bytes (invalid JSON, the shape a partial `writeFile` leaves).
Re-running the plan against the truncated file: `plan.lanes` for
`scratch-407` reads `silent=true` again, with the extra "will simply be
absent" line back — `readTranscriptCaptureManifest`'s `JSON.parse` failure is
caught (`transcript-capture.ts`'s own documented convention: unreadable reads
as "no capture ever ran", never a thrown error) and the file is treated
exactly as if it did not exist. After prune, `readLaneIndex()` on the
truncated-tombstone directory: `scratch-407` is **ABSENT from index** again —
identical to scenario A. No exception was raised anywhere in the pipeline; the
system degrades to exactly its pre-tombstone behaviour, never to something
worse (no crash, no half-rendered lane, no wrong gap text pointing at another
session). [EXECUTED]

**Scenario D — no archive at all.** Skipping `export-record`/`gzip`/tombstone
entirely and pruning the raw fabricated logs directly: `applyRetentionPlan`
freed the same 1646 bytes with **no check anywhere that any archive or
tombstone existed first** — `readLaneIndex()` afterward shows `scratch-407`
**ABSENT** (same as scenario A) and `266-wizard` reading as a gap only because
its (pre-existing, hand-written) manifest happened to still be there.
`applyRetentionPlan`'s own source (`retention.ts:288-322`) confirms why: it
iterates `plan.candidates` and `rm()`s each file whose `stat()` still succeeds,
guarded only by the live-session check (`retention.ts:301-304`, which diverts
the session being written now into `refusedLiveSessionIds`) — nothing in that
loop consults `transcripts/` at all. [EXECUTED]

## Falsifier verdicts

1. **Does an archive step close the "silent" gap without editing
   `retention.ts` or `paths.ts`?** **PASS**, for the ordering
   *seal → archive → tombstone → prune* **and for the lanes
   `allAttributedLanes` can name** — which is a strictly narrower set than the
   lanes the index itself carries, and verdict 5 is that gap. Decided by:
   scenario B — the same fabricated `scratch-407` case that vanished in
   scenario A instead reads as
   a named gap (`recordingPresent: false`, `missingRecordingGap()` sentence,
   `partialVoice` set) after nothing but a new sidecar file was added at a
   path `transcript-capture.ts` and `paths.ts` already export, using a reader
   (`lane-index.ts`) that already folds any manifest naming a lane, real
   capture or not. Zero lines changed in `retention.ts`, `paths.ts`, or
   `lane-index.ts`.

2. **Does the tombstone compose with `retention.ts`'s existing `silent`
   grammar, or does it require amending it?** **PASS, composes.** Decided by:
   the before/after table in scenario B — `plan.lanes[].silent` and
   `voiceRetentionPlan`'s extra warning line both flip off the moment the
   tombstone exists, purely because `retention.ts:186`'s existing
   `slice.transcript === null` check now reads non-null. No new field, no new
   branch, no new case added to `retention.ts`.

3. **Does a crash mid-tombstone-write leave the lane worse off than today
   (no tombstone at all)?** **PASS for the unparseable shape; FAIL for the
   parses-but-wrong shape.** Decided by: scenario C —
   a truncated (unparseable) tombstone reverts the lane to exactly scenario
   A's behaviour (silent, absent-from-index), never to a thrown exception, a
   wrong gap sentence, or a lane rendered present-but-corrupted. The floor is
   "as bad as today, never worse," which is the honest bar for a step that
   cannot itself be made atomic within this issue's fence.

   **That floor is established for the *unparseable* crash shape only, and the
   sibling shape is genuinely worse.** A tombstone that parses cleanly but
   names the wrong lane is not degraded-to-today: `buildLaneIndex` folds every
   lane a manifest names (`lane-index.ts:278`, no `captured` filter and no
   cross-check against the log), so such a file **conjures a lane into the
   index that never ran**. Executed directly: a hand-written manifest naming
   `scratch-408` for session `1700000100000` left `scratch-407` silent and
   absent exactly as in scenario A, *and* added `scratch-408` to
   `index.lanes`. Nothing anywhere validates a manifest's lane list against the
   log it claims to describe — while the log still exists, which is the only
   window in which such a check is possible at all. [EXECUTED]

4. **Residual gap: a session pruned before ANY archive/tombstone step ever
   runs.** **Still a real, unfixed failure mode — explicitly out of what a
   tombstone step alone can close.** Decided by: scenario D — `retention.ts`'s
   `applyRetentionPlan` has, and had before this spike, no dependency on
   `transcripts/` at all; it deletes any candidate whose age qualifies, sidecar
   or not. A tombstone step only helps if **something guarantees it runs
   before prune, every time** — and nothing inspected in this spike's fence
   (`retention.ts`, `paths.ts`, `lane-index.ts`, `transcript-capture.ts`)
   enforces or even checks that ordering. That guarantee would have to live in
   whatever caller composes seal → archive → tombstone → prune into one
   operation (a scheduler, a CLI subcommand, a cron-style sweep) — none of
   which exists yet in this repo, and none of which is this issue's fence.
   **This is the falsifier's live half**: if the eventual retention feature
   ever lets `applyRetentionPlan` run reachable from a path that skips the
   tombstone step (a bare `--apply` with no preceding archive, exactly
   scenario D), a pruned lane is indistinguishable from one that never
   existed, and prd-44 #38 is violated by that path specifically — even though
   the tombstone mechanism itself, once run, is proven to work.

5. **Residual gap: a lane the index knows but `allAttributedLanes` cannot
   name.** **Still a real, unfixed failure mode — and it is not a shape this
   spike's single-lane scenarios could have surfaced.** The tombstone writer
   and the lane index derive their lane sets from *different* facts, and the
   writer's is strictly narrower:

   | | derives lanes from |
   |---|---|
   | `allAttributedLanes` (`transcript-attribution.ts:159`) — what the tombstone writes | lanes named in an `llm.usage` / `tool.activity` / `llm.cost` payload **that also carries a non-empty `sessionId`** — anything else is dropped by `findAttribution` returning `null` |
   | `laneHandlesOf` (`lane-index.ts:354-361`) — what the index carries, and what `planRetention` computes `silent` over | `Object.keys(state.telemetry.lanes)` **∪ the branch of every non-main worktree** |

   The second half of that union is the gap. `lane-index.ts:350-352` states its
   own reason for existing — *"a lane whose agent was never instrumented still
   has a worktree, commits and a branch"* — and such a lane has no
   `ATTRIBUTED_TYPES` event at all, so the tombstone step writes **no entry for
   it** and it stays silent.

   Decided by: a fifth scenario, one session (`1700000100000`) naming **two**
   lanes — `scratch-407` via telemetry, and `ghost-lane` via nothing but a
   `worktree.discovered` event on a non-main branch. Before the tombstone both
   read `silent=true`. `allAttributedLanes` returned `['scratch-407']` only.
   After the tombstone write: `scratch-407: silent=false`, `ghost-lane:
   silent=true`, with `voiceRetentionPlan` still emitting the "will simply be
   absent" line for `ghost-lane` alone. After prune, `readLaneIndex()` shows
   `scratch-407` as a named gap and `ghost-lane` **ABSENT from the index** —
   prd-44 #38 violated for that lane specifically, by the very run that fixed
   it for its sibling one line above. [EXECUTED]

   This is a **different** residual from verdict 4 and does not share its
   remedy: ordering the tombstone before prune, however rigorously a caller
   guarantees it, cannot help a lane the tombstone writer never enumerates. A
   real implementation has to either widen the writer's lane source to match
   `laneHandlesOf` (which reaches into a lane set derived from git state, not
   telemetry — a bigger change than this spike's glue) or accept that
   uninstrumented lanes stay silent and say so out loud.

**Overall: the org-retention design is NOT falsified by S7's caveat, but only
conditionally** — a tombstone step is a sufficient, zero-shipped-code-change
fix for "pruned reads as pruned" **for telemetry-attributed lanes**, and it
must be **mandatory and ordered** (never optional, never racing prune) in
whatever build-PRD wires seal → archive → prune together. A build that lets
prune run without it reachable is the same violation S7 found, just moved one
layer up. Two conditions, not one: verdict 4's ordering guarantee, and verdict
5's lane-coverage gap — the second of which no amount of ordering discipline
closes.

## What this did not test

- **Single machine, single lane, no concurrency.** Nothing here exercises two
  processes racing the tombstone write against a concurrent prune, or two
  writers racing the tombstone file itself (`writeFile` here is not
  `wx`-flagged the way `export-record`'s explicit `--out` path is — a real
  implementation should decide whether the tombstone write needs the same
  refuse-on-existing discipline `export-record.ts` uses for a named `--out`).
- **Real `SIGKILL`, not a truncation.** Scenario C simulates the *shape* a
  partial write leaves (invalid trailing JSON) by truncating a completed file
  with a script, not by actually killing a process mid-`writeFile` — real
  page-cache/fsync timing (S7's own crash-drill caveat) was not reproduced
  here. A `writeFile` that dies after flushing a complete-but-stale manifest
  (e.g. a half-populated `lanes` array from a partially-read log) was not
  attempted either — only "not parseable at all" was tested, not "parses fine
  but is wrong."
- **No test of the crash window between tombstone-durable and prune-actually-
  running.** Reasoned, not executed: if the process dies after the tombstone
  is durably written but before `applyRetentionPlan` ever runs, the `.jsonl`
  is simply still there — nothing is lost, and the next attempt (whenever it
  runs) sees an unpruned session with a tombstone already beside it, which is
  harmless (the tombstone is inert until the log is actually gone). This
  reasoning was not stress-tested the way S7's 5-trial drill stress-tested its
  own crash window.
- **`attributedFrom: 'tombstone'`** was written as a third value alongside the
  shipped type's `'recording' | 'window'` union
  (`transcript-capture.ts`'s `TranscriptCaptureManifest.attributedFrom`).
  Nothing in `lane-index.ts` reads that field today (confirmed by grep — only
  `.lanes` and manifest presence are read), so this was harmless for every
  check this spike ran, but a real implementation would need to either widen
  that union (a change to `transcript-capture.ts`, outside this issue's
  fence) or reuse `'window'`/omit the field — a genuine open question, not
  resolved here, since resolving it means editing a file the fence assigns to
  someone else.
- **One multi-lane session was tried and it found verdict 5** (scenario E: a
  session naming a telemetry lane and an uninstrumented worktree-branch lane).
  Still untested: a session naming **zero** lanes, a session with two
  *telemetry-attributed* lanes (scenario E's second lane was deliberately the
  uninstrumented kind, so "two lanes both get entries" is asserted from
  `allAttributedLanes`'s loop, not run), and an already-half-pruned directory
  (one lane's log gone, tombstone not yet written for a sibling in the same
  session).
- **No attempt to wire this into an actual CLI subcommand, scheduler, or the
  build PRD's real archive step** — this is glue proving the *mechanism*
  composes, not a proposal for where in the codebase it should live.
- **`export-record`'s `--handle` requirement was discovered, not designed
  around in advance**: the first `export-record` run without `--handle`
  stamped the real OS username into the fabricated record before this was
  noticed and corrected — caught before anything was quoted into this
  document, but worth naming as a real near-miss for anyone repeating this
  recipe.

## Reproduction

```bash
SPIKE=<a scratch directory of your own, outside any git checkout>
REPO="$SPIKE/fake-repo"
mkdir -p "$REPO"

# Scenario A — no tombstone (S7's finding, reproduced from scratch)
FAKEROOT="$SPIKE/fakedata-no-tombstone"
npx tsx "$SPIKE/build-fake-data.mjs" "$FAKEROOT" "$REPO"
for id in 1700000000000 1700000100000; do
  RHIZOMORPH_DATA_DIR="$FAKEROOT" npx tsx packages/server/src/index.ts \
    export-record "$REPO" --session "$id" --handle spike-operator
done
SESSDIR=$(find "$FAKEROOT" -maxdepth 1 -type d -name "fake-repo-*")
gzip -9 -k "$SESSDIR"/*.rhizorecord.json
for f in "$SESSDIR"/*.gz; do npx tsx "$SPIKE/verify-gz.mjs" "$f"; done
npx tsx "$SPIKE/plan-and-prune.mjs" "$SESSDIR"            # dry-run — silent=true for scratch-407
npx tsx "$SPIKE/plan-and-prune.mjs" "$SESSDIR" --apply
npx tsx "$SPIKE/check-lane-index.mjs" "$SESSDIR"          # scratch-407: ABSENT

# Scenario B — with tombstone
FAKEROOT="$SPIKE/fakedata-with-tombstone"
npx tsx "$SPIKE/build-fake-data.mjs" "$FAKEROOT" "$REPO"
for id in 1700000000000 1700000100000; do
  RHIZOMORPH_DATA_DIR="$FAKEROOT" npx tsx packages/server/src/index.ts \
    export-record "$REPO" --session "$id" --handle spike-operator
done
SESSDIR=$(find "$FAKEROOT" -maxdepth 1 -type d -name "fake-repo-*")
gzip -9 -k "$SESSDIR"/*.rhizorecord.json
npx tsx "$SPIKE/plan-and-prune.mjs" "$SESSDIR"                     # silent=true, before tombstone
npx tsx "$SPIKE/tombstone-write.mjs" "$SESSDIR" 1700000100000
npx tsx "$SPIKE/plan-and-prune.mjs" "$SESSDIR"                     # silent=false, after tombstone
npx tsx "$SPIKE/plan-and-prune.mjs" "$SESSDIR" --apply
npx tsx "$SPIKE/check-lane-index.mjs" "$SESSDIR"                   # scratch-407: present, named gap

# Scenario C — crash mid-tombstone-write (truncate to simulate a partial write)
# ... same as B up to the tombstone-write step, then:
python3 -c "
p = '$SESSDIR/transcripts/1700000100000/manifest.json'
data = open(p, 'rb').read()
open(p, 'wb').write(data[: len(data) // 2])
"
npx tsx "$SPIKE/plan-and-prune.mjs" "$SESSDIR" --apply
npx tsx "$SPIKE/check-lane-index.mjs" "$SESSDIR"                   # scratch-407: ABSENT again, no crash

# Scenario D — no archive at all
FAKEROOT="$SPIKE/fakedata-no-archive-at-all"
npx tsx "$SPIKE/build-fake-data.mjs" "$FAKEROOT" "$REPO"
SESSDIR=$(find "$FAKEROOT" -maxdepth 1 -type d -name "fake-repo-*")
npx tsx "$SPIKE/plan-and-prune.mjs" "$SESSDIR" --apply
npx tsx "$SPIKE/check-lane-index.mjs" "$SESSDIR"                   # scratch-407: ABSENT, no archive ever taken

# Scenario E — multi-lane session, one lane the tombstone writer cannot name
FAKEROOT="$SPIKE/fakedata-multilane"
npx tsx "$SPIKE/build-fake-data.mjs" "$FAKEROOT" "$REPO"
SESSDIR=$(find "$FAKEROOT" -maxdepth 1 -type d -name "fake-repo-*")
# a lane the index sees only through git — no telemetry event ever names it
cat >> "$SESSDIR/session-1700000100000.jsonl" <<'JSONL'
{"id":"evt-000005","ts":1700000100300,"source":"git","type":"worktree.discovered","payload":{"path":"/repo-wt/ghost-lane","branch":"ghost-lane","head":"abc1234","isMain":false}}
JSONL
npx tsx "$SPIKE/plan-and-prune.mjs"  "$SESSDIR"                    # BOTH lanes silent=true
npx tsx "$SPIKE/tombstone-write.mjs" "$SESSDIR" 1700000100000      # allAttributedLanes -> ['scratch-407'] only
npx tsx "$SPIKE/plan-and-prune.mjs"  "$SESSDIR"                    # scratch-407 silent=false, ghost-lane STILL true
npx tsx "$SPIKE/plan-and-prune.mjs"  "$SESSDIR" --apply
npx tsx "$SPIKE/check-lane-index.mjs" "$SESSDIR"                   # scratch-407: named gap; ghost-lane: ABSENT

# Verdict 3's sibling shape — a tombstone that PARSES but names a lane that never ran.
# Hand-write manifest.json for 1700000100000 with lanes[0].lane = "scratch-408", then prune:
# scratch-407 stays silent and ABSENT (as in A), and "scratch-408" is CONJURED into index.lanes.
```

The five throwaway glue scripts referenced above
(`build-fake-data.mjs`, `verify-gz.mjs`, `plan-and-prune.mjs`,
`check-lane-index.mjs`, `tombstone-write.mjs`) live entirely outside this git
checkout, in the scratch spike directory named at the top of the reproduction
block. Each imports the real, unmodified shipped functions directly from this
worktree's `packages/core/src` and `packages/server/src` (by absolute path,
run under `npx tsx`) rather than reimplementing any of their logic — the only
genuinely new code in any of them is `tombstone-write.mjs`'s manifest
construction, which is the one step this issue names as having "no shipped
implementation yet." Nothing under this repo's tracked tree was modified by
running them; `git status` was clean before and after every scenario above.
