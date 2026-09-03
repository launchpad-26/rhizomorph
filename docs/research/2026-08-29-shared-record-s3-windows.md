# s3-windows — the local store on native Windows: "no local database" survives, but three filesystem refusals and a path ceiling do not appear on POSIX at all

Lane `168-s3-windows`, rhizomorph prd-48 wave 2 (issue #168, "the local store's
behaviour on native Windows is measured"). This spike extends
`docs/research/2026-08-28-shared-record-s3-localstore.md` (WSL2 only; read-only, not
edited) onto native Windows. Build areas `C:\rhizo-spike\localstore\` and
`~/rhizomorph-spikes/localstore/` — both throwaways, outside this git tree (PRD ruling 1).
The repo checkout and `~/.local/share/rhizomorph` were read-only throughout; the corpus
used below is a **copy** (PRD ruling 2).

Run date **2026-09-03**. The filename carries 2026-08-29 because that is the path issue
#168's fence names, and the fence is honoured as written rather than silently corrected.

**Box (one machine, both legs):** AMD Ryzen 7 5800X, 8 cores / 16 logical, 32 GiB
(`34,276,614,144` bytes). Windows 11 Home, build 26200 (`10.0.26200.0`), and WSL2 (`6.18.33.2-microsoft-standard-WSL2`)
on that same Windows install. `node v22.23.2` on **both** legs. WSL2 is allotted **12**
logical processors and 23 GiB by its `.wslconfig`, against the 16 and 32 GiB Windows
sees — an asymmetry that does not touch these single-threaded numbers but would touch
any that were not. Load at run time: WSL loadavg `0.53 0.30 0.31` → `0.91 0.44 0.37`;
Windows CPU 17% → 11%. Windows Defender real-time protection was **left on**, deliberately — excluding the build
directory would have measured a machine nobody runs — and its being on is checked, not
assumed (`(Get-MpComputerStatus).RealTimeProtectionEnabled` → `True`).

**Headline:** on native Windows the shipped parse cache is still the fastest thing measured
— **3.0–3.2 ms** warm, against node:sqlite's **20.3–20.8 ms** query and PGlite's
**65.9–72.0 ms**. The falsifier fails to fire; S3's "no local database" is *not* a POSIX
conclusion wearing a general one's clothes, and the build PRD does not need a per-platform
storage answer. The margin actually **widens** on Windows rather than narrowing: the parse
cache is platform-neutral (1.11x) while its nearest rival, node:sqlite, is the single
engine that degrades (query 1.64x, load 1.69x, cold-open 2.16x). Both risks S3 named as
untested — native-module prebuild availability, wasm memory ceilings — turned out not to
exist here: `node:sqlite` is built into node so there is no prebuild to be missing, and
PGlite's wasm build loaded and queried without incident.

**What the numbers do not settle, and what this note is really for:** three filesystem
operations that POSIX allows and Windows **refuses**, and a SQLite path-length ceiling nine
characters below `MAX_PATH`. None of them changes the storage verdict. All of them change
what a shipper, a rotator, or a retention pass may assume, and they are stated in
[Windows-only behaviour](#windows-only-behaviour-the-part-the-timings-cannot-reach) below.

## Two departures from S3's setup, both forced, both stated before the tables

Neither is a preference. Both bound how far these numbers may be pushed.

1. **S3 ran on different hardware, so its table is not differenced against.** S3's note
   names an i9-13900H / 31 GiB; this box is a Ryzen 7 5800X / 32 GiB. Subtracting S3's
   WSL numbers from this note's Windows numbers would difference two machines and report
   the remainder as a platform effect. So **the WSL leg was re-run here**, on this box, from
   the same scripts and the same corpus, and every ratio below is within-box. S3's table
   remains readable beside this one as history; it is not an operand.
2. **S3's throwaway did not survive, so the scripts are reconstructed.** `~/rhizomorph-spikes/`
   no longer exists — not the log, not the five scripts. They are rebuilt from the method
   S3's note describes: the same schema (`events(id, ts, type, lane, payload)`, index on
   `lane`), the same deliberately naive row-by-row insert inside one transaction, the same
   lane-index aggregate. **The reconstruction is why both legs were re-run rather than one:**
   both columns come from *this* file set, so the scripts cancel and the platform does not.
   A reconstruction is not the original; anything below that reads as a direct comparison
   against S3's published milliseconds should be read as a comparison of *shapes*, not values.

**Corpus.** S3's source log is also gone with its slug directory. The nearest survivor on
this box is used throughout: 53,698 lines / 22,043,666 bytes, 34,669 events (64%) carrying
`payload.lane`, across **20** distinct lanes — against S3's 63,653 lines / 26.3 MB / 48% /
51 lanes. Fewer lanes means lower `GROUP BY` cardinality, which flatters the two databases
relative to S3's run, not the parse cache. Both legs read a byte-identical copy
(`sha256 3283ca911f1f283fff264022ea20c70cbdb0bebdd4baa64c1308f561b351dd95`, verified on both
sides after copying) so no line-ending translation crept into the NTFS copy.

## What ran

Three engines, one task, exactly as S3 framed it: read `session.jsonl`, build a lane index
(distinct lanes, per-lane count, per-lane max `ts`), report load, cold-open, query, and size
on disk.

1. **none** — `baseline.js`: `readline` + `JSON.parse` into an array, then a `Map`
   aggregation. Reported **cold** (read + parse + aggregate, what a fresh process pays) and
   **warm** (aggregate only over the resident array — the prd-44 parse-cache hit, where a
   repeat read is free because the parsed events are already in memory).
   **Where that model is optimistic, measured rather than waved at:** the shipped cache does
   not hand back the array it holds — `readSessionEvents` returns
   `[...(await parsedSessionLogCache.read(filePath)).events]`
   (`packages/server/src/log/session-log.ts:106`), a fresh 53,698-element copy on *every*
   call, deliberate and explained at `:99`. The warm baseline re-aggregates the **same**
   resident array and so omits that copy. It is worth **0.075 ms** on Windows and
   **0.211 ms** on WSL2 (medians of 40 samples, 20 warm-up iterations discarded, arm order
   alternated), which moves the Windows warm figure to ≈3.27 ms and leaves node:sqlite
   ~6.2x slower rather than ~6.4x. Named because the note's whole verdict rests on this
   baseline standing in for shipped code, and a premise that is modelled rather than
   measured should say which it is.
2. **node:sqlite** — `sqlite_load.js` / `sqlite_query.js`. Available on the Windows build
   **without** `--experimental-sqlite`, exactly as on Linux; it still prints
   `ExperimentalWarning: SQLite is an experimental feature` on require, so the flag is not
   required but the feature is not stable. *(That warning cost one harness run: PowerShell
   treats a native command's stderr as a terminating error under
   `$ErrorActionPreference = 'Stop'`, which aborted the first bench before it produced a
   row. Noted because it is a trap for anyone re-running this on Windows, not because it
   affected a number.)*
3. **@electric-sql/pglite v0.5.8** — `pglite_load.js` / `pglite_query.js`, pinned to S3's
   exact version so the engine is not a second variable. Installed fresh on each leg; one
   package, no transitive dependencies, on both.

**3 fresh processes per engine-phase per platform**, all `[EXECUTED]`. Every load run
deleted its store first and rebuilt from `session.jsonl`, so all 18 measured runs are also
rebuild proofs. Two clocks per run: in-process `process.hrtime.bigint()` splits (phase-level,
excludes node startup) and process-level wall clock — `Measure-Command` on Windows, the
analogue of S3's `/usr/bin/time -f "wall=%es"` on Linux.

## Results

### The Windows leg in S3's own table shape, for the side-by-side read

#168 asks for numbers "in the same shape as the landed S3 note so the two tables can be read
side by side", and the platform-ratio tables below cannot serve that — they are transposed
(metric-rows × platform-columns, against S3's engine-rows × phase-columns). So the Windows
leg is given twice. This one lays directly beside
`docs/research/2026-08-28-shared-record-s3-localstore.md`'s first table; the next carries the
platform ratio, which S3's shape has nowhere to put.

| Engine | Load/build (once) | Cold-open (fresh process) | Query (lane-index) | Cold-open + query |
|---|---|---|---|---|
| none (baseline, cold read+parse) | n/a (read *is* the load) | n/a | 188.4–189.3 ms | 188.4–189.3 ms |
| none (warm, parse-cache-equivalent) | n/a | n/a | 3.0–3.2 ms | 3.0–3.2 ms |
| node:sqlite | 658.9–770.5 ms | 0.55–0.61 ms | 20.3–20.8 ms | 20.9–21.4 ms |
| @electric-sql/pglite | 15,104–15,211 ms | 211.5–229.1 ms | 65.9–72.0 ms | 282.3–294.9 ms |

**Read across to S3's table with the two departures above in hand** — different box, and
reconstructed scripts. The shapes match; the values are not a difference of one variable.

### Phase-level (in-process, excludes node startup), 3 fresh-process runs each

| Metric (ms) | WSL2 | Windows | Windows ÷ WSL2 |
|---|---|---|---|
| none — cold read+parse+aggregate | 192.6–195.6 | 188.4–189.3 | **0.97x** |
| **none — warm (parse-cache equivalent)** | **2.8–3.4** | **3.0–3.2** | **1.11x** |
| node:sqlite — load (53,698 row-by-row, 1 txn) | 413.1–531.6 | 658.9–770.5 | **1.69x** |
| node:sqlite — cold-open | 0.3–0.3 | 0.6–0.6 | **2.16x** |
| node:sqlite — query | 12.4–12.7 | 20.3–20.8 | **1.64x** |
| PGlite — load | 14,228–14,377 | 15,104–15,211 | 1.07x |
| PGlite — cold-open | 241.9–248.7 | 211.5–229.1 | 0.87x |
| PGlite — query | 63.3–69.6 | 65.9–72.0 | 1.11x |

### Process-level wall clock (includes node startup), 3 runs each

| Phase (ms) | WSL2 | Windows | Windows ÷ WSL2 |
|---|---|---|---|
| baseline | 230–233 | 235.5–241.5 | 1.01x |
| sqlite load | 441–561 | 699.5–808.8 | 1.67x |
| sqlite cold-open + query | 38–38 | 58.3–64.4 | 1.58x |
| PGlite load | 14,302–14,458 | 15,186.8–15,290.5 | 1.07x |
| PGlite cold-open + query | 386–400 | 386.6–393.0 | 0.99x |

### Footprint — identical to the byte on both platforms

| Engine | node_modules | store on disk | store format |
|---|---|---|---|
| none | 0 | 0 (no store; the 22 MB source log is the input) | n/a |
| node:sqlite | 0 (built into node) | 22,659,072 B (22.7 MB) | single file |
| PGlite | 25,437,688 B (25.4 MB) | 95,567,914 B (95.6 MB, ≈4.3x source) | directory |

**[EXECUTED]** Every one of those six figures is byte-identical across WSL2 and Windows.
There is no Windows footprint penalty for either engine — a thing worth stating because
"it will be bigger on Windows" is the kind of claim that gets assumed rather than measured.

### Correctness

**[EXECUTED]** Across **18 runs — 3 engines × 2 platforms × 3 repetitions** — the lane index
produced exactly **one** distinct `(top-5, lane-count)` signature: 20 lanes, top-1
`unattributed` / 6,861 / `lastTs 1787787052134`, identical through baseline, node:sqlite and
PGlite on both platforms. Since every load run rebuilt its store from the source log first,
this is S3's step-4 rebuild proof and the cross-platform agreement check in the same 18 runs.

## Windows-only behaviour: the part the timings cannot reach

The issue asks for Windows-only behaviour that changes the verdict, "including file locking
and path handling if they bite." They bite — and, importantly, **not in a way that changes
the storage verdict**, which is why they are reported separately from it rather than folded
into the headline. The same `probes.js` ran on both legs; a divergence is therefore a
platform fact, not a crash.

| Probe | WSL2 | Windows |
|---|---|---|
| `unlink` a sqlite file while a handle is open | **ALLOWED** | **REFUSED** `EBUSY` |
| `rename` a sqlite file while a handle is open | **ALLOWED** | **REFUSED** `EBUSY` |
| `rm -r` a directory with an open file inside | **ALLOWED** | **REFUSED** `EBUSY` |
| store at a path containing spaces | OK | OK |
| second writer vs. a held `BEGIN IMMEDIATE` | BLOCKED | BLOCKED |
| store at a 253-char path | OK | **FAILED** — "unable to open database file" |

**[EXECUTED]** The first three are one fact with three faces: POSIX unlinks by name and lets
the inode live until the last handle closes; Windows holds a mandatory lock and refuses.
**This is the finding with consequences beyond this spike.** `log/retention.ts` is the
grammar an org-level ceiling must compose with (prd-44 #38), and prune, rotate and archive
are all "remove or move a file that a reader may hold." Each of those is a no-op-shaped
success on Linux and an `EBUSY` on Windows. Nothing here tests `log/retention.ts` itself —
it was not touched, and this note makes no claim about it — but wave 4's #172 ("a pruned
lane reads as pruned after an archive step, unconditionally") is the issue whose word
*unconditionally* now has a named platform to answer for.

**[EXECUTED]** The last row is sharper than it first appeared, and the sharpening changed
the finding. At a 253-character path, `fs.mkdirSync` and `fs.writeFileSync` both succeed on
Windows while `node:sqlite` fails — so it is not Node, and it is not `MAX_PATH` in the
ordinary sense. Walking the length in one-character steps pins it exactly:

| db path length | 251 | **252** | 253 | 255 | 258 | 260 | 262 |
|---|---|---|---|---|---|---|---|
| `fs` write, Windows | OK | OK | OK | OK | OK | OK | OK |
| `node:sqlite`, Windows | **OK** | **FAIL** | FAIL | FAIL | FAIL | FAIL | FAIL |
| `node:sqlite`, WSL2 | OK | OK | OK | OK | OK | OK | OK |

252 + 8 = 260. The eight characters are `-journal`: SQLite reserves headroom to form its
journal path, so the effective ceiling is **251 characters for the database path itself**,
nine below `MAX_PATH`, and it fails with a generic "unable to open database file" that names
neither the length nor the reason. `fs` is unaffected past 262 because Node's own calls are
long-path aware. Any future design that puts a store under a per-project, per-actor,
per-session directory on Windows should treat 251 as the budget, and should not expect the
error to explain itself.

## Falsifier verdicts

**The issue's falsifier: "if an engine beats the parse cache on Windows, 'no local database'
is a POSIX conclusion wearing a general one's clothes, and the build PRD needs a per-platform
answer."** → **FAILS TO FIRE. [EXECUTED]** No engine beats it. On Windows the warm parse
cache is 3.0–3.2 ms; node:sqlite's query alone is 20.3–20.8 ms (**6.4x slower**) and PGlite's
65.9–72.0 ms (**21x slower**) — both multipliers taken as the *smallest observed rival query*
÷ the *median* warm baseline (20.31 ÷ 3.166 = 6.42; 65.86 ÷ 3.166 = 20.80), the most
conservative reading the runs support rather than the widest; the median-to-median figures
are 6.5x and 22.4x. The verdict is not marginal and it does not depend on the
choice of corpus: both databases would have to improve by more than a factor of six to reach
the number the instrument already ships. **The build PRD does not need a per-platform storage
answer.**

**S3's falsifier 2, re-asked on Windows: "is any engine's lane-index query actually faster
than the warmed parse-cache baseline?"** → **FAIL (no). [EXECUTED]** Same verdict as S3
reached on WSL2, now on native Windows, on one box, with both legs re-measured. As on WSL2,
both databases beat the *cold* baseline (188–189 ms) because they skip re-parsing 53k lines
— and neither beats the case prd-44 already ships, which is "don't re-read, don't re-parse,
keep it in memory."

**S3's falsifier 1, re-asked on Windows: "PGlite cold start >1 s or footprint >30 MB?"** →
**PASS, with S3's same borderline. [EXECUTED]** Cold-open 211.5–229.1 ms in-process,
386.6–393.0 ms process wall clock; both under 1 s. `node_modules` 25.4 MB, under 30 MB. The
caveat S3 flagged is unchanged and is not a Windows effect: the on-disk store is 95.6 MB,
≈4.3x the source log, so a "footprint" that counts the running store reads borderline on
either platform. Flagged rather than resolved, for the same reason S3 flagged it — picking
the reading that passes is the failure mode.

## What this note did not test

- **`log/retention.ts` was not run, on either platform.** The `EBUSY` findings come from
  probes against sqlite files in a throwaway directory. That prune-on-Windows is *implicated*
  is reasoning from the probe to the code path; it is **REASONED**, not executed, and #172 is
  where it becomes a test.
- **PGlite was not probed for the locking or path-length behaviours** — only `node:sqlite`
  was. PGlite keeps a directory rather than a file, so `rmdir-while-open` is suggestive for
  it, but its own handle discipline is untested.
- **One corpus, one size.** 53,698 lines on one box. No scaling curve, so the ratios are one
  data point per metric, not a trend. The 20-lane cardinality is lower than S3's 51 and
  favours the databases; the parse cache wins anyway.
- **Naive row-by-row inserts**, matching S3 deliberately for comparability. PGlite's ~15 s
  load is dominated by per-statement wasm round-trips, not by the engine; a batched or
  `COPY`-style load would look very different, and this spike does not have that number
  on either platform.
- **One query shape.** No range queries, no joins, no append-to-existing-store cost (which
  is closer to the instrument's real write pattern than a one-shot bulk load), no crash
  recovery under `kill -9`, no WAL-mode measurement.
- **Defender was on but not isolated.** Left on deliberately, and no A/B with exclusions was
  run — so the 1.6–1.7x sqlite penalty is "native Windows as configured," and how much of it
  is AV scanning versus NTFS versus the Win32 file API is not separated here.
- **No third platform.** macOS is untouched by this note; S1's machine-2/3 work covers
  different ground.

## Reproduction

Throwaways, both outside the repo: `C:\rhizo-spike\` (Windows) and
`~/rhizomorph-spikes/localstore/` (WSL2). Node 22.23.2 on both — on Windows via the official
portable `.zip` extracted to `C:\rhizo-spike\node`, checksum-verified against
`SHASUMS256.txt`, which needs no installer and no elevation.

```
# corpus: copy the largest local session log to BOTH legs, then verify the digests match
cp <data-dir>/<slug>/session-<id>.jsonl  ~/rhizomorph-spikes/localstore/session.jsonl
cp <data-dir>/<slug>/session-<id>.jsonl  /mnt/c/rhizo-spike/localstore/session.jsonl
sha256sum ~/rhizomorph-spikes/localstore/session.jsonl /mnt/c/rhizo-spike/localstore/session.jsonl

# engine under test, pinned to S3's version, installed on each leg
npm install @electric-sql/pglite@0.5.8

# the matched pair — 3 fresh processes per engine-phase, both clocks
bash ~/rhizomorph-spikes/localstore/bench.sh                       # WSL2 leg
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\rhizo-spike\bench.ps1'   # Windows leg

# behavioural probes and the path-length walk, same files on both legs
node probes.js .
node probe_threshold.js .
```

`bench.ps1` must run with `$ErrorActionPreference = 'Continue'`; under `'Stop'` the
`ExperimentalWarning` that `node:sqlite` writes to stderr is promoted to a terminating error
and the run dies before its first row.
