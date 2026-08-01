import type { ObservatoryEvent } from '@observatory/core'
import type { StreamState } from '../app/streamState.js'
import { EVENT } from './motion.js'
import { clamp01 } from './palette.js'
import { resolveLane, type LaneIndex } from './resolve.js'

/**
 * THE PULSE FIELD — every pulse is an event (ruling 32, law).
 *
 * Not "corresponds to", not "triggered by activity": one `commit.landed` is one
 * packet of light running home, one `llm.usage` record is one to three motes
 * drifting out to the growing tip, one `tool.activity` is one tick at the tip or
 * one notch of a stuck lane's orbit. Nothing here emits a particle because a
 * particle would look nice. If the fleet stops, the network goes still, and that
 * stillness is information.
 *
 * Ruling 32 adopts three enforcement rules, and all three live in this file:
 *
 * 1. **History never pulses.** The only way in is {@link PulseField.ingest}, and
 *    the only caller is {@link takeNews}, which reads the shell fold's
 *    news-vs-history tag. A replay burst of ten thousand spent facts builds
 *    state and lights nothing.
 * 2. **Traffic is coalesced, never invented.** A lane past the motion budget's
 *    concurrency cap does not get another animation; the surplus folds into an
 *    *aggregate* pulse carrying a count, or failing that into thread *glow*. A
 *    busy lane therefore glows rather than fibrillating, and the count it glows
 *    for is real. See {@link EVENT.maxConcurrent}.
 * 3. **An arrival flare is the end of a real journey.** The root-mass surge is
 *    raised in {@link PulseField.step} when a homeward packet's life *ends* at
 *    the mass. There is no way to flare without a journey and no journey without
 *    a commit.
 *
 * The clock is injected into every method. Nothing here reads `Date.now()`, which
 * is what lets `pulses.test.ts` drive the whole field on a fake clock.
 */

/**
 * There is deliberately no OFF-FENCE pulse. A trespass is not an event in the
 * log — it is derived, every frame, by comparing touched files against a fence —
 * so a pulse for it would be motion with no arrival behind it, and on connect
 * the whole replayed past would "become" a trespass at once. Off-fence is an
 * ongoing state, and law 10 says states glow: the barbed filament is static.
 */
/**
 * `aggregate` is the motion cap's answer (ruling 4): when the scene is already
 * animating as many events as a person can follow, the next one does not get its
 * own light — it folds into a journey already running on its own lane, which
 * becomes an aggregate and starts carrying a **count**. Five packets and a "×7"
 * is a picture an operator can read; twelve simultaneous packets is not.
 */
export type PulseKind = 'commit' | 'landing' | 'mote' | 'tick' | 'aggregate'

/** The kinds an event can spawn directly. `aggregate` is only ever converted to. */
type SpawnKind = Exclude<PulseKind, 'aggregate'>

export interface Pulse {
  id: number
  laneId: string
  kind: PulseKind
  /** May be in the future: a burst of motes is staggered rather than stacked. */
  born: number
  life: number
  /** Radius in px at peak brightness. */
  size: number
  /** True when it runs node → root-mass. Motes run the other way. */
  homeward: boolean
  /** Commits only: how many files rode in, for the wake's length. */
  weight: number
  /**
   * How many real events this one animation stands for. 1 for everything that
   * got its own light; more only on an `aggregate`, and every unit of it is an
   * event that actually arrived.
   */
  count: number
}

/** A lane's decaying event energy — the part of flow that is glow, not travel. */
export interface LaneEnergy {
  /** Event density. What a thread's living brightness is made of. */
  heat: number
  /** Events folded into glow because the motion cap left nothing to fold into. */
  coalesced: number
  /** A stuck lane's wheel, in laps. Advances per tool call, never on its own. */
  orbitPhase: number
  orbitTarget: number
  /** Homeward energy — the reduced-motion gradient's root-end brightness. */
  inbound: number
  /** Outbound energy — the same gradient's tip end. */
  outbound: number
}

