import { describe, expect, it } from 'vitest'
import { DONE, NECROTIC, WORKING } from '../../scene/palette.js'
import { type ArmInput, GLYPH_HEIGHT_MAX, GLYPH_HEIGHT_MIN, layoutBranching, SYNTHETIC_DASH, strandsOf } from './geometry.js'

const SIZE = { width: 900, height: 260 }

function arm(id: string, state: ArmInput['state']): ArmInput {
  return { id, state }
}

describe('layoutBranching — the trunk and fork point', () => {
  it('runs the trunk from the left margin to a fork point on the vertical centre', () => {
    const { trunk, fork, height } = layoutBranching({ ...SIZE, arms: [] })

    expect(trunk.path.length).toBeGreaterThan(1)
    expect(trunk.path.every((p) => p.y === height / 2)).toBe(true)
    expect(fork.at.y).toBe(height / 2)
    // The trunk's last point is the fork point — no gap between "trunk" and "fork".
    const last = trunk.path[trunk.path.length - 1]
    expect(last).toEqual(fork.at)
  })

  it('places the fork point as a pure function of panel size, whatever the arms are', () => {
    const noArms = layoutBranching({ ...SIZE, arms: [] })
    const threeArms = layoutBranching({
      ...SIZE,
      arms: [arm('a', 'running'), arm('b', 'finished'), arm('c', 'dead')],
    })
    expect(threeArms.fork).toEqual(noArms.fork)
  })

  it('is deterministic: the same input always returns the same geometry', () => {
    const options = { ...SIZE, arms: [arm('a', 'running'), arm('b', 'dead')] }
    expect(layoutBranching(options)).toEqual(layoutBranching(options))
  })
})

describe('a header glyph, not a diagram (prd-55 ruling 11)', () => {
  it('answers with the band’s height whatever the caller asks for — the old diagram’s 36 px per arm shrinks with no change of its own', () => {
    // The caller LabPage still writes: max(120, 36 * arms + 40). Each of these
    // is a height it can produce; none of them survives as a panel.
    for (const asked of [120, 148, 260, 400, 1000]) {
      expect(layoutBranching({ width: 480, height: asked, arms: [arm('a', 'running')] }).height).toBe(GLYPH_HEIGHT_MAX)
    }
    // …and a caller that asks for nothing at all still gets a band, never a rule.
    expect(layoutBranching({ width: 480, height: 0, arms: [] }).height).toBe(GLYPH_HEIGHT_MIN)
    expect(layoutBranching({ width: 480, height: 30, arms: [] }).height).toBe(30)
  })

  it('keeps every strand inside the band, at the crowding a header actually sees', () => {
    for (const count of [1, 2, 3, 6, 12, 48]) {
      const layout = layoutBranching({ ...SIZE, arms: Array.from({ length: count }, (_u, i) => arm(`a${i}`, 'running')) })
      for (const strand of layout.arms) {
        for (const point of strand.path) {
          expect(point.y, `strand ${strand.id} of ${count} leaves the band at y=${point.y}`).toBeGreaterThanOrEqual(0)
          expect(point.y).toBeLessThanOrEqual(layout.height)
          expect(point.x).toBeLessThanOrEqual(layout.width)
        }
      }
    }
  })
})

describe('the glyph draws RUNS, not arms (prd-55 ruling 11)', () => {
  it('an arm carrying a run count becomes one strand per run, named for its run and still owning its arm', () => {
    const layout = layoutBranching({ ...SIZE, arms: [{ id: 'arm-1', state: 'finished', runs: 3 }, { id: 'arm-2', state: 'dead', runs: 2 }] })

    expect(layout.arms.map((strand) => strand.id)).toEqual(['arm-1-run-1', 'arm-1-run-2', 'arm-1-run-3', 'arm-2-run-1', 'arm-2-run-2'])
    expect(layout.arms.map((strand) => strand.arm)).toEqual(['arm-1', 'arm-1', 'arm-1', 'arm-2', 'arm-2'])
    expect(layout.arms.map((strand) => strand.run)).toEqual([1, 2, 3, 1, 2])
    // The count is the RECORD's, not the arms': two arms, five runs, five strands.
    expect(layout.arms).toHaveLength(5)
  })

  it('an arm-shaped caller — no run count — still gets its one strand under the arm’s own id', () => {
    const layout = layoutBranching({ ...SIZE, arms: [arm('arm-1', 'running'), arm('arm-2', 'running')] })
    expect(layout.arms.map((strand) => strand.id)).toEqual(['arm-1', 'arm-2'])
    expect(layout.arms.map((strand) => strand.run)).toEqual([1, 1])
  })

  it('a lone run’s name is its arm’s — an id tells a strand apart from its siblings, and one strand has none', () => {
    const one = layoutBranching({ ...SIZE, arms: [{ id: 'arm-1', state: 'running', runs: 1 }, { id: 'arm-2', state: 'finished', runs: 1 }] })
    expect(one.arms.map((strand) => strand.id)).toEqual(['arm-1', 'arm-2'])
    expect(one.arms.map((strand) => strand.run)).toEqual([1, 1])
    // …and the moment there IS a sibling, every strand of that arm is named for its run.
    const two = layoutBranching({ ...SIZE, arms: [{ id: 'arm-1', state: 'running', runs: 2 }] })
    expect(two.arms.map((strand) => strand.id)).toEqual(['arm-1-run-1', 'arm-1-run-2'])
    // Whatever the count, no two strands ever share an id — it is a React key and a test handle.
    for (const count of [1, 2, 3, 9]) {
      const ids = layoutBranching({ ...SIZE, arms: [{ id: 'a', state: 'running', runs: count }, { id: 'b', state: 'dead', runs: count }] }).arms.map((strand) => strand.id)
      expect(new Set(ids).size, `${count} runs per arm`).toBe(ids.length)
    }
  })

  it('an arm the caller mentions is an arm the glyph draws — no count, however written, erases it', () => {
    expect(strandsOf([{ id: 'a', state: 'running', runs: 0 }]).map((s) => s.id)).toEqual(['a'])
    expect(strandsOf([{ id: 'a', state: 'running', runs: -3 }]).map((s) => s.id)).toEqual(['a'])
    expect(strandsOf([{ id: 'a', state: 'running', runs: 2.7 }]).map((s) => s.id)).toEqual(['a-run-1', 'a-run-2'])
    expect(strandsOf([{ id: 'a', state: 'running', runs: Number.NaN }]).map((s) => s.id)).toEqual(['a'])
    // Floored to one strand, but the arm's own count is not rewritten as one.
    expect(strandsOf([{ id: 'a', state: 'running', runs: 0 }]).map((s) => s.run)).toEqual([1])
  })
})

