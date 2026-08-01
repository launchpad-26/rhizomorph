import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PATHOLOGY_KINDS, PATHOLOGY_RANK, type LadderRank, type LaneActivity } from './buildFleet.js'
import {
  ACTIVITY_TEXT_CLASS,
  RANK_TEXT_CLASS,
  SIGIL_KINDS,
  SIGIL_RANK,
  SIGIL_ROW_SIZE,
  SIGIL_SCENE_SIZE,
  Sigil,
  stateTextClass,
} from './sigils.js'

afterEach(cleanup)

/**
 * The alphabet's two promises: the same code draws every mark at both scales
 * (which is what lets the fleet table be the scene's legend, graft g1), and the
 * marks are told apart by *form* before colour arrives (law 9 / graft g4).
 */

function svgFor(kind: (typeof SIGIL_KINDS)[number], size: number): SVGSVGElement {
  const { container } = render(<Sigil kind={kind} size={size} />)
  const svg = container.querySelector('svg')
  expect(svg, `no svg rendered for ${kind}`).not.toBeNull()
  return svg as SVGSVGElement
}

/** The mark's geometry, independent of the size it happened to be drawn at. */
function geometryOf(kind: (typeof SIGIL_KINDS)[number], size: number): string {
  return [...svgFor(kind, size).querySelectorAll('path, circle')]
    .map((node) => node.outerHTML)
    .join('|')
}