/**
 * The memory backstop, not the motion budget. {@link EVENT.maxConcurrent} binds
 * first and binds hard, so in practice nothing reaches this — it exists so that
 * a future law with a wider cap still cannot grow the array without bound, and
 * so that if anything ever *is* refused outright the scene says so (law 12)
 * rather than quietly thinning the traffic it reports.
 */
export const MAX_PULSES = 720
/** One mote per this many output tokens, so a mote is a real quantity of work. */
export const TOKENS_PER_MOTE = 450
/** …and never more than this from one request: drift, not spray. */
export const MAX_MOTES_PER_REQUEST = 3

/** One notch of the wheel per tool call. Six calls is one lap of the knot. */
export const ORBIT_STEP = 1 / 6

const LIFE: Record<SpawnKind, number> = {
  commit: 2_200,
  landing: 2_800,
  mote: 3_400,
  tick: 460,
}

/** Heat decays over about one agent turn. */
const HEAT_TAU_MS = 6_000
/** The arrival flare is short: an event, not a state. */
const SURGE_TAU_MS = 950
/** How fast the orbit catches up to the notch a tool call moved it to. */
const ORBIT_CATCHUP_MS = 260

const ZERO_ENERGY: LaneEnergy = {
  heat: 0,
  coalesced: 0,
  orbitPhase: 0,
  orbitTarget: 0,
  inbound: 0,
  outbound: 0,
}

export class PulseField {
  private nextId = 1
  private live: Pulse[] = []
  private readonly energies = new Map<string, LaneEnergy>()
  private surgeLevel = 0
  private lastStep = 0
  private droppedPulses = 0

  /**
   * Fold a batch of **news**. Historical events must never reach here — that is
   * enforced by the caller being {@link takeNews} and nothing else.
   */
  ingest(events: readonly ObservatoryEvent[], index: LaneIndex, now: number): void {
    for (const event of events) this.ingestOne(event, index, now)
  }

  private ingestOne(event: ObservatoryEvent, index: LaneIndex, now: number): void {
    switch (event.type) {
      case 'commit.landed': {
        const laneId = resolveLane(index, event)
        if (laneId === null) {
          // Already home: a commit on main has no thread to travel.
          this.surgeLevel = Math.min(1.6, this.surgeLevel + 0.9)
          return
        }
        const energy = this.energy(laneId)
        energy.heat += 1.4
        energy.inbound += 1
        this.spawn({
          laneId,
          kind: 'commit',
          born: now,
          life: LIFE.commit,
          size: 3.2 + Math.min(3.4, event.payload.files.length * 0.45),
          homeward: true,
          weight: event.payload.files.length,
        })
        return
      }

      case 'worktree.removed': {
        // A landing: the lane's work goes home in one bigger packet, and the
        // thread that carried it is about to fold away.
        const laneId = resolveLane(index, event)
        if (laneId === null) return
        const energy = this.energy(laneId)
        energy.heat += 2
        energy.inbound += 2
        this.spawn({
          laneId,
          kind: 'landing',
          born: now,
          life: LIFE.landing,
          size: 7,
          homeward: true,
          weight: 12,
        })
        return
      }

      case 'llm.usage': {
        const laneId = resolveLane(index, event)
        if (laneId === null) return
        const energy = this.energy(laneId)
        const output = event.payload.tokens.output
        energy.heat += 0.55
        energy.outbound += 0.6

        const wanted = Math.max(
          1,
          Math.min(MAX_MOTES_PER_REQUEST, Math.round(output / TOKENS_PER_MOTE)),
        )

        // Rule 2 is enforced in `spawn` now, for every kind at once: what the
        // motion cap will not animate becomes an aggregate's count or the lane's
        // glow. Nothing is dropped and nothing is invented.
        for (let i = 0; i < wanted; i += 1) {
          this.spawn({
            laneId,
            kind: 'mote',
            // Staggered, so three motes from one request read as a flow rather
            // than as one fat particle.
            born: now + i * 90,
            life: LIFE.mote,
            size: 1.05 + Math.min(1.5, output / 1_400),
            homeward: false,
            weight: 0,
          })
        }
        return
      }

      case 'tool.activity': {
        const laneId = resolveLane(index, event)
        if (laneId === null) return
        const energy = this.energy(laneId)
        energy.heat += 0.3
        // The wheel turns because the agent turned it: a loop that stops looks
        // stopped, because the orbit has nothing left to advance it.
        energy.orbitTarget += ORBIT_STEP
        this.spawn({
          laneId,
          kind: 'tick',
          born: now,
          life: LIFE.tick,
          size: 1.7,
          homeward: false,
          weight: 0,
        })
        return
      }

      default:
        // `pane.activity` is a heartbeat and `llm.cost` is the same request the
        // usage record already pulsed for — both move clocks and light nothing.
        return
    }
  }

