# prd21 — the scrub bar moves smoothly, reads its position, and opens to the full record at a point

> **Outcome:** shipped.
> Proposed 2026-08-07, never blessed; closed out 2026-08-13. **Everything shipped — ruling 1 in full, then ruling 2 and the readability half later the same day, in the same change (#430) that landed this document.** See [Outcome](#outcome--closed-out-2026-08-13) at the foot of this file, and the postscript beneath it, for what landed in what order and one correction to the evidence below.

**Status:** PROPOSED — operator report 2026-08-07, evidence measured the same
day. Sequenced after prd13 (the TIDE, whose dock this modifies). Numbered 21 at
the operator's direction: prd18 is reserved by `docs/roadmap.md` for the
complete-record UI, and prd19 (the connection) and prd20 (the concierge) are
taken.

**Everything from here to [Outcome](#outcome--closed-out-2026-08-13) is the
document as proposed on 2026-08-07 and is left as written**, save for one
bracketed errata pointer marked `[corrected …]`. It is a dated
artefact: it records what was believed and measured on the day the work was
scoped, including one figure later found wrong. The closeout is appended, not
merged back in — a PRD rewritten after shipping to look like it was planned that
way is the anti-pattern `docs/prds/README.md` names.

**Filed as:** #269 (seek-path coalescing, ruling 1's web half) · #270 (the
1000-notch step) · #271 (the 10 fps playback tick) · #272 (absolute time and
the scattered scrub facts) · #273 (the loupe, ruling 2) · #274
(`buildSessionIndex`'s load cost). **Depends on:** #267 (the incremental spend
cursor, core-only fence).

## Problem

Replay is navigated through a scrubber that is coarse to drag, expensive to
move, quiet about where you are, and unable to show what it captured.

The track snaps between ~1000 discrete notches. Every drag frame recomputes
the entire derived fleet object, synchronously, at a cost that exceeds the
frame budget on every session size measured — including a four-lane one. By
default the bar shows no absolute time and no facts about the scrub instant.
And there is **no way to read the raw events the recording holds at a chosen
moment**: an operator can see *that* a lane landed at 14:32 but not the commit,
the diffstat, the token burst, or the trace span the log captured there. The
dock coalesces everything into four chapter-mark kinds and stops. The full
record is on disk, preserved verbatim (`docs/record-format.md`), and
unreachable through the one surface built to replay it.

## Evidence

Operator report, 2026-08-07: *"not smooth to scroll and info is not displayed
clearly"*, then *"add a zoomability feature to expand on the exact point to
read full data captured."*

**Measured** `[Ran]` 2026-08-07, Node 24, against the real `foldFrom`,
`buildFleet` and core selectors. Log: 447 real events (era-1's own corpus plus
a real recorded session, 16 distinct types), amplified by cloning for the
larger sizes.

Per-seek cost during a simulated 240-seek drag:

| session | `foldFrom` /seek | **`buildFleet` /seek** | vs 16.7 ms frame |
|---|---|---|---|
| 5,000 | 0.003 ms | **26.6 ms** | 159% |
| 25,000 | 0.006 ms | **141.9 ms** | 853% |
| 55,000 | 0.475 ms | **317.9 ms** | 1964% |

**The fold is not the problem, and that overturns the obvious diagnosis.**
#160's keyframed incremental fold is sub-millisecond at every size and holds
up completely. The cost is `buildFleet`, recomputed synchronously on every
seek — roughly 1,000–5,000× the fold. `useReplaySession.ts:178`'s `useMemo`
keys on `playback.currentTs`, so a 120 Hz drag demands 120 full fleet rebuilds
per second. The live event path got animation-frame coalescing in #183; the
seek path never did. React commit and canvas paint sit *on top* of these
numbers, unmeasured.

**Where inside `buildFleet` the cost lives, and what it scales with.** Derived
entities stay constant under amplification — `worktrees=4 branches=4
commits=8 panes=12 agents=3` at 466, 5,000 and 25,000 events alike — while
`telemetry.usage` grows 176 → 1,871 → 9,421 and `telemetry.tools` grows
203 → 2,172 → 10,881. Three spend selectors track those records linearly:

