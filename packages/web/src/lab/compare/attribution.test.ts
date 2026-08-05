import { describe, expect, it } from 'vitest'
import { classifyClaim, differingDimensions, formatDimensionList } from './attribution.js'
import type { Arm } from './types.js'

function arm(id: string, model: string, brief: string): Arm {
  return { id, model, brief, runs: [] }
}

describe('differingDimensions', () => {
  it('is computed from the arms themselves, not a declared intent', () => {
    const arms = [arm('a', 'opus', 'brief-x'), arm('b', 'opus', 'brief-x')]
    expect(differingDimensions(arms)).toEqual([])
  })

  it('finds model alone', () => {
    const arms = [arm('a', 'opus', 'brief-x'), arm('b', 'sonnet', 'brief-x')]
    expect(differingDimensions(arms)).toEqual(['model'])
  })

  it('finds brief alone', () => {
    const arms = [arm('a', 'opus', 'brief-x'), arm('b', 'opus', 'brief-y')]
    expect(differingDimensions(arms)).toEqual(['brief'])
  })

  it('finds both when both differ', () => {
    const arms = [arm('a', 'opus', 'brief-x'), arm('b', 'sonnet', 'brief-y')]
    expect(differingDimensions(arms)).toEqual(['model', 'brief'])
  })
})

describe('formatDimensionList', () => {
  it('formats a single dimension', () => {
    expect(formatDimensionList(['model'])).toBe('model')
  })

  it('formats two dimensions with "and"', () => {
    expect(formatDimensionList(['model', 'brief'])).toBe('model and brief')
  })
})

describe('classifyClaim', () => {
  it('a single arm has nothing to compare against', () => {
    expect(classifyClaim([arm('a', 'opus', 'brief-x')])).toEqual({ kind: 'single-arm' })
  })

  it('identically configured arms are replicates, not a comparison', () => {
    const arms = [arm('a', 'opus', 'brief-x'), arm('b', 'opus', 'brief-x')]
    expect(classifyClaim(arms)).toEqual({ kind: 'uniform' })
  })

  it('arms differing in exactly one dimension compare properly', () => {
    const arms = [arm('a', 'opus', 'brief-x'), arm('c', 'sonnet', 'brief-x')]
    expect(classifyClaim(arms)).toEqual({ kind: 'comparable', dimension: 'model' })
  })

  it('arms differing in more than one dimension produce NO comparative claim, not merely a caveat', () => {
    const arms = [arm('a', 'opus', 'brief-x'), arm('b', 'sonnet', 'brief-y')]
    const claim = classifyClaim(arms)

    expect(claim.kind).toBe('confounded')
    // The absence is structural: a confounded claim carries no `dimension` field to compare on.
    expect('dimension' in claim).toBe(false)
    expect(claim).toEqual({
      kind: 'confounded',
      dimensions: ['model', 'brief'],
      reason: 'these arms differ in model and brief, so a difference cannot be attributed to either.',
    })
  })

  it('three-plus arms still classify confounded when more than one dimension varies anywhere', () => {
    const arms = [arm('a', 'opus', 'brief-x'), arm('b', 'opus', 'brief-x'), arm('c', 'sonnet', 'brief-y')]
    expect(classifyClaim(arms).kind).toBe('confounded')
  })
})
