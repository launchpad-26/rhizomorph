import type { RhizomorphEvent } from '@rhizomorph/core'
import type { Fleet, Lane } from '../fleet/index.js'
import { DISSOLUTION, STRUCTURAL, allowance, type MotionMode } from './motion.js'
import { DONE, ICE_400, ICE_600, clamp01, ink, mix, type Ink } from './palette.js'
import { resolveLane, type LaneIndex } from './resolve.js'
import { springStep } from './spring.js'

/**
 * THE RETURN, AND THE STRAND THAT SURVIVES IT (prd10 rulings 13–16).
 *
 * **This file used to hold the cord-cut, and the operator has rescinded it.**
 * prd5 ruling 3 had a landed lane disconnect from the mass and settle into a
 * desaturated scar near the rim; prd10 ruling 2 then had the freed cord compost
 * into motes until no geometry was left at all. Ruling 13 knowingly takes back
 * both halves, and the reasoning is the metaphor itself: *a rhizomorph is a
 * root-cord network, and a mycelial network does not delete the cords that
 * carried its nutrients — it keeps them.* Accumulated strands ARE the picture of
 * growth the north star asks for; an emptying field is the opposite of what this
 * organism is.
 *
 * So a lane's completion is a **transformation, not a deletion** (ruling 15).
 * The return beat survives exactly as it was built — the matter lifts off the
 * cord and streams home (`motes.ts`), the parcel runs down the strand
 * ({@link RetireGeometry.homeward}), the heart takes its permanent growth ring
 * (`marks/root.ts`) — and at the end of it the strand REMAINS, thinned and
 * stilled, threaded into the mass exactly where it always was. What the motes
 * carry home is the lane's **vitality**, not its existence.
 *
 * Four stages, ~1.4 s to the first three, one channel each:
 *
 * | stage        | ms  | what changes                                          |
 * | ------------ | --- | ----------------------------------------------------- |
 * | `tension`    | 150 | curvature only. The strain goes out of the strand.    |
 * | `withdraw`   | 800 | position only. The vitality travels home, ζ = 1.      |
 * | `settle`     | 450 | the strand thins and cools into its resting light.    |
 * | `persistent` |  ∞  | the resting state. Thin, still, lit — and never gone. |
 *
 * One channel per stage is still the whole trick — Heer & Robertson measured
 * staged transitions beating single-shot ones at exactly this job, and recommend
 * about a second per stage. What changed is only the sentence they spell: it used
 * to be "let go — sprang back — went cold", and it is now "let go — sent its
 * vitality home — went quiet, and stayed". The `settle` stage spends its one
 * number ({@link RetireState.stilled}) on two drawn channels at once, width and
 * ink, and that is deliberate rather than a lapse: thinning and cooling are not
 * two facts about a finished lane, they are the single fact that the life has
 * left it.
 *
 * {@link RetireState.dissolve} is the fourth channel and the one that outlives
 * the other three: the return's own clock, running from the moment the matter
 * lifts to the moment the last mote lands. It no longer ends in an erasure — the
 * strand under the drift is the same strand before and after, and the only thing
 * that finishes is the traffic above it.
 *
 * Four laws, and all four are enforced here rather than trusted:
 *
 * 1. **Nothing is ever deleted, and nothing ever fades to nothing.** No code path
 *    in this scene removes a strand's geometry (ruling 13); {@link PERSIST_FLOOR}
 *    is the floor under every mark a finished lane draws. Invisible completion is
 *    indistinguishable from a render bug, and a *deleted* completion is worse: it
 *    is indistinguishable from work that never happened.
 * 2. **It fires once per lane, and only on news.** The way in is
 *    {@link RetireRegistry.note}, whose only caller reads the shell fold's
 *    news-vs-history tag. A replayed session — or a scrub across a landing —
 *    arrives at the persistent strand and animates nothing, the same way history
 *    never pulses.
 * 3. **It respects the structural concurrency cap.** {@link STRUCTURAL} allows
 *    two structural animations at once, staggered; a wave of twelve landings
 *    therefore **queues** rather than returning twelve lanes at once. Queueing is
 *    not throttling: every return still happens, and a lane waiting its turn is
 *    still drawn as the living thread it was until its own return begins.
 * 4. **Reduced motion has no travel.** WCAG 2.3.3 excludes colour and opacity
 *    from "motion animation", so the degradation is the swap without the journey:
 *    the strand thins and cools *in place*, and the node does not drift. That is
 *    read off `allowance('structural', mode).travel` rather than re-decided here,
 *    so the whole scene degrades by one rule. A persistent strand is not motion at
 *    all — it is a still line — so reduced motion keeps every one of them.
 */

