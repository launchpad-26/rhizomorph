import type { Collector, CollectorState } from '@rhizomorph/core'
import type { DisableableSnapshot, ResilientSnapshot } from './resilience.js'

/**
 * Reconciles a resilience-wrapped collector (#110) with the status its
 * session's event history already folds to, once, on this process's first
 * poll — see #111.
 *
 * `withResilience` only emits `collector.recovered` on an in-process
 * failing→succeeding transition. A process that just booted has no such
 * transition to notice even when it inherits a session whose fold still
 * says disabled/degraded from a run that ended before this one started —
 * whether that's because the persisted resilience snapshot pre-dates #110's
 * `{inner, resilience}` envelope (migrated to a fresh start, see
 * `withResilience`'s "snapshot migration" case) or simply because the
 * snapshot store's copy is a poll behind the event log's. Either way the
 * fold would otherwise carry a stale alarm about a collector that is, right
 * now, fine — the same shape of bug #97 fixed for stale worktrees, one
 * layer in.
 *
 * The reconciliation only ever appends a new event; it never rewrites a
 * past one, same as every other fact in this event-sourced log.
 */
export function withResumeReconciliation<S extends DisableableSnapshot>(
  collector: Collector<ResilientSnapshot<S>>,
  foldedState: CollectorState | undefined,
): Collector<ResilientSnapshot<S>> {
  let reconciled = false
  const foldedUnhealthy = foldedState?.status === 'disabled' || foldedState?.status === 'degraded-retrying'

  return {
    name: collector.name,
    initialSnapshot: collector.initialSnapshot,

    async poll(prevWrapped, context) {
      if (reconciled) return collector.poll(prevWrapped, context)
      reconciled = true

      const memoryDisabledBefore = prevWrapped.resilience.disabledAt !== null
      const result = await collector.poll(prevWrapped, context)
      const emittedTypes = new Set(result.events.map((event) => event.type))
      const alreadyReconciled =
        emittedTypes.has('collector.recovered') ||
        emittedTypes.has('collector.disabled') ||
        emittedTypes.has('collector.degraded')

      if (alreadyReconciled) return result

      // Fold says healthy, but the state this process resumed into was
      // already disabled — the backoff window swallowed this tick silently.
      // Say so now rather than waiting out the retry interval in a state
      // that looks fine and isn't.
      if (!foldedUnhealthy && memoryDisabledBefore) {
        return {
          nextSnapshot: result.nextSnapshot,
          events: [
            context.emit('collector.disabled', {
              collector: collector.name,
              reason: 'reconciled on resume: collector was already disabled in the resumed state',
              consecutiveFailures: prevWrapped.resilience.consecutiveFailures,
            }),
          ],
        }
      }

      // Fold says degraded/disabled from a past run, this poll came back
      // clean, but the in-process wrapper had no failing→succeeding
      // transition of its own to notice — so it never emitted
      // `collector.recovered`. Emit it here so the fold catches up.
      if (foldedUnhealthy) {
        return {
          nextSnapshot: result.nextSnapshot,
          events: [
            context.emit('collector.recovered', {
              collector: collector.name,
              consecutiveFailures: foldedState?.consecutiveFailures ?? 0,
            }),
            ...result.events,
          ],
        }
      }

      return result
    },
  }
}

/** A collector snapshot shaped enough to reconcile branch ghosts against. */
export interface BranchBearingSnapshot {
  branches: Record<string, unknown>
}

/**
 * Extends the #111 resume-reconciliation pattern above from collector
 * *health* to a collector's own diffed *content* — see #139.
 *
 * #137 taught the git collector to emit `branch.removed` from a
 * snapshot→snapshot diff: present in the persisted snapshot last poll,
 * absent from `for-each-ref` this poll. That is correct for every branch
 * removal that happens *after* #137 shipped. A removal that happened
 * *before* #137 never got an event at all — the pre-#137 collector's own
 * snapshot quietly dropped the branch with nothing to diff against, so the
 * persisted snapshot today already agrees with reality. The fold rebuilt
 * from the event log, though, only ever saw that branch's `branch.updated`
 * facts and has no `branch.removed` to retire them with — it is stuck
 * believing in a branch nothing but its own memory still remembers.
 *
 * At the first poll after a resume, compare what the fold still believes is
 * live (`foldedBranches`, the resumed session's `state.branches` keys)
 * against this poll's actual reality (`nextSnapshot.branches`, read *after*
 * the inner collector's own diff already ran). Any name the fold holds that
 * reality doesn't gets a real `branch.removed` — the same honest "not
 * present now" fact #137 emits, just reconstructed once for the removals
 * #137 arrived too late to see itself.
 *
 * Idempotent by construction: once emitted, the next boot's fold no longer
 * carries that name, so there is nothing left to reconcile. And because
 * this only ever appends a new event, it never touches replay — a log that
 * still lacks the reconciling event replays exactly as it always did; the
 * reconciliation is a live-boot act, never a rewrite of history.
 */
