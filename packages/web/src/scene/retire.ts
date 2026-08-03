import type { RhizomorphEvent } from '@rhizomorph/core'
import type { Fleet, Lane } from '../fleet/index.js'
import { DISSOLUTION, STRUCTURAL, allowance, type MotionMode } from './motion.js'
import { DONE, ICE_400, ICE_600, clamp01, ink, mix, type Ink } from './palette.js'
import { resolveLane, type LaneIndex } from './resolve.js'
import { springStep } from './spring.js'

/**
 * THE CORD-CUT (prd5 ruling 3) — a finished lane leaves the living network.
 *
 * Every graph tool we could find retires a node by *restyling* it and leaving it
 * attached: GitHub Actions swaps a status icon and keeps the dependency lines,
 * Obsidian dims an orphan and keeps it in the sim, React Flow has no lifecycle
 * for it at all. Nothing found detaches the edge. So this is the Rhizomorph's
 * own idiom, and the reason it is worth having is that the picture then answers
 * "is this fleet still working?" *structurally* rather than by colour: a lane
 * that has landed is no longer connected to the mass, and no amount of squinting
 * at a hue is needed to see it.
 *
 * It is a **staged** retirement, because Heer & Robertson measured staged
 * transitions beating single-shot ones at exactly this job — a topology change
 * the viewer has to be able to follow — and recommend about a second per stage.
 * Three stages, ~1.4 s, one channel each:
 *
 * | stage       | ms  | what changes                                        |
 * | ----------- | --- | --------------------------------------------------- |
 * | `tension`   | 150 | curvature only. The thread goes slack at the root.  |
 * | `retract`   | 800 | position only. The freed end springs back, ζ = 1.   |
 * | `settle`    | 450 | colour only. The remnant desaturates into a scar.   |
 * | `scar`      |  ∞  | the resting state. Drawn for ever, never again lit. |
 *
 * One channel per stage is the whole trick. A single 1.4 s animation that moved
 * and dimmed and slackened at once would read as "something happened"; three
 * stages that each change one thing read as "let go — sprang back — went cold",
 * which is a sentence.
 *
 * prd10 ruling 2 adds a **fourth channel** and, unusually, one that outlives the
 * other three: {@link RetireState.dissolve}, the cord composting into motes that
 * carry its matter home (`motes.ts`). It begins as the cord parts and ends about a
 * second after the cut has settled, and when it ends the cord's ribbon geometry is
 * *gone* — "no stubs persist; the scene may forget the thread's geometry because
 * the LEDGER remembers the thread". The sentence gains a clause: "let go — sprang
 * back — went cold — and came home", which is the difference between a scene that
 * amputates and one that returns (ruling 1). What stays at the rim is the lane's
 * lens, its name and its figure — prd5's law 1 in its own words, and the reason
 * completion is still never invisible — plus the permanent growth ring the arrival
 * deposits in the heart (ruling 3).
 *
 * prd6 ruling 2 hangs two more things off the **retract**, and deliberately off
 * that stage rather than off a new one: the lane's substance travelling home down
 * the severing thread ({@link RetireGeometry.homeward}) and the root-mass
 * thickening as it arrives (`marks/root.ts`). Both are position facts, both are
 * over when the cord is, and both read {@link homecoming} rather than a clock of
 * their own — so the concurrency cap and the queue below already govern them and
 * no new motion grammar was invented to carry them.
 *
 * Four laws, and all four are enforced here rather than trusted:
 *
 * 1. **It never fades to nothing.** {@link SCAR_FLOOR} is the floor under every
 *    mark a scar draws. Invisible completion is indistinguishable from a render
 *    bug, and the operator cannot tell which they are looking at — so the scar
 *    stays on the canvas, at reduced ink, carrying the lane's name and figure.
 * 2. **It fires once per lane, and only on news.** The way in is
 *    {@link RetireRegistry.note}, whose only caller reads the shell fold's
 *    news-vs-history tag. A replayed session — or a scrub across a landing —
 *    builds the scar and animates nothing, the same way history never pulses.
 * 3. **It respects the structural concurrency cap.** {@link STRUCTURAL} allows
 *    two structural animations at once, staggered; a wave of twelve landings
 *    therefore **queues** rather than cutting twelve cords at once. Queueing is
 *    not throttling: every cut still happens, and a lane waiting its turn is
 *    still drawn as the living thread it was until its own cut begins.
 * 4. **Reduced motion has no travel.** WCAG 2.3.3 excludes colour and opacity
 *    from "motion animation", so the degradation is the swap without the
 *    journey: the thread is severed and desaturated *in place*, and the node
 *    does not drift. That is read off `allowance('structural', mode).travel`
 *    rather than re-decided here, so the whole scene degrades by one rule.
 */

