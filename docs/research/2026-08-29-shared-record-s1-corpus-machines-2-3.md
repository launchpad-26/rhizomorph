# s1-corpus — telemetry cost on machine 2 (one of the two remaining machines)

**Scope note, stated up front:** this note covers **one** of the two machines the issue's DoD
asks for. Machine 3 is not available to this dispatch and is **not measured here** — see "Machine
3: not yet measured" below. A two-machine table (machine 1 + this machine) is a correct, partial
result per Ruling 1 ("a spike that overruns its budget files its partial note ... silence is not a
result"); it is not the three-machine table wave 1 originally asked for.

Box: macOS (Apple Silicon, arm64, per `uname -a`'s `RELEASE_ARM64_T6050`), 18 logical cores, 48 GiB
RAM. Load at run start: `6.10, 7.12, 10.15` (10:38 NZST); at compression step: `4.19, 5.49, 8.88`
(10:41 NZST). Date: 2026-09-01. Named by role ("machine 2"), not by hostname, per this repo's rule
against committing a real machine's identity.

## What ran

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

## Results

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
6.81%/7.12%. This is the >2x-spread finding the issue's DoD calls out explicitly. See "Two-machine
table" below.

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

## Two-machine table (machine 1 + machine 2; machine 3 not yet measured)

| metric | machine 1 (WSL2 Ubuntu, i9-13900H) | machine 2 (macOS, Apple Silicon) | spread | >2x? |
|---|---:|---:|---:|:---:|
| real session dirs / fixture dirs | 26 real / 73 fixture (74% dirs, 4.4% bytes) | 3 real / 0 fixture | n/a | — |
| real corpus total bytes | 216,153,315 (206.1 MB) | 565,936,245 (539.8 MiB) | 2.62x | yes (scale, not a red flag — see note) |
| largest-session bytes/event | 413.5 B (26,325,198 B / 63,653 ev) | 280.3 B (273,909,545 B / 977,293 ev) | 1.48x | **no** |
| 3-log-census bytes/event | 415.3 B (67,009,621 B / 161,391 ln) | 280.2 B (428,100,188 B / 1,527,962 ln) | 1.48x | **no** |
| gzip -9 mean ratio | 10.3x | 7.84x | 1.31x | no |
| xz -6 mean ratio | 12.9x | 11.49x | 1.12x | no |
| largest-session events/day-equivalent (events / dur_h × 24) | 35,128 (63,653 ev / 43.5 h) | 191,144 (977,293 ev / 122.7 h) | **5.44x** | **yes** |
| durable-fact % of lines | 6.81% | 0.10% | **68x** | **yes** |
| durable-fact % of bytes | 7.12% | 0.15% | **47x** | **yes** |
| peak events/(lane or pane)-hour, aggregate ratio | 2,024.2 | 1,406.5 | 1.44x | no |
| busiest single (lane/pane, hour) bucket, raw count | 4,183 (`no-lane`) | 1,799 (`%657`) | 2.33x | borderline yes |

**Whole-corpus events/day and bytes/day have no machine-1 equivalent to compare against** —
machine 1's note reports per-session `dur_h` (span of each session's own first→last event) but
never a whole-corpus min/max timestamp or whole-corpus event total, so there is nothing in that
note to divide by. Machine 2's whole-corpus figures (105,155 events/day, 29.77 MB/day) are reported
standalone above; the row above using each machine's *largest session's* own dur_h is the
comparable substitute, and it is itself one of the >2x spreads.

### The named falsifier: bytes/event, PASSES (does not trigger)

The issue's own falsifier is bytes/event specifically: *"if machines 2 and 3 disagree with machine
1 by more than 2x on bytes/event, the brief's §2 baseline is one box's habit and not a corpus."*
On both bytes/event framings above (largest-session and 3-log-census), the spread is **1.48x** —
under 2x. **Verdict: PASS.** The brief's per-event byte-cost baseline (~410 B/event, one box) holds
within 2x on this second, structurally different box (macOS vs WSL2, server-package session vs
worktree-lane fleet). The corpus's *byte cost per event* looks like a real cross-machine constant,
not one box's habit.

### The >2x spread the DoD also asks to be called out: durable-fact percentage

Durable-fact share is **not** part of the issue's named falsifier, but the DoD separately requires
calling out any per-machine figure differing by more than 2x, and this one differs by **47–68x** —
by far the largest spread in this note. Machine 1's ~4–7% durable-fact baseline does **not**
generalize to this machine: durable facts here are 0.10–0.15% of the corpus, because this machine's
dominant real session is almost pure `pane.activity` (99.9% of lines) with the LLM/tool/tracing
classes that filled machine 1's "five high-frequency classes" bucket nearly absent (88 lines total
across all four, out of 1.5M). This reads as a genuine, useful signal about **what this machine's
corpus is made of** (heavy tmux pane-content polling from concurrent lane/collector activity), not
a data-quality defect — but it means any retention or storage-sizing plan derived from "durable
facts are ~4% of the corpus" would be wrong by more than an order of magnitude for a box shaped like
this one. **This is the finding a three-machine baseline exists to catch**, and it is exactly why
this note states machine 3 as still outstanding rather than quietly proceeding as if two machines
settle it.

## Machine 3: not yet measured

This note covers one of the two machines the issue asked for. **Machine 3 has not been measured
and is an open item**, not a silent gap — per Ruling 1, a partial note files its overrun as a
finding rather than pretending completeness. The three-machine table the issue's DoD describes does
not exist yet; what exists is a two-machine table (this note + machine 1's), with one dimension
(durable-fact %) already showing a spread large enough that a third data point matters more than it
would if machine 1 and machine 2 had agreed.

## What this did not test

- **Machine 3, entirely** — see above.
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
