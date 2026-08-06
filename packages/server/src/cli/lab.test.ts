import { describe, expect, it } from 'vitest'
import { labHelpText } from './lab.js'

describe('labHelpText', () => {
  it('labHelpText documents every subcommand the namespace has', () => {
    const text = labHelpText()
    expect(text).toContain('checkpoint <lane>')
    expect(text).toContain('fork <lane>')
    expect(text).toContain('compare <fork-id>')
  })
})
