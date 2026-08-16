# The concurrency measurement — how often do events genuinely coincide?

> ## VERDICT: **RAISE `EVENT.maxConcurrent` 5 → 7. LEAVE `STRUCTURAL.maxConcurrent` AT 2.**
>
> Ten real recorded fleet sessions — **229,489 raw telemetry events across
> ~291 observed-hours**, spanning two eras of this project's own history —
> were replayed through the exact event→pulse mapping
> `packages/web/src/scene/pulses.ts` uses (same per-kind pulse lives, same
> mote-count rule), **without** the cap it currently enforces, to find out how
> many pulses are genuinely alive at once.
>
> The maximum number of **distinct lanes** ever found with a pulse alive at
> the same instant, anywhere in 291 hours, is **7**. Not a round number chosen
> because it sounds generous — it is the actual historical ceiling this
> dataset contains, and it happens to land exactly on the "seven-lane wave"
> scale this issue named. **`EVENT.maxConcurrent` moves to 7.**
>
> Raw pulse concurrency (what the code literally counts today, lane identity
> ignored) tells a different, noisier story: it reaches 45 at its single
> highest peak — but that peak is **one lane** firing motes off a rapid
> tool-call streak, not seven lanes' work coinciding. That gap between the two
> numbers is the load-bearing finding here, not a footnote — see "the number
> the cap should count."
>
> `STRUCTURAL.maxConcurrent` gets the opposite answer. The measured ceiling
> for genuinely simultaneous lane-appearing/disconnecting is **2** — exactly
> today's cap — reached only 5 times in 291 hours. Even the one verified
> seven-lane wave dispatch in this data staggered its own worktree creations
> **16–18 seconds apart**, nowhere near the 800 ms structural window. **The
> data does not support raising this cap, so it does not move.**
>
> All four immovable numbers (`RECEDE`, `CALM_CEILING`, `ALARM_FLOOR`,
> `CALM_FLOOR`) are untouched — nothing proposed here requires or implies
> moving any of them.

*Issue #567 · prd-33 ruling 10 · 2026-08-16 · script and raw output in
`research/concurrency/`.*

---

## What was measured

The recorder (`packages/server/src/recorder/`) writes every session's events
to `~/.local/share/rhizomorph/<repo-slug>/session-<ts>.jsonl` — outside the
git repo entirely (`packages/server/src/log/paths.ts`). This machine's data
root holds real fleet history going back to the project's early issues,
alongside ~70 throwaway repos the server's own vitest suite creates
(`plain-repo-*`, `a-repo-with-spaces-*`, `caf----repo-*`, `primordium-*`,
`target-*` — a different project entirely, `junior-audit/target`). Those are
excluded by construction: the measurement script names ten specific files, not
a directory walk.

| recording | events | span | notes |
| --- | ---: | ---: | --- |
| `rhizomorph-5189ebfe/session-1786665720450.jsonl` | 27,517 | 49.3 h | main checkout, 2026-08-15/16, lanes 512→580 |
| `rhizomorph-5189ebfe/session-1786602585014.jsonl` | 13,451 | 17.4 h | main checkout, 2026-08-14/15 — **contains the verified 7-lane wave** |
| `rhizomorph-5189ebfe/session-1786321490492.jsonl` | 10,401 | 53.5 h | main checkout, 2026-08-11/13 |
| `rhizomorph-5189ebfe/session-1786665406591.jsonl` | 382 | 0.1 h | short reconnect |
| `worktrees-challenge-71202028/session-1785739192605.jsonl` | 63,653 | 43.5 h | early era (issue ~100s) |
| `worktrees-challenge-71202028/session-1785929533332.jsonl` | 56,618 | 13.6 h | early era |
| `worktrees-challenge-71202028/session-1785895666938.jsonl` | 41,120 | 10.5 h | early era |
| `worktrees-challenge-71202028/session-1785978475040.jsonl` | 15,334 | 30.4 h | early era |
| `worktrees-challenge-71202028/session-1785677492476.jsonl` | 856 | 0.2 h | early era, short |
| `worktrees-challenge-71202028/session-1785935062975.jsonl` | 157 | 0.1 h | early era, short |
| **total** | **229,489** | **~291 h** | |