| selector | 466 ev | 5,000 ev | 25,000 ev |
|---|---|---|---|
| `selectLaneSpend` | 2.2 ms | 14.3 ms | 70.7 ms |
| `selectRoleSpend` | 0.8 ms | 7.4 ms | 36.5 ms |
| `selectSessionSpend` | 1.3 ms | 7.3 ms | 35.4 ms |
| `selectWorktreeViews` / `selectCollisions` / `selectTouchesByBranch` | ≤0.06 ms | ≤0.05 ms | ≤0.02 ms |
| **`buildFleet` (whole)** | **6.1 ms** | **58.0 ms** | **292.0 ms** |

So `buildFleet` is **O(telemetry records), not O(lanes)** — and telemetry
records accumulate one per usage or tool event in a real session exactly as
they do here, so the scaling is genuine rather than an artifact of the
amplifier. The geography selectors are irrelevant to the cost. The three named
selectors account for ~22 ms of the 58 ms total at 5,000 events; the remaining
~36 ms is spread across the other ~13 selectors and the draft loop.

> **[corrected 2026-08-09 — see [Outcome](#outcome--closed-out-2026-08-13)]** The
> last sentence is wrong. The ~36 ms remainder is not spread across the other
> selectors; it is *the same three spend selectors called a second time*.

**Even unamplified this is over budget.** The real, un-amplified 466-event
session costs **6.1 ms per `buildFleet`** — 37% of one frame — for a session
with four lanes and eight commits.

`buildSessionIndex` at session load costs 34 ms / 234 ms / **4.4 s** at 55,000
events. One-time per session, but real.

**Honest limits.** Node timing; no React commit and no canvas paint measured,
both of which only add. The amplifier fixes the usage-to-total event ratio at
~38%, so a session with a different mix lands elsewhere on the curve. Absolute
figures want confirming against a real long recording or a browser trace. The
*shape* — fold ≪ buildFleet, linear in telemetry records, over budget at every
size including the smallest real one — is robust.

Supporting code anchors: `packages/web/src/replay/Scrubber.tsx:55` (the
1000-notch `step`), `packages/web/src/replay/usePlayback.ts:26`
(`TICK_MS = 100`, a 10 fps playback clock),
`packages/web/src/tide/TideDock.tsx:300` (`showAxis = zoomed`, so absolute
time is hidden by default), `packages/web/src/tide/chapters.ts:63-71` plus
`TideDock.tsx:132-136` (window-zoom reveals only the four-kind glance layer,
capped at `usefulMaxZoomLevel`, never the raw payloads the record preserves).
Design basis: `docs/research/2026-08-05-replay-ux-spike.md`.

## Success

- Dragging a 55,000-event recording holds a smooth cursor: seek → fleet →
  paint coalesced to **one rebuild per animation frame**, and a single rebuild
  itself inside the 16.7 ms budget rather than 20× over it. Demoable by
  scrubbing this project's own longest recording.
- The thumb moves continuously, with no visible notching, at any session
  length.
- At rest and while scrubbing, the bar shows the absolute time at the playhead
  **and** the scrub instant's own headline facts, co-located with the thumb,
  with no zoom required.
- **Zooming onto an exact point opens the loupe: the events the recording
  captured in that neighbourhood, in the record's own order, source/type/payload
  verbatim, down to the individual event — past the mark lane's coalescing
  cap.** Demoable: scrub to a landing, zoom in, and read the actual
  `commit.landed` files and `llm.usage` burst the dock currently draws as one
  dot.
- Playback at 1x advances the scene at frame rate, not in 100 ms steps.

## Non-goals

- The loupe is a transient, portaled read-out — the idiom `ChapterMarks`'
  `MarkHoverCard` already uses — and **not a new panel**. prd13 ruling 1
  holds: the dock is the replay bar's body, never a panel competing with the
  scene.
- Not the lane drawer's job. The drawer is one lane's whole session; the loupe
  is one instant across the whole fleet. It may link *to* the drawer; it never
  duplicates it.
- Not #170's scope-to-selection (ledger and burn-strip windowing). Untouched.
- Not a rewrite of what `buildFleet` derives, and not a reopening of prd3's
  one-object-four-surfaces law. This changes how often and how cheaply it runs.
- No new hue and no new motion class. No mutation of the record to render it.

## Rulings

## Ruling 1 — coalescing is necessary but not sufficient; the spend selectors must stop rescanning

The measured bottleneck is a pure recompute whose cost is linear in
accumulated telemetry records, so **two changes are required and neither alone
suffices.**

Coalescing seek → `buildFleet` to one rebuild per animation frame — the same
remedy #183 applied to the live path and the seek path skipped — removes the
120-rebuilds-per-second waste. But it cannot rescue a single rebuild that
already exceeds the frame budget on its own: 58 ms at 5,000 events, 292 ms at
25,000, and 6.1 ms even on a four-lane session. So the spend selectors must
*also* stop rescanning the whole telemetry history on every call.

**That half is not this PRD's to rule.** The operator ruled it standalone on
2026-08-07 — the cost lands on the live path too, so it is a product-wide
finding the scrubber merely exposed — and it is specified in **#267** (an
incremental spend cursor in `packages/core/src/selectors/spend.ts`), on the
precedent [ADR-0002](../../adr/0002-one-reducer-for-live-and-replay.md) and #160's
keyframed cure of the same disease one layer down. Per `AGENTS.md`, an
architectural ruling is linked, not restated: **this PRD depends on #267 and
does not duplicate it.**

**Correction, carried from #267.** An earlier draft of this ruling offered
"memoized per `(state, window)`" as an alternative to incrementalising. That is
a dead end and is explicitly not taken: every seek folds a *fresh* state object
(`useReplaySession.ts:178`), so a state-keyed cache misses 120×/s by
construction — the exact case this PRD exists to fix. The incremental cursor is
the load-bearing fix.

What remains this PRD's own: the web-side half — coalescing the seek path and
threading the cursor through `buildFleet` — whose fence is deliberately
disjoint from #267's core-only one.

The seek must still move the clock immediately: the thumb may never lag the
finger, so the clock update and the fleet rebuild decouple. The fold stays
exactly as #160 built it. Nothing here reopens the append-order law (#205).

## Ruling 2 — the loupe reads the record, it does not re-summarise it

Past the mark lane's `usefulMaxZoomLevel` cap, zoom stops thinning marks and
starts revealing events. The loupe slices the raw `scrubEvents` in a small
neighbourhood of the chosen point and lists them verbatim, in the log's own
append order — never re-sorted (#205), never re-derived into a second summary.

A `Chapter` is deliberately thin (`kind`, `ts`, `lane`, `toolName` —
`chapters.ts:63-71`) and the existing window-zoom only re-lays those coalesced
marks, which is why it is capped at the median event-spacing grain: below it
there are no further marks to separate. The loupe is a second, additive
reading of the same instant. The mark lane's coalescing law and its cap are
untouched.

## Open questions

- ~~The `buildFleet` scope question.~~ **RESOLVED 2026-08-07, operator ruling:
  standalone.** The cost lands on the live path too, so it is a product-wide
  finding rather than a replay one, and it is specified in #267 (core-only
  fence). This PRD depends on it; ruling 1 above carries the consequence.
- ~~Is `buildSessionIndex`'s 4.4 s load cost in scope here?~~ **RESOLVED: its
  own finding**, filed as #274.
- What triggers the loupe — zooming past the cap, a click on the playhead, or
  a dedicated inspect affordance?
- Payload sizes vary by orders of magnitude (a large diffstat against a token
  count). Does the loupe truncate-and-declare, the way `TranscriptEntry`
  carries `dropped`, or hand the heavy ones to the drawer?
- Loupe neighbourhood width: a fixed span in ms, a fixed event count, or the
  zoom level's own window?
- Does the absolute-time readout live inside the scrubber, or become an
  always-on axis (relaxing `showAxis = zoomed`)?
- One PRD or two? The smoothness work and the loupe share the scrub path but
  are independent wins, and either could ship without the other.

---

## Outcome — closed out 2026-08-13

Appended after the fact. Everything above is the document as proposed on
2026-08-07; nothing in it has been revised to match what happened.

**The document itself did not land until now.** It was proposed in PR #278 on
2026-08-07, approved, and then **closed unmerged on 2026-08-09** while the work
it scoped went ahead and shipped. For four days the issues under this milestone
cited a file that was not on `main`. That is the failure `docs/prds/README.md`
calls *never closed out*, in an unusually literal form — not a PRD frozen at
kickoff, but one that never arrived. It is landed here from `c49a508`, the head
of the closed `docs/prd21-scrub-bar` branch.

### Ruling 1 — shipped in full

| | issue | landed |
|---|---|---|
| the incremental spend cursor (core half) | #267 | 2026-08-09 |
| seek-path frame coalescing (web half) | #269 | 2026-08-10 |
| the 1000-notch step | #270 | 2026-08-10 |
| the 10 fps playback tick | #271 | 2026-08-11 |
| the exemption's frame bound | #364 | 2026-08-13 |
| resume-after-pause, pinned | #395 | 2026-08-13 |

Two defects in that work were found afterwards by verify passes and closed on
2026-08-13: **#364** (the free-fold exemption survived a session switch, so two
seeks could fold in one frame — a breach of the one-derive-per-frame ceiling
#269's own doc comment states as an invariant) and **#395** (resume-after-pause
was correct but untested; two redundant guards made the gap invisible to
single-point mutation testing).

