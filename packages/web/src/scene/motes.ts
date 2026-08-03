import { pointAt, type Point } from './geometry.js'
import { DISSOLUTION, type DissolutionCause } from './motion.js'
import { clamp01, returningInk, type Ink, type Rgb } from './palette.js'

/**
 * THE COMPOSTING DECAY (prd10 rulings 2 and 12) — a cord coming apart, as data.
 *
 * Ruling 2's picture, in one sentence: on severance the cord **does both
 * movements at once** — it decomposes into bioluminescent motes along its own
 * path, and its matter visibly flows home. Not two effects layered; one act. A
 * mote *is* a piece of the cord, born where the cord was, travelling the cord's
 * own curve into the mass, and gone.
 *
 * Four properties, and each one is a ruling rather than a taste:
 *
 * 1. **Birth delay is proportional to distance from the cut.** The cord parts at
 *    the mass, so the nearest piece comes apart first and the fraying runs
 *    outward while every mote streams inward — the cord unravels *into* home.
 *    A cord whose motes all lifted off together would read as an explosion, which
 *    is the one thing a return must not read as.
 * 2. **A mote rides the spine, not the space between.** Its position is a
 *    parameter along the stored path, so the drift follows the hypha that was
 *    there — the substance is being translocated through a network, not thrown
 *    across a gap.
 * 3. **Family hue at birth, tissue at the heart** (ruling 12, and
 *    `returningInk` is the whole of it): a mote is born in its lane's dim
 *    done-green because it *is* that lane's substance, and cools through the
 *    accent ramp as it goes. Status meaning at the cut, tissue meaning at home.
 * 4. **Luminance-only fades.** A mote's radius is fixed for its whole life
 *    ({@link DISSOLUTION}'s allowance refuses `scale` in every mode). It dims; it
 *    never shrinks, and it never grows toward the viewer.
 *
 * **On "pooled".** The ruling's word, and what it buys is in two places, neither
 * of them here: the painter keeps **one 32 px sprite per quantised colour** and
 * blits it (the spike's verdict against `paint.ts:214`'s per-mote gradient —
 * `perf.test.ts` measures the difference), and {@link DISSOLUTION.maxLive} is a
 * hard ceiling on how many exist at once. The mote *records* are ordinary frame
 * data, deliberately: prd7 ruling 1 says the display list is data a worker or a
 * replay could be handed, and a recycled record mutated on the next frame would
 * quietly make an earlier frame's list wrong. The older law wins, and the cap is
 * what bounds the allocation.
 *
 * No clock is read here and no random: a mote is a pure function of the spine, the
 * progress it is handed and its lane's seed. A paused scene holds its motes still
 * because the clock feeding `progress` is held still, and a replay on another
 * machine draws the same drift.
 */

/** One mote, ready to stamp. Plain data — see the note on pooling. */
export interface Mote {
  at: Point
  /** Radius in px. Fixed for the mote's whole life: luminance-only fades. */
  radius: number
  ink: Ink
}

/**
 * One act of return, described. `spine[0]` is **home** — the mass for a
 * severance, the parent thread's junction for an absorbed bud — so the same
 * arithmetic draws ruling 2 and ruling 9's miniature of it.
 */
export interface Dissolve {
  cause: DissolutionCause
  /** Home first. Motes ride this inward. */
  spine: readonly Point[]
  /** 0–1 through the whole act. Past 1 there is nothing left to draw. */
  progress: number
  /** How much substance came apart, 0–1 — the mote count and their size. */
  sizeFrac: number
  /** The lane's own colour at the cut (ruling 12). */
  family: Rgb
  /** The lane's seed, so its motes are its own. */
  seed: string
  /** Peak luminance one mote may reach. Held under the calm ceiling by the caller. */
  peak: number
}

/** The fewest motes a return is ever drawn with. Below this it reads as a fizzle. */
const MIN_MOTES = 10

