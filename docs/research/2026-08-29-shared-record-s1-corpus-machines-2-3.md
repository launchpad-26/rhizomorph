# s1-corpus — telemetry cost on machines 2 and 3

**Scope note, stated up front:** this note carries every machine measured after machine 1's
original brief (`2026-08-28-shared-record-s1-corpus.md`). Machine 2 arrived with #165; machine 3
with #189. The three-machine table the wave asked for now exists, and the named falsifier is
re-verdicted with three data points.

The note is **structured to keep growing**: each machine gets its own `## Machine N` section, and
the cross-machine table at the bottom gets one more column. Adding a fourth machine is an additive
edit, and the "Still outstanding" section says which fourth machine would be worth the most. Do not
treat the arrival of machine 3 as closing that door — see "Still outstanding".

## Machine 2 (macOS, Apple Silicon)

Box: macOS (Apple Silicon, arm64, per `uname -a`'s `RELEASE_ARM64_T6050`), 18 logical cores, 48 GiB
RAM. Load at run start: `6.10, 7.12, 10.15` (10:38 NZST); at compression step: `4.19, 5.49, 8.88`
(10:41 NZST). Date: 2026-09-01. Named by role ("machine 2"), not by hostname, per this repo's rule
against committing a real machine's identity.

### What ran (machine 2)

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

### Results (machine 2)

#### 1. Corpus census

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

#### 2. Global per-type census, three largest real logs

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
6.81%/7.12%. This is the >2x-spread finding the issue's DoD calls out explicitly. See "Two-machine
table" below.

#### 3. Events per lane-hour → events per pane-hour (convention change, and why)

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

#### 4. Compression

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

## Machine 3 (WSL2 Ubuntu, AMD Ryzen 7 5800X)

Box: WSL2 Ubuntu on Windows, AMD Ryzen 7 5800X (8c/16t host), `nproc`=12 visible to WSL,
23 GiB RAM visible to WSL. Load at the compression step: `3.35, 2.45, 1.44` (untimed first run)
and `4.62, 2.86, 1.62` (the timed run whose numbers are reported below), both 2026-09-01 ~12:15
NZST. **Load at the census step was not captured** — an omission against machine 1's and machine
2's format, recorded here rather than back-filled from a later reading. Date: 2026-09-01. Named by
role ("machine 3"), not by hostname, per this repo's rule against committing a real machine's
identity.

This is a **third, distinct** box, not machine 1 re-measured: machine 1's note records `nproc`=6
and 31 GiB on an i9-13900H host, against 12 and 23 GiB on a Ryzen 7 5800X here, and the two
machines' dir-hash suffixes differ for the same repo name. It is, however, the **same OS family
and the same workload shape** as machine 1 — see the confound called out under the durable-fact
verdict below.

### What ran (machine 3)

1. Read-only walk of `~/.local/share/rhizomorph` (9 session dirs), split into real and fixture by
   reading each dir's first event's `repoPath`.
2. `awk` single-pass per-type count+bytes census over the three largest **real** session logs —
   all three in the same real dir, as on machine 1.
3. `awk` bucketing of the largest real session log by `ts→hour`, by `(hour,lane)` (machine 1's
   unit) **and** by `(hour,paneId)` (machine 2's unit), since this machine carries both fields.
4. `gzip -9` and `xz -6 -T0` on those same three logs.

**Deviation from the two earlier notes, stated rather than hidden:** machine 3 did **not** copy the
logs to a build area first. The three source files' mtimes are 2026-08-11, 2026-08-18 and
2026-08-27 — none is the file currently being appended to — so there was nothing to freeze, and
compression ran as `gzip -9 -c <src> > <scratch>` / `xz -6 -T0 -c <src> > <scratch>`, reading the
corpus and writing only to a throwaway scratch dir. No writes to `~/.local/share/rhizomorph`.

**This machine's corpus is also live.** `rhizomorph-*/session-1788207588315.jsonl` grew from
2,554,469 to 2,683,393 bytes over the ~7 minutes this note's measurements took. It is not one of
the three census logs; the whole-machine totals below are a single timestamped snapshot and the
per-type census is over three files that did not move.

**Locale caveat, and it changes the numbers.** Under `LANG=en_US.UTF-8`, GNU awk's `length()`
counts *characters*, not bytes. Run that way the per-type census totalled 57,770,700 bytes against
a true file-size sum of 57,895,247 — a 0.22% undercount, because this machine's `pane.activity`
payloads carry multibyte UTF-8 (box-drawing and similar in captured pane content). Every machine-3
byte figure below was produced under `LC_ALL=C` and reconciles exactly with `stat`. Machine 2's
census total matches its file sizes exactly, so that note is unaffected; anyone re-running this on
a UTF-8 box should set `LC_ALL=C` or their bytes will be quietly low.

### Results (machine 3)

#### 1. Corpus census

**[EXECUTED]** `find <dir> -type f -printf '%s\n' | awk '{s+=$1}END{print s}'` per dir, 9 dirs
total, snapshotted 2026-09-01 00:08:58 UTC.

Fixture litter is present but negligible: 4 of 9 dirs (44.4%) are fixtures, holding 102,957 bytes
— **0.12% of the corpus**. Confirmed by `repoPath`: `plain-repo-*` (two dirs) point at
`/tmp/tmp.*/watched/plain-repo`, the path-encoding harness machine 1 documented; `e2e-repo-*` and
`live235-repo-*` point at repos built inside an agent scratch dir. So all three machines now
disagree on fixture litter (74% of dirs / 4.4% of bytes on machine 1; none on machine 2; 44% of
dirs / 0.12% of bytes here) and on all three it is a rounding error by *bytes*.

| dir (role) | dir bytes | sessions | largest session bytes | largest session events | dur (h) | distinct panes | lane-tagged lines |
|---|---:|---:|---:|---:|---:|---:|---:|
| `rhizomorph-*` (main checkout) | 85,697,956 | 7 | 22,043,666 | 53,698 | 72.27 | 76 | 34,669 |
| `43-red-leg-reports-*` (a worktree lane) | 85,995 | 1 | 25,571 | 84 | 0.00 | 15 | 4 |
| `server-*` (server package) | 85,436 | 1 | 20,823 | 70 | 0.01 | 6 | 11 |
| `_rev-a-*` (a worktree lane) | 77,884 | 1 | 17,101 | 57 | 0.00 | 15 | 0 |
| `worktrees-challenge-*` (another repo) | 44,650 | 1 | 21,720 | 70 | 0.00 | 32 | 0 |
| **total (5 real dirs, fixtures excluded)** | **85,989,935** | **11** | — | **230,647** (all session files) | — | — | — |

One dir is 99.7% of the corpus; the other four are minutes-long sessions. Unlike machine 2, the
dominant session is **lane-tagged**: 34,669 of 53,698 lines (64.6%) carry a `"lane"` field, against
machine 1's 48.2% and machine 2's 0.028%.

**[EXECUTED]** Whole-machine snapshot (2026-09-01 00:08:58 UTC), real dirs only: total bytes across
all files 85,989,935 (82.0 MiB); session `.jsonl` bytes 85,197,623; session `.jsonl` files 11; total
events (line count, all session files) 230,647; earliest event 2026-08-06 23:36:42 UTC; latest event
2026-09-01 00:08:42 UTC; span 25.022 days.

- **Events/day (whole-corpus, span-based):** 230,647 / 25.022 ≈ **9,218 events/day**.
- **Bytes/day:** 85,197,623 / 25.022 ≈ **3.40 MB/day**.
- **Bytes/event (whole-corpus):** 85,197,623 / 230,647 ≈ **369.4 B/event**.

#### 2. Global per-type census, three largest real logs

**[EXECUTED]** Three largest real logs globally, all in `rhizomorph-*` (as on machine 1, unlike
machine 2):

```
22,043,666  rhizomorph-*/session-1787526914634.jsonl
19,635,388  rhizomorph-*/session-1786837993748.jsonl
16,216,193  rhizomorph-*/session-1786059402007.jsonl
```

Single-pass `awk` under `LC_ALL=C` over the three, 57,895,247 bytes / 155,653 lines total:

| type | lines | % lines | bytes | % bytes |
|---|---:|---:|---:|---:|
| pane.activity | 80,704 | 51.849% | 23,833,531 | 41.167% |
| llm.usage | 28,512 | 18.318% | 11,552,723 | 19.955% |
| trace.span | 16,008 | 10.284% | 10,620,882 | 18.345% |
| tool.activity | 14,348 | 9.218% | 5,687,374 | 9.824% |
| agent.activeTime | 5,144 | 3.305% | 1,372,605 | 2.371% |
| **"five high-frequency classes," same named group as machines 1 and 2** | **144,716** | **92.974%** | **53,067,115** | **91.661%** |
| llm.cost | 3,643 | | 1,260,825 | |
| worktree.dirty | 1,944 | | 1,567,285 | |
| agent.status | 1,810 | | 419,734 | |
| commit.landed | 879 | | 718,421 | |
| branch.updated | 836 | | 267,734 | |
| judge.finding | 769 | | 288,789 | |
| pane.discovered | 199 | | 70,760 | |
| worktree.discovered | 195 | | 59,726 | |
| collector.error | 181 | | 77,549 | |
| pane.closed | 156 | | 16,058 | |
| worktree.removed | 152 | | 25,657 | |
| collector.disabled | 92 | | 42,566 | |
| branch.removed | 62 | | 7,557 | |
| collector.degraded | 9 | | 3,821 | |
| collector.recovered | 4 | | 574 | |
| telemetry.refused | 3 | | 503 | |
| session.started | 3 | | 573 | |
| **durable rest, subtotal (17 types)** | **10,937** | **7.027%** | **4,828,132** | **8.339%** |

**Here the five high-frequency classes really are five.** All five appear in volume (the smallest,
`agent.activeTime`, is 5,144 lines) — machine 1's shape, not machine 2's, where four of the five
summed to 88 lines. Two type-vocabulary differences worth recording: `collector.disabled` (92 lines)
appears here and is absent from machine 2's census; `agent.removed` appears on machine 2 and has
**zero** lines here. `telemetry.refused` is non-zero here (3 lines) and zero on machine 2.

**Durable-fact percentage:** 7.03% of lines / 8.34% of bytes — machine 1's neighbourhood
(6.81% / 7.12%), not machine 2's (0.10% / 0.15%). See the durable-fact verdict below.

#### 3. Events per lane-hour, and per pane-hour

**[EXECUTED]** `rhizomorph-*/session-1787526914634.jsonl` (53,698 events, 72.27 h span). 34,669 of
53,698 lines (64.6%) carry `"lane"`; only 16,358 (30.5%) carry `"paneId"`, because the
llm/tool/trace classes that dominate this machine are session-scoped, not pane-scoped. **Lane is
the meaningful unit here — the inverse of machine 2**, where `paneId` was the only usable one. Both
are reported so each earlier note has a like-for-like row.

Busiest hours by aggregate ratio (total events that hour ÷ distinct lanes active that hour):

| hour bucket | events | distinct lanes | events/lane-hour |
|---|---:|---:|---:|
| 496581 | 2,821 | 4 | 705.2 |
| 496583 | 3,399 | 5 | 679.8 |
| 496557 | 3,350 | 5 | 670.0 |

Same file bucketed by pane, for machine-2 comparability: peak aggregate 1,410.5 events/pane-hour
(hour 496581, 2,821 events ÷ 2 distinct panes) — but that denominator is small precisely because
most events have no pane, so treat it as a comparability row, not this machine's real rate.

Busiest single `(lane, hour)` bucket, not aggregated: `51-symlink-verdict-pinned` at hour 496581,
1,547 events; busiest `no-lane` bucket 1,361 at hour 496583. Busiest single real `(pane, hour)`
bucket: `%68` at hour 496583, 989 events. **Full sorts confirm no `(lane,hour)` and no `(pane,hour)`
bucket anywhere in this file exceeds 5,000** (0 buckets found above that threshold on either
grouping) — machine 1's stated ceiling holds on a third machine.

#### 4. Compression

**[EXECUTED]** `gzip -9 -c` and `xz -6 -T0 -c` on the three logs, single-run each, load
`4.62, 2.86, 1.62`:

| file | orig bytes | gzip -9 bytes | gzip ratio | gzip ms | xz -6 bytes | xz ratio | xz ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| session-1786059402007.jsonl | 16,216,193 | 1,728,965 | 9.38x | 335 | 1,366,540 | 11.87x | 4,990 |
| session-1786837993748.jsonl | 19,635,388 | 3,078,726 | 6.38x | 524 | 2,321,076 | 8.46x | 9,240 |
| session-1787526914634.jsonl | 22,043,666 | 2,211,102 | 9.97x | 443 | 1,686,480 | 13.07x | 5,830 |

gzip -9 mean ≈ 8.58x; xz -6 mean ≈ 11.13x. xz costs ~13x the wall-clock of gzip for ~25–30% better
ratio — machine 1 measured ~10x for ~25%, so the trade is stable in shape across boxes.

**[EXECUTED]** The middle file is the outlier in both columns (6.38x / 8.46x against 9.38–9.97x /
11.87–13.07x), and machine 2's stated cause — `pane.activity`'s hash-shaped payload resisting
gzip/xz — predicts exactly that ordering here. Per-file `pane.activity` share of bytes:

| file | pane.activity % of bytes | gzip ratio | xz ratio |
|---|---:|---:|---:|
| session-1787526914634.jsonl | 20.4% | 9.97x | 13.07x |
| session-1786059402007.jsonl | 37.8% | 9.38x | 11.87x |
| session-1786837993748.jsonl | 67.2% | 6.38x | 8.46x |

Monotone in both compressors, three points, on a machine whose corpus composition is otherwise
nothing like machine 2's. That makes "compression ratio is a function of `pane.activity` share"
a cross-machine mechanism rather than one box's coincidence, and it is the reason machine 2 —
99.85% `pane.activity` by bytes — has the worst mean ratio of the three.

## Three-machine table (machines 1, 2 and 3)

| metric | machine 1 (WSL2 Ubuntu, i9-13900H) | machine 2 (macOS, Apple Silicon) | machine 3 (WSL2 Ubuntu, Ryzen 7 5800X) | spread (max/min) | >2x? |
|---|---:|---:|---:|---:|:---:|
| real session dirs / fixture dirs | 26 real / 73 fixture (74% dirs, 4.4% bytes) | 3 real / 0 fixture | 5 real / 4 fixture (44% dirs, 0.12% bytes) | n/a | — |
| real corpus total bytes | 216,153,315 (206.1 MiB) | 565,936,245 (539.8 MiB) | 85,989,935 (82.0 MiB) | 6.58x | yes (scale, not a red flag) |
| largest-session bytes/event | 413.5 | 280.3 | 410.5 | 1.48x | **no** |
| 3-log-census bytes/event | 415.3 | 280.2 | 372.0 | 1.48x | **no** |
| whole-corpus bytes/event | not reported | 283.1 | 369.4 | 1.30x | **no** |
| gzip -9 mean ratio | 10.3x | 7.84x | 8.58x | 1.31x | no |
| xz -6 mean ratio | 12.9x | 11.49x | 11.13x | 1.16x | no |
| largest-session events/day-equivalent (events / dur_h × 24) | 35,128 (63,653 ev / 43.5 h) | 191,144 (977,293 ev / 122.7 h) | 17,833 (53,698 ev / 72.27 h) | **10.72x** | **yes** |
| whole-corpus events/day | not reported | 105,155 | 9,218 | **11.41x** | **yes** |
| whole-corpus bytes/day | not reported | 29.77 MB | 3.40 MB | **8.76x** | **yes** |
| durable-fact % of lines | 6.81% | 0.10% | 7.03% | **70x** | **yes** (2 of 3 agree) |
| durable-fact % of bytes | 7.12% | 0.15% | 8.34% | **56x** | **yes** (2 of 3 agree) |
| lines carrying a `lane` field (largest session) | 48.2% | 0.028% | 64.6% | n/a | — |
| peak events/lane-hour, aggregate ratio | 2,024.2 | not usable (no lanes) | 705.2 | 2.87x | yes |
| peak events/pane-hour, aggregate ratio | not reported | 1,406.5 | 1,410.5 | **1.003x** | **no** |
| busiest single (lane/pane, hour) bucket, raw count | 4,183 (`no-lane`) | 1,799 (`%657`) | 1,547 (`51-symlink-verdict-pinned`) | 2.70x | yes |
| any bucket > 5,000 events? | no | no | no | — | — |

Machine 3 is a **whole order of magnitude smaller** than either earlier machine on every
volume-shaped row and a near-exact match on every cost-shaped one. That split is the finding: the
metrics that vary 7–11x across boxes are all *how much work happened*, and the metrics that vary
1.0–1.5x are all *what one event costs*. A shared server has to be sized on the first and can
budget on the second.

### The named falsifier: bytes/event — PASSES with three points

The issue's falsifier is bytes/event specifically: *"if machines 2 and 3 disagree with machine 1 by
more than 2x on bytes/event, the brief's §2 baseline is one box's habit and not a corpus."*

| framing | m1 | m2 | m3 | spread | verdict |
|---|---:|---:|---:|---:|:---|
| largest session | 413.5 | 280.3 | 410.5 | 1.48x | PASS |
| 3-log census | 415.3 | 280.2 | 372.0 | 1.48x | PASS |
| whole corpus | — | 283.1 | 369.4 | 1.30x | PASS |

**Verdict: PASS on all three framings, with three machines.** The widest gap anywhere is 1.48x,
and it is machine 2 against the other two rather than a drift — machines 1 and 3 sit within 1.01x
of each other on the largest-session framing (413.5 vs 410.5). Machine 2's ~280 B/event is the low
end and is explained, not anomalous: it is the machine whose corpus is 99.85% `pane.activity`, the
cheapest event class per line. **~280–415 B/event is a real corpus constant, not one box's habit.**
For sizing purposes, ~400 B/event is a safe planning number and ~280 B/event a floor for a
pane-polling-dominated box.

### The durable-fact spread, with a third point — machine 2 is the outlier, and the cause is workload, not OS

Machine 2's note raised the 47–68x durable-fact spread as the open question a third machine would
settle. It is settled in machine 1's direction:

| | m1 | m2 | m3 |
|---|---:|---:|---:|
| durable-fact % of lines | 6.81% | 0.10% | **7.03%** |
| durable-fact % of bytes | 7.12% | 0.15% | **8.34%** |

Machines 1 and 3 agree within 1.03x on lines and 1.17x on bytes. Machine 2 is 70x below both.
**Two of three land at ~7–8%; the "durable facts are a few percent of the corpus" baseline
survives, and machine 2 is the case that needs explaining rather than the rule.**

**[REASONED]** The mechanism is visible in the type census and is about *what the session was
doing*, not what it ran on. Durable facts ride along with agent and LLM activity —
`llm.usage`, `trace.span`, `tool.activity`, `commit.landed`, `judge.finding`. A session driving a
worktree-lane fleet emits all of them; a long-lived session that is mostly polling tmux pane content
emits `pane.activity` and almost nothing else. Machine 2's dominant session is the second kind
(0.028% of lines lane-tagged); machines 1 and 3's are the first (48.2% and 64.6%).

**The confound, stated plainly, because this data cannot remove it:** machines 1 and 3 are *both*
WSL2 Ubuntu boxes *and* both lane-fleet workloads. Machine 2 differs on both axes at once. So the
correlation is real but the attribution to workload rather than OS is reasoning from the type
census, not something these three data points can separate. **The measurement that would separate
them is a fourth machine that breaks the pairing** — a macOS box running a lane fleet, or a Linux
box running a long server-package session. Until one exists, read "workload shape drives
durable-fact share" as the best-supported explanation, not a demonstrated one.

Practical consequence for the shared record, unchanged from machine 2's note and now better
evidenced: a retention plan that assumes "durable facts are ~7% of the corpus" is right for two of
three machines and wrong by ~70x for the third, so retention must be driven by *event type*, never
by a percentage-of-corpus rule of thumb.

## Still outstanding

Machine 3's numbers are in, so the note's original "Machine 3: not yet measured" gap is closed and
the three-machine table the wave asked for exists. Two things are deliberately still open, and
**#189 should not be closed on this note alone**:

- **More machines are wanted, not merely welcome.** The table now has three points and one clean
  2-vs-1 split whose cause is confounded (above). Any contributor with a real
  `~/.local/share/rhizomorph` can append a machine by following "Reproduction" below and adding one
  column — the sections are structured per machine so that is an additive edit.
- **The confound-breaking machine specifically:** macOS running a worktree-lane fleet, or Linux
  running a long-lived server-package session. That single data point converts the durable-fact
  finding from `[REASONED]` to `[EXECUTED]`.

## What this did not test

### Machine 2

- **`server-*`'s largest session was still growing while this note was written.** The frozen copy
  used for census/pane-hour/compression (977,293 events, 273,909,545 bytes) is ~2 minutes older
  than the whole-machine snapshot (980,057 events in that same file). Both are reported with their
  own timestamps rather than merged into one inconsistent number.
- **No independent check that a differently-shaped real dir on this machine compresses or
  distributes types the same way as the `server-*`/`rhizomorph-*` pair used for the census** — the
  third real dir (`262-clone-by-url-*`, 18.9 MB, one session) was sized but not put through the
  per-type census or compression.
- **No repeat compression runs** — single-shot on a shared, loaded box (load 4.2–8.9 during the
  compression step), same caveat machine 1's note carries.
- **No `zstd`** — not checked here either, same gap as machine 1.
- **Whether the `server-*` role's near-total `pane.activity` composition is typical of a
  server-package checkout in general, or an artefact of this one long-running session** — one
  session file is not enough to tell those apart, and this note does not attempt to.

### Machine 3

- **Load at the census step was not captured** — only at the compression step. The census is
  `awk` over 58 MB and is not load-sensitive in the way the compression timings are, but the
  earlier notes record both readings and this one records one.
- **The four small real dirs were sized but not censused.** 99.7% of this machine's bytes are in
  one dir, and the per-type census, lane-hour bucketing and compression all ran on three logs from
  that dir. Whether a minutes-long lane session has the same type mix as a 72-hour one is untested
  here — the four small dirs total 293,965 bytes, so it changes no total, but it means "machine 3's
  composition" is really "machine 3's dominant session's composition", the same caveat machine 2's
  note carries about `server-*`.
- **No repeat compression runs** — single-shot, load 4.62/2.86/1.62, same caveat as both earlier
  notes. The gzip timings here (335–524 ms) are short enough that scheduler noise is a larger
  share of them than on either earlier machine.
- **No `zstd`** — the same gap on all three machines now. Worth closing on whichever machine goes
  fourth, since `zstd -19` is the option that would actually be reached for in a shipper.
- **The workload-vs-OS confound behind the durable-fact result** — see the verdict section. Not a
  gap in this machine's measurement; a gap in what three machines can prove.
- **Nothing was re-run after the corpus grew.** One session file gained ~129 KB mid-run; the
  reported totals are a single snapshot at 2026-09-01 00:08:58 UTC, not a settled corpus.

## Reproduction

```bash
# whole-machine snapshot (all real dirs; this machine has no fixture-litter dirs to split out)
cd ~/.local/share/rhizomorph
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

### Machine 3 addendum — three changes, each of which changes a number

Run the block above as written, then apply these. They are not style preferences; the first two
alter the results.

**1. `LC_ALL=C` on every `awk`, or your byte counts are low.** GNU awk's `length()` is
character-based under a UTF-8 locale, and `pane.activity` payloads carry multibyte content:

```bash
LC_ALL=C awk '{ len=length($0)+1; ... }' session-*.jsonl
```

On machine 3 this was the difference between 57,770,700 (wrong) and 57,895,247 (matches `stat`) over
three files — 0.22%. Check it rather than trust it: the census byte total **must** equal the sum of
the files' sizes plus nothing. If it does not, you are counting characters.

**2. Bucket by `lane` as well as `paneId`, and report whichever your corpus actually carries.**
Machine 2 had no lanes; machine 3 has lanes on 64.6% of lines and panes on only 30.5%. Reporting
one unit only makes a machine incomparable with half the table.

```bash
LC_ALL=C awk '{
  if (match($0,/"ts":[0-9]+/)) h=int(substr($0,RSTART+5,RLENGTH-5)/3600000); else next
  l="no-lane"; if (match($0,/"lane":"[^"]*"/)) l=substr($0,RSTART+8,RLENGTH-9)
  print h"\t"l
}' <largest>.jsonl | sort | uniq -c | sort -rn | head
```

Report both the **aggregate ratio** (events that hour ÷ distinct actors that hour) and the
**busiest single (actor, hour) bucket** — the table has a row for each, and they answer different
questions.

**3. Skip the copy if nothing is growing; never write into the corpus dir.** Check `stat -c '%s %y'`
on your three largest logs first. If none is the file currently being appended to, compress in place
with `-c` and a redirect, which keeps the corpus strictly read-only:

```bash
gzip -9   -c "$src" > "$scratch/$(basename "$src").gz"
xz   -6 -T0 -c "$src" > "$scratch/$(basename "$src").xz"
```

Note the earlier block's `gzip -9 -k -f session-*.jsonl` writes `.gz` files **next to the input** —
fine in a copied build area, wrong if you point it at `~/.local/share/rhizomorph`.

**Timing gotcha:** `date +%s%3N` is not honoured everywhere — on machine 3 it emitted full
nanoseconds (19 digits), silently turning millisecond figures into nonsense. Use `date +%s%N` and
divide by 1,000,000 in the shell, and sanity-check that the digit count is 19, not 13.

**Then:** add a `## Machine N` section in this note's shape, add one column to the three-machine
table, and re-state the bytes/event verdict with your point included.