/**
 * LUMINOUS, BUT NOT ALIVE (prd10 ruling 14) — the four numbers that separate a
 * finished strand from a living one, named here because they are a law rather
 * than a paint job.
 *
 * The ruling: *"a completed strand stays visible as a thin, still, luminous
 * filament — light without animation, without glow, without the alarm grammar,
 * below the calm ceiling. The living hierarchy must remain unmistakable at a
 * glance. A reader must never have to ask which lanes are working."* Ruling 16
 * adds the density clause: with dozens of finished lanes the field is kept
 * legible by **thinness, stillness and depth** — never by removing history.
 *
 * So the hierarchy is bought in three channels, and all three point the same way:
 *
 * - **width**, here — a finished strand is under half the living one's, everywhere
 *   along it;
 * - **luminance**, here — capped strictly below `CALM_FLOOR`, which is the floor
 *   every *living* mark is held above (`salience.ts`). Living ≥ CALM_FLOOR >
 *   PERSIST_LUMINANCE ≥ finished is the whole hierarchy as one arithmetic
 *   sentence, and `marks.test.ts` reads it off the display list rather than off a
 *   screenshot;
 * - **depth**, in `marks/index.ts` — finished strands are painted before living
 *   ones, so the network reads as living work in front of the ground it grew from.
 *
 * And three things a finished strand does *not* get, each of them an instrument
 * of a grammar it has no business wearing: no bloom (a halo is light in the act of
 * being spent), no shimmer or breath (the ambient layer is the scene being alive),
 * and nothing from the alarm vocabulary at all — no enclosure, no fade exemption,
 * no summons. A lane nobody can act on may not ask for anybody.
 */

/**
 * How thin, as a fraction of the living strand's own width at the same point.
 *
 * Under a half, and the bounds either side of it are arithmetic rather than
 * taste. **Above about 0.5** the claim in ruling 14 stops being safe: a lane's
 * thread runs 1.2–6.2 px at the root (`geometry.ts`), so a finished big lane at
 * 0.5 draws 3.1 px against a living small lane's 1.2 and the *finished* one is
 * the fatter line — "thicker" would have become a statement about work size
 * rather than about liveness. **Below about 0.3** the small end goes the other
 * way: a 0.36 px strand is under a device pixel at 1× and the work-size channel
 * the whole scene is drawn on stops reading at the bottom of its range.
 *
 * 0.42 keeps the wedge-versus-hairline span between a 200K lane and an empty one
 * and leaves a comfortable margin at both bounds. It is a *starting* number for
 * the density judgement, not a settled one: ruling 16 says a field that stops
 * reading is answered with more hierarchy, and this is the first dial to turn.
 * The operator's eye on a thirty-lane replay is the gate (ruling 8).
 */
export const PERSIST_WIDTH_SCALE = 0.42

/**
 * …and how much of its own root width a finished strand keeps at the far end.
 *
 * A living thread tapers to a needle because it is *growing* — the tip is where
 * the organism is happening. A finished one is not going anywhere, so it holds an
 * even-ish line rather than thinning to nothing at the rim, which is the
 * difference between a filament and a scratch. Bounded so the result is still
 * strictly under the living tip at every work size: the largest ratio of root to
 * tip in the scene is ~3.1, so `root · 0.35 · 0.42` cannot reach `tip`.
 */
export const PERSIST_TAPER_FLOOR = 0.35

