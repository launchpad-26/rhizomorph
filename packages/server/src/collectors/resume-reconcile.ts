import type { Collector, CollectorState } from '@rhizomorph/core'
import type { GitSnapshot } from './git/types.js'
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
 *
 * A poll that did not observe branches did not observe reality — and
 * `collector.disabled` is not the only way that happens. The git collector
 * carries `prevSnapshot` forward unchanged on a failed
 * `git worktree list --porcelain` (`collector.disabled`, `git-collector.ts`),
 * but a *second*, sibling path does the identical carry-forward one call
 * later: a failed `git for-each-ref` emits `collector.error` (not
 * `collector.disabled`) and `diffBranches` returns `prevSnapshot.branches`
 * verbatim — same object, not a copy. Gating on the event type alone (as
 * originally written here) covers the first path and misses the second:
 * verified live (#449 verify findings, step 10) that a for-each-ref blip on
 * a fresh post-resume boot (empty persisted snapshot) reads as "every folded
 * branch is gone" and mass-retires a repo's entire real branch set, and
 * because that path emits `collector.error` rather than `collector.disabled`,
 * `withResilience` does not swallow it — the false removals reach the
 * recorder and land permanently in the append-only session log.
 *
 * The honest gate is not "which event type did this poll emit" but "did this
 * poll hand back branches it actually observed, or just the ones it was
 * given" — and the collector's own return value already answers that: every
 * successful `diffBranches` call builds a fresh `nextBranches` object, so
 * `result.nextSnapshot.branches` is only ever the *same object reference* as
 * `prevSnapshot.branches` when nothing was observed this tick, whether that's
 * because the whole poll failed (`collector.disabled`) or just the branch
 * read within it did (`collector.error`). Checking identity instead of event
 * type catches both without needing to know which failure produced which
 * event — and doesn't misfire on an unrelated `collector.error` (e.g. a
 * detached-HEAD warning) that a poll which *did* observe branches might also
 * emit.
 *
 * Comparing a carried-forward snapshot against the fold would read "nothing
 * observed yet" as "every folded branch is gone" and mass-retire the whole
 * set on one transient blip, spending the one-shot latch for nothing and
 * leaving any real removal unreconciled for the rest of the process. So this
 * wrapper bails without latching whenever the poll it just ran didn't
 * actually observe branches (#449).
 *
 * The signature below takes `GitSnapshot` concretely rather than a generic
 * `S extends BranchBearingSnapshot` (#454). The identity gate above is an
 * inferred contract — "not observed" is read off an allocation side effect,
 * not stated by the collector — and that inference is only as good as the
 * one collector it has actually been checked against: every reachable
 * `gitCollector` poll either allocates a fresh `branches` object or hits one
 * of the two known non-observation paths above, both of which emit
 * `collector.disabled` or `collector.error` (#449 re-verify, step 2's
 * exhaustive enumeration: unborn HEAD, detached HEAD, four-tick steady
 * state, both carry-forward failures, and the sticky-disabled latch, which
 * is unreachable on the wired path).
 *
 * That "unreachable" claim rests on a second inferred contract one layer
 * out, in `withResilience` rather than this wrapper: the sticky-disabled
 * latch above only stays unreachable because `withResilience` hands every
 * attempt `{ ...prevInner, disabled: false }` (`resilience.ts:118`), and
 * that spread is shallow — `branches` keeps its original reference, so the
 * identity gate here still reads "not observed" correctly on that path too.
 * A deep-clone of `prevInner` there would silently break this gate with no
 * type error and no failing test on either side, since neither file's
 * signature says anything about how nested fields are copied.
 *
 * Before #454 the wrapper was generic, so
 * nothing stopped some unrelated future collector from being handed to it
 * with that contract never checked at all — silently disabling
 * reconciliation for the life of the process, no event, no log line, green
 * suite. Naming `GitSnapshot` here makes that contract visible to the
 * compiler: only a collector whose snapshot is (structurally) a
 * `GitSnapshot` may be wrapped, so reusing this for anything else is a type
 * error, not a silent gap.
 *
 * That narrowing cannot check `gitCollector`'s own *behaviour*, though — a
 * future edit to `git-collector.ts` could still add a "nothing changed →
 * return `prevSnapshot`" fast path (the same shape its own sticky-disabled
 * latch already has one screen up) without changing any type. The `poll`
 * body below closes that residual gap at runtime: if identity says "not
 * observed" and neither known failure event is present, that is an
 * unexplained contract violation, and it is reported as a loud
 * `collector.error` rather than passed through silently.
 *
 * Gate asymmetry, for whoever next reads this next to
 * `withAgentReconciliation` and is tempted to unify the two: this wrapper
 * gates on allocation identity because `gitCollector` allocates fresh
 * `branches` on every poll that isn't a known failure (verified above).
 * `withAgentReconciliation` below gates on the `collector.disabled` event
 * instead, because workmux's missing-binary path returns a *fresh* empty
 * `agents: {}` — identity there would misread "observed an empty roster" as
 * legitimate and retire every folded agent. Do not port either gate to the
 * other collector without re-verifying its allocation behaviour from
 * scratch; they are correct only because they are different.
 */
export function withBranchReconciliation(
  collector: Collector<GitSnapshot>,
  foldedBranches: ReadonlySet<string> | undefined,
): Collector<GitSnapshot> {
  let reconciled = false

  return {
    name: collector.name,
    initialSnapshot: collector.initialSnapshot,

    async poll(prevSnapshot, context) {
      const result = await collector.poll(prevSnapshot, context)
      if (reconciled) return result

      const observedBranches = result.nextSnapshot.branches !== prevSnapshot.branches
      if (!observedBranches) {
        const explainedByKnownFailure = result.events.some(
          (event) => event.type === 'collector.disabled' || event.type === 'collector.error',
        )
        if (explainedByKnownFailure) return result

        // #454: identity says nothing was observed, but neither known
        // non-observation path (a failed `git worktree list`, a failed
        // `git for-each-ref`) explains it — gitCollector's own allocation
        // contract, which the identity gate above depends on, has been
        // silently broken. Say so loudly instead of disabling reconciliation
        // for the rest of the process with nothing to show for it.
        return {
          nextSnapshot: result.nextSnapshot,
          events: [
            ...result.events,
            context.emit('collector.error', {
              collector: collector.name,
              message:
                `${collector.name} returned branches unchanged from the previous snapshot without emitting ` +
                `collector.disabled or collector.error — withBranchReconciliation's identity gate (#454) can ` +
                `only tell "not observed" from "observed, nothing changed" because this collector is verified ` +
                `to always allocate fresh branches otherwise; that contract just broke`,
            }),
          ],
        }
      }

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
 * resume with a missing snapshot, is empty.
 *
 * Gate asymmetry, deliberate (#454, see `withBranchReconciliation` above for
 * the full argument): this wrapper gates on the `collector.disabled` event
 * rather than `agents` reference identity because workmux's missing-binary
 * path returns a *fresh* empty `agents: {}` — identity would misread that as
 * "observed an empty roster" and retire everyone folded. Do not port
 * `withBranchReconciliation`'s identity gate here without re-verifying
 * workmux's allocation behaviour from scratch; the two wrappers use
 * different gates on purpose.
 *
 * Comparing that against the fold would read "nothing observed yet" as
 * "everyone left" and mass-retire the
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