Two eras, because `worktrees-challenge` is a second checkout of this same
project recorded under a different directory name — confirmed by its own
commits carrying this repo's issue numbers (e.g. `"feat(core): #123 trace.span
event, traces slice, idempotent fold"`). Not a distribution drawn from one
quiet afternoon: the shortest recording is nine minutes, the longest run of
sustained activity in one file is 43.5 hours, and the set spans both the
project's early days and its current, denser fleet operation.

`session-1786602585014.jsonl` carries a genuine multi-lane wave, found by
clustering `worktree.discovered` timestamps and discarding the boot-scan
artifact (below): **`289-proto-keys`, `247-dead-code`, `246-fleet-to-core`,
`453-bin-honesty`, `362-issues-show`, `411-sample-keys`, `410-rotate-deflake`**
appear 16–18 seconds apart, over a 104-second span, 8.5 minutes into the
session. Seven lanes, dispatched as a wave — the exact scale this issue named.

## The coincidence window, and why it isn't a free choice

"Concurrent" needs a definition before it can be counted, and the scene
already has one: a pulse is alive for exactly as long as its own animation
lasts (`pulses.ts:108-113` — commit 2,200 ms, landing 2,800 ms, mote 3,400 ms,
tick 460 ms), and `EVENT.maxConcurrent` counts how many are alive, i.e. how
many overlapping animations a viewer would actually be asked to track at
once. Using anything else — a fixed window, an arbitrary threshold — would be
measuring a different question than the one the cap answers.

So the **primary method** mirrors `pulses.ts`'s own `ingestOne` switch
event-for-event (the per-kind life table, the ≤3-motes-per-request rule, the
90 ms mote stagger — all cited from source, not re-guessed), builds every
interval the real `PulseField` would have opened had the cap not intervened,
and sweeps them for overlap. Concurrency here means exactly what the shipping
code means by it.

**Sensitivity — the window is a choice, and it moves the answer:**

| variant | max | `>=5` (all-time) | `>=10` (all-time) |
| --- | ---: | ---: | ---: |
| 0.5× real pulse life | 41 | 0.62% | 0.08% |
| **1× real pulse life (primary)** | **45** | **1.49%** | **0.30%** |
| 2× real pulse life | 53 | 3.01% | 1.00% |
| 4× real pulse life | 84 | 4.73% | 2.68% |

| naive fixed window (every event a point) | max | `>=5` | `>=10` |
| --- | ---: | ---: | ---: |
| 100 ms | 18 | 0.0053% | 0.00007% |
| 500 ms | 20 | 0.082% | 0.004% |
| 1,000 ms | 36 | 0.247% | 0.020% |
| 2,000 ms | 38 | 0.692% | 0.104% |
| 4,000 ms | 42 | 1.838% | 0.416% |

Doubling the assumed life roughly doubles the `>=5` reading; the naive
point-window method converges toward the real-life numbers only around the
2,000–4,000 ms mark, because that is roughly a mote's real life. The
real-per-kind-life method is reported as primary because it is not a free
parameter — it is what the code already does.

## The number the cap should count

Raw pulse concurrency and **distinct-lane** concurrency (how many *different*
lanes have a live pulse, lane identity collapsed) diverge sharply, and the gap
is the central finding:

| | max ever | `>=5` (all-time) | `>=5` (of active time*) | `>=7` (all-time) |
| --- | ---: | ---: | ---: | ---: |
| raw pulses (what the code counts today) | 45 | 1.49% | 32.5% | 0.66% |
| **distinct lanes (what MOT research bounds)** | **7** | **0.019%** | **0.40%** | **0.003%** |

