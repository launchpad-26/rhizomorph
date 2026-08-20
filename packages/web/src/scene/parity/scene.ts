import {
  buildFleet,
  fixtureHistory,
  manifestFor,
  pathologySpec,
  reduceAll,
} from '../../fleet/index.js'
import { layoutScene } from '../geometry.js'
import { breathOf, motionMode, sceneMarks, type Mark, type SceneFrame } from '../marks/index.js'
import { PulseField } from '../pulses.js'
import { laneIndex } from '../resolve.js'
import { RETURN, returnAt } from '../retire.js'
import { DARK_PALETTE } from '../palette.js'
import { salienceOf } from '../salience.js'

/**
 * THE SEEDED SCENE the parity captures are taken of.
 *
 * One frame, one clock, no randomness anywhere — the same `Mark[]` on any
 * machine, in any year, so the two PNGs beside this file differ only by the
 * painter that drew them. Everything here is the shipping model layer, imported
 * rather than re-implemented: `layoutScene` and `sceneMarks` are the same
 * functions the frame loop calls.
 *
 * The fixture is `pathologySpec` because parity is about *fidelity*, not scale.
 * It puts one of each pathology in the picture — a lane frozen and severed, one
 * looping, one waiting with a summons up, one burning, one reaching over a fence
 * — plus a lane mid-return (which is the only thing that draws a mote drift and
 * a dissolution), a selected lane (its spotlight ring and its label chip), and
 * the panel's own chrome. All twelve mark kinds are present, which is the point:
 * a capture that omitted a kind could not show a difference in it.
 */

/** Pinned. Every duration in the scene is measured from here. */
export const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

export const PANEL = { width: 1100, height: 620 }

export function seededMarks(): Mark[] {
  const spec = pathologySpec()
  const history = fixtureHistory(spec, NOW)
  const fleet = buildFleet(reduceAll(history), { now: NOW, manifest: manifestFor(spec) })

  const field = new PulseField()
  field.ingest(
    history.filter((event) => event.type === 'commit.landed').slice(-3),
    laneIndex(fleet),
    NOW - 500,
  )
  field.step(NOW)

  // One cord half a second past its tension phase: the frame a dissolve is drawn
  // in, and the only one that carries `motes`.
  const returning = fleet.lanes[0]?.id ?? ''
  const retire = new Map([[returning, returnAt(RETURN.tensionMs + 420)]])

  const geometry = layoutScene(fleet, { ...PANEL, now: NOW, retire })
  const selectedId = fleet.lanes[1]?.id ?? null

  const frame: SceneFrame = {
    fleet,
    geometry,
    field,
    salience: salienceOf({ fleet, hoverId: null, selectedId }),
    now: NOW,
    asOf: NOW,
    quality: 'rich',
  vibrancy: 1,
    reducedMotion: false,
    paused: false,
    breath: breathOf(NOW, motionMode({ reducedMotion: false, paused: false })),
    // The parity capture IS the dark-byte-identity evidence, so it pins dark explicitly.
    palette: DARK_PALETTE,
  }

  return sceneMarks(frame)
}
