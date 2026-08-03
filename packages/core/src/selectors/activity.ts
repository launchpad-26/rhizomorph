import type { SessionState } from '../state.js'
import { compareStrings } from './touches.js'

/**
 * #141 — the strongest of the metrics prd1 wired but never read. OTel's
 * `claude_code.active_time.total` is a monotonic counter reported per session,
 * kept whole in `state.telemetry.activeTime` (the telemetry-slice pattern):
 * nothing is accumulated in the fold, so every total here is derived on read,
 * same as the money layer's own totals in `selectors/spend.ts`.
 *
 * The one rule this file exists to get right: **a session's counter can reset**
 * (the CLI process restarts and starts counting active seconds from zero
 * again), so naively summing every datapoint, or even just taking the latest
 * one, double-counts or under-counts across a restart. The honest fold is:
 * for each session, take the LARGEST value it ever reported — a monotonic
 * counter's high-water mark survives a mid-session reset, because a reset
 * only ever produces a smaller *later* reading, never a larger one — then sum
 * those per-session watermarks for the lane. A reading with no session id has
 * nothing to join against, so it stands as its own one-reading group rather
 * than being folded into (or against) anyone else's.
 */

export interface LaneActiveTime {
  lane: string
  activeSeconds: number
  /** Session ids that contributed a watermark, alphabetical. */
  sessionIds: string[]
}

interface SessionWatermark {
  lane: string
  activeSeconds: number
}

/** Per session id (or a synthetic one-reading group), the highest value seen. */
function sessionWatermarks(state: SessionState): Map<string, SessionWatermark> {
  const watermarks = new Map<string, SessionWatermark>()
  let anonymous = 0
  for (const record of state.telemetry.activeTime) {
    const key = record.sessionId ?? `__no-session-${anonymous++}`
    const current = watermarks.get(key)
    if (current === undefined || record.activeSeconds > current.activeSeconds) {
      watermarks.set(key, { lane: record.lane, activeSeconds: record.activeSeconds })
    }
  }
  return watermarks
}

/**
 * One row per lane that has ever reported active time, dearest first. A lane
 * the counter never reached is simply absent — never a zeroed row, which is
 * what would let a surface mistake "no OTel" for "measured, and it was zero".
 */
export function selectActiveTimeByLane(state: SessionState): LaneActiveTime[] {
  const byLane = new Map<string, { activeSeconds: number; sessionIds: Set<string> }>()

  for (const [key, watermark] of sessionWatermarks(state)) {
    const entry = byLane.get(watermark.lane) ?? { activeSeconds: 0, sessionIds: new Set<string>() }
    entry.activeSeconds += watermark.activeSeconds
    if (!key.startsWith('__no-session-')) entry.sessionIds.add(key)
    byLane.set(watermark.lane, entry)
  }

  return [...byLane.entries()]
    .map(([lane, { activeSeconds, sessionIds }]) => ({
      lane,
      activeSeconds,
      sessionIds: [...sessionIds].sort(compareStrings),
    }))
    .sort((a, b) => b.activeSeconds - a.activeSeconds || compareStrings(a.lane, b.lane))
}

export function selectActiveSecondsByLaneIndex(state: SessionState): Record<string, number> {
  const index: Record<string, number> = {}
  for (const entry of selectActiveTimeByLane(state)) index[entry.lane] = entry.activeSeconds
  return index
}

/** Null for a lane the counter has never reached — never an invented zero. */
export function selectActiveSecondsForLane(state: SessionState, lane: string): number | null {
  return selectActiveSecondsByLaneIndex(state)[lane] ?? null
}
