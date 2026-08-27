# s1-corpus — telemetry cost on this machine (events, bytes, fact-classes, compression)

Box: WSL2 Ubuntu, `nproc`=6 visible to WSL (host i9-13900H/20c per brief), 31 GiB.
Load at run start: `4.85, 2.75, 1.31` (05:22 NZST); at compression step: `4.58, 3.46, 1.80` (05:25 NZST).
Date: 2026-08-28.

## What ran

1. Read-only walk of `~/.local/share/rhizomorph` (99 session dirs), split fixture litter from real dirs by inspecting each family's `repoPath` in its first event.
2. `awk` single-pass per-type count+bytes census over the three largest **real** session logs (copied to `~/rhizomorph-spikes/s1-corpus/logs/`, all three turned out to belong to the same real dir, `worktrees-challenge-71202028`).
3. `awk` bucketing of the largest real single session log by `ts→hour` and by `(hour,lane)`.
4. `gzip -9` and `xz -6` on the same three copies.

Build area: `~/rhizomorph-spikes/s1-corpus/logs/`. No writes to `~/.local/share/rhizomorph`. No docker needed for this lane.

## Results

### 1. Corpus census

**[EXECUTED]** `find <dir> -type f -printf '%s\n' | awk '{s+=$1}END{print s}'` per dir, 99 dirs total.

Fixture-litter families, confirmed by `repoPath` (all point at `/tmp/tmp.*/watched/...`, the path-encoding test harness — `café-世界-repo`, `a repo with spaces`, `plain-repo`):

