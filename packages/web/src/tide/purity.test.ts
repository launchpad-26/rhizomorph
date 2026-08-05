import { describe, expect, it } from 'vitest'

/**
 * PURITY IS THE POINT (#167's definition of done): zero rendering, zero DOM,
 * zero React. The TIDE's contract is computed here and drawn three waves later,
 * and the moment this module can reach a node it stops being testable without
 * one. Stated as a law rather than as a review note, because a review note is
 * something a hurried later wave can talk itself past.
 */

const SOURCES = import.meta.glob('./*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const FORBIDDEN: readonly [RegExp, string][] = [
  [/from ['"]react/, 'React'],
  [/from ['"]react-dom/, 'React DOM'],
  [/from ['"]@testing-library/, 'a rendering harness'],
  [/\bdocument\./, 'the DOM'],
  [/\bwindow\./, 'the window'],
  [/\bDate\.now\(/, 'the clock'],
  [/\bnew Date\(/, 'the clock'],
  [/\bMath\.random\(/, 'an unseeded random'],
]

describe('the tide module is pure', () => {
  const names = Object.keys(SOURCES).sort()

  it('has every source in the directory to check', () => {
    expect(names).toContain('./bands.ts')
    expect(names).toContain('./coalesce.ts')
    expect(names).toContain('./rowPlan.ts')
    expect(names).toContain('./index.ts')
    expect(names).toContain('./chapters.ts')
    expect(names).toContain('./markCoalesce.ts')
  })

  for (const name of names) {
    it(`${name} reaches for no view, no DOM and no clock`, () => {
      const source = SOURCES[name] as string
      for (const [pattern, what] of FORBIDDEN) {
        expect(pattern.test(source), `${name} reaches for ${what}`).toBe(false)
      }
    })
  }
})
