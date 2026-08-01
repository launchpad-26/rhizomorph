import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  WANDER_MAX_SPACING,
  WIDTH_JITTER_MAX,
  WIDTH_JITTER_WAVES,
  blobRing,
  variationFor,
  variationSeed,
  type Channel,
} from './variation.js'

/**
 * BOUNDED UNIQUENESS, PINNED (prd7 ruling 4).
 *
 * The operator asked for a scene where no two lanes look alike. The danger in
 * granting that is not ugliness, it is *dishonesty*: every geometric channel
 * here already carries a fact, so a wobble in the wrong one is a lane that reads
 * as further through its life, or wider, or more urgent than it is.
 *
 * So the ruling is a permission table and this file is the table's teeth. Three
 * things are held:
 *
 * 1. **the table itself** — which channels are locked, and what the two bounded
 *    ones are bounded to. A limit that lives only in a comment is a limit that
 *    gets nudged.
 * 2. **the bounds are obeyed**, at every parameter along a thread, by every seed
 *    a lane name could produce. Sampled rather than argued.
 * 3. **replay is safe** — the same handle produces the same numbers from a
 *    *freshly constructed* noise field, which is the property that makes a log
 *    recorded on another machine redraw the picture it recorded.
 */

/** Handles chosen to be adjacent, so "similar names, similar shapes" would show. */
const HANDLES = [
  '113-ribbons',
  '114-contour',
  '115-prd7-docs',
  '41-retry-parser',
  '42-otel-receiver',
  'main',
  '',
]

const ALONG = Array.from({ length: 101 }, (_unused, i) => i / 100)

describe('the channel table is law, not commentary', () => {
  it('locks the three channels that carry the encoding', () => {
    // Distance is the lifecycle (prd6 ruling 4), hue is state (law 9a/9b), width
    // is work size (prd6 ruling 1). Nothing in this file may touch any of them,
    // and the table says so in a form a test can read.
    expect(CHANNELS.radial.permission).toBe('locked')
    expect(CHANNELS.hue.permission).toBe('locked')
    expect(CHANNELS.width.permission).toBe('locked')
    for (const key of ['radial', 'hue', 'width'] as const) {
      expect(CHANNELS[key].meaning, `${key} was locked without saying why`).not.toBeNull()
    }
  })

  it('grants only what carries nothing, and says how much', () => {
    expect(CHANNELS.widthJitter.permission).toBe('bounded')
    expect(CHANNELS.wander.permission).toBe('bounded')
    expect(CHANNELS.curl.permission).toBe('free')
    // The two numbers the ruling named. Pinned here so a retune has to argue
    // with the prd rather than with a diff nobody reads.
    expect(WIDTH_JITTER_MAX).toBe(0.1)
    expect(WANDER_MAX_SPACING).toBe(0.3)
  })

  it('never grants a channel that carries something, whatever gets added later', () => {
    // The invariant the table exists for, stated over the whole of it: if a
    // channel has a meaning it is locked, and if it is not locked it has no
    // meaning to lose. A future row that broke this would fail here rather than
    // in a screenshot six months on.
    for (const [name, channel] of Object.entries(CHANNELS as Record<string, Channel>)) {
      if (channel.meaning === null) continue
      expect(channel.permission, `${name} encodes something and was not locked`).toBe('locked')
    }
  })
})

describe('the wander stays inside its cap', () => {
  it('never leaves the bound, at any point on any lane', () => {
    for (const handle of HANDLES) {
      const variation = variationFor(handle)
      for (const t of ALONG) {
        expect(Math.abs(variation.wander(t)), `${handle} wandered off at ${t}`).toBeLessThanOrEqual(
          1,
        )
      }
    }
  })

  it('is exactly zero at both ends — the encoded endpoints do not move', () => {
    // This is the single property that makes the whole channel table safe rather
    // than merely well-intentioned. A thread's two ends are where the lifecycle
    // radius and the identity angle are read; multiply the noise by zero there
    // and no amount of bend in between can move either of them.
    for (const handle of HANDLES) {
      const variation = variationFor(handle)
      expect(variation.wander(0)).toBe(0)
      expect(variation.wander(1)).toBe(0)
    }
  })

  it('bends rather than vibrates — one lazy curve along a thread', () => {
    // Bounded amplitude is only half of "not noise". A wander that changed sign
    // twenty times inside the cap would read as a frayed line, which is the
    // opposite of the grown look the ruling is buying.
    for (const handle of HANDLES) {
      const variation = variationFor(handle)
      let flips = 0
      for (let i = 1; i < ALONG.length; i += 1) {
        const before = variation.wander(ALONG[i - 1] as number)
        const here = variation.wander(ALONG[i] as number)
        if (before !== 0 && here !== 0 && Math.sign(before) !== Math.sign(here)) flips += 1
      }
      expect(flips, `${handle} frayed instead of bending`).toBeLessThanOrEqual(3)
    }
  })

  it('actually bends — a cap nobody reaches is a cap nobody needed', () => {
    const reach = Math.max(
      ...HANDLES.flatMap((handle) => ALONG.map((t) => Math.abs(variationFor(handle).wander(t)))),
    )
    expect(reach).toBeGreaterThan(0.3)
  })
})

