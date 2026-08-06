import { describe, expect, it } from 'vitest'
import { labCheckpointHelpText, parseLabCheckpointArgs } from './lab-checkpoint.js'

describe('parseLabCheckpointArgs', () => {
  const labDefaults = { lane: 'my-lane', path: undefined, capturedBy: 'operator', help: false }

  it('takes the lane as the first positional, defaulting path and capturedBy', () => {
    expect(parseLabCheckpointArgs(['my-lane'])).toEqual(labDefaults)
  })

  it('parses --path', () => {
    expect(parseLabCheckpointArgs(['my-lane', '--path', '../some-repo'])).toEqual({
      ...labDefaults,
      path: '../some-repo',
    })
  })

  it('parses --captured-by', () => {
    expect(parseLabCheckpointArgs(['my-lane', '--captured-by', 'gate'])).toEqual({
      ...labDefaults,
      capturedBy: 'gate',
    })
    expect(parseLabCheckpointArgs(['my-lane', '--captured-by', 'dispatch'])).toEqual({
      ...labDefaults,
      capturedBy: 'dispatch',
    })
  })

  it('parses --captured-by=<value>', () => {
    expect(parseLabCheckpointArgs(['my-lane', '--captured-by=gate'])).toEqual({
      ...labDefaults,
      capturedBy: 'gate',
    })
  })

  it('throws on an invalid --captured-by', () => {
    expect(() => parseLabCheckpointArgs(['my-lane', '--captured-by', 'human'])).toThrow(/invalid --captured-by/)
  })

  it('throws when the lane is missing', () => {
    expect(() => parseLabCheckpointArgs([])).toThrow(/missing required argument.*<lane>/is)
  })

  it('throws on an unrecognised flag, naming it', () => {
    expect(() => parseLabCheckpointArgs(['my-lane', '--foo'])).toThrow(/unknown option.*"--foo"/is)
  })

  it('parses --help without requiring a lane', () => {
    expect(parseLabCheckpointArgs(['--help']).help).toBe(true)
    expect(parseLabCheckpointArgs(['-h']).help).toBe(true)
  })
})

describe('labCheckpointHelpText', () => {
  it('labCheckpointHelpText documents the lane argument, --path, --captured-by and --help', () => {
    const text = labCheckpointHelpText()
    expect(text).toContain('rhizomorph lab checkpoint <lane>')
    expect(text).toContain('--path')
    expect(text).toContain('--captured-by')
    expect(text).toContain('--help')
  })
})