*"active time" = the 4.58% of all observed time the scene had any live pulse
at all — most of 291 hours is the fleet asleep, and dividing by that dilutes
how often the cap matters *while something is actually happening*. Even
rebased onto active time, distinct-lane concurrency of 5+ happens in under
half a percent of it.

Pylyshyn & Storm's tracking limit is about **independent moving targets** —
the thing a viewer has to individually follow. The measured peak of 45 raw
pulses traces to a **single lane** (`224` in one recording) firing off ~15
rapid tool-call turns in under 3.4 seconds — real activity, but one thread
being busy, not fifteen separate things to track. The current implementation
doesn't distinguish this: `EVENT.maxConcurrent` in `pulses.ts:351` counts
`this.live.length` globally, so one chatty lane can consume the whole budget
and start coalescing its own further pulses into an aggregate on itself. That
is arguably *correct* behavior for a single-thread burst (nobody needs five
separate flashes from one thread), which is exactly why raw pulse
concurrency is the wrong quantity to size the cap against: it is dominated by
single-lane bursts the coalescing rule already handles gracefully, not by the
multi-lane storms the cap exists to bound.

**`EVENT.maxConcurrent` is derived from the distinct-lane ceiling: 5 → 7.**
Seven is not a step taken past the evidence — it is the evidence's own
maximum, observed in three independent recordings spanning both eras of the
project. At 7, raw pulse concurrency still exceeds the cap 0.66% of all
time (14.5% of active time) — the aggregate/coalesce mechanism (`pulses.ts`'s
existing "traffic is coalesced, never invented" law) remains a real, exercised
backstop for single-lane bursts, not a vestigial one.

## Structural: the data says leave it alone

| | max ever | `>=2` | `>=3` |
| --- | ---: | ---: | ---: |
| structural (appear/disconnect) | 2 | 0.0006% (5 episodes / 291h) | **0 episodes, ever** |

Genuinely simultaneous lane-appearing-or-disconnecting essentially doesn't
happen in this data, even during a deliberate wave dispatch: the verified
seven-lane wave staggered its own `worktree.discovered` events 16–18 seconds
apart — about 20,000× longer than the 800 ms window `STRUCTURAL.durationMs`
opens. Creating a worktree, wiring telemetry and starting an agent takes real
wall-clock time even when a human or a conductor script intends them as one
batch; the caps' 800 ms window is not competing against that timescale.

**`STRUCTURAL.maxConcurrent` does not move.** This is the case the brief asked
to be honest about: the measurement does not support raising it, so it isn't
raised. Two already covers every real instance this dataset contains.

## Three things that nearly made this measurement lie

Each was caught by checking a suspiciously round number against the raw
events behind it, the same discipline the renderer spike names for its own
gotchas.

1. **252 "simultaneous" commits were one collector poll, not one merge.** The
   first pass showed a spike of raw concurrency to 253, all on branch
   `topup-389-391`. Every one of the 252 commits shared **one `ts`** — but
   their `authoredAt` values span **four real days**. The git collector
   discovers a merged range in one poll and stamps the whole batch with that
   poll's instant; `ts` is discovery time, not landing time. Fixed by anchoring
   `commit.landed` pulses on `authoredAt`, not `ts` — this is "history never
   pulses" (`pulses.ts`'s rule 1) for a second event type the rule wasn't
   originally written to cover.
2. **A resync burst and a prune sweep both look like a crowd, from far away.**
   38 `worktree.discovered` shared one `ts` 3.8 hours into a session (a
   mid-run resync re-enumerating everything, not 38 lanes appearing at once);
   18 `worktree.removed` shared another `ts`, spanning issues #225 through
   #519 — a bulk cleanup sweep, not 18 lanes disconnecting live. Both fixed
   the same way: any run of ≥3 same-type events sharing one exact timestamp is
   a batch flush, excluded from the structural measurement.