/**
 * Where a cut has got to. `scar` is the resting state a retired lane sits in for
 * the rest of the session — the other three are the 1.4 s getting there.
 */
export type RetireStage = 'tension' | 'retract' | 'settle' | 'scar'

export interface RetireState {
  stage: RetireStage
  /** 0–1 through the whole cut. 1 for a settled scar. */
  progress: number
  /** 0–1 how much slack has been let into the thread. Stage 1's only output. */
  tension: number
  /** 0–1 how far the freed end has sprung back toward the node. Stage 2's. */
  retract: number
  /**
   * 0–1 how far the node has drifted out toward the rim. Normally the same
   * number as {@link retract} — and deliberately **0** when the mode forbids
   * travel, which is what makes reduced motion a swap in place rather than a
   * shorter journey.
   */
  drift: number
  /** 0–1 how far the remnant has gone cold. Stage 3's only output. */
  scar: number
  /**
   * 0–1 HOW FAR THE CORD HAS COMPOSTED (prd10 ruling 2) — the fourth channel,
   * and the one stage that outlives the cut.
   *
   * It starts when the cord actually parts (the end of `tension`) and runs for
   * {@link DISSOLUTION.spanMs}, which is longer than the whole three-stage cut. So
   * `progress` reaching 1 means "the cord has let go, sprung back and gone cold"
   * and *this* reaching 1 means "and its matter has finished coming home" — at
   * which point the lane's ribbon geometry is gone, because there is nothing left
   * of the cord to draw (`marks/thread.ts`). Two different instants, deliberately:
   * every cord-cut law prd5 wrote is about the first one and is untouched.
   *
   * 1 from the first frame for a scar nobody watched leave — history, a replay,
   * and a reduced-motion frame, exactly as {@link retract} is. A cord that never
   * travelled never composted on this screen; what the operator sees is the end
   * state, which is a heart with a ring in it and a rim with no stub on it.
   */
  dissolve: number
  /**
   * HOW LONG AGO THIS CUT BEGAN, in ms — or **null** for a scar nobody watched
   * leave.
   *
   * One consumer, and it needs exactly this shape: the heart's growth rings are
   * ordered oldest-landing innermost (prd10 ruling 3's tree-ring memoir), and
   * "oldest" is a fact about *when* rather than about how far through. A lane the
   * scene never saw retire is older than anything it did see, which is what null
   * means here and why it sorts furthest in — history is the wood at the centre.
   *
   * Deliberately not an absolute instant: every other number in this record is
   * relative, `cutAt` is pure in its elapsed time, and a state carrying an epoch
   * would be a state that could not be tested on a number.
   */
  elapsedMs: number | null
}

/**
 * Tension release. Carbon's `moderate-01` — the shortest span that still reads
 * as a change rather than as a jump, which is all this stage needs: it is the
 * intake of breath before the cut, not the cut.
 */
const TENSION_MS = 150
/**
 * Settling to a scar. M3's `long1`: long enough for a desaturation to be
 * watched, short enough that the eye is released before it gets bored.
 *
 * Named for the *scar* rather than for the stage, because `geometry.ts` already
 * exports a `SETTLE_MS` — the 900 ms a new lane takes to grow in — and two
 * different durations under one name in one package is a trap.
 */
const SCAR_SETTLE_MS = 450

/** The three stages, in ms, and what they add up to. */
export const CUT = {
  tensionMs: TENSION_MS,
  /**
   * When the cord has finished composting, measured from the same instant every
   * other number here is (prd10 ruling 2). The dissolve begins as the cord parts
   * and outlives the cut by about a second — see {@link RetireState.dissolve}.
   */
  dissolvedMs: TENSION_MS + DISSOLUTION.spanMs,
  /**
   * The retract is not a number of its own. A lane disconnecting *is* the
   * structural motion class, and ruling 4 already priced that at 800 ms
   * critically damped — so this reads the budget rather than restating it.
   */
  retractMs: STRUCTURAL.durationMs,
  settleMs: SCAR_SETTLE_MS,
  totalMs: TENSION_MS + STRUCTURAL.durationMs + SCAR_SETTLE_MS,
} as const