### Ruling 2 — landed 2026-08-13

**#273** is built. The three open questions this document left were resolved on
the day: the operator ruled the **trigger** — zooming past the mark lane's cap,
which becomes a threshold rather than a stop — and left the **neighbourhood
width** (a fixed event count) and **payload handling** (truncate-and-declare) as
implementation defaults to be judged running rather than in the abstract. Two
further rulings followed the verify pass on PR #430: the loupe keeps its in-grid
form with a halved height ceiling, and it keeps reading `value` rather than
growing a `derivedTs` prop for a cost measured at 1–7% of a frame. All four are
recorded on #273.

**#272** landed beside it. It belongs to neither ruling — it is the readability
half of the operator's original report, which this document scoped but never
ruled on; the operator ruled it directly on 2026-08-13 (an always-on axis *and*
a readout at the thumb, because the axis alone fixes the missing clock and
leaves the scattering).

Both fences were amended on 2026-08-13, before any change: #272 widened to
include the three sibling test files, #273 narrowed from the whole of
`packages/web/src/tide/` to the new module plus `TideDock.tsx` and their tests.

**That narrowing did not do what it was justified as doing, and the record
should say so.** The stated reason was that putting `chapters.ts`,
`markCoalesce.ts`, `eventSpacing.ts` and `ChapterMarks.tsx` outside the fence
would make ruling 2 mechanically checkable — a diff reaching them *being* the
breach signal. The first cut of #273 breached the ruling anyway, with all four
files untouched and the fence audit passing cleanly: the mark lane was re-laid
through `TideDock`'s own `window_`, which is inside the fence. A fence over the
lane's *modules* cannot check a law about the lane's *window*. Caught by the
verify pass on PR #430, not by the audit.