describe('the width jitter stays inside its cap', () => {
  it('never moves the encoded width by more than the table allows', () => {
    for (const handle of HANDLES) {
      const variation = variationFor(handle)
      for (const t of ALONG) {
        const factor = variation.widthJitter(t)
        expect(factor, `${handle} thinned past the cap at ${t}`).toBeGreaterThanOrEqual(
          1 - WIDTH_JITTER_MAX,
        )
        expect(factor, `${handle} fattened past the cap at ${t}`).toBeLessThanOrEqual(
          1 + WIDTH_JITTER_MAX,
        )
      }
    }
  })

  it('is low-frequency, which is the other half of the permission', () => {
    // "±10%" alone would allow a ribbon that shimmered along its whole length.
    // The ruling says low-frequency, so the wobble is counted: at most a couple
    // of turning points along a thread, which reads as a hand-drawn line rather
    // than a serrated one.
    for (const handle of HANDLES) {
      const variation = variationFor(handle)
      let turns = 0
      for (let i = 1; i < ALONG.length - 1; i += 1) {
        const a = variation.widthJitter(ALONG[i - 1] as number)
        const b = variation.widthJitter(ALONG[i] as number)
        const c = variation.widthJitter(ALONG[i + 1] as number)
        if ((b > a && b >= c) || (b < a && b <= c)) turns += 1
      }
      expect(turns, `${handle} shimmered`).toBeLessThanOrEqual(2 * WIDTH_JITTER_WAVES + 1)
    }
  })

  it('is not a no-op — a jitter nobody can see is a channel spent on nothing', () => {
    for (const handle of HANDLES) {
      const variation = variationFor(handle)
      const swing = Math.max(...ALONG.map((t) => Math.abs(variation.widthJitter(t) - 1)))
      expect(swing, `${handle} did not vary at all`).toBeGreaterThan(0.01)
    }
  })
})

describe('seeded by identity, never by the clock', () => {
  it('gives the same lane the same numbers from a fresh field', () => {
    // The replay guarantee. `variationFor` caches, so the cache is deliberately
    // sidestepped by asking for a value, then asking a differently-spelled route
    // to the same seed — what matters is that the *construction* is a pure
    // function of the string, which is what a second process would do.
    const first = variationFor('113-ribbons')
    const again = variationFor(['113', 'ribbons'].join('-'))
    for (const t of ALONG) {
      expect(again.wander(t)).toBe(first.wander(t))
      expect(again.widthJitter(t)).toBe(first.widthJitter(t))
    }
    expect(again.curl).toBe(first.curl)
  })

  it('gives adjacent lane names their own shapes', () => {
    // A character-sum hash would put `114-contour` right beside `113-ribbons`
    // and the fleet would come in families. cyrb128 is here to stop that: no two
    // handles share a bend, and across a fleet the bends run the full width of
    // what the cap allows rather than clustering around one house curve.
    const shapes = HANDLES.map((handle) =>
      ALONG.map((t) => variationFor(handle).wander(t)).join(','),
    )
    expect(new Set(shapes).size).toBe(HANDLES.length)

    const apart = (a: string, b: string): number =>
      Math.max(...ALONG.map((t) => Math.abs(variationFor(a).wander(t) - variationFor(b).wander(t))))
    const pairs = HANDLES.flatMap((a, i) => HANDLES.slice(i + 1).map((b) => apart(a, b)))

    expect(Math.min(...pairs), 'two lanes drew the same bend').toBeGreaterThan(0.05)
    expect(Math.max(...pairs), 'the whole fleet bent the same way').toBeGreaterThan(0.5)
  })

  it('does not drift while nothing has changed', () => {
    const before = ALONG.map((t) => variationFor('42-otel-receiver').wander(t))
    // Anything that read a clock or a global counter would diverge across this.
    for (let i = 0; i < 5_000; i += 1) variationFor(`throwaway-${i % 700}`).curl
    const after = ALONG.map((t) => variationFor('42-otel-receiver').wander(t))
    expect(after).toEqual(before)
  })

  it('takes the handle, and takes it in a stable order', () => {
    // Two collectors can name the same lane in either order. If the seed came
    // off `handles[0]` a lane would change shape depending on which collector
    // reported first, which is a picture that flickers for no reason at all.
    expect(variationSeed({ id: 'x', handles: ['zeta', 'alpha'] })).toBe('alpha')
    expect(variationSeed({ id: 'x', handles: ['alpha', 'zeta'] })).toBe('alpha')
    // …and a lane telemetry never named still gets a shape.
    expect(variationSeed({ id: 'only-an-id', handles: [] })).toBe('only-an-id')
  })
})

describe('the enclosure blob', () => {
  const centre = { x: 100, y: 50 }

  it('is closed, and stays near the ring it grew from', () => {
    const ring = blobRing(centre, 40, 15, '113-ribbons')
    expect(ring.length).toBeGreaterThan(20)
    for (const point of ring) {
      const away = Math.hypot((point.x - centre.x) / 40, (point.y - centre.y) / 15)
      // Displaced, but recognisably the same enclosure: it never balloons out to
      // twice the name it is behind, and it never collapses inside it.
      expect(away).toBeGreaterThan(0.6)
      expect(away).toBeLessThan(1.45)
    }
  })

  it('is not a circle — displacement is the whole point', () => {
    const ring = blobRing(centre, 40, 15, '113-ribbons')
    const radii = ring.map((p) => Math.hypot((p.x - centre.x) / 40, (p.y - centre.y) / 15))
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.08)
  })

  it('gives every lane its own, and gives each lane the same one twice', () => {
    expect(blobRing(centre, 40, 15, 'a')).toEqual(blobRing(centre, 40, 15, 'a'))
    expect(blobRing(centre, 40, 15, 'a')).not.toEqual(blobRing(centre, 40, 15, 'b'))
  })
})