/**
 * SCAR TISSUE — desaturated, but not all the way.
 *
 * The research said "saturation → 0", and taken literally that puts a landed
 * lane in exactly the ink law 9a reserves for *nothing-to-say*: `ICE_600` is
 * what an unknown lane wears, and "this lane finished its work" and "the log has
 * never mentioned this lane" are opposite facts that must not share a colour. So
 * a whisper of the done green survives — far below the 0.35 tint a *living* done
 * thread carries, and nowhere near enough to read as activity.
 *
 * Deliberately not `NECROTIC`: that grey is a corpse, and the whole point of
 * prd4's done/frozen separation is that landing is not dying.
 */
const SCAR_TISSUE = mix(ICE_600, DONE, 0.18)

/**
 * Nothing a scar draws may be dimmer than this, in `luminance` units, on a fleet
 * with nothing needing anyone — the same footing `CALM_FLOOR` is pinned on. (When
 * something *is* wrong, a scar recedes with the rest of the calm world; getting
 * out of a summons's way is the one thing that outranks being seen.)
 *
 * Well under `CALM_FLOOR`'s 0.15, because a scar is *supposed* to sit below the
 * living fleet — and well clear of zero, which is the half that is a law rather
 * than a taste. Invisible completion is indistinguishable from a render bug.
 */
export const SCAR_FLOOR = 0.05

/**
 * The three inks a settled scar is drawn in. Living inks interpolate into these
 * over the settle stage, so the desaturation is the stage rather than a switch.
 */
export const SCAR = {
  /**
   * The remnant ribbon. Lands just under `CALM_FLOOR`, which is the arithmetic
   * form of "a retired lane may not out-read a working one".
   */
  thread: ink(SCAR_TISSUE, 0.45),
  /** The lens, its terminal and its seal — the marks that say *which* lane this was. */
  glyph: ink(SCAR_TISSUE, 0.7),
  /**
   * The name — **ice**, not scar tissue, and deliberately still easy to read. A
   * scar exists to be identified; one whose name has gone the colour of the
   * remnant is a lane that was deleted with extra steps. Reduced from a living
   * label, never faint.
   */
  name: ink(ICE_400, 0.7),
} as const

/** The resting scar: everything done, nothing moving, for the rest of the session. */
const SETTLED: RetireState = {
  stage: 'scar',
  progress: 1,
  tension: 1,
  retract: 1,
  drift: 1,
  scar: 1,
  dissolve: 1,
  // Null: this is the state a lane rests in *and* the state history arrives in.
  // `cutAt` stamps the elapsed time back on whenever the cut is one we watched, so
  // a null here means exactly "nobody saw this happen" (see `elapsedMs`).
  elapsedMs: null,
}

/** The same, without the drift — reduced motion's swap in place. */
const SETTLED_IN_PLACE: RetireState = { ...SETTLED, drift: 0 }

/**
 * Is this lane out of the living network?
 *
 * Two ways in, and they are not the same kind of fact. **Done** is a moment in
 * the log — workmux said so, or the worktree went away — so it has an instant to
 * animate. **Parked** is a standing declaration in `.swarm/lanes.json` (prd4
 * ruling 5), so it has none: it is true from the first frame we read the
 * manifest, and there is no event whose arrival a cut could be the picture of.
 * A parked lane therefore *scars* without ever cutting, which is the honest
 * reading — and it un-scars the moment the operator unparks it, because this
 * predicate is the only thing that decides.
 */
export function isRetired(lane: Pick<Lane, 'activity' | 'parked'>): boolean {
  return lane.activity === 'done' || lane.parked
}

/**
 * The cut, `elapsedMs` after it began. Pure, so a pinned clock is a still image
 * of a known stage and `retire.test.ts` drives the whole thing on a number.
 *
 * `travel` is `allowance('structural', mode).travel`: false collapses the cut to
 * its endpoint with the node left where it was.
 */
