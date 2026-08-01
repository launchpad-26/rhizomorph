import type { Collector, CollectorContext, EventOf, ObservatoryEvent, PollResult } from '@observatory/core'

/**
 * The retry/backoff/self-heal policy shared by every collector whose poll
 * can fail on a transient exec (tmux server churning mid-merge, git worktree
 * mid-prune, a project-log directory briefly unreadable). Each of those
 * collectors already knows how to detect *its own* failure — it emits
 * `collector.disabled` and flips a `disabled` flag on its own snapshot when
 * the exec it depends on comes back failed. What none of them should have to
 * duplicate is the policy for *how many times to try before giving up, and
 * how to notice the world came back* — that lives here, once.
 *
 * A collector caught one failure and died forever (#110): the tmux server
 * hiccuped once while lanes were merging, the collector emitted
 * `collector.disabled`, latched its own `disabled: true`, and every later
 * poll was a silent no-op — recoverable only by restarting the server. This
 * wraps a collector so a lone failure is retried silently, only
 * `failureThreshold` CONSECUTIVE failures actually disable it (with the
 * count in the reason), and once disabled it keeps probing on a slow
 * interval and re-enables itself the moment a poll succeeds again.
 */

/** The shape every collector's own snapshot already has: a permanent-latch flag. */
export interface DisableableSnapshot {
  disabled: boolean
}

export interface ResilienceMeta {
  /** Failures in the current run of bad polls; 0 once a poll succeeds. */
  consecutiveFailures: number
  /** Tick timestamp this collector crossed the disable threshold; null while healthy or merely degraded. */
  disabledAt: number | null
  /** Earliest tick timestamp the wrapper will attempt another poll while disabled. */
  nextAttemptAt: number
}

export interface ResilientSnapshot<S> {
  inner: S
  resilience: ResilienceMeta
}

export interface ResilienceOptions {
  /** Consecutive failures before the collector is genuinely disabled. */
  failureThreshold?: number
  /** Once disabled, how often the wrapper lets a real poll attempt through. */
  retryIntervalMs?: number
}

export const DEFAULT_FAILURE_THRESHOLD = 3
export const DEFAULT_RETRY_INTERVAL_MS = 30_000

function isCollectorDisabledEvent(
  event: ObservatoryEvent,
): event is EventOf<'collector.disabled'> {
  return event.type === 'collector.disabled'
}

function freshResilience(): ResilienceMeta {
  return { consecutiveFailures: 0, disabledAt: null, nextAttemptAt: 0 }
}

function isResilientSnapshot<S>(value: unknown): value is ResilientSnapshot<S> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'inner' in value &&
    'resilience' in value
  )
}

/**
 * Wraps a `Collector<S>` (S must carry the `disabled` latch convention every
 * collector here already uses) with the shared resilience policy. The
 * wrapped collector's snapshot is opaque to the poll loop, same as any
 * other — it just happens to carry the inner collector's own state plus the
 * wrapper's failure bookkeeping.
 */
export function withResilience<S extends DisableableSnapshot>(
  collector: Collector<S>,
  options: ResilienceOptions = {},
): Collector<ResilientSnapshot<S>> {
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS

  return {
    name: collector.name,

    initialSnapshot(): ResilientSnapshot<S> {
      return { inner: collector.initialSnapshot(), resilience: freshResilience() }
    },

    async poll(
      prevWrapped: ResilientSnapshot<S>,
      context: CollectorContext,
    ): Promise<PollResult<ResilientSnapshot<S>>> {
      // A snapshot persisted before this policy existed (or by an unwrapped
      // build) is the collector's own raw shape, not `{inner, resilience}` —
      // same "start fresh" tolerance the snapshot store already extends to a
      // missing or corrupt file, just for a shape mismatch instead. The
      // collector's own state is real data, so it is kept rather than
      // discarded; only the wrapper's bookkeeping (which never existed
      // before) starts clean.
      const { inner: prevInner, resilience: prevResilience } = isResilientSnapshot<S>(prevWrapped)
        ? prevWrapped
        : { inner: prevWrapped as S, resilience: freshResilience() }

      // Backoff: a disabled collector must keep probing to notice the world
      // recovered, but not hammer a source that is still gone every tick —
      // skip the attempt entirely until the slow interval elapses.
      if (prevResilience.disabledAt !== null && context.now < prevResilience.nextAttemptAt) {
        return { nextSnapshot: prevWrapped, events: [] }
      }

      // Every attempt this wrapper schedules must look "enabled" to the
      // inner collector — its own `disabled` latch would otherwise no-op
      // forever once tripped, which is exactly the bug this wrapper exists
      // to fix.
      const attemptSnapshot = { ...prevInner, disabled: false } as S
      const result = await collector.poll(attemptSnapshot, context)
      const failureEvent = result.events.find(isCollectorDisabledEvent)

      if (!failureEvent) {
        const events = [...result.events]
        const wasUnhealthy = prevResilience.consecutiveFailures > 0 || prevResilience.disabledAt !== null
        if (wasUnhealthy) {
          events.unshift(
            context.emit('collector.recovered', {
              collector: collector.name,
              consecutiveFailures: prevResilience.consecutiveFailures,
            }),
          )
        }
        return {
          nextSnapshot: { inner: result.nextSnapshot, resilience: freshResilience() },
          events,
        }
      }

      const consecutiveFailures = prevResilience.consecutiveFailures + 1
      const reason = failureEvent.payload.reason

      if (consecutiveFailures < failureThreshold) {
        // Degraded, not disabled: force the inner snapshot back to
        // "enabled" for next tick so it actually retries the exec, rather
        // than latching on its own first failure.
        return {
          nextSnapshot: {
            inner: { ...result.nextSnapshot, disabled: false } as S,
            resilience: { consecutiveFailures, disabledAt: null, nextAttemptAt: 0 },
          },
          events: [
            context.emit('collector.degraded', {
              collector: collector.name,
              reason: `${reason} (attempt ${consecutiveFailures}/${failureThreshold} — retrying)`,
              consecutiveFailures,
            }),
          ],
        }
      }

      return {
        nextSnapshot: {
          inner: result.nextSnapshot,
          resilience: {
            consecutiveFailures,
            disabledAt: context.now,
            nextAttemptAt: context.now + retryIntervalMs,
          },
        },
        events: [
          // The WHAT ("<NAME> COLLECTOR DISABLED") and the command
          // (`observatory doctor`) are assembled downstream by the gap
          // registry (buildFleet.ts) from `collector.name` and this event's
          // fixed shape — `reason` only ever needs to carry the WHY, here
          // with the count that makes it honest about how hard this tried.
          context.emit('collector.disabled', {
            collector: collector.name,
            reason: `${reason} (after ${consecutiveFailures} consecutive failures)`,
            consecutiveFailures,
          }),
        ],
      }
    },
  }
}