  /** Advance the field to `now`: retire finished pulses, decay every energy. */
  step(now: number): void {
    const elapsed = this.lastStep === 0 ? 16 : Math.max(0, now - this.lastStep)
    this.lastStep = now

    // Decay runs on the true elapsed time — exponential decay is stable at any
    // step size, and a tab that was in the background for five minutes must come
    // back to a cold fleet rather than to five-minute-old heat.
    //
    // The orbit's easing does not: it is an animation catching up to a notch, and
    // a huge step would snap it round the knot in a single frame. So it is
    // clamped to a plausible frame, which stalls the catch-up for a few frames
    // after a long gap and never invents a lap that no tool call asked for.
    const dt = Math.min(240, elapsed)

    const survivors: Pulse[] = []
    for (const pulse of this.live) {
      if (now - pulse.born < pulse.life) {
        survivors.push(pulse)
        continue
      }
      // Rule 3: the flare is the journey's end. Nothing else raises the surge —
      // and an aggregate is N journeys ending together, so it flares for all of
      // them. Coalescing changes how the traffic is *drawn*, never how much of
      // it there was.
      if (pulse.homeward) {
        const each = pulse.kind === 'landing' ? 1.2 : 0.55
        this.surgeLevel = Math.min(1.8, this.surgeLevel + each * pulse.count)
      }
    }
    this.live = survivors

    const decay = Math.exp(-elapsed / HEAT_TAU_MS)
    const catchUp = Math.min(1, dt / ORBIT_CATCHUP_MS)
    for (const energy of this.energies.values()) {
      energy.heat *= decay
      energy.inbound *= decay
      energy.outbound *= decay
      energy.coalesced *= decay
      energy.orbitPhase += (energy.orbitTarget - energy.orbitPhase) * catchUp
    }
    this.surgeLevel *= Math.exp(-elapsed / SURGE_TAU_MS)
  }

  pulses(): readonly Pulse[] {
    return this.live
  }

  energyOf(laneId: string): LaneEnergy {
    return this.energies.get(laneId) ?? ZERO_ENERGY
  }

  /** The root-mass's arrival brightness, 0 when nothing has come home lately. */
  surge(): number {
    return this.surgeLevel
  }

  /**
   * Pulses refused outright at {@link MAX_PULSES} — not the ones the motion cap
   * coalesced, which are still counted and still drawn. Surfaced by the scene
   * rather than swallowed: a cap that silently eats traffic makes the picture a
   * guess. Zero is the normal reading, and it means what it says.
   */
  dropped(): number {
    return this.droppedPulses
  }

  /** Live event animations — what {@link EVENT.maxConcurrent} is a cap on. */
  concurrency(): number {
    return this.live.length
  }

  /** 0–1 through a pulse's life. Clamped, so a stale frame cannot overshoot. */
  static progress(pulse: Pulse, now: number): number {
    return clamp01((now - pulse.born) / pulse.life)
  }

  /** Where it sits on the thread: 0 = root-mass, 1 = node. */
  static position(pulse: Pulse, now: number): number {
    const t = PulseField.progress(pulse, now)
    return pulse.homeward ? 1 - t : t
  }

