import { alarmCartouche } from '../../fleet/index.js'
import { thorn } from '../../fleet/strokes.js'

/**
 * The scene's share of the sigil alphabet (ruling 23).
 *
 * These are authored in the same unit square, by the same stroke engine, as the
 * fleet table's row glyphs (`fleet/strokes.ts`, `fleet/sigils.tsx`) — tapered
 * filled polygons with thorn-curl terminals, never uniform strokes. Canvas draws
 * them through `Path2D`, so the alphabet is shared as *code* rather than
 * duplicated as a second set of hand-drawn shapes.
 *
 * What the scene does **not** reuse is the row glyphs' silhouettes: at row scale
 * a state is a mark beside a word, and in the scene the same state is a
 * *behaviour* of the thread — a knot, a severed line, a raised hand. Those are
 * the scene contract's encodings (ruling 21) and they are built where they are
 * drawn. The shared thing is the hand, not the letters.
 */

/**
 * The one enclosure in the instrument: the thorned ring an alarm node wears.
 * Straight from the keystone's alphabet, so a bracketed lane in the scene and a
 * bracketed row in the table are literally the same mark (graft g1/g2).
 */
export const CARTOUCHE = alarmCartouche()

/**
 * A thorn curl leaving the unit centre along +x. Every terminal in this scene
 * ends in one of these — it is what makes the register read as sigilist rather
 * than as iconography.
 */
function thornCurl(sweep: number, width: number): string {
  const r = 0.3
  return thorn(0.5 - r, 0.5, r, 0, sweep, width)
}

/** The standard outward terminal, pre-built: one curl, one width. */
export const THORN_OUT = thornCurl(1.05, 0.16)

/**
 * A lane's node: a lens, pointed at both ends, lying along its thread. Sharp
 * rather than round on purpose — nothing in this scene is a bead.
 */
export const NODE_LENS = 'M0.04 0.5Q0.5 0.1 0.96 0.5Q0.5 0.9 0.04 0.5Z'