/**
 * THE CEILING ON A FINISHED STRAND'S OWN INK, in `luminance` units.
 *
 * Deliberately *under* `CALM_FLOOR` (0.15) — the number `salience.ts` holds every
 * living mark above — so "living strands are unmistakably dominant" is a fact
 * about two constants rather than about two screenshots. A finished strand is the
 * only thing in the instrument allowed below that floor apart from a frozen
 * lane's dark hypha, and for the same kind of reason: the absence of light *is*
 * the encoding.
 *
 * Well clear of zero, which is the half that is a law rather than a taste
 * ({@link PERSIST_FLOOR}).
 */
export const PERSIST_LUMINANCE = 0.14

/**
 * Nothing a finished lane draws may be dimmer than this, in `luminance` units, on
 * a fleet with nothing needing anyone — the same footing `CALM_FLOOR` is pinned
 * on. (When something *is* wrong, a finished lane recedes with the rest of the
 * calm world; getting out of a summons's way is the one thing that outranks being
 * seen.)
 *
 * Well under `CALM_FLOOR`'s 0.15, because a finished strand is *supposed* to sit
 * below the living fleet — and well clear of zero. Invisible completion is
 * indistinguishable from a render bug.
 */
export const PERSIST_FLOOR = 0.05

/**
 * Where a return has got to. `persistent` is the resting state a finished lane
 * sits in for the rest of the session — the other three are the 1.4 s getting
 * there.
 */
export type RetireStage = 'tension' | 'withdraw' | 'settle' | 'persistent'

export interface RetireState {
  stage: RetireStage
  /** 0–1 through the whole return. 1 for a strand that has settled. */
  progress: number
  /** 0–1 how much slack has been let into the strand. Stage 1's only output. */
  tension: number
  /**
   * 0–1 HOW MUCH OF THE LANE'S VITALITY HAS COME HOME. Stage 2's only output.
   *
   * The channel that used to be the freed end springing back, re-read for ruling
   * 15: nothing springs anywhere now, and what travels is the lane's substance —
   * the homeward parcel, the motes, the swell the mass takes as it arrives. The
   * strand it travels down is exactly where it was when the lane was working.
   */
  withdraw: number
  /**
   * 0–1 how far the node has drifted out toward the rim. Normally the same
   * number as {@link withdraw} — and deliberately **0** when the mode forbids
   * travel, which is what makes reduced motion a swap in place rather than a
   * shorter journey.
   */
  drift: number
  /**
   * 0–1 HOW FAR THE STRAND HAS GONE THIN AND STILL. Stage 3's only output, and
   * the whole of the transformation ruling 15 replaced the deletion with: the
   * width closes toward {@link PERSIST_WIDTH_SCALE} and the ink cools toward
   * {@link PERSIST.strand} on this one number, together, because a lane going
   * quiet is one fact and not two.
   */
  stilled: number
  /**
   * 0–1 HOW FAR THE RETURN HAS RUN (prd10 rulings 2 and 12) — the fourth channel,
   * and the one that outlives the other three.
   *
   * It starts as the matter lifts off the strand (the end of `tension`) and runs
   * for {@link DISSOLUTION.spanMs}, which is longer than the whole three-stage
   * settle. So `progress` reaching 1 means "the strand has gone thin and still"
   * and *this* reaching 1 means "and its vitality has finished coming home". Two
   * different instants, deliberately — and **neither of them removes anything**
   * (ruling 13): the strand under the drift is the same strand before and after.
   *
   * 1 from the first frame for a lane nobody watched finish — history, a replay,
   * and a reduced-motion frame, exactly as {@link withdraw} is. Matter that never
   * travelled never composted on this screen; what the operator sees is the end
   * state, which is a heart with a ring in it and a network still standing.
   */
  dissolve: number
  /**
   * HOW LONG AGO THIS RETURN BEGAN, in ms — or **null** for a landing nobody
   * watched.
   *
   * One consumer, and it needs exactly this shape: the heart's growth rings are
   * ordered oldest-landing innermost (prd10 ruling 3's tree-ring memoir), and
   * "oldest" is a fact about *when* rather than about how far through. A lane the
   * scene never saw retire is older than anything it did see, which is what null
   * means here and why it sorts furthest in — history is the wood at the centre.
   *
   * Deliberately not an absolute instant: every other number in this record is
   * relative, `returnAt` is pure in its elapsed time, and a state carrying an epoch
   * would be a state that could not be tested on a number.
   */
  elapsedMs: number | null
}

