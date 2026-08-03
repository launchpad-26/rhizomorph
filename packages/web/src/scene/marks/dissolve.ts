import type { ThreadGeometry } from '../geometry.js'
import { DISSOLUTION } from '../motion.js'
import { dissolutionMotes, type Dissolve, type Mote } from '../motes.js'
import { ACTIVITY_HUE } from '../palette.js'
import { emphasisOf } from '../salience.js'
import { variationSeed } from '../variation.js'
import type { SceneFrame } from './frame.js'
import type { Mark, MarkRole } from './types.js'

/**
 * THE RETURN, AS MARKS (prd10 rulings 2, 9 and 10).
 *
 * Two acts, one grammar, and that is the point of building them in one file: a
 * severed cord composting into the mass and a finished subagent's bud being taken
 * back into its parent are the same event at two scales (ruling 9's own words —
 * "the same return grammar as ruling 2, in miniature"). They share the arithmetic
 * (`motes.ts`), the class and its pool (`DISSOLUTION`), and they are the *only*
 * two things allowed to spawn one.
 *
 * **The pool is enforced here**, because it is a scene-wide ceiling rather than a
 * per-lane one: the acts are walked in a stable order and each is handed what is
 * left of {@link DISSOLUTION.maxLive}. Truncation rather than thinning, and in a
 * stable order rather than a fair one, so the same frame always draws the same
 * motes — a pool that shared itself out proportionally would make one cord's
 * appearance depend on how many others happened to be composting, which is the
 * sort of coupling that shows up as flicker.
 *
 * A severance's motes are absent from a scar nobody watched leave — a replay, a
 * scrub, a reduced-motion frame — for the same reason the homeward ribbon is:
 * `dissolve` is already 1 on its first frame, and a return nobody saw start is a
 * return that did not happen on this screen. That is also what makes a
 * scrubbed-to-the-end replay show a clean rim rather than a wave of composting
 * cords the log is only telling us about.
 */

/**
 * How bright one mote may be at the peak of its life.
 *
 * Under `CALM_CEILING` by construction rather than by capping: the brightest thing
 * this can produce is the light end of the tissue ramp at this alpha, which is
 * about 0.3 in `luminance` units — a little under half the calm ceiling. Motes are
 * the *ashes* of a lane's work; they have no business competing with the working
 * fleet around them, let alone with a summons.
 */
const MOTE_PEAK = 0.62

export function dissolveMarks(frame: SceneFrame): Mark[] {
  const marks: Mark[] = []
  let budget = DISSOLUTION.maxLive

  for (const thread of frame.geometry.threads) {
    if (budget <= 0) break
    for (const job of jobsFor(frame, thread)) {
      if (budget <= 0) break
      const items = dissolutionMotes(job.dissolve, budget)
      if (items.length === 0) continue
      budget -= items.length
      marks.push(drift(job.role, thread.laneId, items))
    }
  }

  return marks
}

interface Job {
  role: MarkRole
  dissolve: Dissolve
}

/** Every act of return this lane is currently making. Usually none. */
function jobsFor(frame: SceneFrame, thread: ThreadGeometry): Job[] {
  const jobs: Job[] = []
  // The lane's own substance, which is what ruling 12 means by "family hue at
  // birth": for a cord this is `done`'s dim green (the only activity a landing
  // has), and for a bud it is whatever the parent is doing while its subagent
  // finishes. Either way the mote is born the colour of the thing it came off.
  const family = ACTIVITY_HUE[thread.lane.activity]
  const seed = variationSeed(thread.lane)
  const peak = MOTE_PEAK * emphasisOf(frame.salience, thread.laneId, false)

  const cut = thread.retire
  // A hidden scar composts nothing: the operator asked not to be shown this lane,
  // and a drift of motes over the lane that is not there would be the loudest
  // thing the toggle failed to hide.
  if (cut !== null && !cut.hidden) {
    jobs.push({
      role: 'dissolution',
      dissolve: {
        cause: 'severance',
        // The **stored spine**: the whole cord as it was, root-mass end first, so
        // a mote's parameter along it is literally its distance from the cut and
        // travelling to parameter 0 is travelling home. `thread.path` stays whole
        // through the entire cut for exactly this reason (`RetireGeometry`).
        spine: thread.path,
        progress: cut.dissolve,
        sizeFrac: thread.sizeFrac,
        family,
        seed,
        peak,
      },
    })
  }

  const bud = thread.bud
  if (bud !== null && bud.absorb > 0) {
    jobs.push({
      role: 'absorption',
      dissolve: {
        cause: 'absorption',
        // Reversed, so home is first here too: a bud's home is the junction on its
        // parent's thread, and its matter goes back into the lane that spawned it
        // rather than to the mass. One level deep, and this is where that shows.
        spine: [...bud.path].reverse(),
        progress: bud.absorb,
        // Small: a bud is a branchlet, so what it gives back is a handful of motes
        // whatever the parent lane has produced.
        sizeFrac: 0,
        family,
        seed: `${seed}/bud`,
        peak: peak * 0.8,
      },
    })
  }

  return jobs
}

function drift(role: MarkRole, laneId: string, items: readonly Mote[]): Mark {
  return { kind: 'motes', role, laneId, alarm: false, items }
}
