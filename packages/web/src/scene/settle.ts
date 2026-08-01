import type { ObservatoryEvent } from '@observatory/core'
import { SETTLE_MS } from './geometry.js'
import { clamp01 } from './palette.js'
import { resolveLane, type LaneIndex } from './resolve.js'

/**
 * THE SETTLE (graft g3) — a new lane's thread grows out of the root-mass.
 *
 * Event-lawful, which is the whole reason it is allowed: the growth is a
 * `worktree.discovered` and nothing else. Spike B cut this for screenshot
 * determinism rather than on principle, so the fix is determinism, not
 * abstinence — every clock is injected, `settle.test.ts` drives the growth on a
 * fake one, and a pinned clock produces a still image at a known stage.
 *
 * Two constraints the code enforces rather than trusts:
 *
 * - **Only news grows in.** A stream replays its whole session on connect; a
 *   fleet that sprouted twenty threads on every page load would be animating
 *   history, which ruling 32 forbids. The registry is fed from the same news
 *   tail the pulse field reads.
 * - **Once per discovery.** The git collector re-reports the worktrees it can
 *   see, so the same `worktree.discovered` arrives again whenever the collector
 *   restarts. A lane already growing (or already grown) keeps its original start
 *   instant, so nothing re-sprouts.
 */
export class SettleRegistry {
  private readonly startedAt = new Map<string, number>()

  /**
   * Record any new discoveries in this batch. Returns the lane ids that actually
   * started growing, so a caller can tell a real settle from a re-report.
   */
  note(events: readonly ObservatoryEvent[], index: LaneIndex, now: number): string[] {
    const started: string[] = []
    for (const event of events) {
      if (event.type !== 'worktree.discovered') continue
      // Main is the mass, not a thread that grows out of it.
      if (event.payload.isMain) continue
      const laneId = resolveLane(index, event)
      if (laneId === null || this.startedAt.has(laneId)) continue
      this.startedAt.set(laneId, now)
      started.push(laneId)
    }
    return started
  }

  /**
   * laneId → grow-in progress, for the lanes still growing. A lane that finished
   * growing is dropped from the map entirely rather than pinned at 1: the
   * geometry treats an absent entry as "already grown", so the common case — a
   * settled fleet — costs nothing per frame.
   */
  progress(now: number): Map<string, number> {
    const growing = new Map<string, number>()
    for (const [laneId, started] of this.startedAt) {
      const value = clamp01((now - started) / SETTLE_MS)
      if (value < 1) growing.set(laneId, value)
    }
    return growing
  }

  /** True while at least one thread is still growing — the frame loop's hint. */
  settling(now: number): boolean {
    for (const started of this.startedAt.values()) {
      if (now - started < SETTLE_MS) return true
    }
    return false
  }
}