export function cutAt(elapsedMs: number, travel = true): RetireState {
  if (!travel) return SETTLED_IN_PLACE

  const elapsed = Math.max(0, elapsedMs)
  // Past *both* clocks: the cut has settled and the cord has finished composting.
  // The order matters — `SETTLED` is what every "already retired" reading in the
  // instrument means, so it has to be the state a lane rests in for ever, and the
  // dissolve is the reason that instant is now later than `CUT.totalMs`.
  if (elapsed >= CUT.dissolvedMs) return { ...SETTLED, elapsedMs: elapsed }

  const progress = clamp01(elapsed / CUT.totalMs)
  // The composting starts as the cord parts and runs on its own span (ruling 2).
  const dissolve = clamp01((elapsed - CUT.tensionMs) / DISSOLUTION.spanMs)

  if (elapsed < CUT.tensionMs) {
    return {
      stage: 'tension',
      progress,
      tension: easeOut(elapsed / CUT.tensionMs),
      retract: 0,
      drift: 0,
      scar: 0,
      dissolve,
      elapsedMs: elapsed,
    }
  }

  const afterTension = elapsed - CUT.tensionMs
  if (afterTension < CUT.retractMs) {
    const retract = retractAt(afterTension)
    return {
      stage: 'retract',
      progress,
      tension: 1,
      retract,
      drift: retract,
      scar: 0,
      dissolve,
      elapsedMs: elapsed,
    }
  }

  if (afterTension < CUT.retractMs + CUT.settleMs) {
    const scar = easeOut((afterTension - CUT.retractMs) / CUT.settleMs)
    return {
      stage: 'settle',
      progress,
      tension: 1,
      retract: 1,
      drift: 1,
      scar,
      dissolve,
      elapsedMs: elapsed,
    }
  }

  // The cut is over and the cord is still coming apart. `scar` is the resting
  // state's own name, so this *is* a settled scar — it simply still has matter in
  // the air above it, which is the one thing that has not finished.
  return {
    stage: 'scar',
    progress: 1,
    tension: 1,
    retract: 1,
    drift: 1,
    scar: 1,
    dissolve,
    elapsedMs: elapsed,
  }
}

/**
 * How far the freed end has sprung back, `sinceMs` into the retract.
 *
 * The scene's own critically-damped spring, evaluated as a closed form rather
 * than integrated: `springStep` from a unit displacement at rest *is* the exact
 * solution sampled at that dt, so one call with the elapsed time is the same
 * curve a per-frame integration would have produced — and it is a pure function
 * of the clock, which is what keeps a paused scene and a pinned test still.
 *
 * ζ = 1 is not a parameter. `spring.ts` offers no way to ask for bounce, because
 * a structural change that recoils reads as "it failed" rather than "it
 * finished" — and a cord that bounced back toward the mass it just left would be
 * saying the opposite of what happened.
 *
 * Normalised by the spring's own value at the end of the stage, so the stage
 * boundary is exact rather than 0.03% short. Monotone either way: dividing a
 * monotone rise by a constant cannot introduce an overshoot.
 */
function retractAt(sinceMs: number): number {
  const remaining = (at: number): number =>
    springStep({ x: 1, v: 0 }, 0, STRUCTURAL.stiffness, at).x
  const span = 1 - remaining(CUT.retractMs)
  return span <= 0 ? 1 : clamp01((1 - remaining(sinceMs)) / span)
}

/**
 * How much of this lane's work has made it home, 0–1 (prd6 ruling 2).
 *
 * It is the retract, and naming it is the point: the substance arrives exactly as
 * the cord parts, so the mass thickens *because* the thread let go rather than on
 * a timer of its own. A scar that was never watched leaving — history, a replay, a
 * reduced-motion frame — reads 1 from its first frame, which is the honest answer:
 * the work did land, we simply were not there for the journey.
 */
export function homecoming(state: RetireState): number {
  return clamp01(state.retract)
}

/** An ink `t` of the way from where it lives to where it ends up. */
export function toward(from: Ink, to: Ink, t: number): Ink {
  const k = clamp01(t)
  return ink(mix(from.rgb, to.rgb, k), from.alpha + (to.alpha - from.alpha) * k)
}

/**
 * THE REGISTRY — which lanes are cutting, and when each one is allowed to start.
 *
 * The twin of `SettleRegistry`: that one owns a thread growing out of the mass,
 * this one owns a thread letting go of it, and both are fed from the same news
 * tail for the same reason.
 */
export class RetireRegistry {
  /** laneId → the instant its cut is scheduled to begin. Written once per lane. */
  private readonly startedAt = new Map<string, number>()
  /** Every start instant assigned so far, live ones only — the queue's ledger. */
  private starts: number[] = []

