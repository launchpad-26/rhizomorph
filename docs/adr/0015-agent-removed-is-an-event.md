# 0015. Agent removed is an event, not a silent gap

- **Status:** proposed
- **Date:** 2026-08-12

## Context and Problem Statement

prd22 ruling 3 requires the fold to distinguish "gone" from "unchanged," in both
directions. It names workmux as a mirror of the git worktree case (#241): a
`workmux status` failure that isn't a missing binary parses as empty stdout, so
every known agent vanishes from the snapshot with no event at all — and,
independently, a handle that genuinely drops out of a *successful* poll (removed
outside rhizomorph) has never been diffed against the previous roster either, so
it also just stops appearing. Both need a way to say "this identity is gone" as a
fact distinct from "no change this tick." No such event exists for workmux today;
`agent.status` only carries `working`/`waiting`/`done`, workmux's own reported
vocabulary.

#241 (the git-side twin, same PRD wave) settled on reusing the *existing*
`worktree.removed` event rather than inventing a new type, keying off git's own
`prunable` annotation. Its own plan states the rule this ADR follows: reuse an
existing removal event if the source has one; only add a new type when it does
not. Workmux's entity is an agent keyed by `handle`, a different identity
namespace from a git worktree keyed by `path`, and no `agent`-shaped removal
event exists to reuse.

## Considered Options

- **A — A new `agent.removed` event** (source `workmux`), payload `{ handle:
  nonEmptyString }`.
- **B — Widen `agentStatusSchema`** with a synthetic `'removed'` member
  (`working|waiting|done|removed`), reusing `agent.status`.
- **C — A derived/selector-level staleness read** (no new event): infer "gone"
  from "no `agent.status` for handle X in N consecutive polls."
- **D — Reuse `worktree.removed`** for a departed agent handle, since #241
  already extended that event's meaning to "an entity proven absent."

## Decision Outcome

Chosen: **A**.

Payload and shape copied directly from the two precedents already in this
codebase: `worktreeRemovedPayloadSchema` (`{ path: nonEmptyString }`) and
`paneClosedPayloadSchema` (`{ paneId: nonEmptyString }`). The reducer gains the
same `present`/`removedAt` pair `WorktreeState` and `PaneState` already carry,
folded by a function with the same shape as `worktreeRemoved()`/`paneClosed()`.

**B was rejected** because `agent.status`'s enum is workmux's own reported
vocabulary — every member is a string `workmux status` actually prints in its
STATUS column. `'removed'` is not; it would be the collector's own synthetic
judgment injected into a field whose contract everywhere else is "raw fact,
straight off the command." It also gives the reducer no clean `present`/
`removedAt` shape to fold into — a status transition and a presence fact are
different shapes wearing one field.

**C was rejected** because it reintroduces, one level up, exactly the ambiguity
ruling 3 exists to remove: a timeout-shaped "hasn't been seen in a while" is
indistinguishable from "quiet but fine," which is the same complaint ruling 3
makes about git's carry-forward. Ruling 3's own text calls for a raw fact ("an
entity proven absent is dropped and its removal is an event"), not a heuristic.

**D was rejected**: `worktree.removed`'s payload is `{ path }`, keyed to a git
worktree's identity, not workmux's `handle` namespace — the two can and do
diverge (`workmux/collector.ts`'s own `listByHandle` join exists because a
worktree's basename and workmux's handle are not always the same string).
Reusing it would mean either widening its payload to carry both identities (a
schema change to an event `worktree.discovered`/`branch.updated` and every other
git reader also depend on, for a fact only workmux produces) or reporting an
agent's departure under a worktree's path, which is a lie the moment the two
diverge. `agent.status` already keeps its own `handle` identity distinct from
`worktreePath`/`branch` for exactly this reason; the removal event should keep
the same separation.

## Consequences

- **Good.** Matches two independent existing precedents' *shape* exactly
  (`worktree.removed`/`pane.closed`), so this is a known idiom extended to a
  third entity, not a new one invented — readers of one already know how to
  read `agent.removed`.
- **Good.** Purely additive at the wire level: `EVENT_SOURCE_BY_TYPE` and the
  discriminated union both grow, nothing existing changes shape, no old
  recording's bytes change on read.
- **Bad — touches the golden era corpus.** `AgentState` gaining required
  `present`/`removedAt` fields changes what era-1's `agent.status` events fold
  to, so `packages/core/src/eras/era-1/session-state.snapshot.json` needed
  re-blessing (`CAPTURE.md`'s documented, deliberate procedure) as part of
  landing this — a real, if small and one-time, cost every future field
  addition to a folded state type keeps paying.
- **Neutral.** Two structurally different "an entity left" events now exist
  side by side (`worktree.removed` keyed by `path`, `agent.removed` keyed by
  `handle`) rather than one shared shape. This is a direct consequence of D's
  rejection: the two namespaces are genuinely different identities, so forcing
  one shape onto both would have been the actual novelty, not the honest
  reading of what each source can prove.
