# Is the model stage's frame-time variance GC? — prd-47 ruling 4

**VERDICT: NO-GO.** The variance is not garbage collection. The pooling
(`prd47 w4`) is **not built**, and ruling 4 closes as answered rather than
staying an open question.

The decision is **conditional and instrumented**, not permanent: the measurement
stays in `perf.test.ts`, and a filed follow-up re-asks this question if the
scene's rendered scale ever reaches the regime this note could not test. See
**Consequence** below.

- Measured 2026-09-01. The filename carries the date the issue was groomed
  (2026-08-28), which is what #160's fence declares; this is the date the
  numbers were taken.
- Environment: a development machine — Apple silicon, 8 GB, Node 22.23.2,
  Chrome/Chromium via the DevTools performance panel. The web app under the
  **vite dev server** (see the honesty note in *What this does not establish*).
- Every claim below is `[Ran]` — the command was executed and its output is
  reproduced. Nothing here is reasoned from the code alone.

---

## The question

prd-47 ruling 4: *variance is measured before it is fixed.*

The audit observed that model-stage frame times are not uniform — most frames
cheap, a minority noticeably slower. The hypothesis was GC pauses landing inside
frames. The proposed mechanism was pooling the display list and the mark
objects, so fewer allocations means less to collect.

Ruling 4 exists to test the hypothesis before the mechanism is built, and it
named its own falsifier: **if `worst / median` collapses under forced
out-of-band collection, the attribution holds; if it does not, the attribution
was wrong and the pooling is never built.**

---

## Q1 — Do the model-floor cells improve under forced collection?

**Verdict: NO. The falsifier was not met.**