describe('the sigil alphabet', () => {
  it('draws every kind', () => {
    for (const kind of SIGIL_KINDS) {
      expect(svgFor(kind, SIGIL_ROW_SIZE).getAttribute('data-sigil')).toBe(kind)
    }
  })

  it('renders the same geometry at row scale and at scene scale (graft g1)', () => {
    for (const kind of SIGIL_KINDS) {
      const row = svgFor(kind, SIGIL_ROW_SIZE)
      const scene = svgFor(kind, SIGIL_SCENE_SIZE)

      expect(row.getAttribute('width')).toBe(String(SIGIL_ROW_SIZE))
      expect(scene.getAttribute('width')).toBe(String(SIGIL_SCENE_SIZE))
      // Authored in a unit square and scaled once: the table's 15px mark and
      // the scene's 64px mark are literally the same paths.
      expect(row.getAttribute('viewBox')).toBe('0 0 1 1')
      expect(scene.getAttribute('viewBox')).toBe('0 0 1 1')
      cleanup()
      expect(geometryOf(kind, SIGIL_ROW_SIZE)).toBe(geometryOf(kind, SIGIL_SCENE_SIZE))
      cleanup()
    }
  })

  it('gives every kind a distinct silhouette', () => {
    const seen = new Map<string, string>()
    for (const kind of SIGIL_KINDS) {
      const geometry = geometryOf(kind, SIGIL_SCENE_SIZE)
      cleanup()
      const clash = seen.get(geometry)
      expect(clash, `${kind} draws the same mark as ${clash}`).toBeUndefined()
      seen.set(geometry, kind)
    }
  })

  it('separates the three NEEDS-YOU marks on axis, so one amber is still three signs', () => {
    // Hue is severity, form is kind (graft g4). These three share an amber, so
    // they have to be unconfusable by silhouette alone: LOOPING is a closed
    // coil, WAITING is a tall vertical, OFF-FENCE is a horizontal spear.
    const amber = PATHOLOGY_KINDS.filter((kind) => PATHOLOGY_RANK[kind] === 'needs-you')
    expect([...amber].sort()).toEqual(['looping', 'off-fence', 'waiting'])

    const extents = Object.fromEntries(
      amber.map((kind) => {
        const box = boundsOf(kind)
        cleanup()
        return [kind, box]
      }),
    )

    // WAITING is taller than it is wide; OFF-FENCE is wider than it is tall.
    expect(extents.waiting!.height).toBeGreaterThan(extents.waiting!.width)
    expect(extents['off-fence']!.width).toBeGreaterThan(extents['off-fence']!.height)
    // LOOPING is neither: a coil is round.
    const loop = extents.looping!
    expect(Math.abs(loop.width - loop.height)).toBeLessThan(0.3)
  })

  it('never carries its own colour — the ladder class decides the hue', () => {
    for (const kind of SIGIL_KINDS) {
      const markup = svgFor(kind, SIGIL_SCENE_SIZE).outerHTML
      cleanup()
      // Only `currentColor`, so a mark inherits the rung's hue from its parent
      // and can never assert a severity of its own.
      expect(markup).not.toMatch(/(fill|stroke)="#/)
      expect(markup).not.toMatch(/(fill|stroke)="rgb/)
      expect(markup).toContain('currentColor')
    }
  })

  it('gives every state a rung, and only ladder classes for hues', () => {
    for (const kind of SIGIL_KINDS) {
      expect(SIGIL_RANK[kind]).toBeDefined()
      expect(RANK_TEXT_CLASS[SIGIL_RANK[kind]]).toMatch(/^text-(calm|notice|needs-you|broken)$/)
    }
    // `done` is calm: a finished lane is not a silent one (the rule that stops
    // a landed fleet from reading as a wall of alarms).
    expect(SIGIL_RANK.done).toBe('calm')
    expect(SIGIL_RANK.frozen).toBe('broken')
  })

  it('gives every activity a hue of its own, from the semantic map (law 9a)', () => {
    // Ruling 3's half of the scale. `working` and `done` are one family at two
    // brightnesses, `waiting` the muted end of the amber a summons wears — so a
    // reader who has learned one end of a family has learned the other.
    expect(ACTIVITY_TEXT_CLASS.working).toBe('text-working')
    expect(ACTIVITY_TEXT_CLASS.done).toBe('text-done')
    expect(ACTIVITY_TEXT_CLASS.waiting).toBe('text-waiting-benign')
    // Nothing-to-say is structure, so it stays on the ice ramp: a lane the log
    // has never mentioned cannot borrow a status hue's confidence (law 12).
    expect(ACTIVITY_TEXT_CLASS.idle).toMatch(/^text-ice-/)
    expect(ACTIVITY_TEXT_CLASS.unknown).toMatch(/^text-ice-/)
    // And no activity may reach for the two hues that mean somebody is needed.
    for (const activity of activities()) {
      expect(ACTIVITY_TEXT_CLASS[activity]).not.toBe('text-needs-you')
      expect(ACTIVITY_TEXT_CLASS[activity]).not.toBe('text-broken')
    }
  })

  it('lets a rung outrank the activity under it, and only a rung (law 9b)', () => {
    // Full-strength rung colour belongs to alarm marks alone. A looping lane is
    // also, technically, working — and must not be softened into green by it.
    for (const rank of ['notice', 'needs-you', 'broken'] as const satisfies LadderRank[]) {
      for (const activity of activities()) {
        expect(stateTextClass(rank, activity)).toBe(RANK_TEXT_CLASS[rank])
      }
    }
    // Below that the activity speaks, which is what makes the table a legend
    // for the palette and not only for the glyphs (graft g1).
    for (const activity of activities()) {
      expect(stateTextClass('calm', activity)).toBe(ACTIVITY_TEXT_CLASS[activity])
    }
    // `waiting` is in both vocabularies, and that is the whole of ruling 3: one
    // amber family read at two brightnesses, severity told by the rung.
    expect(stateTextClass('needs-you', 'waiting')).toBe('text-needs-you')
    expect(stateTextClass('calm', 'waiting')).toBe('text-waiting-benign')
  })

  it('is decorative without a label and named with one', () => {
    const bare = svgFor('frozen', SIGIL_ROW_SIZE)
    expect(bare.getAttribute('aria-hidden')).toBe('true')
    cleanup()

    const { container } = render(<Sigil kind="frozen" label="FROZEN" />)
    const named = container.querySelector('svg') as SVGSVGElement
    expect(named.getAttribute('role')).toBe('img')
    expect(named.getAttribute('aria-label')).toBe('FROZEN')
  })
})

/** Every activity, read off the class map itself so a new one cannot be missed. */
function activities(): LaneActivity[] {
  return Object.keys(ACTIVITY_TEXT_CLASS) as LaneActivity[]
}

/** Crude unit-space bounding box, read straight off the drawn coordinates. */
function boundsOf(kind: (typeof SIGIL_KINDS)[number]): { width: number; height: number } {
  const svg = svgFor(kind, SIGIL_SCENE_SIZE)
  const xs: number[] = []
  const ys: number[] = []

  for (const node of svg.querySelectorAll('path')) {
    const numbers = (node.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g) ?? []
    numbers.forEach((value, index) => {
      ;(index % 2 === 0 ? xs : ys).push(Number(value))
    })
  }
  for (const node of svg.querySelectorAll('circle')) {
    const cx = Number(node.getAttribute('cx'))
    const cy = Number(node.getAttribute('cy'))
    const r = Number(node.getAttribute('r'))
    xs.push(cx - r, cx + r)
    ys.push(cy - r, cy + r)
  }

  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}
