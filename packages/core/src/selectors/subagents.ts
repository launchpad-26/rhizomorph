import type { SessionState, SpanRecord } from '../state.js'
import { compareStrings } from './touches.js'

/**
 * prd10 ruling 9's data layer — the fact the scene's subagent buds will read:
 * does a lane have a subagent thread alive RIGHT NOW, and if the lane is
 * trace-instrumented, whose subagent is it.
 *
 * Two signals, kept strictly apart:
 *
 * - **Liveness** comes only from `llm.usage`/`tool.activity` records marked
 *   `thread: 'subagent'` (prd1's thread dimension, `events/telemetry.ts`) —
 *   the same `isSidechain` marker every lane's sessionlog already carries, so
 *   this reads for every instrumented lane and the tailed conductor alike.
 * - **Enrichment** — `agentId`/`subagentType` — comes only from `trace.span`
 *   records, which are a beta and not every lane exports them. A lane can
 *   therefore be live with no enrichment (subagent thread active, no trace),
 *   but never the other way around: a span alone, with no thread-marked
 *   telemetry recent enough, does not make a lane's bud live (prd9 ruling 4's
 *   discipline about spans applies here too — they annotate, they never
 *   originate a fact this selector reports).
 *
 * Honest gaps: a lane with no `thread: 'subagent'` record inside the window
 * is simply absent from the result — never a zeroed "not live" row. A caller
 * that wants "does lane X have a bud" asks the index, and a miss there means
 * exactly that, the same convention `selectActiveSecondsForLane` uses for a
 * lane the active-time counter never reached.
 */

/** Same "still counts as now" width `DEFAULT_FLATLINE_MS`/`DEFAULT_SPEND_WINDOW_MS` use. */
export const DEFAULT_SUBAGENT_RECENCY_MS = 5 * 60_000

export interface SubagentActivityOptions {
  /** Epoch millis to measure against — injected, never read from the clock. */
  now: number
  /** Silence beyond this means the bud is no longer live. */
  recencyMs?: number
}

export interface LaneSubagentActivity {
  lane: string
  /** Newest thread-marked `llm.usage`/`tool.activity` ts inside the window. */
  lastActivityTs: number
  /** From a matching `trace.span`, when the lane is trace-instrumented; else null. */
  agentId: string | null
  /** Ditto. Both are null together — a span never reports one without the other having a chance to be there. */
  subagentType: string | null
}

/**
 * One row per lane with a `thread: 'subagent'` reading inside the window,
 * dearest (most recent) first. The conductor's own telemetry lane is not
 * special-cased out — its subagents count exactly like any worker's, because
 * this file groups by whatever `lane` the record itself carries.
 */
export function selectSubagentActivity(
  state: SessionState,
  options: SubagentActivityOptions,
): LaneSubagentActivity[] {
  const recencyMs = Math.max(0, options.recencyMs ?? DEFAULT_SUBAGENT_RECENCY_MS)
  const since = options.now - recencyMs

  const latest = new Map<string, number>()
  const touch = (lane: string, ts: number): void => {
    if (ts < since || ts > options.now) return
    const current = latest.get(lane)
    if (current === undefined || ts > current) latest.set(lane, ts)
  }

  for (const record of state.telemetry.usage) {
    if (record.thread === 'subagent') touch(record.lane, record.ts)
  }
  for (const record of state.telemetry.tools) {
    if (record.thread === 'subagent') touch(record.lane, record.ts)
  }

  const enrichment = latestSubagentSpanByLane(state, since, options.now)

  return [...latest.entries()]
    .map(([lane, lastActivityTs]) => {
      const span = enrichment.get(lane)
      return {
        lane,
        lastActivityTs,
        agentId: span?.agentId ?? null,
        subagentType: span?.subagentType ?? null,
      }
    })
    .sort((a, b) => b.lastActivityTs - a.lastActivityTs || compareStrings(a.lane, b.lane))
}

export function selectSubagentActivityIndex(
  state: SessionState,
  options: SubagentActivityOptions,
): Record<string, LaneSubagentActivity> {
  const index: Record<string, LaneSubagentActivity> = {}
  for (const entry of selectSubagentActivity(state, options)) index[entry.lane] = entry
  return index
}

/** Null for a lane with no live subagent bud — never a zeroed one. */
export function selectSubagentActivityForLane(
  state: SessionState,
  lane: string,
  options: SubagentActivityOptions,
): LaneSubagentActivity | null {
  return selectSubagentActivityIndex(state, options)[lane] ?? null
}

/**
 * Each lane's newest span carrying a subagent identity, inside the window —
 * the enrichment half. A span's own `thread` is not required to be
 * `'subagent'` here: the capture shows a `Task` call's own span (which runs on
 * the dispatching lane's `main` thread) is exactly where `subagentType` rides,
 * so requiring `thread === 'subagent'` on the span itself would throw away
 * the one place the type is actually reported.
 */
function latestSubagentSpanByLane(
  state: SessionState,
  since: number,
  now: number,
): Map<string, SpanRecord> {
  const latest = new Map<string, SpanRecord>()
  for (const span of state.traces.spans) {
    if (span.agentId === null && span.subagentType === null) continue
    if (span.ts < since || span.ts > now) continue
    const current = latest.get(span.lane)
    if (current === undefined || span.ts > current.ts) latest.set(span.lane, span)
  }
  return latest
}