3. **Pooling files with overlapping real time doubles the same lane.** Two
   pairs of recordings genuinely overlap in wall-clock time (~64 minutes and
   ~10 minutes respectively — separate recorder runs of the same live fleet).
   Concatenating their intervals into one timeline before sweeping counted a
   lane present in both files, at the same real instant, as two *different*
   lanes — the first pass this way reported a phantom distinct-lane max of
   10. Fixed by sweeping each file strictly against itself and only summing
   the resulting time-at-level histograms afterward.

## The alarm exemption — ready to paste into prd-33 ruling 10

Ruling 10 already states the intent ("alarms are exempt and always win"); the
issue's own done-when asks for the clause **as amendment text**, not a
restatement. This is that text:

> **The alarm class is exempt from `EVENT.maxConcurrent` by priority, not by
> a larger share of it.** An alarm pulse always animates, at every value of
> the cap, regardless of how many event-class pulses are already live. It is
> never itself coalesced into an aggregate, never dropped to make room for
> another pulse, and never counted against the budget it bypasses. When the
> budget is full and a new pulse arrives, the pulse that yields is the newest
> non-alarm event-class pulse — today's existing "traffic is coalesced, never
> invented" rule, applied one-directionally. This clause is not sized against
> the cap: raising `EVENT.maxConcurrent` (as this measurement proposes) does
> not touch it, and neither would lowering it back to 5. A death is visible at
> any density, which is precisely what a cap that throttled alarms equally
> would have gotten wrong.

## What would change this conclusion

1. **A recording with a genuinely denser wave** — more than seven lanes
   dispatched with overlapping activity — would move the distinct-lane
   ceiling and, with it, the proposed cap. This dataset's largest confirmed
   simultaneous-appearance wave is seven; a bigger one hasn't been recorded
   yet on this operator's fleet.
2. **A different accounting of "one lane's own burst."** This note treats
   single-lane rapid-fire pulses (the 45-peak case) as evidence *against*
   sizing the cap off raw pulse count. If a future implementer decides a
   single busy lane genuinely needs several concurrently-legible flashes
   (rather than reading as one glowing thread), the raw-pulse-count numbers
   in "the coincidence window" section, not the distinct-lane ones, are the
   ones to size against — and they would argue for a higher cap, plausibly
   8–10.
3. **A coincidence-window choice other than "real pulse life."** The
   sensitivity table shows the `>=5` reading moves by roughly 2× for each
   doubling of assumed pulse life. The primary method is defended by being
   the shipping mechanism's own definition, but a reviewer preferring a
   different window would get a different number from the same data — the
   raw sweep in `results.json` supports recomputing at any window.
4. **Contradicting numbers at all.** Run `npx tsx research/concurrency/measure.ts`
   (needs the raw session logs — see `research/concurrency/README.md`) and
   disagree with the table.

## What would *not* change it

- **A single very chatty lane.** Refuted directly — the 45-peak case is
  exactly this, and it does not move the distinct-lane ceiling of 7.
- **A bigger data root.** Doubling the observed-hours without a wave bigger
  than seven lanes would sharpen the percentages, not the proposed cap.
- **The four immovable numbers.** Nothing here touches `RECEDE`,
  `CALM_CEILING`, `ALARM_FLOOR` or `CALM_FLOOR` — the salience band is
  untouched by a motion-budget change.

## Supporting stat: does "five minutes to two hours" hold?

Lane lifetime (`worktree.discovered` → `worktree.removed`), matched
approximately by path suffix since `worktree.removed` only carries a path —
**reported, not asserted**, given that approximation:

- n = 168 matched lane lifetimes
- median ≈ **60.7 minutes**
- p90 ≈ 32.8 hours, max ≈ 35.7 hours (worktrees that sat finished for a day or
  more before cleanup — plausible given this operator's own workflow, but the
  path-suffix match is loose enough that a few of these could be mismatches
  rather than genuinely long-lived lanes)

The median matches the issue's own premise well; the long tail is real but
noisier, and is reported here as context for why event density stays low
rather than as a number this measurement leans on.