export function withBranchReconciliation<S extends BranchBearingSnapshot>(
  collector: Collector<S>,
  foldedBranches: ReadonlySet<string> | undefined,
): Collector<S> {
  let reconciled = false

  return {
    name: collector.name,
    initialSnapshot: collector.initialSnapshot,

    async poll(prevSnapshot, context) {
      const result = await collector.poll(prevSnapshot, context)
      if (reconciled) return result
      reconciled = true

      if (!foldedBranches || foldedBranches.size === 0) return result

      const alreadyReported = new Set<string>()
      for (const event of result.events) {
        if (event.type === 'branch.removed') alreadyReported.add(event.payload.branch)
      }

      const ghosts = [...foldedBranches]
        .filter((branch) => !(branch in result.nextSnapshot.branches) && !alreadyReported.has(branch))
        .sort()

      if (ghosts.length === 0) return result

      return {
        nextSnapshot: result.nextSnapshot,
        events: [...result.events, ...ghosts.map((branch) => context.emit('branch.removed', { branch }))],
      }
    },
  }
}

/** A collector snapshot shaped enough to reconcile agent ghosts against. */
export interface AgentBearingSnapshot {
  agents: Record<string, unknown>
}

/**
 * Extends the #111/#139 resume-reconciliation seam from collector health,
 * then branch content, to workmux's own agent roster — see #418.
 *
 * #306 taught the workmux collector to emit `agent.removed` from a
 * snapshot→snapshot diff: present last poll, absent from this poll's
 * `workmux status`. That is correct for every departure that happens while
 * the collector is running. A departure that happened while the process was
 * down, or whose workmux snapshot is missing or stale, is never diffed at
 * all — the fold still carries the handle's last `agent.status` with nothing
 * to retire it with, the same gap #139 closed for branches.
 *
 * At the first poll after a resume, compare what the fold still believes is
 * live (`foldedHandles` — the resumed session's still-`present` agent
 * handles) against this poll's actual reality (`nextSnapshot.agents`, read
 * *after* the inner collector's own diff already ran). Any handle the fold
 * holds that reality doesn't gets a real `agent.removed` — reconstructed
 * once for the departure the live diff arrived too late, or had nothing, to
 * see itself.
 *
 * Idempotent by construction, same as `withBranchReconciliation`: emitting
 * `agent.removed` flips the fold's `present` to false (`reduce.ts`'s
 * `agentRemoved`), so the next boot's `foldedHandles` no longer carries that
 * handle — unlike `branches`, an agent record is a soft delete, so the ghost
 * set must be *present* handles, not all folded keys. That filtering is the
 * caller's job (`collector-loader.ts`); this wrapper is agnostic to how the
 * set was built, same as `withBranchReconciliation`.
 *
 * This wrapper sits inside `withResilience` (see `collector-loader.ts`), so
 * `collector` here is the raw inner collector — its only failure signal is a
 * `collector.disabled` event; `collector.degraded` / `collector.recovered`
 * are translations `withResilience` produces one layer out and never appear
 * here. A poll that emits `collector.disabled` did not observe reality: the
 * raw collector either couldn't run at all, or carried the previous snapshot
 * forward unchanged (workmux's own ruling 3 direction 1) — which, on a
 * resume with a missing snapshot, is empty. Comparing that against the fold
 * would read "nothing observed yet" as "everyone left" and mass-retire the
 * whole roster on a transient blip, and the one-shot latch would be spent for
 * nothing, leaving any real departure unreconciled for the rest of the
 * process. So this wrapper bails without latching whenever the poll failed.
 */
export function withAgentReconciliation<S extends AgentBearingSnapshot>(
  collector: Collector<S>,
  foldedHandles: ReadonlySet<string> | undefined,
): Collector<S> {
  let reconciled = false

  return {
    name: collector.name,
    initialSnapshot: collector.initialSnapshot,

    async poll(prevSnapshot, context) {
      const result = await collector.poll(prevSnapshot, context)
      if (reconciled) return result

      const pollFailed = result.events.some((event) => event.type === 'collector.disabled')
      if (pollFailed) return result

      reconciled = true

      if (!foldedHandles || foldedHandles.size === 0) return result

      const alreadyReported = new Set<string>()
      for (const event of result.events) {
        if (event.type === 'agent.removed') alreadyReported.add(event.payload.handle)
      }

      const ghosts = [...foldedHandles]
        .filter((handle) => !(handle in result.nextSnapshot.agents) && !alreadyReported.has(handle))
        .sort()

      if (ghosts.length === 0) return result

      return {
        nextSnapshot: result.nextSnapshot,
        events: [...result.events, ...ghosts.map((handle) => context.emit('agent.removed', { handle }))],
      }
    },
  }
}