  /**
   * Schedule a cut for any lane this batch of **news** just retired. Returns the
   * lane ids that were actually scheduled, so a caller can tell a real landing
   * from a collector re-reporting one.
   */
  note(events: readonly RhizomorphEvent[], index: LaneIndex, now: number): string[] {
    const scheduled: string[] = []
    for (const event of events) {
      if (!declaresDone(event)) continue
      const laneId = resolveLane(index, event)
      // `null` is the root-mass, which is not a lane and cannot retire; a lane
      // already scheduled keeps its original instant, so a collector restart
      // that re-reports every worktree it can see cuts nothing twice.
      if (laneId === null || this.startedAt.has(laneId)) continue
      this.startedAt.set(laneId, this.schedule(now))
      scheduled.push(laneId)
    }
    return scheduled
  }

  /**
   * laneId → where its cut has got to, for every retired lane in the fleet.
   *
   * Three cases, and the difference between them is the whole of law 2:
   *
   * - a lane whose cut we **watched start** animates from its own instant;
   * - a lane that was **already retired** when we first saw it is scarred
   *   outright — it is history, and history does not move;
   * - a lane whose cut is still **queued** is absent from the map entirely, and
   *   is therefore drawn as the living thread it still visibly is.
   *
   * A lane that is no longer retired (an operator unparked it) is simply absent
   * too, and its thread comes back whole — while its remembered start instant
   * stays remembered, so re-retiring it never re-fires the cut.
   */
  progress(fleet: Pick<Fleet, 'lanes'>, now: number, mode: MotionMode): Map<string, RetireState> {
    const travel = allowance('structural', mode).travel
    const states = new Map<string, RetireState>()

    for (const lane of fleet.lanes) {
      if (!isRetired(lane)) continue
      const started = this.startedAt.get(lane.id)
      if (started === undefined) {
        states.set(lane.id, travel ? SETTLED : SETTLED_IN_PLACE)
        continue
      }
      if (now < started) continue
      states.set(lane.id, cutAt(now - started, travel))
    }

    return states
  }

  /**
   * When a cut queued at `now` may begin (ruling 4's structural cap, as a queue).
   *
   * Two constraints, resolved by walking forward to the first instant that
   * satisfies both: no more than {@link STRUCTURAL.maxConcurrent} cords may be
   * in flight together, and two cuts may not *set off* inside
   * {@link STRUCTURAL.staggerMs} of each other. So a wave of landings retires in
   * pairs, 75 ms apart within the pair and one cut-length between pairs — which
   * reads as the fleet standing down lane by lane rather than as the whole
   * network coming apart at once.
   *
   * The ledger is pruned to the cuts that can still matter, so a session that
   * lands two hundred lanes does not carry two hundred instants around.
   */
  private schedule(now: number): number {
    this.starts = this.starts.filter((start) => start + CUT.totalMs > now)

    let at = now
    // Each pass moves `at` strictly forward, and there are only ever a bounded
    // number of live starts to clear, so this terminates; the guard is for the
    // arithmetic being wrong rather than for the loop being unbounded.
    for (let guard = 0; guard < 128; guard += 1) {
      const busy = this.starts.filter((start) => at >= start && at < start + CUT.totalMs)
      if (busy.length >= STRUCTURAL.maxConcurrent) {
        at = Math.min(...busy.map((start) => start + CUT.totalMs))
        continue
      }

      const crowding = this.starts.filter((start) => start <= at && at - start < STRUCTURAL.staggerMs)
      if (crowding.length > 0) {
        at = Math.max(...crowding) + STRUCTURAL.staggerMs
        continue
      }

      break
    }

    this.starts.push(at)
    return at
  }
}

/**
 * The events that say a lane has finished — and there are exactly two.
 *
 * `agent.status: done` is workmux declaring it, and `worktree.removed` is the
 * worktree folding away, which the derived model reads as `done` for the same
 * reason (`activityOf`: `!lane.present`). Nothing else counts: a lane going
 * quiet is FROZEN's evidence, not a finish, and inferring "done" from silence is
 * the single loudest way this instrument could cry wolf about a successful run.
 */
function declaresDone(event: RhizomorphEvent): boolean {
  if (event.type === 'worktree.removed') return true
  return event.type === 'agent.status' && event.payload.status === 'done'
}

function easeOut(t: number): number {
  const k = clamp01(t)
  return 1 - (1 - k) * (1 - k)
}
