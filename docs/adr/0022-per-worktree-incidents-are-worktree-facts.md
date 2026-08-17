# 0022. Per-worktree incidents are recorded on the worktree, not the collector

- **Status:** accepted
- **Date:** 2026-08-14

## Context and Problem Statement

`CollectorState` (`packages/core/src/state.ts`) is keyed one slot per
*collector name* (`"git"`). The git collector, though, tracks
`git status --porcelain` failures **per worktree**
(`dirtyFailures: Record<worktreePath, number>`, `git-collector.ts`). Every
`collector.*` event payload carries only `collector`, never an entity key
(`packages/core/src/events/system.ts`), so a per-worktree fact voiced through
`collector.error`/`collector.recovered` gets squeezed into the one shared slot.

That squeeze produced three faces of the same defect (#429): a recovered
worktree's `collector.recovered` can mask a sibling worktree's still-open
incident; the shared `lastErrorMessage` latches to whichever worktree emitted
last, misattributing an open alarm to the wrong lane; and, pre-existing, the
strip never self-clears for these per-worktree conditions at all. #415 found
face one first and deliberately declined to voice a close through the shared
slot rather than ship the mask — parking the real fix here.

A structurally identical, unbounded heartbeat lives in the same file:
`diffBranches`' `for-each-ref` failure path (`git-collector.ts`) voices
`collector.error` on *every* failing poll, no threshold, the same pattern
#415/#506 already stamped out for the dirty-status path.

## Considered Options

- **Option 1 — make entities first-class inside `CollectorState`.** Add an
  optional `entity` key to `collector.*` payloads; give `CollectorState` a
  per-entity `entries` sub-map; derive overall status from it.
- **Option 2 — a separate per-worktree fact, `CollectorState` stays coarse.**
  Keep `CollectorState` about collector-*process* health only (the
  `withResilience` disabled/degraded machine). Introduce a new event pair
  whose subject is the worktree, reduced onto the worktree's own state slice.
- **Option 3 — stop routing per-entity voicing through collector state at
  all.** The git collector voices `collector.error` only for genuinely
  collector-wide conditions; a lane's dirty-status failure surfaces only on
  that lane's own render, inferred from `dirtyUpdatedAt` staleness rather than
  recorded as a fact.

## Decision Outcome

Chosen: **Option 2**, with the refinement that the new fact reduces onto the
*existing* `WorktreeState` slice (`dirtyStatusFailedSince: number | null`),
not a new top-level registry — the per-worktree state already exists; nothing
else needs to learn to read a second place.

New additive event pair, subject = the worktree:

- `worktree.dirtyStatusFailed { worktreePath, consecutiveFailures, message }`
  — emitted once, on the poll that crosses `MAX_DIRTY_STATUS_FAILURES` (#415's
  own once-per-incident discipline).
- `worktree.dirtyStatusRecovered { worktreePath }` — emitted on the first
  clean poll after a voiced incident. The close #415 couldn't voice safely
  through the shared per-collector slot is safe here, because it names its
  own worktree — a sibling's still-open incident cannot be touched by it.

`CollectorState` is untouched by either event. The attention strip stops
carrying per-worktree git incidents entirely; it reflects true collector
health only, and keeps self-clearing via the existing `collector.recovered`
machinery for real collector-wide failures. The `for-each-ref` sibling gets
the identical threshold-and-latch shape (silent through the bound, voiced
once on crossing it, silent again after, no voiced close on recovery) applied
to its own collector-wide failure counter — it keeps using `collector.error`
rather than gaining a new event type, because a single `for-each-ref` call
has exactly one entity (the whole repo), so the masking defect this ADR
exists to fix cannot occur there in the first place.

**Option 1 lost** on the upcast/over-generalization lesson this repo just
relearned pruning `upcast()`: "generalizes to workmux/tmux" is a theoretical
benefit today, since both of those collectors fail whole-poll and git is the
only one with per-entity failure granularity. General machinery built for one
consumer is the shape this repo deletes on sight. It also blends process
health and per-entity data health into one record, giving the resilience
enum a second, unrelated meaning.

**Option 3 lost** because the record is supposed to carry facts, not
inferences: an operator reading "this worktree's dirty data looks old" from
`dirtyUpdatedAt` staleness is deriving an incident the instrument itself
observed and chose not to write down. The instrument already knows `git
status` is failing; declining to say so is a worse instrument, not a smaller
one.

## Consequences

- Good: for every log this change writes, all three faces of #429 are fixed —
  masking and misattribution are structurally impossible (each event names its
  own worktree), and the strip self-clears because it no longer carries this
  class of fact. One caveat, a one-time transition artifact rather than a
  steady state: a session resumed *across* this upgrade whose fold still carries
  an old per-worktree `collector.error` stays `status: 'error'` until the next
  boot, because `withResumeReconciliation`'s `foldedUnhealthy` gate covers
  `disabled`/`degraded-retrying`, not `error`.
- Good: `CollectorState` keeps exactly one meaning (collector-process health),
  so `withResilience`'s disabled/degraded/healthy machine never has to
  reason about per-entity data.
- Good: no upcast machinery needed — old recordings carry no new events and
  refold cleanly; `dirtyStatusFailedSince` simply stays `null` forever for a
  pre-#429 log.
- Bad: the attention strip loses its own aggregate "some lane's git is
  failing" signal. The ruling names the intended new home — the lane's own
  row, or an attention-ladder read of `WorktreeState` — but building that
  consumer is explicitly out of scope for #429; until it exists, this signal
  is only visible in the event log and `WorktreeState`, not on screen.
- Bad: the threshold-and-latch shape now exists in two independent places in
  `git-collector.ts` (`dirtyFailures`, per-worktree; `refsFailures`,
  collector-wide) rather than one shared mechanism. Accepted per Option 1's
  rejection: unifying them for two call sites in one file is the same
  premature generalization this ADR just declined to do at the event-schema
  level.
- Neutral: `GitSnapshot` (the git collector's own internal, non-schema'd
  snapshot) grows one field (`refsFailures`); it is opaque to the poll loop
  and was already carrying `dirtyFailures` in the same shape.