/**
 * What fraction of the act is spent on births.
 *
 * Exactly `1 - moteLife/span`, so the *last* mote is born with precisely its own
 * life left to run and the act ends the instant it arrives. Any less and the
 * dissolve would sit finished for a moment with nothing on screen; any more and
 * the last mote would be cut off in mid-flight, which is the one thing that would
 * make a return read as an amputation (ruling 1's own word).
 */
const BIRTH_SPREAD = 1 - DISSOLUTION.moteLifeMs / DISSOLUTION.spanMs

/** How much of the fraction of a life a mote spends fading in rather than out. */
const ENVELOPE = 0.6

/** How many motes this much substance comes apart into. */
export function moteCount(sizeFrac: number): number {
  return Math.round(MIN_MOTES + (DISSOLUTION.maxPerLane - MIN_MOTES) * clamp01(sizeFrac))
}

/**
 * The live motes of one act, at the progress it is at.
 *
 * `budget` is what is left of {@link DISSOLUTION.maxLive} after the acts already
 * drawn this frame — the pool's ceiling, enforced by truncation. Truncating
 * loses no *fact*: a mote is a rendering of matter, not a count of events (which
 * is why nothing here reports a drop to the gap voice the way `pulses.ts` does
 * for refused traffic).
 */
export function dissolutionMotes(job: Dissolve, budget: number): Mote[] {
  if (job.progress <= 0 || job.progress >= 1 || budget <= 0) return []
  if (job.spine.length < 2) return []

  const wanted = Math.min(moteCount(job.sizeFrac), DISSOLUTION.maxPerLane, budget)
  const life = DISSOLUTION.moteLifeMs / DISSOLUTION.spanMs
  const salt = saltOf(job.seed)
  const motes: Mote[] = []

  for (let i = 0; i < wanted; i += 1) {
    // Where along the cord this piece was, and therefore how far from the cut —
    // which is the birth delay, and the whole of property 1 above.
    const born = ((i + 0.5) / wanted) * BIRTH_SPREAD
    const age = (job.progress - born) / life
    if (age <= 0 || age >= 1) continue

    // Home along its own spine. Eased out, so a mote leaves briskly and is drawn
    // into the mass rather than arriving at a constant speed like a vehicle.
    const journey = age * age * (3 - 2 * age)
    const at = pointAt(job.spine, ((i + 0.5) / wanted) * (1 - journey))

    // In and out, so a mote appears and is absorbed rather than blinking twice.
    const envelope = Math.sin(Math.PI * age) ** ENVELOPE
    motes.push({
      at,
      // Fixed for its whole life (ruling 10's luminance-only fade), and a little
      // different per mote so a drift does not read as a stencil.
      //
      // Off a **hash** of the lane's seed rather than off the string's length,
      // which is what this was first written as and is the same bug `variation.ts`
      // records against character sums: two lanes whose names happen to be
      // congruent got bit-identical motes. A drift is one of the few things in this
      // scene with no encoded channel at all, so the one thing it owes the picture
      // is that no two lanes' matter looks like the same stencil.
      radius:
        MOTE_RADIUS.min +
        (MOTE_RADIUS.span * ((i * 7 + salt) % 5)) / 4 +
        MOTE_RADIUS.work * clamp01(job.sizeFrac),
      ink: returningInk(job.family, journey, job.peak * envelope),
    })
  }

  return motes
}

/**
 * How big a mote is drawn, in px. Small: the reading is a *drift* of matter, and
 * a drift is made of things too small to count. The sprite the painter stamps is
 * 32 px, which is comfortably over twice the largest of these at 2× device
 * pixels — a sprite scaled *down* is resampled cleanly, one scaled up is a blur.
 */
const MOTE_RADIUS = { min: 2, span: 1.4, work: 1.6 } as const

/**
 * A lane's seed as one small whole number — FNV-1a, the same hash `geometry.ts`
 * keys its wander on.
 *
 * A hash rather than anything cheaper for the reason `variation.ts` writes down at
 * length: adjacent lane names (`113-ribbons`, `114-contour`) must not produce
 * adjacent — or, as the first version of this managed, *identical* — results.
 */
function saltOf(seed: string): number {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 997
}
