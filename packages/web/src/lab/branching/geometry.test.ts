import { describe, expect, it } from 'vitest'
import { DONE, NECROTIC, WORKING } from '../../scene/palette.js'
import { layoutBranching, SYNTHETIC_DASH, type ArmInput } from './geometry.js'

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
