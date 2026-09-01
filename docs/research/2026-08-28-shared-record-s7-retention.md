# s7-retention — seal → archive → prune → verify, end to end

Lane s7-retention, prd-48 (PR #141) research-spike fleet. Question: does
seal → archive → prune → verify compose end-to-end against a real (copied)
data dir using the shipped `export-record` CLI + `packages/core/src/record/verify.ts`
+ `packages/server/src/log/retention.ts` + `packages/server/src/log/lane-index.ts`,
and does a pruned lane read as pruned?

Box: WSL2 Ubuntu, i9-13900H (per spike brief, 20 physical cores; `nproc`
inside this session reported 6, likely cgroup-limited), 31 GiB, node
v22.23.2, docker unused this lane. `/proc/loadavg` at start: `6.96 1.85 0.85`;
at crash drill: `3.92 3.40 1.83` — other lanes were active on the box
throughout.

## What ran

Build area: `~/rhizomorph-spikes/retention/` (gitignored, outside the
read-only `~/rhizomorph` checkout). Fake home: `~/rhizomorph-spikes/retention/fakehome`.
Real data dir `~/.local/share/rhizomorph` was only ever read from; nothing
written or deleted there — confirmed by MD5 of the three source `.jsonl`
files being identical before and after the whole run (see Reproduction).

1. **Copy.** Picked the 3 sessions under `rhizomorph-5189ebfe` (this repo's
   own slug) that had **no** `session-<id>.lock.json` sidecar (11 of 14
   sessions in that slug dir were still lock-held — presumably other
   concurrent lanes/sessions on this shared box; only 3 were unambiguously
   closed): `1786602585014` (5,079,174 B), `1786665406591` (1,310,492 B,
   has a `transcripts/` sidecar), `1786665720450` (15,656,535 B, has a
   `transcripts/` sidecar). Copied each `.jsonl` + `.resumes.json` sidecar +
   its `snapshots/<id>/` and `transcripts/<id>/` subtree into
   `$FAKEHOME/.local/share/rhizomorph/rhizomorph-5189ebfe/`. [EXECUTED]

2. **Seal.** `defaultDataRoot()` (`packages/server/src/log/paths.ts`) is
   `path.join(homedir(), '.local', 'share', 'rhizomorph')`, and Node's
   `os.homedir()` reads `$HOME` — so `HOME=$FAKEHOME` redirects the CLI's
   default data root with no code changes needed. One correction versus the
   brief: `packages/server/src/cli/index.ts` only *exports* `runCli`; it has
   no `if (require.main…)` invocation block, so running it directly with
   `tsx` does nothing silently (exit 0, no output, no file). The real
   direct-executable entrypoint is `packages/server/src/index.ts`
   (`isDirectlyExecuted()` guard calling `runCli(process.argv.slice(2))`).
   Used that instead:
   `HOME=$FAKEHOME npx tsx packages/server/src/index.ts export-record ~/rhizomorph --session <id>`
   for each of the 3 ids. All 3 wrote inside `$FAKEHOME` as expected
   (verified by `find $FAKEHOME -iname '*.rhizorecord.json'`). [EXECUTED]

3. **Archive + verify.** `gzip -9 -k` each `.rhizorecord.json`, then a
   throwaway script (`verify-gz.mjs`) that `gunzip`s, `JSON.parse`s, and
   calls `verifyRecord()` from `packages/core/src/record/verify.ts` — the
   real shipped verifier, unmodified. All 3 returned `{ok:true}`, no
   `unknown` lines. [EXECUTED]

4. **Prune.** Read `packages/server/src/log/retention.ts`'s exported API
   first (`RetentionAnswer`, `planRetention`/`readRetentionPlan`,
   `applyRetentionPlan`, `voiceRetentionPlan` — no default max-age; a
   caller must supply `maxAgeMs` or gets `RetentionAnswerRefused`). Wrote
   `seal-then-prune.mjs`, which per retention candidate: skips re-sealing if
   a verified `.gz` archive already exists for that session id, otherwise
   calls `buildRecord()` (the same function `export-record` calls) +
   gzip + `verifyRecord()` round-trip and refuses to prune if that fails,
   then calls `applyRetentionPlan()` with a single-candidate plan to delete
   just that session's `.jsonl`. Ran dry-run (`voiceRetentionPlan`) then
   `--apply` with `maxAgeMs=1000` (all 3 candidates, correctly reported by
   age against their `mtime`, not session-start). [EXECUTED]

5. **Pruned-reads-as-pruned.** `check-lane-index.mjs` calls `readLaneIndex()`
   from `packages/server/src/log/lane-index.ts` over the now-pruned fake
   dir. [EXECUTED]

6. **Crash drill.** `crash-drill.sh`: 5 trials, each restoring a pristine
   pre-seal copy of the 3 sessions, spawning
   `HOME=$FAKEHOME tsx seal-then-prune.mjs ~/rhizomorph 1000 --apply` as a
   background child, sleeping a fixed-but-spread delay (0.8s/1.8s/3.0s/4.5s/6.2s
   against a measured ~7.3s full-run wall time), then `kill -9` on the pid if
   still alive, then checking per-session: does `.jsonl` exist, does `.gz`
   exist, does the `.gz` verify. [EXECUTED]

## Results

**Size table** (from the real `export-record` CLI + `gzip -9`, step 2–3):

| session | log bytes | record bytes | record/log | gz bytes | gz/log | gz/record |
|---|---:|---:|---:|---:|---:|---:|
| 1786602585014 | 5,079,174 | 8,371,056 | 1.648x | 1,202,042 | 23.7% | 14.4% |
| 1786665406591 | 1,310,492 | 1,592,031 | 1.215x | 99,755 | 7.6% | 6.3% |
| 1786665720450 | 15,656,535 | 23,881,554 | 1.525x | 3,567,669 | 22.8% | 14.9% |
| **sum** | **22,046,201** | **33,844,641** | 1.535x | **4,869,466** | 22.1% | 14.4% |

The record format (manifest + hash-chained body) runs ~1.2–1.65x the raw
log's bytes; `gzip -9` gets that back down to ~14–23% of the raw log, i.e.
net ~4.3x–13x compression log→archive depending on session content.

**Prune.** `voiceRetentionPlan` at `maxAgeMs=1000` correctly named all 3
candidates and enumerated every lane losing history — including per-lane
`silent` flags (see below). `applyRetentionPlan` freed
**22,046,201 bytes**, exactly the sum of the 3 `.jsonl` sizes — matches
prediction byte-for-byte. [EXECUTED]

**Pruned-reads-as-pruned.** Lane `266-wizard` (single recording,
`1786665720450`, which has a `transcripts/` sidecar) after prune:

```
partialVoice: 1 session of this lane's 1 could not be read (1786665720450) — this reading is
partial, and the gap is where those sessions were
session 1786665720450 recordingPresent=false gap="RECORDING MISSING for session 1786665720450 —
this lane's captured transcript is beside it but its event log is not, so the part of
"266-wizard"'s life that ran in that session cannot be read here — what is shown is the rest of it"
```

The lane never vanishes; it reads as an honestly-partial lane with a named
gap, through the shipped `missingRecordingGap()`/`partialVoice()` code —
exactly the module's own documented contract. [EXECUTED]

**But**: lane `scratch-407` (single recording, `1786602585014`, which has
**no** `transcripts/` sidecar — the dry-run's `voiceRetentionPlan` flagged
it `silent`) is **absent from the lane index entirely** after prune —
`index.lanes.filter(l => l.handle === 'scratch-407')` returns `[]`, and
`index.unreadableSessionIds` only names the 2 sessions that *do* have a
transcript sidecar (`1786665406591`, `1786665720450`), never
`1786602585014`. This is not a bug — `retention.ts`'s own header and
`LaneHistoryLoss.silent` name this exact case in advance, and
`voiceRetentionPlan` said so before the prune ran — but it means "a pruned
lane reads as pruned" is conditional on a transcript sidecar existing, not
universal. [EXECUTED]

**Crash drill** (5 trials, `maxAgeMs=1000`, ~7.3s unperturbed full run,
loadavg 3.92/3.40/1.83 during the drill):

| trial | kill delay | outcome | invariant |
|---:|---:|---|---|
| 1 | 0.8s | killed while alive; all 3 sessions untouched (before first archive write) | OK |
| 2 | 1.8s | killed while alive; 2/3 sessions archived+pruned, 1/3 untouched | OK |
| 3 | 3.0s | killed while alive; all 3 archived+pruned | OK |
| 4 | 4.5s | killed while alive; all 3 archived+pruned | OK |
| 5 | 6.2s | process had already exited cleanly; all 3 archived+pruned | OK |

Invariant checked per session per trial (15 checks total): **if `.jsonl` is
gone, a `.gz` exists and `verifyRecord()` on it returns `ok:true`.** 0
violations across 15 checks; 9 of the 15 had the log already gone, and all
9 of those had a verifying archive. [EXECUTED]

## Falsifier verdicts

1. **Any state where a session is neither readable (`.jsonl` present) nor
   archived (verified `.gz` present)?** **PASS.** Decided by: 0 violations
   across 15 session-checks in the 5-trial crash drill (table above). The
   per-candidate loop writes+verifies the `.gz` synchronously before calling
   `applyRetentionPlan` for that one candidate, so a `SIGKILL` anywhere in
   the loop leaves each already-processed candidate's log gone only if its
   archive was already durably written and verified.

2. **Does the lane index express "pruned" without code changes?**
   **PASS, with a documented caveat.** Decided by: lane `266-wizard`
   (transcript sidecar present) quoting the exact `missingRecordingGap()`
   sentence above with zero code changes vs. lane `scratch-407` (no
   transcript sidecar) vanishing from the index entirely — the second
   outcome is the module's own named `silent` case (`LaneHistoryLoss.silent`,
   `voiceRetentionPlan`'s extra line), not a hidden gap, but it does mean
   "pruned reads as pruned" only holds when a capture sidecar exists.

3. **Reclaimed bytes vs prediction?** **PASS, exact.** Decided by:
   `applyRetentionPlan` reported `bytesFreed` summing to 22,046,201 across
   the 3 candidates, identical to `stat().size` summed over the 3 source
   `.jsonl` files before pruning.

## What this did not test

- **Single-machine only**, and the box had 4–7 loadavg from other lanes
  throughout — no isolation of the crash-drill timings from that noise;
  the 7.3s baseline run time is this-box-this-moment, not a stable number.
- **Only 3 of 14 candidate sessions in this slug were usable** — 11 were
  lock-held by other concurrent work on the shared box, so the 3 chosen
  were whatever happened to be closed at the moment, not a deliberately
  varied sample (sizes 1.3–15.7 MB, only 2 of 3 had transcript sidecars).
  No empty-session, no zero-byte, no malformed-log case was tried.
- **`kill -9` tests process-level atomicity, not power-loss/fsync
  durability.** `writeFileSync` for the `.gz` returns once the syscall
  completes, which can be page-cache-resident rather than on physical
  disk; a `SIGKILL` doesn't reclaim that, so the crash drill cannot
  distinguish "archive durably on disk" from "archive in page cache when
  the OS is still up." A real power-loss test would need `fsync`+an actual
  power cut or `dm-flakey`, neither of which this lane attempted.
  Similarly, none of the 5 trials landed a kill in the narrow synchronous
  window between the `.gz` write completing and `applyRetentionPlan`'s
  `rm()` starting for the *same* candidate — the timing was spread across
  the whole 3-candidate loop, not aimed at that specific ~ms-scale gap.
- **The prune wrapper does not exercise `export-record`'s CLI wrapper for
  the seal step** (`seal-then-prune.mjs` calls `buildRecord()` directly
  for speed across 5 repeated crash trials, same as `runExportRecord` does
  internally, but skips its `--out`-refuse-existing / containment-check
  logic). Step 2 above *did* run the real CLI once per session for the
  size-table numbers; the CLI path and the direct-`buildRecord` path were
  not cross-checked byte-for-byte against each other (they use a different
  declared `actor.handle`, which changes the JSON and therefore the exact
  byte counts — this is why the two seal passes in this note report
  slightly different archive sizes for the same session, e.g.
  1,202,042 B via CLI vs 1,129,385 B via the wrapper for session
  `1786602585014`; the *shape* of the record and `verifyRecord()`'s
  `ok:true` result were identical either way).
- **No multi-writer / concurrent-append case**: `applyRetentionPlan`'s
  `liveSessionId` refusal path (never prune the session currently being
  written) was read but not exercised — none of the 3 copied sessions was
  live, and no `--apply` run supplied a `liveSessionId`.
- Docker not used; no attempt to reproduce on macOS (the `os.tmpdir()`
  symlink issues noted elsewhere in this repo's own history don't apply
  here since nothing in this lane touched `os.tmpdir()`).

## Reproduction

```bash
FAKEHOME=~/rhizomorph-spikes/retention/fakehome
DST=$FAKEHOME/.local/share/rhizomorph/rhizomorph-5189ebfe
mkdir -p "$DST/snapshots" "$DST/transcripts"

SRC=~/.local/share/rhizomorph/rhizomorph-5189ebfe
for id in 1786602585014 1786665406591 1786665720450; do
  cp -p "$SRC/session-$id.jsonl" "$DST/"
  cp -p "$SRC/session-$id".*.json "$DST/" 2>/dev/null || true
  [ -d "$SRC/snapshots/$id" ] && cp -rp "$SRC/snapshots/$id" "$DST/snapshots/"
  [ -d "$SRC/transcripts/$id" ] && cp -rp "$SRC/transcripts/$id" "$DST/transcripts/"
done

cd ~/rhizomorph
for id in 1786602585014 1786665406591 1786665720450; do
  HOME=$FAKEHOME npx tsx packages/server/src/index.ts export-record ~/rhizomorph --session "$id"
done
gzip -9 -k "$DST"/*.rhizorecord.json
npx tsx ~/rhizomorph-spikes/retention/verify-gz.mjs "$DST/<file>.rhizorecord.json.gz"

npx tsx ~/rhizomorph-spikes/retention/seal-then-prune.mjs ~/rhizomorph 1000        # dry run
HOME=$FAKEHOME npx tsx ~/rhizomorph-spikes/retention/seal-then-prune.mjs ~/rhizomorph 1000 --apply

HOME=$FAKEHOME npx tsx ~/rhizomorph-spikes/retention/check-lane-index.mjs ~/rhizomorph 266-wizard

bash ~/rhizomorph-spikes/retention/crash-drill.sh
```

Throwaway scripts and the crash-drill harness live in
`~/rhizomorph-spikes/retention/` (`seal-then-prune.mjs`, `verify-gz.mjs`,
`check-lane-index.mjs`, `crash-drill.sh`), all outside the read-only
`~/rhizomorph` checkout. `~/rhizomorph` itself was never edited or
`git`-mutated; the real data dir `~/.local/share/rhizomorph` was only read
from — verified by identical MD5s on the 3 source `.jsonl` files before and
after this entire lane.
