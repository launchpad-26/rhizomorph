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
