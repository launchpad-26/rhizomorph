# s1-corpus — telemetry cost on machines 2, 3 and 4

**Scope note, stated up front:** this note now covers machine 2, machine 3, **and a fourth
machine**. It was filed on 2026-08-29 covering machine 2 only, with machine 3 recorded as an open
item under Ruling 1 ("a spike that overruns its budget files its partial note ... silence is not a
result"); machine 3 was measured on 2026-09-01 and folded in (#189, commit `a4c92f2`) — that work is
**unchanged by this update**. A fourth, independently-measured machine (gabriel-canaan, posted as a
GitHub comment on issue #189 on 2026-09-01) is folded in here, **additively**: nothing about machine
1, 2 or 3's own numbers or sections is altered. The three-machine table the wave-1 DoD asked for
already existed; this update extends it to four points.

All four machines are named by role ("machine 2", "machine 3", "machine 4"), never by hostname, and
no real home path appears below — this repo's rule against committing a real machine's identity.
Machine 4's numbers are gabriel-canaan's own, posted as "numbers only — no verdicts or conclusions
drawn"; every comparison, falsifier re-verdict and spread call involving machine 4 below is this
note's addition, graded `[REASONED]`, built on their `[EXECUTED]` figures.

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

## Machine 4

No CPU, RAM, OS or load-average figures were reported for this machine — unlike machines 1–3, all
of which state a box spec. This is a real gap in what can be claimed about it (see "What this did
not test"), not an oversight in transcription: the source comment states machine identifiers,
absolute timestamps and wall-clock timings were deliberately omitted.

## Machine 4: what ran

**[EXECUTED — gabriel-canaan, issue #189 comment, 2026-09-01]** Posted as "numbers only — no
verdicts or conclusions drawn here." Per the comment: "All executed read-only against a live
`~/.local/share/rhizomorph`, per the machine-2 note's Reproduction block. `awk` run under `LC_ALL=C`
(byte totals reconcile exactly with `stat`)." No copies, no method deviations reported, and no
"Reproduction (machine 4)" section is added below — the comment states it reused "Reproduction
(machine 2)" unmodified.

## Machine 4: results

### 1. Corpus census

**[EXECUTED — gabriel-canaan]**

```
dirs                     9  (5 real, 4 fixture)
fixture dirs             4   (44.4% of dirs)
fixture bytes      102,957   (0.12% of corpus)
fixture sessions         4   189 lines

real dirs                5
real files              83
real bytes      85,989,935   (82.0 MiB)
real sessions           11
session bytes   85,197,623
total events       230,647
corpus span         25.022 days

events/day           9,218
bytes/day          3.40 MB
bytes/event          369.4
```

| dir (role) | dir bytes | sessions | largest session bytes | largest session events | dur (h) | distinct panes | lane-tagged lines |
|---|---:|---:|---:|---:|---:|---:|---:|
| main project checkout | 85,697,956 | 7 | 22,043,666 | 53,698 | 72.27 | 76 | 34,669 |
| worktree lane A | 85,995 | 1 | 25,571 | 84 | 0.00 | 15 | 4 |
| server package | 85,436 | 1 | 20,823 | 70 | 0.01 | 6 | 11 |
| worktree lane B | 77,884 | 1 | 17,101 | 57 | 0.00 | 15 | 0 |
| an unrelated repo | 44,650 | 1 | 21,720 | 70 | 0.00 | 32 | 0 |
| **total (5 real)** | **85,989,935** | **11** | — | **230,647** | — | — | — |

Fixture dirs identified by `repoPath` on each dir's first event, same method as machines 2 and 3:
two `plain-repo-*` point at a `/tmp/tmp.*/watched/plain-repo` sandbox path, the other two at repos
built inside an agent scratch dir — no real home path in either.

**[REASONED] Reconciliation flag, not silently smoothed over:** the five dir-bytes figures above sum
to 85,991,921, which is 1,986 bytes (0.0023%) **more** than the reported "real bytes" total of
85,989,935 that the comment's bytes/event, MiB and MB/day figures are all derived from and reconcile
against exactly (verified below). The itemized table and the top-line total disagree by a small,
immaterial amount — most likely a between-snapshot difference of the kind machine 2's note already
flags for its own live corpus (per-dir bytes and the whole-machine total taken at slightly different
moments), though that is inference, not confirmed here. The 85,989,935 figure is used throughout
this note wherever "machine 4 real bytes" is needed, since it is the one every derived figure
(bytes/event, MiB, MB/day) was checked against and matches.

**[REASONED] Every other subtotal in this machine's numbers reconciles exactly:** fixture dirs
(4/9 = 44.4%, matches), fixture bytes (102,957 / (85,989,935+102,957) = 0.12%, matches), sessions
(7+1+1+1+1 = 11, matches), bytes/event (85,197,623 / 230,647 ≈ 369.4, matches), bytes/day
(85,197,623 / 25.022 ≈ 3.40 MB, matches), events/day (230,647 / 25.022 ≈ 9,218, matches), and real
bytes in MiB (85,989,935 / 1,048,576 ≈ 82.0 MiB, matches). The dir-table discrepancy above is the
only one found.

### 2. Global per-type census, three largest real logs

**[EXECUTED — gabriel-canaan]** All three logs sit in the same real dir (the main project
checkout): 57,895,247 bytes / 155,653 lines, bytes/event 372.0.

| type | lines | % lines | bytes | % bytes |
|---|---:|---:|---:|---:|
| pane.activity | 80,704 | 51.849 | 23,833,531 | 41.167 |
| llm.usage | 28,512 | 18.318 | 11,552,723 | 19.955 |
| trace.span | 16,008 | 10.284 | 10,620,882 | 18.345 |
| tool.activity | 14,348 | 9.218 | 5,687,374 | 9.824 |
| agent.activeTime | 5,144 | 3.305 | 1,372,605 | 2.371 |
| **five high-frequency classes** | **144,716** | **92.974** | **53,067,115** | **91.661** |
| **durable rest (17 types)** | **10,937** | **7.027** | **4,828,132** | **8.339** |

**[REASONED] This reconciles exactly**, both ways: the five-class and durable-rest subtotals sum to
155,653 lines / 57,895,247 bytes (the stated census total), and independently, summing the 17
individual durable-rest line items given in the source comment (`llm.cost` through `session.started`)
gives 10,937 lines / 4,828,132 bytes on the nose — the same two numbers the comment states as the
subtotal. No smoothing needed here.

`agent.removed` = 0 on this machine (stated); `collector.disabled` = 92.

**Like machine 3, and unlike machine 2, this machine has genuine five-high-frequency-class
composition** — all five of machine 1's named set are real percentages here, not one dominant class
with the other four near zero. Machine 4's non-`pane.activity` share of the five classes
(18.318 + 10.284 + 9.218 + 3.305 = 41.125% of lines) is larger than machine 3's equivalent
(6.603 + 4.814 + 2.606 + 1.384 = 15.407%), making machine 4 the most agent/LLM-dense of the three
machines whose per-type breakdown is available in this note (machine 1's own breakdown is not
reproduced here, only its aggregate durable-fact %). See "The durable-fact spread" below for what
this does to the four-machine ordering.

### 3. Events per lane-hour and per pane-hour

**[EXECUTED — gabriel-canaan]** Largest session (main project checkout, 53,698 events, 72.27 h):
64.6% of lines carry `lane` (34,669 / 53,698), 30.5% carry `paneId` (16,358 / 53,698) — real
coverage on both axes, as on machine 3.

| | events | lanes | ev/lane-hour |
|---|---:|---:|---:|
| peak lane-hour 1 | 2,821 | 4 | 705.2 |
| peak lane-hour 2 | 3,399 | 5 | 679.8 |
| peak lane-hour 3 | 3,350 | 5 | 670.0 |

| | events | panes | ev/pane-hour |
|---|---:|---:|---:|
| peak pane-hour 1 | 2,821 | 2 | 1,410.5 |
| peak pane-hour 2 | 3,208 | 3 | 1,069.3 |
| peak pane-hour 3 | 2,880 | 3 | 960.0 |

```
busiest single (lane,hour)   1,547
busiest no-lane bucket       1,361
busiest single (pane,hour)     989
buckets > 5,000 events           0   (both groupings)
```

**[REASONED] Unlike machine 3's lane-hour figure, this one is not a denominator-of-1 artefact:**
machine 4's three peak lane-hour buckets have real multi-lane denominators (4, 5, 5), not 1. That
makes 705.2 the first lane-hour aggregate-ratio figure in this note's whole four-machine set that is
not suspected of being inflated by an all-untagged hour — see "peak events/lane-hour" in the table
below. It also reports its overall busiest (lane,hour) bucket, 1,547, separately from its busiest
`no-lane`-only bucket, 1,361 — the two are not the same query. Machines 1 and 3 report only a single
figure under "busiest single (lane,hour) bucket," which is their **overall** busiest bucket, and it
happens to be a `no-lane` one on both. Machine 4's overall busiest bucket (1,547) is what maps
directly onto machine 1's and 3's figures, not the no-lane-restricted one — see the four-machine
table below.

### 4. Compression

**[EXECUTED — gabriel-canaan]** `gzip -9`, `xz -6 -T0`, single run each. No per-run timing (ms) and
no `zstd` run were reported for this machine.

| file | orig | gzip -9 | ratio | xz -6 | ratio | pane.activity % bytes |
|---|---:|---:|---:|---:|---:|---:|
| log C | 16,216,193 | 1,728,965 | 9.38x | 1,366,540 | 11.87x | 37.8 |
| log B | 19,635,388 | 3,078,726 | 6.38x | 2,321,076 | 8.46x | 67.2 |
| log A | 22,043,666 | 2,211,102 | 9.97x | 1,686,480 | 13.07x | 20.4 |

gzip -9 mean 8.58x; xz -6 mean 11.13x.

**[REASONED] Reconciles exactly:** each ratio (orig ÷ compressed) matches the stated per-file value,
and the mean of the three gzip ratios is 8.577 ≈ 8.58x, the mean of the three xz ratios is
11.133 ≈ 11.13x — both match the comment's stated means.

The "pane.activity % bytes" column has no counterpart in machine 2's or 3's compression tables — a
per-machine-4-only figure, not forced into the shared four-machine table below.

## Four-machine table

Machine 1 = WSL2 Ubuntu, i9-13900H. Machine 2 = macOS Apple Silicon, 18 cores / 48 GiB.
Machine 3 = macOS Apple Silicon, 8 cores / 8 GiB. Machine 4 = specs not reported (gabriel-canaan,
issue #189 comment). "Spread" is max ÷ min across all four. Machine 1–3 columns are unchanged from
the three-machine table Ciaran Slow committed in `a4c92f2`; only the machine 4 column, and the
spread/>2x columns, are new.

| metric | machine 1 | machine 2 | machine 3 | machine 4 | spread | >2x? |
|---|---:|---:|---:|---:|---:|:---:|
| real session dirs / fixture dirs | 26 real / 73 fixture (74% dirs, 4.4% bytes) | 3 real / 0 fixture | 35 real / 4 fixture (10.3% dirs, 8.21% bytes) | 5 real / 4 fixture (44.4% dirs, 0.12% bytes) | n/a | — |
| real corpus total bytes | 216,153,315 | 565,936,245 | 40,225,806 | 85,989,935 | **14.07x** | **yes** (scale) |
| **largest-session bytes/event** | **413.5** | **280.3** | **366.6** | **410.5** | **1.48x** | **no** |
| **3-log-census bytes/event** | **415.3** | **280.2** | **377.7** | **372.0** | **1.48x** | **no** |
| whole-corpus bytes/event | — | 283.1 | 361.1 | 369.4 | 1.30x | no |
| gzip -9 mean ratio | 10.3x | 7.84x | 8.80x | 8.58x | 1.31x | no |
| xz -6 mean ratio | 12.9x | 11.49x | 12.06x | 11.13x | 1.16x | no |
| zstd -19 mean ratio | — | — | 12.13x | — | n/a | — |
| largest-session events/day-equiv (ev / dur_h × 24) | 35,128 | 191,144 | 28,211 | 17,832 | **10.72x** | **yes** |
| whole-corpus events/day | — | 105,155 | 5,142 | 9,218 | **20.4x** | **yes** |
| whole-corpus MB/day | — | 29.77 | 1.86 | 3.40 | **16.0x** | **yes** |
| **durable-fact % of lines** | **6.81%** | **0.10%** | **3.23%** | **7.03%** | **70.3x** | **yes** |
| **durable-fact % of bytes** | **7.12%** | **0.15%** | **2.86%** | **8.34%** | **55.6x** | **yes** |
| peak events/lane-hour, aggregate | 2,024.2 | n/a (no lanes) | 4,629.0 ⚠ | 705.2 | **6.56x** (2.87x excl. m3 ⚠) | **yes** (see ⚠) |
| peak events/pane-hour, aggregate | n/a | 1,406.5 | 1,161.5 | 1,410.5 | 1.21x | no |
| busiest single (pane,hour) bucket | n/a | 1,799 | 1,799 | 989 | 1.82x | no |
| busiest single (lane,hour) bucket | 4,183 (`no-lane`) | n/a | 5,942 (`no-lane`) | 1,547 | **3.84x** | **yes** |

⚠ The machine-3 lane-hour figure has a denominator of 1 and is not a real per-actor rate — see
"Events per lane-hour AND per pane-hour" above. Machine 1's is likely affected the same way. Machine
4's is not: its three peak lane-hour buckets have real multi-lane denominators (4, 5, 5), so 705.2 is
the first lane-hour aggregate-ratio figure in this set not suspected of being an artefact. Excluding
the flagged machine-3 value, machine 1 vs machine 4 alone is 2,024.2 / 705.2 = **2.87x** — still
over the 2x line on a same-unit, non-degenerate comparison.

Machine 4 also separately reports its busiest `no-lane`-only bucket, 1,361 — smaller than its
overall busiest bucket (1,547), meaning the largest single bucket on this machine happens to carry a
real lane tag, unlike on machines 1 and 3 where the overall largest bucket is the `no-lane` one. The
1,361 figure has no counterpart on machines 1 or 3 (they report only their overall busiest bucket,
not a `no-lane`-restricted one), so it is not forced into the row above.

**Machine 3 is the first machine that can be compared to both others on their own chosen unit** —
it has lanes (like machine 1) and enough panes to bucket (like machine 2), so the lane-hour and
pane-hour rows above finally sit on the same page rather than in two notes using two conventions.
Machine 4 adds a second such machine, and its multi-lane-denominator lane-hour figure is arguably
the more trustworthy of the two.

**Two rows newly cross the 2x line with a fourth point that did not with three:** the busiest single
(lane,hour) bucket (was 1.42x at three machines, machine 3 vs machine 1; is 3.84x at four, machine 3
vs machine 4's 1,547) and the peak lane-hour aggregate ratio (was 2.29x machine 1 vs machine 3,
already flagged as caveated; is 6.56x at four, or 2.87x on the reliable pair alone). Neither is the
named falsifier — see below — but both are >2x spreads the DoD's general instruction to call out
per-machine differences would catch.

### The named falsifier: bytes/event, PASSES on four points

The issue's falsifier: *"if machines 2 and 3 disagree with machine 1 by more than 2x on
bytes/event, the brief's §2 baseline is one box's habit and not a corpus."* Machine 4 is not named
in the issue's original wording (it predates machine 4's data existing at all), but the same test
applies to it by extension: does it also stay inside 2x of machine 1?

| framing | m1 | m2 | m3 | m4 | max ÷ min | verdict |
|---|---:|---:|---:|---:|---:|:---|
| largest-session bytes/event | 413.5 | 280.3 | 366.6 | 410.5 | **1.48x** | PASS |
| 3-log-census bytes/event | 415.3 | 280.2 | 377.7 | 372.0 | **1.48x** | PASS |

**Verdict: PASS, unchanged, and machine 4 does not widen the spread either.** Machine 4 lands close
to machine 1 on the largest-session framing (410.5 vs 413.5) and mid-band on the 3-log-census
framing (372.0, between machine 3's 377.7 and machine 2's 280.2). The max and min across all four
points are still machine 1 and machine 2 in both framings, so the ratio is unchanged at 1.48x.

A corroborating framing not part of the issue's named test (machine 1 has no equivalent figure, so
it cannot be the falsifier itself): whole-corpus bytes/event is 283.1 (m2), 361.1 (m3), 369.4 (m4) —
a 1.30x spread across the three machines where it can be computed at all, consistent with the same
band.

Three things this fourth point buys that the three-machine version could not:

1. **The spread is now interpolated by two independent points, not one.** Machine 3 landing in the
   middle could have been one coincidence; machine 4 landing near the top of the same band, on a
   compositionally very different corpus, makes the band itself the more likely explanation.
2. **It holds across the widest compositional swing in the set, not just the second-widest.**
   Machine 4's durable-fact share (7.03%/8.34%) is now the highest of all four machines — higher
   than machine 1's, and 70x machine 2's — yet its bytes/event sits *inside* the same 280–415 B
   band, not above it. **Byte cost per event is invariant to what the events are**, even at the
   extreme of composition, which is the property a storage-sizing model actually needs.
3. **It holds without hardware or OS information for machine 4 at all.** Machines 1–3 differ by OS
   and CPU; machine 4's box is unknown entirely. That the byte-cost band holds even when a data
   point's hardware can't be checked is a mild additional point in favour of it being a property of
   the event format, not of any one machine's disk, filesystem, or encoding.

**For sizing, use bytes/event ≈ 280–415 B, centre ~360 B — unchanged from the three-machine
conclusion.** All four machines fall in it, on four different workload shapes, at least two
different OSes (a third, unknown), and now including the machine with the highest durable-fact
share of the cohort.

### The durable-fact spread: a continuum, not a coin flip — now with a new top end

The three-machine version of this note found machine 3 landing between machine 1's 6.81–7.12% and
machine 2's 0.10–0.15%, nearer machine 1. **Machine 4 does not land in that gap. It lands past
machine 1, becoming the new top of the continuum.**

| | m4 | m1 | m3 | m2 |
|---|---:|---:|---:|---:|
| durable-fact % of lines | **7.03%** | 6.81% | 3.23% | 0.10% |
| durable-fact % of bytes | **8.34%** | 7.12% | 2.86% | 0.15% |
| step ratio to next column | 1.03x / 1.17x | 2.11x / 2.49x | 32.3x / 19.1x | — |

Span across all four (max ÷ min): **70.3x on lines, 55.6x on bytes.**

This ordering — 0.10% < 3.23% < 6.81% < 7.03% on lines, 0.15% < 2.86% < 7.12% < 8.34% on bytes — is
itself directly checkable from the four percentages above; it does not depend on machine 1's
per-type breakdown, which is not reproduced in this note. It is monotonic across all four points,
same as the three-machine finding, with machine 4 marginally ahead of machine 1 rather than tied
with or below it.

The mechanism the three-machine note proposed still explains the ordering wherever a per-type
breakdown is available (machines 2, 3 and 4):

- Machine 2's dominant session was one long-running server-package session — almost pure
  `pane.activity` (99.9% of lines), with LLM/tool/tracing classes essentially absent. 0.10%.
- Machine 3's sessions are mixed lane work — real `llm.usage` (6.6%), `trace.span` (4.8%),
  `tool.activity` (2.6%) traffic alongside pane polling. 3.23%.
- Machine 4's sessions are more agent/LLM-dense still: `llm.usage` (18.3%), `trace.span` (10.3%),
  `tool.activity` (9.2%), `agent.activeTime` (3.3%) — a non-`pane.activity` share of the five
  high-frequency classes (41.1%) more than double machine 3's (15.4%). 7.03%.
- Machine 1's are dogfood lane-fleet sessions; its own per-type breakdown is not in this note, so
  where it sits on this same axis cannot be checked directly, only inferred from its durable-fact %
  landing just under machine 4's.

**The consequence for PRD48 stands and is now better evidenced, with a wider worst case:** a
retention plan that assumes "durable facts are ~4% of the corpus" is now wrong by up to **70x**
(was 68x) at one end of this cohort. **Durable facts must be sized from the count of agent/LLM
events a machine actually produces, never as a percentage of total corpus bytes** — the percentage
is not a property of Rhizomorph, it is a property of the workload, and it remains the single least
portable number in this note.

By contrast, bytes/event (invariant, 1.48x at four points) is still a property of Rhizomorph, and
the per-pane poll ceiling finding needs a small revision rather than a restatement: machine 4's
busiest single pane-hour bucket is 989, well under the ~1,800 ceiling machines 2 and 3 both hit
exactly. That is **consistent with, not a counter-example to**, the ceiling theory — a ceiling caps
the maximum a pane *can* reach, it does not require every machine's busiest hour to reach it, and
989 < 1,800 is exactly what "under the cap" looks like. Bytes/event and the ceiling remain the two
numbers a shared server should be sized on; durable-fact share should not be one of them.

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

### What the fourth machine changed

Recorded the same way, against the three-machine table in `a4c92f2` (which this update leaves
unchanged):

- **The falsifier still passes** — unchanged verdict, and machine 4 does not widen the spread; it
  lands close to machine 1 on one framing and mid-band on the other.
- **Machine 1 is no longer the top of the durable-fact continuum.** Machine 4 sits marginally above
  it (7.03%/8.34% vs 6.81%/7.12%), so the ordering is a continuum with machine 4 at one end, not
  "machine 1 as ceiling, machine 2 as floor."
- **Two rows newly cross the 2x line that did not at three machines:** the busiest single
  (lane,hour) bucket (1.42x → 3.84x) and the peak lane-hour aggregate ratio (2.29x, already caveated
  → 6.56x, or 2.87x excluding the flagged machine-3 value). Neither is the named falsifier.
- **The 1,799 poll-ceiling finding is not falsified, but is no longer "identical on every machine
  that measured it."** Machine 4's busiest pane-hour bucket is 989 — under the ceiling, which is
  consistent with a cap rather than a target.
- **Machine 4 supplies the first lane-hour aggregate-ratio figure with a real (non-1) denominator**,
  making it arguably more trustworthy than either machine 1's or machine 3's equivalent figure.
- **A small, unresolved reconciliation gap**: machine 4's itemized real-dir bytes sum to 1,986 bytes
  (0.0023%) more than its reported real-bytes total. Flagged, not corrected — see "Corpus census"
  above.
- **No hardware, OS or load information exists for machine 4** — the first machine in this note
  where that is true. Every claim above is about its telemetry output only.

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

Machine 4's gaps:

- **No hardware, OS or load-average figures at all** — the source comment states these were
  deliberately omitted, along with machine identifiers, absolute timestamps and wall-clock timings.
  No claim in this note about machine 4 depends on its hardware, but it also means no claim about
  hardware *can* be made — unlike machines 1–3, there is no way to say whether this box was loaded
  during the run.
- **No compression timing (ms) and no `zstd` run.** The ratios reconcile exactly against the
  reported bytes; there is nothing to check the *speed* claims against, because none were made.
- **Not independently re-executed.** These are gabriel-canaan's own read-only numbers, posted to
  the issue; this note's author verified the arithmetic (subtotals, ratios, percentages, MiB/MB
  conversions) against the numbers as posted, but did not re-run the commands on that machine —
  same evidentiary status this note already gives machine 1's figures, which are also cited rather
  than re-executed by whoever writes the comparison.
- **A small, unresolved dir-bytes reconciliation gap** (1,986 bytes / 0.0023%) between the itemized
  per-dir table and the reported real-bytes total — see "Corpus census" above. Immaterial to every
  conclusion drawn (all derived figures use the reported total, which is internally consistent with
  bytes/event, MiB and MB/day), but not silently corrected.
- **Four machines is still a small cohort of developer workstations** — see machine 3's gap above,
  which now applies with one more data point rather than fewer.

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