### One correction to the evidence

The Evidence section's claim that *"the remaining ~36 ms is spread across the
other ~13 selectors and the draft loop"* is **wrong**, and the error flatters
the diagnosis rather than undermining it.

Found by @KelliherL while building #267 (PR #286): the remainder is **the same
three spend selectors called a second time**. `packages/web/src/fleet/buildFleet.ts:138-149`
runs each of them twice — once filtered to token origins and once for dollars,
deliberately, because one mixed pass would double-count every request both
collectors saw — while the table above timed single calls. Non-spend selectors
total **1.5%** of a rebuild at 25,000 events, not the ~62% the sentence implies.
The same instrument reproduced this document's own single-call figures within
~15%.

Still true on `main` at the time of this closeout: those two calls per selector
are at `buildFleet.ts:138-149`, unchanged. `EXECUTED` — read from `origin/main`.

The correction makes ruling 1 *more* right, not less: the spend selectors were
an even larger share of the cost than the measurement claimed, and the geography
selectors an even smaller one. Recorded here rather than silently fixed above,
because the wrong number is what the ruling was argued from.

### The open question this answers

*"One PRD or two? The smoothness work and the loupe share the scrub path but are
independent wins, and either could ship without the other."*

Answered by events rather than by a ruling: **two.** The smoothness half shipped
inside four days. The readability half and the loupe are still open six days
later, one of them blocked on questions this document left open. They were
independent wins and they proved it.

### Postscript — later the same day (2026-08-13)

The closeout above describes the tree as it stood when this document was
authored for landing — and the change that landed it (#430) is the same one
that closed what the closeout calls open. **Ruling 2 shipped**: the loupe
(#273), its trigger ruled on the issue (zooming past the cap — the cap becomes
a threshold, not a stop), with the neighbourhood and payload handling marked
as defaults in `Loupe.tsx`. The readability half shipped beside it (#272: an
always-on axis *and* a readout at the thumb, both ruled on the issue). And the
two ruling-1 defects closed in the same change: #364 (the load-fold exemption
now expires with the frame that armed it) and #395 (the resume-after-pause
pin). The closeout's sections are left as written for the same reason the
proposal is: each says what was true on the date it carries, and this
postscript is what changed between that writing and this document reaching
`main`.
