import type { Collector, CollectorContext, PollResult, RhizomorphEvent } from '@rhizomorph/core'
import { discoverLanes } from '../../judge/lanes.js'
import { speculativeMergeTree } from '../../judge/mergetree.js'
import { extractLaneSymbols, intersectSymbols } from '../../judge/symbols.js'

/**
 * prd11 ruling 6b, phase 1 — the semantic judge's structural organ, wired as
 * a polled collector (research `docs/research/2026-08-04-semantic-judge-spike.md`,
 * open question 4: this issue's direction settles it — inside the server, a
 * collector, like every other observer). Every finding this poll emits is
 * `judge.finding` at `severity: 'log'` — the ladder's silent first rung ONLY
 * (research §3); nothing here ever summons.
 */

const COLLECTOR_NAME = 'judge'

/** Default cadence: every 60s, not every poll tick — a LOW-cost organ stays low-cost. Flag-adjustable via `createJudgeCollector`'s options; wired from an env var in `collector-loader.ts`. */
export const DEFAULT_JUDGE_CADENCE_MS = 60_000

export interface JudgeCollectorOptions {
  cadenceMs?: number
}

export interface JudgeSnapshot {
  disabled: boolean
  /** Tick clock at the last run that actually did work; ticks in between are a cheap no-op. */
  lastRunAt: number | null
  /**
   * `<kind>:<laneA>@<headA>:<laneB>@<headB>` → already emitted at this exact
   * head pair. Rebuilt fresh every run from only the pairs and kinds that were
   * actually true THIS run, so it never grows unbounded and a stale entry for
   * a branch that moved or disappeared falls away on its own — nothing here
   * needs an explicit eviction policy.
   */
  reported: Record<string, true>
}

export function createJudgeCollector(options: JudgeCollectorOptions = {}): Collector<JudgeSnapshot> {
  const cadenceMs = options.cadenceMs ?? DEFAULT_JUDGE_CADENCE_MS

  return {
    name: COLLECTOR_NAME,

    initialSnapshot(): JudgeSnapshot {
      return { disabled: false, lastRunAt: null, reported: {} }
    },

    async poll(prevSnapshot, context: CollectorContext): Promise<PollResult<JudgeSnapshot>> {
      if (prevSnapshot.disabled) {
        return { nextSnapshot: prevSnapshot, events: [] }
      }

      if (prevSnapshot.lastRunAt !== null && context.now - prevSnapshot.lastRunAt < cadenceMs) {
        return { nextSnapshot: prevSnapshot, events: [] }
      }

      let discovery: Awaited<ReturnType<typeof discoverLanes>>
      try {
        discovery = await discoverLanes(context.exec, context.repoPath)
      } catch (error) {
        return {
          nextSnapshot: { ...prevSnapshot, disabled: true },
          events: [
            context.emit('collector.disabled', {
              collector: COLLECTOR_NAME,
              reason: error instanceof Error ? error.message : String(error),
            }),
          ],
        }
      }

      const { mainBranch, lanes } = discovery
      if (mainBranch === null || lanes.length < 2) {
        // Nothing to corroborate yet — graceful no-op, same as workmux's
        // "binary missing" latch but without disabling: this is a normal,
        // expected shape of a session that hasn't forked into lanes yet.
        return { nextSnapshot: { disabled: false, lastRunAt: context.now, reported: {} }, events: [] }
      }

      const events: RhizomorphEvent[] = []
      const symbolsByBranch = new Map<string, string[]>()

      for (const lane of lanes) {
        try {
          const extracted = await extractLaneSymbols({
            exec: context.exec,
            repoPath: context.repoPath,
            mainBranch,
            branch: lane.branch,
          })
          symbolsByBranch.set(lane.branch, extracted.symbols)
        } catch (error) {
          events.push(
            context.emit('collector.error', {
              collector: COLLECTOR_NAME,
              message: `symbol extraction failed for lane "${lane.branch}"`,
              detail: error instanceof Error ? error.message : String(error),
            }),
          )
        }
      }

      const nextReported: Record<string, true> = {}

      for (let i = 0; i < lanes.length; i += 1) {
        for (let j = i + 1; j < lanes.length; j += 1) {
          const left = lanes[i]
          const right = lanes[j]
          if (!left || !right || left.branch === right.branch) continue
          const [first, second] = left.branch < right.branch ? [left, right] : [right, left]

          const symbolsA = symbolsByBranch.get(first.branch)
          const symbolsB = symbolsByBranch.get(second.branch)
          if (symbolsA && symbolsB) {
            const overlap = intersectSymbols(symbolsA, symbolsB)
            if (overlap.length > 0) {
              const key = `symbol-overlap:${first.branch}@${first.head}:${second.branch}@${second.head}`
              nextReported[key] = true
              if (!prevSnapshot.reported[key]) {
                events.push(
                  context.emit('judge.finding', {
                    kind: 'symbol-overlap',
                    lanes: [first.branch, second.branch],
                    evidence: { symbols: overlap },
                    severity: 'log',
                    detectedAt: context.now,
                  }),
                )
              }
            }
          }

          try {
            const merge = await speculativeMergeTree({
              exec: context.exec,
              repoPath: context.repoPath,
              branchA: first.branch,
              branchB: second.branch,
            })
            if (!merge.clean) {
              const key = `speculative-conflict:${first.branch}@${first.head}:${second.branch}@${second.head}`
              nextReported[key] = true
              if (!prevSnapshot.reported[key]) {
                events.push(
                  context.emit('judge.finding', {
                    kind: 'speculative-conflict',
                    lanes: [first.branch, second.branch],
                    evidence: { conflictingFiles: merge.conflictingFiles },
                    severity: 'log',
                    detectedAt: context.now,
                  }),
                )
              }
            }
          } catch (error) {
            events.push(
              context.emit('collector.error', {
                collector: COLLECTOR_NAME,
                message: `speculative merge failed for "${first.branch}" vs "${second.branch}"`,
                detail: error instanceof Error ? error.message : String(error),
              }),
            )
          }
        }
      }

      return {
        nextSnapshot: { disabled: false, lastRunAt: context.now, reported: nextReported },
        events,
      }
    },
  }
}
