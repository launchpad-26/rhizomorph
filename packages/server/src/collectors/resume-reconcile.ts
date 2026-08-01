import type { Collector, CollectorState } from '@observatory/core'
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
