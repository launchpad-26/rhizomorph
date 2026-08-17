import { describe, expect, it } from 'vitest'
import { diagnose, NAMED_TRESPASSES, type DiagnoseContext } from './diagnose.js'
import type { Trespass } from './fences.js'
import type { Lane } from './types.js'

/**
 * OFF-FENCE'S EVIDENCE IS BOUNDED AT THE SOURCE (walkthrough, 2026-08-17).
 *
 * A human walked the running instrument and found the attention strip
 * truncating a trespass path mid-word. The cause was not the view: this
 * detector joined **every** trespass path with ` · ` into one unbounded string,
 * and the 18rem chip that rendered it was doing the only thing it could with a
 * sentence thousands of characters long.
 *
 * The clause is `Pathology.evidence` and five surfaces read it — the attention
 * chip, the fleet table's STATE title, the peek's evidence line,
 * `selectLaneCondition`, and the run view's outcome. Clipping it in the view
 * would have fixed the one surface with the narrowest box and left the other
 * four rendering a sentence nobody can finish.
 *
 * Every assertion below is written against **forty** trespasses, because one is
 * the case the original author considered and forty is the case that broke.
 */

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0)

function ctx(): DiagnoseContext {
  return {
    now: NOW,
    medianOutputPerMin: 100,
    expensiveThreshold: Number.POSITIVE_INFINITY,
    paneActivityTs: null,
    agentStatusTs: null,
    commitTs: null,
  }
}

/** A lane with nothing wrong with it but its fence, so off-fence is the only pathology returned. */
function laneWith(trespasses: Trespass[]): Lane {
  return {
    id: '600-offender',
    fenced: true,
    trespasses,
    // Everything else quiet enough that no other detector fires: recent work,
    // no repeating tool cycle, no waiting declaration, no burn outlier.
    lastEventTs: NOW - 1_000,
    workAgeMs: 1_000,
    ageMs: 60_000,
    recentTools: [],
    outputPerMin: 1,
    activity: 'working',
    present: true,
    parked: false,
    pathologies: [],
  } as unknown as Lane
}

function trespasses(count: number): Trespass[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `packages/web/src/panels/attention/very/long/path/number-${i}.tsx`,
    victim: `61${i}-other-lane`,
  }))
}

function offFenceEvidence(lane: Lane): string {
  const found = diagnose(lane, ctx()).find((pathology) => pathology.kind === 'off-fence')
  expect(found, 'off-fence did not fire on a fenced lane with trespasses').toBeDefined()
  return found?.evidence ?? ''
}

describe('off-fence names a bounded number of paths and counts the rest', () => {
  it('is short enough to read in a chip at forty trespasses', () => {
    const forty = offFenceEvidence(laneWith(trespasses(40)))

    // THE MUTATION THIS EXISTS FOR, as arithmetic. The unbounded join produced
    // 40 × ~70 characters; this bound is far below that and far above one path,
    // so it fails in both directions — a regression to the join, and an
    // over-eager truncation that stopped naming a path at all.
    expect(forty.length).toBeLessThan(160)
    expect(forty.length).toBeGreaterThan(40)
  })

  it('names the count, names the first path in full, and says how many more', () => {
    const forty = offFenceEvidence(laneWith(trespasses(40)))

    expect(forty).toContain('40 files outside fence')
    // The first path is WHOLE — truncating it mid-word is exactly the bug.
    expect(forty).toContain('packages/web/src/panels/attention/very/long/path/number-0.tsx → 610-other-lane')
    expect(forty).toContain(`+${40 - NAMED_TRESPASSES} more`)
    // …and no other path leaked in.
    expect(forty).not.toContain('number-1.tsx')
    expect(forty).not.toContain('number-39.tsx')
  })

  it('does not count at one — a lone breach reads as the path it is', () => {
    // "1 file outside fence — <path>" beside the one path it names reads as an
    // instrument that cannot count. This is also the shape `buildFleet.test.ts`
    // has pinned since #226, so the single case is unchanged by the bound.
    const one = offFenceEvidence(
      laneWith([{ path: 'packages/core/src/selectors/spend-subrows.ts', victim: '46-spend-selectors' }]),
    )
    expect(one).toBe('outside fence — packages/core/src/selectors/spend-subrows.ts → 46-spend-selectors')
    expect(one).not.toContain('more')
  })

  it('counts from two, and the count is the total rather than the remainder', () => {
    // The off-by-one a "+N more" implementation invites: N is what is hidden,
    // and the headline is what exists. Two paths, one named, one hidden.
    const two = offFenceEvidence(laneWith(trespasses(2)))
    expect(two).toContain('2 files outside fence')
    expect(two).toContain('+1 more')
  })

  it('names an unclaimed path without inventing a victim', () => {
    const orphan = offFenceEvidence(laneWith([{ path: 'docs/adr/README.md', victim: null }]))
    expect(orphan).toBe('outside fence — docs/adr/README.md')
    expect(orphan).not.toContain('→')
  })

  it('does not fire at all on an unfenced lane, or on a fenced lane inside its fence', () => {
    // Without this the assertions above would be equally green against a
    // detector that fired on everything.
    const unfenced = { ...laneWith(trespasses(3)), fenced: false } as Lane
    expect(diagnose(unfenced, ctx()).some((p) => p.kind === 'off-fence')).toBe(false)
    expect(diagnose(laneWith([]), ctx()).some((p) => p.kind === 'off-fence')).toBe(false)
  })
})