/**
 * Tension release. Carbon's `moderate-01` — the shortest span that still reads
 * as a change rather than as a jump, which is all this stage needs: it is the
 * intake of breath before the return, not the return.
 */
const TENSION_MS = 150
/**
 * Going still. M3's `long1`: long enough for a thinning and a cooling to be
 * watched, short enough that the eye is released before it gets bored.
 *
 * Named for the *stilling* rather than for the stage, because `geometry.ts`
 * already exports a `SETTLE_MS` — the 900 ms a new lane takes to grow in — and
 * two different durations under one name in one package is a trap.
 */
const STILL_MS = 450

/** The three stages, in ms, and what they add up to. */
export const RETURN = {
  tensionMs: TENSION_MS,
  /**
   * When the last mote has landed, measured from the same instant every other
   * number here is (prd10 ruling 2). The dissolve begins as the matter lifts and
   * outlives the settle by about a second — see {@link RetireState.dissolve}.
   * It is the end of the *traffic*, never the end of the strand (ruling 13).
   */
  dissolvedMs: TENSION_MS + DISSOLUTION.spanMs,
  /**
   * The withdraw is not a number of its own. A lane's substance coming home *is*
   * the structural motion class, and ruling 4 already priced that at 800 ms
   * critically damped — so this reads the budget rather than restating it.
   */
  withdrawMs: STRUCTURAL.durationMs,
  settleMs: STILL_MS,
  totalMs: TENSION_MS + STRUCTURAL.durationMs + STILL_MS,
} as const

/**
 * PERSISTENT TISSUE — desaturated, but not all the way.
 *
 * The research said "saturation → 0", and taken literally that puts a landed
 * lane in exactly the ink law 9a reserves for *nothing-to-say*: `ICE_600` is
 * what an unknown lane wears, and "this lane finished its work" and "the log has
 * never mentioned this lane" are opposite facts that must not share a colour. So
 * a whisper of the done green survives — far below the 0.35 tint a *living* done
 * thread carries, and nowhere near enough to read as activity.
 *
 * Deliberately not `NECROTIC`: that grey is a corpse, and the whole point of
 * prd4's done/frozen separation is that landing is not dying. Ruling 13 makes
 * that argument twice over — a strand that carried a lane's nutrients is part of
 * the organism for the rest of the session, not a mark left where one used to be.
 */
const PERSIST_TISSUE = mix(ICE_600, DONE, 0.18)

/**
 * The three inks a settled strand is drawn in. Living inks interpolate into these
 * over the settle stage, so the cooling is the stage rather than a switch.
 */
export const PERSIST = {
  /**
   * THE STRAND ITSELF, and the one ink {@link PERSIST_LUMINANCE} caps: quiet
   * light, held strictly under the floor every living mark is held above. The
   * arithmetic form of "a reader must never have to ask which lanes are working".
   */
  strand: ink(PERSIST_TISSUE, 0.44),
  /** The lens, its terminal and its seal — the marks that say *which* lane this was. */
  glyph: ink(PERSIST_TISSUE, 0.7),
  /**
   * The name — **ice**, not tissue, and deliberately still easy to read. A
   * finished lane exists to be identified; one whose name has gone the colour of
   * its own strand is a lane that was deleted with extra steps. Reduced from a
   * living label, never faint.
   */
  name: ink(ICE_400, 0.7),
} as const

/**
 * A finished strand's widths, from the living ones it had (ruling 14).
 *
 * One function rather than two multiplications at the call site, because the
 * hierarchy law is asserted against exactly this: `marks.test.ts` compares the
 * ribbon a finished lane draws with the ribbon the same lane drew while it was
 * working, at both ends, and the claim it is making is about this arithmetic.
 */
export function persistWidths(widthRoot: number, widthTip: number): {
  root: number
  tip: number
} {
  return {
    root: widthRoot * PERSIST_WIDTH_SCALE,
    tip: Math.max(widthTip, widthRoot * PERSIST_TAPER_FLOOR) * PERSIST_WIDTH_SCALE,
  }
}