| family | dirs | files | bytes |
|---|---:|---:|---:|
| `a-repo-with-spaces-*` | 24 | — | — |
| `plain-repo-*` | 24 | — | — |
| `caf----repo-*` (not in brief's named list — same fixture shape/size/`repoPath` family as the two above, added by evidence) | 24 | — | — |
| `server-*` (brief-named; the one instance found, `server-7eefb3e1`, has a real-looking `repoPath` under `worktrees-challenge__worktrees/194/packages/server` but is a single 220-byte session-started-only file — trivial either way) | 1 | — | — |
| **fixture total** | **73** | **559** | **10,016,393 (9.6 MB)** |

Real dirs:

| | |
|---|---:|
| dirs | 26 |
| files (all, incl. snapshots/locks) | 350 |
| total bytes | 216,153,315 (206.1 MB) |
| session `.jsonl` files | 47 |
| session `.jsonl` bytes | 157,812,261 (150.5 MB) |

Fixture litter is 73/99 = 74% of dirs but only 4.4% of bytes — dir count is a bad proxy for corpus weight here.

**[EXECUTED]** Per-real-dir table (sorted by dir bytes desc; `lg_*` = stats of that dir's largest single session file; `dur_h` = span of that largest session's first→last `ts`; `lanes` = distinct `"lane"` values seen in it):

| dir | dir bytes | sessions | largest session bytes | largest session events | dur (h) | distinct lanes |
|---|---:|---:|---:|---:|---:|---:|
| rhizomorph-5189ebfe | 118,954,567 | 14 | 15,656,535 | 31,724 | 54.6 | 33 |
| worktrees-challenge-71202028 | 74,058,851 | 8 | 26,325,198 | 63,653 | 43.5 | 51 |
| 197-ded3d806 | 12,079,569 | 1 | 12,072,199 | 35,608 | 40.8 | 2 |
| e-scene-8bfca38e | 4,223,301 | 1 | 4,174,474 | 14,801 | 55.8 | 2 |
| primordium-772f51a2 | 2,109,664 | 2 | 2,040,880 | 5,623 | 45.3 | 1 |
| agenticlaunchpad-af889083 | 1,415,307 | 1 | 1,398,299 | 5,861 | 25.1 | 0 |
| 119-rename-33a0126f | 851,365 | 1 | 851,365 | 2,390 | 12.5 | 1 |
| a1-orphan-sweep-17c8ae42 | 573,102 | 1 | 539,845 | 1,708 | 0.3 | 3 |
| cd-surfaces-0e1aba09 | 347,876 | 1 | 303,036 | 870 | 1.1 | 2 |
| a3-doorstep-bc9992a4 | 333,199 | 1 | 296,026 | 796 | 1.0 | 3 |
| (16 smaller real dirs, each <300 KB, 0–7 lanes) | ~40,000 combined | 1 each | — | — | — | — |

Two largest real dirs (rhizomorph-5189ebfe, worktrees-challenge-71202028) hold 193 MB of the 206.1 MB real total — 93.6% concentrated in two dirs (both are dogfood/lane-fleet activity, not toy runs).

**Not counted above, flagged as a scope gap**: `rhizomorph-5189ebfe/transcripts/` holds per-agent raw LLM transcript `.jsonl` files (one seen at 17.25 MB alone) that are a *different* data class from the top-level `session-*.jsonl` telemetry event log this brief asks about. Not included in any figure here — see "What this did not test."

### 2. Global per-type census, three largest real logs

**[EXECUTED]** All three largest real logs turned out to be the three largest session files inside `worktrees-challenge-71202028` (globally largest real logs were checked across all 26 real dirs, not just per-dir maxima):

```
26,325,198  worktrees-challenge-71202028/session-1785739192605.jsonl
24,279,447  worktrees-challenge-71202028/session-1785929533332.jsonl
16,884,964  worktrees-challenge-71202028/session-1785895666938.jsonl
```

Single-pass `awk` (regex-extract `"type":"..."`, `length($0)+1` for bytes incl. newline) over the concatenation of the three, 67,009,621 bytes / 161,391 lines total, 0.58s wall:

| type | lines | % lines | bytes | % bytes |
|---|---:|---:|---:|---:|
| pane.activity | 67,675 | 41.9% | 24,335,535 | 36.3% |
| llm.usage | 34,573 | 21.4% | 12,885,257 | 19.2% |
| trace.span | 29,618 | 18.4% | 19,104,907 | 28.5% |
| tool.activity | 9,928 | 6.2% | 3,770,625 | 5.6% |
| agent.activeTime | 8,611 | 5.3% | 2,145,666 | 3.2% |
| **five above, subtotal** | **150,405** | **93.19%** | **62,241,990** | **92.88%** |
| llm.cost | 6,369 | | 2,089,080 | |
| worktree.dirty | 1,458 | | 1,071,926 | |
| commit.landed | 1,268 | | 1,098,816 | |
| branch.updated | 801 | | 249,164 | |
| agent.status | 317 | | 87,865 | |
| pane.discovered | 204 | | 72,174 | |
| pane.closed | 180 | | 18,524 | |
| judge.finding | 117 | | 26,984 | |
| worktree.discovered | 95 | | 27,721 | |
| worktree.removed | 84 | | 13,090 | |
| branch.removed | 69 | | 7,510 | |
| collector.disabled | 16 | | 3,314 | |
| session.started | 3 | | 606 | |
| collector.recovered | 2 | | 290 | |
| collector.degraded | 2 | | 400 | |
| telemetry.refused | 1 | | 167 | |
| **durable rest, subtotal (14 types)** | **10,986** | **6.81%** | **4,767,631** | **7.12%** |

### 3. Events per lane-hour, largest single real log

**[EXECUTED]** `worktrees-challenge-71202028/session-1785739192605.jsonl` (63,653 events, 43.5 h span). 30,702/63,653 lines (48.2%) carry a `"lane"` field; the rest are session/collector-scoped events with no lane attribution (bucketed separately as `no-lane`, excluded from the lane-count denominator, included in the numerator).

Busiest hour by aggregate ratio (total events that hour ÷ distinct real lanes active that hour):

| hour bucket | UTC start | events | distinct lanes | events/lane-hour |
|---|---|---:|---:|---:|
| 496058 | 2026-08-04 02:00 | 12,145 | 6 | 2,024.2 |
| 496067 | 2026-08-04 11:00 | 3,460 | 2 | 1,730.0 |
| 496057 | 2026-08-04 01:00 | 5,547 | 4 | 1,386.8 |

Busiest single `(lane, hour)` bucket, not aggregated: `no-lane` at hour 496058, 4,183 events; busiest **named**-lane bucket: `159-connective-tissue` at hour 496058, 3,170 events. Full per-(lane,hour) sort confirms no bucket anywhere in this file exceeds 5,000.

### 4. Compression

**[EXECUTED]** `gzip -9 -k` and `xz -6 -k -T0` on the three copied logs, single-run each (not repeated for variance — see gaps):

| file | orig bytes | gzip -9 bytes | gzip ratio | gzip ms | xz -6 bytes | xz ratio | xz ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| session-1785739192605.jsonl | 26,325,198 | 2,736,690 | 9.61x | 714 | 2,170,388 | 12.12x | 7,188 |
| session-1785895666938.jsonl | 16,884,964 | 1,617,106 | 10.44x | 460 | 1,291,412 | 13.07x | 7,107 |
| session-1785929533332.jsonl | 24,279,447 | 2,243,952 | 10.81x | 740 | 1,801,304 | 13.47x | 6,038 |

gzip -9 mean ≈ 10.3x; xz -6 mean ≈ 12.9x. xz costs ~10x the wall-clock of gzip for ~25% better ratio.

## Falsifier verdicts

| falsifier | verdict | decided by |
|---|---|---|
| high-frequency classes <70% of lines? | **PASS** (does not trigger — concentration claim holds) | 93.19% of lines / 92.88% of bytes in the 5 named classes, measured over 161,391 lines |
| compression <4x? | **PASS** (does not trigger) | gzip 9.61x–10.81x, xz 12.12x–13.47x across all three logs |
| any lane-hour >5k events? | **PASS** (does not trigger) | max per-(lane,hour) bucket = 4,183 events (`no-lane`), max named-lane bucket = 3,170 (`159-connective-tissue`), both at hour 496058 |
| three-machine requirement | **UNRESOLVED, stated plainly** | this is one machine (WSL2, i9-13900H box) — nothing here speaks to cross-machine variance in event mix, lane concurrency, or compressibility |

## What this did not test

- **One machine only.** No comparison point for whether the type-mix, lane-hour peak, or compression ratio generalize — the plan's three-machine requirement is untouched by this note.
- **`transcripts/` excluded.** `rhizomorph-5189ebfe/transcripts/` (per-agent raw LLM transcripts, one file alone at 17.25 MB) is a distinct data class from the `session-*.jsonl` telemetry event log this brief scopes to. Not sized, not typed, not compressed here — if telemetry cost is meant to include transcript storage, this note undercounts real-dir bytes substantially (rhizomorph-5189ebfe's true footprint is more than the 118.9 MB reported, which already includes transcripts/ in the *directory* total but not in the jsonl-only breakdown used for §2–4).
- **Type census and compression both drawn from the same real dir** (`worktrees-challenge-71202028` happened to hold all three globally-largest real logs). No independent check that a differently-shaped repo's telemetry compresses or distributes types the same way — `rhizomorph-5189ebfe`, `197-ded3d806`, and `e-scene-8bfca38e` were not put through §2/§4.
- **No repeat runs.** Compression timings are single-shot on a shared, loaded box (other lanes running concurrently, load 3.4–4.9) — treat the ms figures as rough, the ratios (deterministic given the algorithm/level) as solid.
- **`server-*` fixture classification is shaky.** The one instance found has a real-looking `repoPath`, unlike the other three fixture families whose `repoPath` unambiguously points at the `/tmp/tmp.*/watched/` test harness. Kept in the fixture bucket per the brief's explicit naming; the correct call is genuinely unclear from one data point.
- **No `zstd`** (absent per box context) — gzip/xz only, so no read on zstd's cost/ratio tradeoff, which matters if that's a real candidate.

## Reproduction

```bash
# census (fixture vs real, by repoPath inspection)
cd ~/.local/share/rhizomorph
for d in */; do d="${d%/}"; find "$d" -type f -printf '%s\n' | awk -v d="$d" '{s+=$1}END{print d","NR","s}'; done

# three largest real logs -> build area
mkdir -p ~/rhizomorph-spikes/s1-corpus/logs
cp worktrees-challenge-71202028/session-{1785739192605,1785929533332,1785895666938}.jsonl \
   ~/rhizomorph-spikes/s1-corpus/logs/

# per-type census
cd ~/rhizomorph-spikes/s1-corpus/logs
awk '{
  len=length($0)+1
  if (match($0,/"type":"[^"]*"/)) t=substr($0,RSTART+8,RLENGTH-9); else t="UNKNOWN"
  cnt[t]++; byt[t]+=len
} END { for (t in cnt) printf "%s\t%d\t%d\n", t, cnt[t], byt[t] }' \
  session-1785739192605.jsonl session-1785929533332.jsonl session-1785895666938.jsonl

# lane-hour buckets (note: "lane" field is 4 chars, same prefix length as "type" —
# use RSTART+8,RLENGTH-9, not +7/-8, or the leading quote leaks into the lane name)
awk '{
  if (match($0,/"ts":[0-9]+/)) hour=int(substr($0,RSTART+5,RLENGTH-5)/3600000); else next
  lane="no-lane"
  if (match($0,/"lane":"[^"]*"/)) lane=substr($0,RSTART+8,RLENGTH-9)
  print hour"\t"lane
}' session-1785739192605.jsonl | sort | uniq -c | sort -rn | head

# compression
gzip -9 -k -f session-*.jsonl
xz -6 -k -f -T0 session-*.jsonl
```

Build area used: `~/rhizomorph-spikes/s1-corpus/`.
