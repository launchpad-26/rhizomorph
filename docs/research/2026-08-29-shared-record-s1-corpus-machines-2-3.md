# s1-corpus — telemetry cost on machines 2 and 3

**Scope note, stated up front:** this note now covers **both** remaining machines. It was filed on
2026-08-29 covering machine 2 only, with machine 3 recorded as an open item under Ruling 1 ("a
spike that overruns its budget files its partial note ... silence is not a result"); machine 3 was
measured on 2026-09-01 and folded in here (#189). The three-machine table the wave-1 DoD asked for
now exists.

Both machines are named by role ("machine 2", "machine 3"), never by hostname, and no real home
path appears below — this repo's rule against committing a real machine's identity.

## Machine 2

Box: macOS (Apple Silicon, arm64, per `uname -a`'s `RELEASE_ARM64_T6050`), 18 logical cores, 48 GiB
RAM. Load at run start: `6.10, 7.12, 10.15`; at compression step: `4.19, 5.49, 8.88`. Date:
2026-09-01.

## Machine 2: what ran

1. Read-only walk of `~/.local/share/rhizomorph` (3 session dirs total — **all three real**, zero
   fixture litter, confirmed by inspecting each dir's first event's `repoPath`: all three point at
   real working directories under this operator's home, none at a `/tmp/tmp.*/watched/` fixture
   harness path).
2. `awk` single-pass per-type count+bytes census over the three largest real session logs (copied
   to `~/rhizomorph-spikes/s1-corpus-m2/logs/`), same method as machine 1's note.
3. `awk` bucketing of the largest real single session log by `ts→hour` and by `(hour,paneId)` —
   **`paneId`, not `lane`**, see "Events per lane-hour" below for why.
4. `gzip -9` and `xz -6` on the same three copies.
5. A second, later snapshot of the live corpus (whole-machine totals, event counts, and the
   earliest/latest timestamp across all real session files) taken separately from the frozen
   copies used in steps 2–4, to get events/day and bytes/day for the whole machine.

Build area: `~/rhizomorph-spikes/s1-corpus-m2/logs/`. No writes to `~/.local/share/rhizomorph`.

**This machine's corpus is live and growing.** One of the three real dirs
(`server-*`, the "server" role below) holds a session file that was still being appended to while
this note was written — this worktree lane's own telemetry, or a concurrent session on the same
box, is landing events in it in real time. The three files copied in step 2 are a frozen snapshot
(sizes fixed at copy time); the whole-machine totals in step 5 were taken ~2 minutes later and are
slightly larger. Both snapshots are timestamped below so the discrepancy is checkable rather than
silently absorbed.

## Machine 2: results

### 1. Corpus census

**[EXECUTED]** `find <dir> -type f -printf '%s\n' | awk '{s+=$1}END{print s}'` per dir, plus a
whole-machine `find` pass, snapshotted 2026-08-31 22:42:21 UTC.

No fixture litter on this machine — unlike machine 1 (74% of dirs, 4.4% of bytes), this box's
`~/.local/share/rhizomorph` holds only real session dirs. (This is a fact about this box's history,
not a methodology difference — there simply are no path-encoding-fixture-test session dirs here.)

| dir (role) | dir bytes | sessions | largest session bytes | largest session events | dur (h) | distinct panes | lane-tagged lines |
|---|---:|---:|---:|---:|---:|---:|---:|
| `server-*` | 365,565,066 | 6 | 274,714,481 | 980,057 | 122.8 | 300 | 277 |
| `rhizomorph-*` (main checkout) | 181,653,069 | 5 | 106,818,786 | 381,418 | 21.7 | 140 | 0 |
| `262-clone-by-url-*` (a worktree lane) | 18,915,330 | 1 | 18,885,623 | 60,062 | 3.8 | 65 | 0 |
| **total (all real, no fixture dirs)** | **565,936,245** | **12** | — | **1,997,511** (all session files) | — | — | — |

Two of three dirs hold effectively zero `"lane"`-tagged lines; the third holds 277 out of 980,057
(0.028%). See "Events per lane-hour."

**[EXECUTED]** Whole-machine snapshot (2026-08-31 22:42:21 UTC): total bytes across all files
565,936,245 (539.8 MiB); session `.jsonl` bytes 565,523,472; session `.jsonl` files 12; total
events (line count, all session files) 1,997,511; earliest event 2026-08-12 22:48:24 UTC; latest
event 2026-08-31 22:42:20 UTC; span 18.996 days.

- **Events/day (whole-corpus, span-based):** 1,997,511 / 18.996 days ≈ **105,155 events/day**.
- **Bytes/day:** 565,523,472 / 18.996 days ≈ **29.77 MB/day**.
- **Bytes/event (whole-corpus):** 565,523,472 / 1,997,511 ≈ **283.1 B/event**.

### 2. Global per-type census, three largest real logs

**[EXECUTED]** Three largest real logs globally (unlike machine 1, these span two different real
dirs, not one):

```
273,909,545  server-*/session-1787774200489.jsonl   (frozen copy, snapshot for steps 2-4)
106,818,786  rhizomorph-*/session-1787532221601.jsonl
 47,371,857  rhizomorph-*/session-1786608181037.jsonl
```

Single-pass `awk` (same regex-extract method as machine 1) over the concatenation of the three,
428,100,188 bytes / 1,527,962 lines total:

| type | lines | % lines | bytes | % bytes |
|---|---:|---:|---:|---:|
| pane.activity | 1,526,333 | 99.899% | 427,417,360 | 99.851% |
| pane.discovered | 556 | 0.0364% | 247,795 | 0.0579% |
| pane.closed | 400 | 0.0262% | 41,643 | 0.0097% |
| agent.status | 150 | 0.0098% | 36,331 | 0.0085% |
| collector.error | 136 | 0.0089% | 21,452 | 0.0050% |
| **"five high-frequency classes," named for cross-machine comparability** | **1,526,421** | **99.899%** | **427,461,576** | **99.851%** |
| commit.landed | 103 | | 74,882 | |
| worktree.dirty | 78 | | 162,703 | |
| trace.span | 34 | | 22,789 | |
| llm.usage | 34 | | 13,788 | |
| branch.updated | 51 | | 14,725 | |
| judge.finding | 22 | | 26,918 | |
| worktree.discovered | 16 | | 5,430 | |
| tool.activity | 10 | | 4,874 | |
| agent.activeTime | 10 | | 2,765 | |
| llm.cost | 7 | | 2,509 | |
| worktree.removed | 10 | | 2,037 | |
| branch.removed | 5 | | 661 | |
| session.started | 3 | | 752 | |
| agent.removed | 2 | | 245 | |
| collector.recovered | 1 | | 144 | |
| collector.degraded | 1 | | 385 | |
| telemetry.refused | 0 | | 0 | |
| **durable rest, subtotal (16 types, incl. 0-count telemetry.refused)** | **1,541** | **0.1008%** | **638,612** | **0.1492%** |

**This does not have five high-frequency classes.** Machine 1's brief names five classes
(`pane.activity`, `llm.usage`, `trace.span`, `tool.activity`, `agent.activeTime`) as the
high-frequency set, and they are kept as the same named group here for comparability — but on this
machine only **one** of the five (`pane.activity`) is actually high-frequency; the other four sum
to 88 lines total (0.0058% of lines). This machine's corpus is almost entirely tmux pane-content
polling, not agent/LLM tool activity — a real compositional difference from machine 1's dogfood
lane-fleet sessions, not a data-quality problem (see falsifier verdicts).

**Durable-fact percentage:** 0.10% of lines / 0.15% of bytes — **well under** machine 1's
6.81%/7.12%. This is the >2x-spread finding the issue's DoD calls out explicitly. See "Three-machine
table" below — machine 3 lands between the two, at 3.23%/2.86%.

### 3. Events per lane-hour → events per pane-hour (convention change, and why)

**[EXECUTED]** `"lane"` does not cleanly apply on this machine: across the full 1,527,962-line
census, only 95 lines (0.006%) carry a `"lane"` field at all — all 95 in the largest session file,
which grew to 277/980,057 (0.028%) by the later whole-machine snapshot. The other two real dirs
have **zero** lane-tagged lines. This machine's dominant real session
(`server-*/session-1787774200489.jsonl`) is a single long-running server-package session, not a
worktree-lane fleet — so the natural per-actor attribution unit here is the tmux **pane**
(`paneId`), which `pane.activity`, the dominant type, always carries. Using **events per pane-hour**
in place of events per lane-hour, matching the structure of machine 1's metric.

`server-*/session-1787774200489.jsonl` (977,293 events at copy time, 122.71 h span, 300 distinct
`paneId` values seen). Busiest hour by aggregate ratio (total events that hour ÷ distinct panes
active that hour):

| hour bucket | events | distinct panes | events/pane-hour |
|---|---:|---:|---:|
| 496705 | 30,944 | 22 | 1,406.5 |
| 496702 | 31,235 | 23 | 1,358.0 |
| 496683 | 32,404 | 26 | 1,246.3 |

Busiest single `(pane, hour)` bucket, not aggregated: `%657` at hour 496705/496637/496682 and
`%666`/`%990` at neighbouring hours, all around 1,796–1,799 events; full sort confirms no
`(pane,hour)` bucket anywhere in this file exceeds 5,000 (0 buckets found above that threshold).

### 4. Compression

**[EXECUTED]** `gzip -9 -k` and `xz -6 -k -T0` on the three copied logs, single-run each:

| file | orig bytes | gzip -9 bytes | gzip ratio | gzip ms | xz -6 bytes | xz ratio | xz ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| session-1786608181037.jsonl | 47,371,857 | 4,716,538 | 10.04x | 615 | 3,128,196 | 15.14x | 3,484 |
| session-1787532221601.jsonl | 106,818,786 | 15,785,622 | 6.77x | 1,560 | 10,998,844 | 9.71x | 6,800 |
| session-1787774200489.jsonl | 273,909,545 | 40,816,429 | 6.71x | 4,164 | 28,447,848 | 9.63x | 7,826 |

gzip -9 mean ≈ 7.84x; xz -6 mean ≈ 11.49x. The smallest of the three files (least dominated by
near-random `contentHash` hex strings) compresses noticeably better than the two pane-activity-heavy
larger ones — consistent with this machine's corpus being almost entirely `pane.activity` payloads,
whose `contentHash` field is a SHA-256-shaped hex string with little redundancy for gzip/xz to
exploit.

## Machine 3

Box: macOS (Apple Silicon, arm64), 8 logical cores, 8 GiB RAM — a materially smaller box than
machine 2, and the only one of the three where RAM is a real constraint on how many lanes run at
once. Load at run start: `2.70, 2.70, 4.02`. Date: 2026-09-01, snapshot 00:54:26 UTC.

**Method deviation, stated up front (two of them, both forced, neither affecting the numbers):**

1. **BSD `find`, not GNU.** This box has no `gfind`, so `find -printf '%s\n'` from the Reproduction
   section does not exist here; `find -type f -exec stat -f%z {} +` was substituted. Same bytes,
   different spelling — the macOS-adapted commands are in "Reproduction (machine 3)" below.
2. **No frozen copies; the logs were read in place.** The note's method copies the three largest
   logs into `~/rhizomorph-spikes/` and compresses the copies. Copying was unavailable in this
   environment, so the census, bucketing and compression all read the originals read-only and
   compression was **streamed** (`gzip -9 -c < file | wc -c`) rather than written to disk. This is
   safe here in a way it would not have been on machine 2: **[EXECUTED]** all three target logs
   have `mtime` of 2026-08-10 to 2026-08-12 and the corpus's latest event anywhere is
   2026-08-31 03:39:33 UTC, ~21 h before the run — nothing was being appended to, so there is no
   frozen-vs-live skew of the kind machine 2 had to report. Streaming measures the same bytes as
   `gzip -9 -k` (both are the deflate stream; only the ~18-byte gzip header/trailer and the file
   write differ), and timings are `/usr/bin/time -p` wall clock, so they are comparable to machine
   2's to within the same single-shot noise its note already warns about.

No writes to the corpus directory.

## Machine 3: results

### 1. Corpus census

**[EXECUTED]** Per-dir `find <dir> -type f -exec stat -f%z {} + | awk '{s+=$1}END{print s}'`, plus
a whole-machine pass, snapshotted 2026-09-01 00:54:26 UTC.

**This machine does have fixture litter, at a third rate again from both others.** 39 session dirs
total; 4 are test-harness dirs whose first event's `repoPath` points into a throwaway sandbox path
under `/private/tmp/.../scratchpad/` rather than a real checkout, and 35 are real. Classified the
same way machine 2's note classifies: by inspecting each dir's first event's `repoPath`.

| | dirs | bytes |
|---|---:|---:|
| real | 35 | 40,225,806 |
| fixture (sandbox `repoPath`) | 4 | 3,596,831 |
| **all** | **39** | **43,822,637** |

Fixture share: **10.3% of dirs, 8.21% of bytes** — against machine 1's 74% of dirs / 4.4% of bytes
and machine 2's zero. Note the inversion worth flagging: machine 1 has *far more* fixture dirs than
this box but they cost *proportionally less* (4.4% vs 8.21% of bytes), because this box's four
fixture dirs include one comparatively fat 2.7 MB verify-harness dir. **Fixture-dir count is not a
proxy for fixture-dir cost** on any of the three machines.

The four largest real dirs, by role:

| dir (role) | dir bytes | sessions |
|---|---:|---:|
| `rhizomorph-*` (main checkout) | 23,435,578 | 7 |
| `build-243-*` (a build lane) | 10,047,103 | 1 |
| `383-listbyhandle-key-*` (a worktree lane) | 4,004,299 | 5 |
| `prd22-w7-workmux-*` (a worktree lane) | 400,866 | 2 |

**[EXECUTED]** Whole-machine snapshot over the 35 real dirs (2026-09-01 00:54:26 UTC): session
`.jsonl` bytes 39,229,702; session `.jsonl` files 46; total events (line count, all real session
files) 108,639; earliest event 2026-08-10 00:37:52 UTC; latest event 2026-08-31 03:39:33 UTC; span
21.126 days.

- **Events/day (whole-corpus, span-based):** 108,639 / 21.126 ≈ **5,142 events/day**.
- **Bytes/day:** 39,229,702 / 21.126 ≈ **1.86 MB/day**.
- **Bytes/event (whole-corpus):** 39,229,702 / 108,639 ≈ **361.1 B/event**.

### 2. Global per-type census, three largest real logs

**[EXECUTED]** Three largest real logs (spanning two real dirs, as on machine 2):

```
10,237,870  rhizomorph-*/session-1786415166167.jsonl
10,034,972  build-243-*/session-1786411486413.jsonl
 9,664,429  rhizomorph-*/session-1786322272929.jsonl
```

Single-pass `awk` (the note's script, unmodified) over the concatenation of the three,
29,937,271 bytes / 79,266 lines total:

| type | lines | % lines | bytes | % bytes |
|---|---:|---:|---:|---:|
| pane.activity | 64,495 | 81.365% | 23,275,201 | 77.747% |
| llm.usage | 5,234 | 6.603% | 2,107,962 | 7.041% |
| trace.span | 3,816 | 4.814% | 2,521,508 | 8.423% |
| tool.activity | 2,066 | 2.606% | 884,792 | 2.956% |
| agent.activeTime | 1,097 | 1.384% | 290,291 | 0.970% |
| **"five high-frequency classes," same named group** | **76,708** | **96.773%** | **29,079,754** | **97.136%** |
| llm.cost | 854 | | 294,178 | |
| collector.disabled | 609 | | 131,040 | |
| agent.status | 286 | | 75,419 | |
| worktree.dirty | 189 | | 130,119 | |
| commit.landed | 164 | | 109,037 | |
| pane.discovered | 155 | | 58,662 | |
| pane.closed | 109 | | 11,199 | |
| branch.updated | 106 | | 29,299 | |
| worktree.discovered | 25 | | 7,632 | |
| branch.removed | 20 | | 2,232 | |
| judge.finding | 17 | | 4,348 | |
| collector.degraded | 9 | | 1,932 | |
| worktree.removed | 6 | | 936 | |
| collector.recovered | 4 | | 573 | |
| session.started | 3 | | 611 | |
| collector.error | 2 | | 300 | |
| **durable rest, subtotal (16 types)** | **2,558** | **3.227%** | **857,517** | **2.864%** |

**Unlike machine 2, this machine does have five high-frequency classes** — all five of machine 1's
named set are genuinely high-frequency here (the smallest, `agent.activeTime`, is still 1.38% of
lines, against 0.0058% for the four non-`pane.activity` members on machine 2). This box's corpus is
mixed agent/LLM lane work plus pane polling, structurally much closer to machine 1's dogfood
lane-fleet sessions than to machine 2's near-pure `pane.activity` server session.

Two type-level differences worth recording, neither affecting a headline number:

- **`collector.disabled` (609 lines) appears here and is absent from machine 2's census entirely.**
- **`telemetry.refused` is absent here**, where machine 2 explicitly recorded it at 0. Absent and
  zero are the same fact; noted so the row counts reconcile (16 durable types both times).

**Durable-fact percentage:** 3.23% of lines / 2.86% of bytes — **between** machine 1's 6.81%/7.12%
and machine 2's 0.10%/0.15%, and much nearer machine 1's end. See "The durable-fact spread" below;
this is the third point the issue asked for and it is not a tie-break, it is a continuum.

### 3. Events per lane-hour AND per pane-hour (both, because this machine supports both)

**[EXECUTED]** Machine 1 measured events per **lane**-hour; machine 2 could not (95 lane-tagged
lines in 1.5M) and substituted **pane**-hour. **This machine supports both**, so both are reported
— which is what lets the two prior notes be compared to each other for the first time rather than
only each to this one.

Lane coverage across the three census logs: 1,387 / 27,929 lane-tagged in the largest, 678 / 27,878
in the second, and **11,002 / 23,459 (46.9%)** in the third. Untagged lines bucket as `no-lane`,
the same convention machine 1 used (its own busiest bucket was a `no-lane` one).

Largest real session, `rhizomorph-*/session-1786415166167.jsonl` (27,929 events, 23.76 h span, 49
distinct `paneId`, 1,387 lane-tagged lines).

Busiest hour by aggregate ratio (events that hour ÷ distinct actors active that hour):

| unit | hour bucket | events | distinct actors | events/actor-hour |
|---|---|---:|---:|---:|
| **pane** | 496247 | 2,323 | 2 | **1,161.5** |
| pane | 496246 | 4,318 | 4 | 1,079.5 |
| pane | 496227 | 4,629 | 7 | 661.3 |
| **lane** | 496227 | 4,629 | 1 | **4,629.0** |
| lane | 496246 | 4,318 | 1 | 4,318.0 |
| lane | 496226 | 6,343 | 5 | 1,268.6 |

Busiest single bucket, not aggregated: **1,799** for `(pane %35, hour 496246)`; **5,942** for
`(no-lane, hour 496226)`. No `(pane,hour)` bucket anywhere in the file exceeds 5,000 (0 found),
matching machine 2.

**The lane figure is inflated by its own denominator and should not be read as a peak rate.** In
both top lane-hours the distinct-actor count is 1 — every event that hour was untagged, so the
"ratio" is just the hour's total event count. That is an artefact of lane tagging being sparse in
this particular session, not a real per-actor rate, and machine 1's 2,024.2 is likely subject to
the same effect for the same reason (its top bucket was also `no-lane`). **The pane row is the
trustworthy one**; the lane row is reported because the DoD asks for comparability with machine 1,
with this caveat attached rather than omitted.

### 4. The 1,799 ceiling is a poll interval, not a coincidence

**[EXECUTED]** Machine 2's busiest single pane-hour bucket was 1,799 and this machine's is also
**1,799** — on a different box, a different session, a different workload. That looked like a
coincidence worth checking, so it was checked: consecutive `pane.activity` timestamps for one pane
(`%35`, n=3,576 gaps) have **median 2,001 ms** (p05 1,985, p95 2,028, mean 2,071).

`pane.activity` is a **~2 s poll**, so a single pane cannot emit more than ~1,800 events in an
hour, and both machines are sitting on that ceiling rather than near each other by chance. This is
the most directly useful finding here for the thing PRD48 is actually sizing: **per-pane telemetry
cost is bounded and predictable**, not demand-driven. A server-side worst case is
`panes × hours × 1,800 × ~360 B/event` ≈ **648 KB per pane-hour**, and no amount of user activity
in a pane pushes it past that. It also explains machine 2's whole-corpus rate directly: that box's
volume comes from having ~300 panes, not from any pane being busier than this box's.

**[REASONED]** The two `> 1,800` bucket values on this machine are both `no-lane` lane-buckets
(5,942 and 4,979), which aggregate many panes into one bucket — consistent with the ceiling being
per-pane, not per-file. Machine 1's 4,183 `no-lane` bucket is the same shape. Not separately
executed: no per-pane gap distribution was taken on machines 1 or 2, so the 2 s interval is
confirmed on **this** machine and inferred (from the shared 1,799) for machine 2.

### 5. Compression

**[EXECUTED]** Streamed `gzip -9 -c`, `xz -6 -c -T0` and `zstd -19 -c -T0`, single run each,
`/usr/bin/time -p` wall clock, load 2.70 at start:

| file | orig bytes | gzip -9 | ratio | ms | xz -6 | ratio | ms | zstd -19 | ratio | ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| session-1786415166167.jsonl | 10,237,870 | 1,235,795 | 8.28x | 220 | 889,896 | 11.51x | 1,960 | 900,992 | 11.36x | 3,860 |
| session-1786411486413.jsonl | 10,034,972 | 1,201,714 | 8.35x | 220 | 870,444 | 11.53x | 1,340 | 876,630 | 11.45x | 3,330 |
| session-1786322272929.jsonl | 9,664,429 | 988,346 | 9.78x | 160 | 735,840 | 13.13x | 1,130 | 711,471 | 13.58x | 3,210 |

gzip -9 mean ≈ **8.80x**; xz -6 mean ≈ **12.06x**; zstd -19 mean ≈ **12.13x**.

**`zstd` closes a gap both prior notes named as untested.** At `-19` it lands statistically level
with `xz -6` (12.13x vs 12.06x mean) while costing ~2.5x the wall time in this single-shot run — so
on these corpora **`zstd -19` buys nothing over `xz -6`**, and the interesting comparison for a
server is `zstd` at a *low* level against `gzip`, which is still untested (see "What this did not
test"). Treat the timings as indicative only: single-shot, shared box, and `-T0` threading behaves
differently across the three compressors.

The same intra-machine pattern machine 2 reported holds here — the smallest of the three files
compresses best on all three compressors — but note it is **weaker** here (9.78x vs 8.28x, a 1.18x
spread) than the "noticeably better" machine 2 saw, consistent with this box's corpus being less
dominated by high-entropy `contentHash` strings.

## Three-machine table

Machine 1 = WSL2 Ubuntu, i9-13900H. Machine 2 = macOS Apple Silicon, 18 cores / 48 GiB.
Machine 3 = macOS Apple Silicon, 8 cores / 8 GiB. "Spread" is max ÷ min across all three.

| metric | machine 1 | machine 2 | machine 3 | spread | >2x? |
|---|---:|---:|---:|---:|:---:|
| real session dirs / fixture dirs | 26 real / 73 fixture (74% dirs, 4.4% bytes) | 3 real / 0 fixture | 35 real / 4 fixture (10.3% dirs, 8.21% bytes) | n/a | — |
| real corpus total bytes | 216,153,315 | 565,936,245 | 40,225,806 | **14.07x** | **yes** (scale) |
| **largest-session bytes/event** | **413.5** | **280.3** | **366.6** | **1.48x** | **no** |
| **3-log-census bytes/event** | **415.3** | **280.2** | **377.7** | **1.48x** | **no** |
| whole-corpus bytes/event | — | 283.1 | 361.1 | 1.28x | no |
| gzip -9 mean ratio | 10.3x | 7.84x | 8.80x | 1.31x | no |
| xz -6 mean ratio | 12.9x | 11.49x | 12.06x | 1.12x | no |
| zstd -19 mean ratio | — | — | 12.13x | n/a | — |
| largest-session events/day-equiv (ev / dur_h × 24) | 35,128 | 191,144 | 28,211 | **6.78x** | **yes** |
| whole-corpus events/day | — | 105,155 | 5,142 | **20.4x** | **yes** |
| whole-corpus MB/day | — | 29.77 | 1.86 | **16.0x** | **yes** |
| **durable-fact % of lines** | **6.81%** | **0.10%** | **3.23%** | **68x** | **yes** |
| **durable-fact % of bytes** | **7.12%** | **0.15%** | **2.86%** | **47x** | **yes** |
| peak events/lane-hour, aggregate | 2,024.2 | n/a (no lanes) | 4,629.0 ⚠ | 2.29x | see caveat |
| peak events/pane-hour, aggregate | n/a | 1,406.5 | 1,161.5 | 1.21x | no |
| busiest single (pane,hour) bucket | n/a | 1,799 | 1,799 | **1.00x** | no |
| busiest single (lane,hour) bucket | 4,183 (`no-lane`) | n/a | 5,942 (`no-lane`) | 1.42x | no |

⚠ The machine-3 lane-hour figure has a denominator of 1 and is not a real per-actor rate — see
"Events per lane-hour AND per pane-hour" above. Machine 1's is likely affected the same way.

**Machine 3 is the first machine that can be compared to both others on their own chosen unit** —
it has lanes (like machine 1) and enough panes to bucket (like machine 2), so the lane-hour and
pane-hour rows above finally sit on the same page rather than in two notes using two conventions.

### The named falsifier: bytes/event, PASSES on three points

The issue's falsifier: *"if machines 2 and 3 disagree with machine 1 by more than 2x on
bytes/event, the brief's §2 baseline is one box's habit and not a corpus."*

| framing | m1 | m2 | m3 | max ÷ min | verdict |
|---|---:|---:|---:|---:|:---|
| largest-session bytes/event | 413.5 | 280.3 | 366.6 | **1.48x** | PASS |
| 3-log-census bytes/event | 415.3 | 280.2 | 377.7 | **1.48x** | PASS |

**Verdict: PASS, and more strongly than it passed at two points.** Machine 3 lands *between* the
two prior machines (366.6 / 377.7 against machine 1's ~414 and machine 2's ~280), so it does not
widen the spread at all — the max and min are still machine 1 and machine 2, and the ratio is
unchanged at 1.48x, comfortably under the 2x trigger.

Two things this third point buys that the two-machine version could not:

1. **The spread is now interpolated, not just bounded.** With two points, 1.48x could have been two
   arbitrary values that happened to be close. With a third landing in the middle, ~280–415 B/event
   looks like a genuine band rather than a coincidence of two boxes.
2. **It holds across the largest compositional difference in the set.** Machine 3's durable-fact
   share (3.23%) is 32x machine 2's, and its type mix is close to machine 1's — yet its bytes/event
   sits *between* them rather than tracking composition. **Byte cost per event is roughly invariant
   to what the events are**, which is the property a storage-sizing model actually needs.

**For sizing, use bytes/event ≈ 280–415 B, centre ~360 B.** All three machines fall in it, on three
different workload shapes and two different OSes.

### The durable-fact spread: a continuum, not a coin flip

The DoD asked whether machine 3 lands near either end of machine 1's 6.81–7.12% vs machine 2's
0.10–0.15%, or somewhere else. **Somewhere else — in between, nearer machine 1.**

| | m1 | m3 | m2 |
|---|---:|---:|---:|
| durable-fact % of lines | 6.81% | **3.23%** | 0.10% |
| durable-fact % of bytes | 7.12% | **2.86%** | 0.15% |
| ratio to machine 3 | 2.11x / 2.49x above | — | 32x / 19x below |

The three points do not cluster at two poles, so the honest reading is **not** "machine 2 is the
odd one out and 4–7% is the real baseline". It is that durable-fact share is a **function of what
the machine was doing**, and it moves over more than two orders of magnitude:

- Machine 2's dominant session was one long-running server-package session — almost pure
  `pane.activity` (99.9% of lines), with LLM/tool/tracing classes essentially absent. 0.10%.
- Machine 3's sessions are mixed lane work — real `llm.usage` (6.6%), `trace.span` (4.8%),
  `tool.activity` (2.6%) traffic alongside pane polling. 3.23%.
- Machine 1's are dogfood lane-fleet sessions, denser still in agent activity. 6.81%.

The ordering tracks *agent/LLM activity per unit of pane polling*, monotonically, across all three.
That is a mechanism, not a spread.

**The consequence for PRD48 stands and is now better evidenced:** a retention plan that assumes
"durable facts are ~4% of the corpus" is wrong by up to 68x at one end of this cohort. **Durable
facts must be sized from the count of agent/LLM events a machine actually produces, never as a
percentage of total corpus bytes** — the percentage is not a property of Rhizomorph, it is a
property of the workload, and it is the single least portable number in this note.

By contrast, bytes/event (invariant, 1.48x) and the per-pane poll ceiling (~1,800 events/pane-hour,
identical on the two machines it could be measured on) *are* properties of Rhizomorph, and those
are the two numbers a shared server should be sized on.

### What the third machine changed

Recorded plainly, since two of these revise the machine-2 note rather than merely extending it:

- **The falsifier still passes** — unchanged verdict, stronger evidence (interpolated, not bounded).
- **"This machine does not have five high-frequency classes" was machine 2's finding, not a general
  one.** All five are high-frequency on machine 3. Machine 2 is the outlier of the three on
  composition, which the two-machine note could not have known.
- **Fixture-dir count does not predict fixture-dir cost** — machine 1 has 74% of dirs at 4.4% of
  bytes; machine 3 has 10.3% of dirs at 8.21% of bytes.
- **The 1,799 peak is a 2 s poll ceiling**, identified only because two machines hit the identical
  number. A two-machine note had the coincidence in it and did not resolve it.
- **`zstd` is no longer untested** — and at `-19` it is not worth its time over `xz -6`.

## What this did not test

Machine 2's gaps, as filed:

- **`server-*`'s largest session was still growing while that note was written.** The frozen copy
  used for its census (977,293 events, 273,909,545 bytes) is ~2 minutes older than its whole-machine
  snapshot (980,057 events in that same file). Both reported with their own timestamps.
- **No independent check that a differently-shaped real dir on machine 2 compresses or distributes
  types the same way** as the `server-*`/`rhizomorph-*` pair used for its census — its third real
  dir (18.9 MB, one session) was sized but not censused or compressed.
- **No repeat compression runs** — single-shot on a shared, loaded box.
- **Whether the `server-*` role's near-total `pane.activity` composition is typical** of a
  server-package checkout in general, or an artefact of one long-running session. Machine 3 does
  **not** settle this: it has no server-package session to compare against.

Machine 3's gaps:

- **No repeat compression runs**, same as both prior notes — single-shot, shared box. The gzip
  timings (160–220 ms) are short enough that scheduler noise is a material fraction of them; treat
  the *ratios* as solid and the *milliseconds* as indicative.
- **`zstd` at low levels is untested.** `-19` was run and is level with `xz -6`; the practically
  interesting question for a server — `zstd -3`-ish against `gzip -9`, where zstd is expected to
  win decisively on time at similar ratio — was not run, on any machine.
- **The 2 s poll interval was measured on one pane of one session on this machine only.** It is
  confirmed here and inferred for machine 2 from the shared 1,799 ceiling; it was not measured on
  machine 1 or 2 directly, and no check was made that the interval is configuration-independent.
- **Only the largest session was bucketed** by lane/pane-hour, as on machine 2 — the other two
  census logs were censused and compressed but not bucketed.
- **The lane-hour aggregate ratio is not a trustworthy peak rate on this machine** (denominator of
  1; see caveat above), and re-deriving machine 1's 2,024.2 under the same scrutiny would need
  machine 1's raw logs, which this dispatch did not have.
- **Three machines is still a small cohort, and all three are developer workstations** running the
  same team's dogfood workload. None is a CI box, a shared server, or a machine belonging to
  someone outside this repo — the durable-fact mechanism above says workload shape is what moves
  the numbers, so a fourth machine with a genuinely different *purpose* would be worth more than a
  fourth developer laptop.

## Reproduction (machine 2)

```bash
# whole-machine snapshot (all real dirs; this machine has no fixture-litter dirs to split out)
cd <corpus-dir>
find . -type f -printf '%s\n' | awk '{s+=$1}END{print "total_bytes",s}'
find . -maxdepth 2 -name 'session-*.jsonl' -printf '%s\n' | awk '{s+=$1}END{print "session_jsonl_bytes",s}'
find . -maxdepth 2 -name 'session-*.jsonl' -exec wc -l {} + | tail -1
for f in $(find . -maxdepth 2 -name 'session-*.jsonl'); do
  head -1 "$f" | grep -o '"ts":[0-9]*' | head -1 | cut -d: -f2
  tail -1 "$f" | grep -o '"ts":[0-9]*' | head -1 | cut -d: -f2
done | sort -n | sed -n '1p;$p'

# three largest real logs -> build area
mkdir -p ~/rhizomorph-spikes/s1-corpus-m2/logs
cp <dir>/session-<largest1>.jsonl <dir>/session-<largest2>.jsonl <dir>/session-<largest3>.jsonl \
   ~/rhizomorph-spikes/s1-corpus-m2/logs/

# per-type census (identical script to machine 1's note)
cd ~/rhizomorph-spikes/s1-corpus-m2/logs
awk '{
  len=length($0)+1
  if (match($0,/"type":"[^"]*"/)) t=substr($0,RSTART+8,RLENGTH-9); else t="UNKNOWN"
  cnt[t]++; byt[t]+=len
} END { for (t in cnt) printf "%s\t%d\t%d\n", t, cnt[t], byt[t] }' \
  session-*.jsonl

# pane-hour buckets (paneId in place of lane — see "Events per lane-hour")
awk '{
  if (match($0,/"ts":[0-9]+/)) hour=int(substr($0,RSTART+5,RLENGTH-5)/3600000); else next
  pane="no-pane"
  if (match($0,/"paneId":"[^"]*"/)) pane=substr($0,RSTART+10,RLENGTH-11)
  print hour"\t"pane
}' session-<largest>.jsonl | sort | uniq -c | sort -rn | head

# compression
gzip -9 -k -f session-*.jsonl
xz -6 -k -f -T0 session-*.jsonl
```

Build area used: `~/rhizomorph-spikes/s1-corpus-m2/`.

## Reproduction (machine 3)

Same measurements, adapted for BSD userland and read-in-place. Run from the corpus directory; all
of it is read-only.

```bash
cd <corpus-dir>

# 1. classify each dir real vs fixture by its first event's repoPath
for d in */; do d=${d%/}
  f=$(find "$d" -maxdepth 1 -name 'session-*.jsonl' | head -1)
  [ -z "$f" ] && { printf '%s\tNO-SESSION\n' "$d"; continue; }
  printf '%s\t%s\n' "$d" "$(head -1 "$f" | grep -o '"repoPath":"[^"]*"' | head -1 | cut -d'"' -f4)"
done
# a fixture dir is one whose repoPath is a throwaway sandbox path, not a real checkout

# 2. per-dir bytes (BSD find has no -printf)
find <dir> -type f -exec stat -f%z {} + | awk '{s+=$1}END{print s+0}'

# 3. whole-machine snapshot over REAL dirs only (list them in realdirs.txt)
while read -r d; do find "$d" -maxdepth 2 -name 'session-*.jsonl'; done < realdirs.txt > realsessions.txt
xargs stat -f%z < realsessions.txt | awk '{s+=$1}END{print "session_jsonl_bytes",s}'
xargs wc -l    < realsessions.txt | tail -1
while read -r f; do
  head -1 "$f" | grep -o '"ts":[0-9]*' | head -1 | cut -d: -f2
  tail -1 "$f" | grep -o '"ts":[0-9]*' | head -1 | cut -d: -f2
done < realsessions.txt | sort -n | sed -n '1p;$p'

# 4. confirm the target logs are static before reading them in place
stat -f'%z %Sm %N' -t'%Y-%m-%dT%H:%M:%SZ' <largest1> <largest2> <largest3>

# 5. per-type census — the note's script, unmodified, over the originals
awk '{
  len=length($0)+1
  if (match($0,/"type":"[^"]*"/)) t=substr($0,RSTART+8,RLENGTH-9); else t="UNKNOWN"
  cnt[t]++; byt[t]+=len; TL++; TB+=len
} END { for (t in cnt) printf "%s\t%d\t%d\t%.4f\t%.4f\n", t, cnt[t], byt[t], 100*cnt[t]/TL, 100*byt[t]/TB
        printf "TOTAL\t%d\t%d\n", TL, TB }' <largest1> <largest2> <largest3> | sort -t$'\t' -k2,2rn

# 6. per-file events / duration / distinct panes / lane-tagged lines
awk '{ n++
  if (match($0,/"ts":[0-9]+/)) { t=substr($0,RSTART+5,RLENGTH-5)+0; if(!mn||t<mn)mn=t; if(t>mx)mx=t }
  if (match($0,/"paneId":"[^"]*"/)) panes[substr($0,RSTART+10,RLENGTH-11)]=1
  if ($0 ~ /"lane"/) lane++
} END { for(p in panes) np++
  printf "events=%d dur_h=%.2f panes=%d lane_lines=%d\n", n, (mx-mn)/3600000, np, lane+0 }' <largest>

# 7. aggregate ratio per hour — swap paneId/lane to switch unit
awk '{ if (match($0,/"ts":[0-9]+/)) hour=int(substr($0,RSTART+5,RLENGTH-5)/3600000); else next
  k="no-pane"; if (match($0,/"paneId":"[^"]*"/)) k=substr($0,RSTART+10,RLENGTH-11)
  ev[hour]++; seen[hour"\t"k]++
} END { for (x in seen) { split(x,a,"\t"); nk[a[1]]++ }
  for (h in ev) printf "%s\t%d\t%d\t%.1f\n", h, ev[h], nk[h], ev[h]/nk[h] }' <largest> \
  | sort -t$'\t' -k4,4rn | head

# 8. the poll-interval check behind the 1,799 ceiling
grep '"paneId":"<pane>"' <largest> | grep '"type":"pane.activity"' \
  | grep -o '"ts":[0-9]*' | cut -d: -f2 \
  | awk 'NR>1{d=$1-p; if(d>0&&d<10000) print d} {p=$1}' | sort -n \
  | awk '{a[NR]=$1; s+=$1} END{printf "n=%d median=%d mean=%.0f p05=%d p95=%d\n",
      NR, a[int(NR/2)], s/NR, a[int(NR*0.05)+1], a[int(NR*0.95)]}'

# 9. compression, streamed (writes nothing; safe because the logs are static)
/usr/bin/time -p sh -c 'gzip -9    -c    < <log> | wc -c'
/usr/bin/time -p sh -c 'xz   -6    -c -T0 < <log> | wc -c'
/usr/bin/time -p sh -c 'zstd -19   -c -T0 < <log> 2>/dev/null | wc -c'
```

No build area was used on machine 3 — nothing was copied and nothing was written.