`[Ran]` `npx vitest run packages/web/src/scene/perf.test.ts --silent=false`
(serial, alone — the only condition under which this file's wall clocks mean
anything; it carries the gate's timing marker for exactly that reason).

The cell runs the same 60x3 frame twice per round, interleaved, forcing a
collection out of band — immediately before one sample, outside the timed
region.

```
model floor 60x3 plain:  22.633 ms median · 28.225 ms worst · 1.25x tail
model floor 60x3 forced:  7.821 ms median · 12.976 ms worst · 1.66x tail
```

The tail ratio did not collapse. It **rose**, 1.25x → 1.66x. Ruling 4's stated
falsifier fails on its own terms.

### Q1a — the confound, tested rather than assumed

The median fell by two thirds, which invites the opposite reading. But the
forced sample always ran on a freshly collected heap and the plain sample never
did, so the gap could be heap *state* rather than the act of collecting.

`[Ran]` A throwaway third frame per round, with no collection before it, in
round order A → gc → B → C:

```
B — collection immediately before, 0 frames of garbage : 15.205 ms median
C — third in round, no collection,  1 frame of garbage : 18.687 ms median
A — first in round,  no collection, 2 frames of garbage: 60.418 ms median
```

C sits close to B, not to A. The effect therefore tracks **accumulated
allocation pressure**, not the collection itself — and non-linearly, A being
~4x B. Allocation volume matters to this stage. GC *pauses* are a different
claim, and Q2 answers it directly.

(The probe is not shipped. The absolute milliseconds in this run are inflated
relative to Q1's — the box was under memory pressure and a third frame per round
adds allocation. The *ordering* is the finding, not the times.)

---

## Q2 — Do GC events land on the rAF timeline?

**Verdict: NO. GC is 0.74% of main-thread animation-frame time, and no frame
missed budget.**

`[Ran]` A Chrome DevTools performance recording of a real drag on the 20-lane
synthetic fixture (`STREAM_SOURCE_KEYS['2']`), exported and parsed event by
event. 13.4 s, 765 `FireAnimationFrame` callbacks on the main thread.

Nested V8 GC trace events were **merged into a union of intervals** before
measuring. Summing them raw double-counts: `V8.GC_MC_INCREMENTAL` contains its
own sub-phases, and the naive sum reported GC at up to 254% of a frame it sat
inside. 6,949 raw main-thread GC events reduce to 1,050 merged intervals.

```
rAF callback: median 2.396 ms · p90 2.678 · p99 3.696 · worst 6.601 ms
tail (worst/median): 2.76x
frames over the 16.67 ms budget: 0 / 764
GC share of all main-thread rAF time: 0.74%
frames containing any main-thread GC: 12 / 764
frames >2x median: 4 · GC share within them: 32.08%
total main-thread GC wall time over the whole trace: 339.9 ms
```

339.9 ms of main-thread GC happened, and almost none of it inside a frame. V8's
incremental marking schedules that work between frames; the trace shows it doing
so. GC is not absent from the slow frames — inside the four frames above 2x
median it is ~32% of their time — it is **immaterial**, because the slowest of
those is 6.6 ms against a 16.67 ms budget.

### Q2a — the outlier that was not the app

The recording's longest frame was **196.266 ms**, twelve times over budget and
exactly what a smoking gun looks like. It is excluded from every figure above,
because it is the instrument:

```
196.266 ms  FireAnimationFrame
195.773 ms    FunctionCall
192.269 ms      V8.InvokeApiInterruptCallbacks
191.464 ms        CpuProfiler::StartProfiling
```

DevTools starting its own profiler on the first frame of the recording. It
contains 0.060 ms of GC and no scene work. Recorded here because reported
unexamined it would have been a 196 ms dropped frame and a false alarm — and
because it is the argument for parsing trace events rather than eyeballing the
flame chart.

---

## Consequence

Ruling 4's own wording is binding: the attribution did not hold, so **the
pooling is never built on this evidence**.

- `prd47 w4` is **not groomed**. The issue does not exist.
- The cross-PRD note for `scene/marks/` (prd-33's territory) is **not needed** —
  it was owed only if pooling entered that fence.
- Ruling 4 **closes as answered**, with this note as its evidence.
- The real constraint at scale is the **median, not the tail** — see below. That
  belongs to prd-33's model-stage table, not to a variance fix.

**What ships from #160 regardless:** the model-floor report line now prints its
`worst` beside its median, and the forced-collection cells stay in
`perf.test.ts`. Re-asking this question later costs one command rather than
another investigation.

**The tripwire.** This is a NO-GO *at the scale the instrument renders today*,
not a proof that pooling could never pay. A follow-up issue is filed to re-ask
it if the rendered scale grows into the regime Q2 could not reach.

---

## What this does not establish

- **Q2 never reached the regime where a tail exists.** The shipped fixture is
  21 lanes and drags at a 2.4 ms median. The cell that shows a tail is 60x3 —
  **180 threads** — which no fixture in the app reaches. Q2 says "no problem at
  shipped scale"; it does not disprove a GC tail at 180 threads.

  It does not need to, for this decision. At 180 threads the model floor reads
  `17.776 ms median · 106.7% of budget` — the **median** is already over. A
  free-list does not fix a median. Even in the regime where slowness is real,
  pooling is the wrong instrument:

  | cell | threads | median | of budget |
  | --- | --- | --- | --- |
  | 30x1 | 30 | 3.961 ms | 23.8% |
  | 30x3 | 90 | 8.292 ms | 49.8% |
  | 60x3 | 180 | 17.776 ms | 106.7% |

- **Q2 ran against the vite dev server** — unminified, React in development
  mode, which allocates more than a production build. That bias runs *against*
  this note's conclusion: it over-states GC, and GC still came out at 0.74%. A
  production build would make the NO-GO stronger, not weaker. It has not been
  measured.
- **The box was under memory pressure** during Q1/Q1a (swap in use from
  concurrent suites). Absolute milliseconds moved substantially between runs;
  the ratios, the ordering and the GC share are the durable figures, not the raw
  times.
- **Forced collection changes allocation timing, not volume.** Nothing here
  measures what the model stage allocates, only when it is reclaimed. Q1a is
  suggestive that volume matters; it is not a measurement of volume.
- **Neither Q1 nor Q2 is the GPU side.** Both are the CPU model stage. The
  GPU-side harness remains unfiled work, as prd-47's Sequencing says.
