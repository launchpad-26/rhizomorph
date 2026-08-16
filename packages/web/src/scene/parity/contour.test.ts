import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contourDigests, STATES, type ContourDigest, type LevelDigest } from './contour.js'
import before from './contour-before.json' with { type: 'json' }

/**
 * THE SCENE IS VISUALLY UNCHANGED (#579), EVIDENCED RATHER THAN ASSERTED.
 *
 * `contour.ts`'s bake takes the mass's field out of the per-frame path: the
 * surface and its shells are walked once in unit space and *placed* by the
 * frame's own similarity transform. The saving is real and `perf.test.ts`
 * reports it; the question a reviewer actually has is whether the picture moved.
 *
 * `contour-before.json` answers it. It was produced by the code in
 * `parity/contour.ts` running against the tree **before** the bake:
 *
 * ```
 * git stash push -- packages/web/src/scene/contour.ts
 * WRITE_CONTOUR_BEFORE=1 npx vitest run packages/web/src/scene/parity/contour.test.ts
 * git stash pop
 * ```
 *
 * — so it is the old implementation's own output, checked in, and what follows
 * is a genuine before/after rather than a snapshot of the code that wrote it.
 * Re-record it only when the *mass* is deliberately retuned, and say so on the
 * PR; re-recording it to make this file go green is the one way to make it
 * worthless.
 *
 * **What is exact and what is bounded, and why the split is the whole test.**
 *
 * - **The shape's structure is exact.** Ring counts, vertex counts, the number
 *   of levels, the number of marks. These are integers and they cannot drift:
 *   a shell that gained a ring, lost a vertex or vanished is a different
 *   picture, full stop.
 * - **The coordinates are bounded, and the bound is measured.** The bake rounds
 *   the field to 1e-6 of the grid pitch before walking it (see `contour.ts`'s
 *   `BAKE_PLACES` note — that rounding is what makes the answer an exact
 *   function of the cache key rather than a lookup that can be half a ULP off
 *   the shape asked for). A ~8 px cell puts the ceiling on that at about eight
 *   nanometres of picture. {@link MOVED_PX} is a thousandth of a pixel, i.e.
 *   over a hundred times looser than the mechanism can produce and still four
 *   orders of magnitude tighter than anything a display, a screenshot or an eye
 *   could resolve — so a real move cannot pass and the last bits of a double
 *   cannot fail.
 *
 * The worst deviation actually observed is **reported** on every run, which is
 * the number that matters: a bound nobody watches the distance to is a bound
 * that has already been widened once.
 */

/**
 * Off the repo root rather than off `import.meta.url`: vitest hands this module
 * a transformed URL that `fileURLToPath` refuses, and the write arm below is a
 * developer command run from the root — the same place `vitest` itself is.
 */
const GOLDEN = resolve(process.cwd(), 'packages/web/src/scene/parity/contour-before.json')

/** A thousandth of a pixel. See the header for both sides of why that number. */
const MOVED_PX = 1e-3

function report(line: string): void {
  // eslint-disable-next-line no-console -- the measurement is the deliverable
  console.log(line)
}

describe('the mass drawn before and after the contour bake', () => {
  it('walks the same surface, to within a thousandth of a pixel, in every state', () => {
    const after = contourDigests()

    // The capture arm. Off in every normal run — see the header for when it is
    // legitimately on, and for why turning it on to clear a failure is the one
    // thing that empties this file of meaning.
    if (process.env.WRITE_CONTOUR_BEFORE === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(after)}\n`)
    }

    const recorded = before as unknown as ContourDigest[]
    expect(after.map((state) => state.name)).toEqual(STATES.map((state) => state.name))
    expect(recorded.map((state) => state.name)).toEqual(STATES.map((state) => state.name))

    let worst = 0
    let worstAt = ''
    const moved = (label: string, then: number, now: number): void => {
      const away = Math.abs(now - then)
      if (away > worst) {
        worst = away
        worstAt = label
      }
    }

    after.forEach((now, index) => {
      const then = recorded[index] as ContourDigest

      // EXACT: the structure of the shape. Integers, and a change in one of them
      // is a change in the picture rather than in the last bit of a double.
      expect(now.marks, `${now.name}: mark count`).toBe(then.marks)
      expect(now.surface.length, `${now.name}: surface rings`).toBe(then.surface.length)
      expect(
        now.surface.map((ring) => ring.length),
        `${now.name}: surface vertices`,
      ).toEqual(then.surface.map((ring) => ring.length))
      expect(now.levels.length, `${now.name}: levels`).toBe(then.levels.length)
      expect(
        now.levels.map((level) => [level.rings, level.vertices]),
        `${now.name}: shell rings and vertices`,
      ).toEqual(then.levels.map((level) => [level.rings, level.vertices]))

      // BOUNDED: where each of those vertices actually is.
      moved(`${now.name}.centre.x`, then.centre.x, now.centre.x)
      moved(`${now.name}.centre.y`, then.centre.y, now.centre.y)
      now.surface.forEach((ring, r) => {
        const was = then.surface[r] as number[]
        ring.forEach((value, i) => moved(`${now.name}.surface[${r}][${i}]`, was[i] as number, value))
      })
      now.levels.forEach((level, l) => {
        const was = then.levels[l] as LevelDigest
        moved(`${now.name}.level[${l}].minRadius`, was.minRadius, level.minRadius)
        moved(`${now.name}.level[${l}].maxRadius`, was.maxRadius, level.maxRadius)
        // Per vertex, not in total: a sum over three thousand points accumulates
        // three thousand roundings, and comparing it against a per-vertex bound
        // would be comparing two different quantities.
        const per = Math.max(1, level.vertices)
        moved(`${now.name}.level[${l}].sumX/vertex`, was.sumX / per, level.sumX / per)
        moved(`${now.name}.level[${l}].sumY/vertex`, was.sumY / per, level.sumY / per)
      })
    })

    report(
      `contour parity: worst move ${worst.toExponential(2)} px at ${worstAt || 'nowhere'} ` +
        `(bound ${MOVED_PX} px — ${((worst / MOVED_PX) * 100).toFixed(3)}% of it)`,
    )
    expect(worst, `the mass moved at ${worstAt}`).toBeLessThan(MOVED_PX)
  })

  /**
   * …and the states are not six copies of one state. The evidence above is
   * worth nothing if the mass came out the same shape and size in all of them:
   * the bake is keyed on the shape *in units of the radius*, so a spread that
   * only varied the radius would exercise one baked shape six times and prove
   * only that a cache can be read.
   */
  it('covers six genuinely different masses, not one drawn six times', () => {
    const digests = contourDigests()
    expect(new Set(digests.map((d) => JSON.stringify(d.surface))).size).toBe(digests.length)
    // …including three that differ by the breath alone, which is the
    // frame-to-frame change the bake exists to answer without re-walking.
    const calm = digests.filter((d) => d.name.startsWith('calm'))
    expect(calm).toHaveLength(3)
    expect(new Set(calm.map((d) => d.levels[0]?.maxRadius)).size).toBe(3)
  })
})
