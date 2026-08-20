import type { RhizomorphEvent } from '@rhizomorph/core'
import type { Fleet } from '../fleet/index.js'
import { SETTLE_MS, seedSize } from './geometry.js'
import { GROWTH } from './motion.js'
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
 *
 * A **germinating** lane (prd6 ruling 3) needs nothing special from this file, and
 * that is the point: a re-dispatched handle is a new worktree, so it is a new
 * discovery and it grows in exactly like any other. What makes it a germination
 * rather than a stranger is where the growth happens — `geometry.ts` seats it on
 * the seed its handle left behind, at that seed's angle and starting from the size
 * it earned — so the same 900 ms of growth reads as the old lane coming back.
 */
export class SettleRegistry {
  private readonly startedAt = new Map<string, number>()

  /**
   * Record any new discoveries in this batch. Returns the lane ids that actually
   * started growing, so a caller can tell a real settle from a re-report.
   */
  note(events: readonly RhizomorphEvent[], index: LaneIndex, now: number): string[] {
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

  private readonly thickness = new Map<string, { value: number; at: number }>()

  /**
   * THICKEN WHILE ALIVE (prd-33 ruling 9's third verb; cause `'work'`).
   *
   * Encoded width steps discontinuously as token counts arrive; the drawn
   * width tracks it on a low-pass (`GROWTH.thickenTau`) with a rate cap
   * (`GROWTH.maxRatePerS`) — "gentle" as two numbers. Three honesty clauses:
   *
   * - **Only change animates.** A lane's first sighting initialises AT its
   *   target — a fleet appearing on boot at its historical sizes must not
   *   thicken from zero (ruling 32's stance, extended from pulses to width).
   * - **Understate only.** The tracker never exceeds the encoded width, so
   *   the locked work-size channel is only ever read low during the approach.
   * - **The caller's clock decides.** Fed the scene clock, a pause freezes
   *   thicken exactly as it freezes the breath — unlike the grow-in, thicken
   *   has no topology to finish (an under-width thread is a true lane whose
   *   width is still arriving), so it holds with the picture.
   */
  sizes(fleet: Fleet, now: number): Map<string, number> {
    const out = new Map<string, number>()
    const seen = new Set<string>()
    for (const lane of fleet.lanes) {
      seen.add(lane.id)
      const target = seedSize(lane.outputTokens)
      const known = this.thickness.get(lane.id)
      if (known === undefined) {
        this.thickness.set(lane.id, { value: target, at: now })
        out.set(lane.id, target)
        continue
      }
      const dt = Math.max(0, now - known.at)
      const approach = 1 - Math.exp(-dt / GROWTH.thickenTau)
      const step = (target - known.value) * approach
      const cap = Math.abs(target) * GROWTH.maxRatePerS * (dt / 1_000)
      const moved = known.value + Math.sign(step) * Math.min(Math.abs(step), cap)
      // Never overshoot in the direction of travel — understate-only holds on
      // the way up, and a (rare) downward retarget lands exactly, never below.
      const final = step >= 0 ? Math.min(moved, target) : Math.max(moved, target)
      this.thickness.set(lane.id, { value: final, at: now })
      out.set(lane.id, final)
    }
    // Lanes that left the fleet stop being tracked — a returning handle is a
    // new lane and initialises at its own target.
    for (const id of this.thickness.keys()) {
      if (!seen.has(id)) this.thickness.delete(id)
    }
    return out
  }
}