  /**
   * THE MOTION CAP (ruling 4), which is rule 2 extended from traffic to motion.
   *
   * Above {@link EVENT.maxConcurrent} concurrent animations the scene stops
   * being readable — people follow four or five independent moving targets and
   * fail past that, so a sixth simultaneous pulse does not add a sixth fact, it
   * subtracts from the five already there. Nothing is thrown away to enforce it;
   * the surplus goes somewhere it can still be counted.
   */
  private spawn(pulse: Omit<Pulse, 'id' | 'count'>): void {
    if (this.live.length >= MAX_PULSES) {
      this.droppedPulses += 1
      return
    }

    // A tick is a flick across the thread with no journey in it, so it yields
    // its slot to light that is actually going somewhere. Cutting one short
    // loses no fact: its heat is already recorded on the lane.
    if (this.live.length >= EVENT.maxConcurrent && (pulse.kind === 'tick' || !this.dropOneTick())) {
      this.coalesce(pulse)
      return
    }

    this.live.push({ ...pulse, count: 1, id: this.nextId })
    this.nextId += 1
  }

  /**
   * Fold a refused event into something that still carries it.
   *
   * First choice is an **aggregate**: the oldest journey already running on that
   * lane in the same direction, which takes on a count. That keeps the fold
   * honest twice over — the journey it rides is one a real event started, and
   * the direction it travels is the direction the folded event actually went.
   *
   * A landing is never folded into, because it is the biggest single arrival the
   * fleet produces and it has earned its own light. If there is nothing lawful
   * to fold into, the event becomes the lane's glow, which is where surplus has
   * always gone.
   */
  private coalesce(pulse: Omit<Pulse, 'id' | 'count'>): void {
    let host: Pulse | null = null
    for (const live of this.live) {
      if (live.laneId !== pulse.laneId) continue
      if (live.kind === 'tick' || live.kind === 'landing') continue
      if (live.homeward !== pulse.homeward) continue
      if (host === null || live.born < host.born) host = live
    }

    if (host === null) {
      this.energy(pulse.laneId).coalesced += 1
      return
    }

    host.kind = 'aggregate'
    host.count += 1
  }

  /** Retire the oldest tick to make room for a journey. False if there is none. */
  private dropOneTick(): boolean {
    let oldest = -1
    for (let i = 0; i < this.live.length; i += 1) {
      const pulse = this.live[i] as Pulse
      if (pulse.kind !== 'tick') continue
      if (oldest === -1 || pulse.born < (this.live[oldest] as Pulse).born) oldest = i
    }
    if (oldest === -1) return false
    this.live.splice(oldest, 1)
    return true
  }

  private energy(laneId: string): LaneEnergy {
    const existing = this.energies.get(laneId)
    if (existing !== undefined) return existing
    const created: LaneEnergy = { ...ZERO_ENERGY }
    this.energies.set(laneId, created)
    return created
  }
}

/**
 * The news cursor — rule 1, made mechanical.
 *
 * `StreamState.news` is a capped ring of the most recent news events and
 * `newsCount` is how many have ever arrived. Together they let the scene take
 * each news event exactly once without the fold having to remember what the
 * scene has seen: the count says how many are new, the ring says which. If the
 * scene ever falls further behind than the ring is long the excess is simply
 * missed rather than replayed late — a pulse for a fact from thirty seconds ago
 * would be a lie about when it happened.
 *
 * History is not filtered out here; it never entered. `state.news` only contains
 * what {@link StreamState} tagged as news in the first place.
 */
export function takeNews(
  state: Pick<StreamState, 'news' | 'newsCount'>,
  cursor: number,
): { events: readonly ObservatoryEvent[]; cursor: number } {
  if (state.newsCount <= cursor) return { events: [], cursor: state.newsCount }
  const wanted = Math.min(state.newsCount - cursor, state.news.length)
  return {
    events: state.news.slice(state.news.length - wanted),
    cursor: state.newsCount,
  }
}
