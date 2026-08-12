import { describe, expect, it } from 'vitest'
import { voiceSkips } from './parse-skip.js'

describe('voiceSkips', () => {
  it('renders nothing for an empty list', () => {
    expect(voiceSkips([])).toBe('')
  })

  it('renders every skip with no suffix when under the limit', () => {
    const skipped = [
      { line: 'a', reason: 'bad a' },
      { line: 'b', reason: 'bad b' },
    ]
    expect(voiceSkips(skipped)).toBe('bad a: a; bad b: b')
  })

  it('renders exactly four skips with no suffix', () => {
    const skipped = [
      { line: 'a', reason: 'r1' },
      { line: 'b', reason: 'r2' },
      { line: 'c', reason: 'r3' },
      { line: 'd', reason: 'r4' },
    ]
    expect(voiceSkips(skipped)).toBe('r1: a; r2: b; r3: c; r4: d')
  })

  it('caps at four and appends a +N more suffix beyond the limit', () => {
    const skipped = [
      { line: 'a', reason: 'r1' },
      { line: 'b', reason: 'r2' },
      { line: 'c', reason: 'r3' },
      { line: 'd', reason: 'r4' },
      { line: 'e', reason: 'r5' },
      { line: 'f', reason: 'r6' },
    ]
    expect(voiceSkips(skipped)).toBe('r1: a; r2: b; r3: c; r4: d (+2 more)')
  })
})