/** The resting strand: thinned, stilled, lit, and there for the rest of the session. */
const SETTLED: RetireState = {
  stage: 'persistent',
  progress: 1,
  tension: 1,
  withdraw: 1,
  drift: 1,
  stilled: 1,
  dissolve: 1,
  // Null: this is the state a lane rests in *and* the state history arrives in.
  // `returnAt` stamps the elapsed time back on whenever the return is one we
  // watched, so a null here means exactly "nobody saw this happen" (`elapsedMs`).
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
 * manifest, and there is no event whose arrival a return could be the picture of.
 * A parked lane therefore arrives at the persistent strand without ever running
 * the return, which is the honest reading — and it comes back to life the moment
 * the operator unparks it, because this predicate is the only thing that decides.
 */
export function isRetired(lane: Pick<Lane, 'activity' | 'parked'>): boolean {
  return lane.activity === 'done' || lane.parked
}

/**
 * The return, `elapsedMs` after it began. Pure, so a pinned clock is a still
 * image of a known stage and `retire.test.ts` drives the whole thing on a number.
 *
 * `travel` is `allowance('structural', mode).travel`: false collapses the return
 * to its endpoint with the node left where it was.
 */
export function returnAt(elapsedMs: number, travel = true): RetireState {
  if (!travel) return SETTLED_IN_PLACE

  const elapsed = Math.max(0, elapsedMs)
  // Past *both* clocks: the strand has gone still and the last mote has landed.
  // The order matters — `SETTLED` is what every "already retired" reading in the
  // instrument means, so it has to be the state a lane rests in for ever, and the
  // dissolve is the reason that instant is now later than `RETURN.totalMs`.
  if (elapsed >= RETURN.dissolvedMs) return { ...SETTLED, elapsedMs: elapsed }

  const progress = clamp01(elapsed / RETURN.totalMs)
  // The return's traffic lifts as the tension goes and runs on its own span.
  const dissolve = clamp01((elapsed - RETURN.tensionMs) / DISSOLUTION.spanMs)

  if (elapsed < RETURN.tensionMs) {
    return {
      stage: 'tension',
      progress,
      tension: easeOut(elapsed / RETURN.tensionMs),
      withdraw: 0,
      drift: 0,
      stilled: 0,
      dissolve,
      elapsedMs: elapsed,
    }
  }

  const afterTension = elapsed - RETURN.tensionMs
  if (afterTension < RETURN.withdrawMs) {
    const withdraw = withdrawAt(afterTension)
    return {
      stage: 'withdraw',
      progress,
      tension: 1,
      withdraw,
      drift: withdraw,
      stilled: 0,
      dissolve,
      elapsedMs: elapsed,
    }
  }

  if (afterTension < RETURN.withdrawMs + RETURN.settleMs) {
    const stilled = easeOut((afterTension - RETURN.withdrawMs) / RETURN.settleMs)
    return {
      stage: 'settle',
      progress,
      tension: 1,
      withdraw: 1,
      drift: 1,
      stilled,
      dissolve,
      elapsedMs: elapsed,
    }
  }

  // The settle is over and the matter is still in the air. `persistent` is the
  // resting state's own name, so this *is* the resting strand — it simply still
  // has traffic above it, which is the one thing that has not finished.
  return {
    stage: 'persistent',
    progress: 1,
    tension: 1,
    withdraw: 1,
    drift: 1,
    stilled: 1,
    dissolve,
    elapsedMs: elapsed,
  }
}

/**
 * How far the lane's vitality has come home, `sinceMs` into the withdraw.
 *
 * The scene's own critically-damped spring, evaluated as a closed form rather
 * than integrated: `springStep` from a unit displacement at rest *is* the exact
 * solution sampled at that dt, so one call with the elapsed time is the same
 * curve a per-frame integration would have produced — and it is a pure function
 * of the clock, which is what keeps a paused scene and a pinned test still.
 *
 * ζ = 1 is not a parameter. `spring.ts` offers no way to ask for bounce, because
 * a structural change that recoils reads as "it failed" rather than "it
 * finished" — and matter that bounced back out of the mass it had just reached
 * would be saying the opposite of what happened.
 *
 * Normalised by the spring's own value at the end of the stage, so the stage
 * boundary is exact rather than 0.03% short. Monotone either way: dividing a
 * monotone rise by a constant cannot introduce an overshoot.
 */
function withdrawAt(sinceMs: number): number {
  const remaining = (at: number): number =>
    springStep({ x: 1, v: 0 }, 0, STRUCTURAL.stiffness, at).x
  const span = 1 - remaining(RETURN.withdrawMs)
  return span <= 0 ? 1 : clamp01((1 - remaining(sinceMs)) / span)
}

/**
 * How much of this lane's work has made it home, 0–1 (prd6 ruling 2).
 *
 * It is the withdraw, and naming it is the point: the substance arrives exactly as
 * the strain leaves the strand, so the mass thickens *because* the lane finished
 * rather than on a timer of its own. A landing that was never watched — history, a
 * replay, a reduced-motion frame — reads 1 from its first frame, which is the
 * honest answer: the work did land, we simply were not there for the journey.
 */
export function homecoming(state: RetireState): number {
  return clamp01(state.withdraw)
}

/** An ink `t` of the way from where it lives to where it ends up. */
export function toward(from: Ink, to: Ink, t: number): Ink {
  const k = clamp01(t)
  return ink(mix(from.rgb, to.rgb, k), from.alpha + (to.alpha - from.alpha) * k)
}

/**
 * THE REGISTRY — which lanes are returning, and when each one is allowed to start.
 *
 * The twin of `SettleRegistry`: that one owns a thread growing out of the mass,
 * this one owns a thread giving its vitality back to it, and both are fed from the
 * same news tail for the same reason.
 */
export class RetireRegistry {
  /** laneId → the instant its return is scheduled to begin. Written once per lane. */
  private readonly startedAt = new Map<string, number>()
  /** Every start instant assigned so far, live ones only — the queue's ledger. */
  private starts: number[] = []

  /**
   * Schedule a return for any lane this batch of **news** just retired. Returns the
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
      // that re-reports every worktree it can see returns nothing twice.
      if (laneId === null || this.startedAt.has(laneId)) continue
      this.startedAt.set(laneId, this.schedule(now))
      scheduled.push(laneId)
    }
    return scheduled
  }

  /**
   * laneId → where its return has got to, for every retired lane in the fleet.
   *
   * Three cases, and the difference between them is the whole of law 2:
   *
   * - a lane whose return we **watched start** animates from its own instant;
   * - a lane that was **already retired** when we first saw it arrives at the
   *   persistent strand outright — it is history, and history does not move;
   * - a lane whose return is still **queued** is absent from the map entirely,
   *   and is therefore drawn as the living thread it still visibly is.
   *
   * A lane that is no longer retired (an operator unparked it) is simply absent
   * too, and its thread comes back to life — while its remembered start instant
   * stays remembered, so re-retiring it never re-fires the return.
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
      states.set(lane.id, returnAt(now - started, travel))
    }

    return states
  }

  /**
   * When a return queued at `now` may begin (ruling 4's structural cap, as a
   * queue).
   *
   * Two constraints, resolved by walking forward to the first instant that
   * satisfies both: no more than {@link STRUCTURAL.maxConcurrent} returns may be
   * in flight together, and two may not *set off* inside
   * {@link STRUCTURAL.staggerMs} of each other. So a wave of landings returns in
   * pairs, 75 ms apart within the pair and one return-length between pairs —
   * which reads as the fleet standing down lane by lane rather than as the whole
   * network going quiet at once.
   *
   * The ledger is pruned to the returns that can still matter, so a session that
   * lands two hundred lanes does not carry two hundred instants around.
   */
  private schedule(now: number): number {
    this.starts = this.starts.filter((start) => start + RETURN.totalMs > now)

    let at = now
    // Each pass moves `at` strictly forward, and there are only ever a bounded
    // number of live starts to clear, so this terminates; the guard is for the
    // arithmetic being wrong rather than for the loop being unbounded.
    for (let guard = 0; guard < 128; guard += 1) {
      const busy = this.starts.filter((start) => at >= start && at < start + RETURN.totalMs)
      if (busy.length >= STRUCTURAL.maxConcurrent) {
        at = Math.min(...busy.map((start) => start + RETURN.totalMs))
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