describe('layoutBranching — N arms diverging', () => {
  it('returns exactly N arms, keeping the caller’s own order', () => {
    const arms = [arm('a', 'running'), arm('b', 'finished'), arm('c', 'dead')]
    const layout = layoutBranching({ ...SIZE, arms })
    expect(layout.arms.map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })

  it('fans arms out symmetrically around the trunk, first arm topmost', () => {
    const arms = [arm('a', 'running'), arm('b', 'running'), arm('c', 'running')]
    const layout = layoutBranching({ ...SIZE, arms })
    const endY = layout.arms.map((a) => a.path[a.path.length - 1]?.y as number)

    // Strictly increasing top-to-bottom, matching input order.
    expect(endY[0]).toBeLessThan(endY[1] as number)
    expect(endY[1]).toBeLessThan(endY[2] as number)
    // Symmetric about the trunk's own y.
    const centreY = layout.height / 2
    expect((endY[0] as number) - centreY).toBeCloseTo(-((endY[2] as number) - centreY), 5)
  })

  it('draws a single arm as a straight continuation of the trunk', () => {
    const layout = layoutBranching({ ...SIZE, arms: [arm('solo', 'finished')] })
    const arm0 = layout.arms[0]
    expect(arm0?.path.every((p) => p.y === layout.height / 2)).toBe(true)
  })

  it('every arm reaches from the fork point out toward the panel edge', () => {
    const arms = [arm('a', 'running')]
    const layout = layoutBranching({ ...SIZE, arms })
    const first = layout.arms[0]?.path[0]
    expect(first).toEqual(layout.fork.at)
  })
})

describe('layoutBranching — dead, distinctly from finished', () => {
  it('gives a dead arm a strictly shorter reach than a finished or running one', () => {
    const layout = layoutBranching({
      ...SIZE,
      arms: [arm('running', 'running'), arm('finished', 'finished'), arm('dead', 'dead')],
    })
    const reachOf = (id: string): number => {
      const found = layout.arms.find((a) => a.id === id)
      const path = found?.path ?? []
      return path[path.length - 1]?.x as number
    }

    const deadReach = reachOf('dead')
    const finishedReach = reachOf('finished')
    const runningReach = reachOf('running')

    expect(deadReach).toBeLessThan(finishedReach)
    expect(deadReach).toBeLessThan(runningReach)
    // Living and finished arms both run all the way to the panel edge.
    expect(finishedReach).toBe(runningReach)
  })

  it('gives dead and finished arms different ink — never the same colour as each other or as running', () => {
    const layout = layoutBranching({
      ...SIZE,
      arms: [arm('running', 'running'), arm('finished', 'finished'), arm('dead', 'dead')],
    })
    const inkOf = (id: string) => layout.arms.find((a) => a.id === id)?.ink.rgb

    expect(inkOf('dead')).toEqual(NECROTIC)
    expect(inkOf('finished')).toEqual(DONE)
    expect(inkOf('running')).toEqual(WORKING)
    expect(inkOf('dead')).not.toEqual(inkOf('finished'))
  })

  it('gives dead and finished arms different terminal shapes — death and completion never share a form', () => {
    const layout = layoutBranching({
      ...SIZE,
      arms: [arm('running', 'running'), arm('finished', 'finished'), arm('dead', 'dead')],
    })
    const terminalOf = (id: string) => layout.arms.find((a) => a.id === id)?.terminal

    expect(terminalOf('dead')).toBe('stub')
    expect(terminalOf('finished')).toBe('seal')
    expect(terminalOf('running')).toBe('arrow')
    expect(terminalOf('dead')).not.toBe(terminalOf('finished'))
  })
})

describe('layoutBranching — forks render as visibly synthetic (prd12 ruling 3)', () => {
  it('marks every arm, whatever its state, with the same synthetic dash', () => {
    const layout = layoutBranching({
      ...SIZE,
      arms: [arm('a', 'running'), arm('b', 'finished'), arm('c', 'dead')],
    })
    for (const a of layout.arms) expect(a.dash).toEqual(SYNTHETIC_DASH)
  })

  it('never dashes the trunk — the trunk is the observed history, not a fork', () => {
    const layout = layoutBranching({ ...SIZE, arms: [arm('a', 'running')] })
    expect('dash' in layout.trunk).toBe(false)
  })
})
