import { describe, expect, it } from 'vitest'
import { labForkHelpText, parseLabForkArgs } from './lab-fork.js'

describe('parseLabForkArgs', () => {
  const forkDefaults = {
    lane: 'my-lane',
    at: undefined,
    model: undefined,
    promptFile: undefined,
    arms: 3,
    path: undefined,
    launch: false,
    help: false,
  }

  it('defaults to three arms — prd12 ruling 4\'s floor — and no launch', () => {
    expect(parseLabForkArgs(['my-lane'])).toEqual(forkDefaults)
  })

  it('parses --at, --model, --prompt-file, --arms and --path', () => {
    expect(
      parseLabForkArgs([
        'my-lane', '--at', 'ckpt-1', '--model', 'opus',
        '--prompt-file', './p.md', '--arms', '5', '--path', '../repo',
      ]),
    ).toEqual({
      ...forkDefaults,
      at: 'ckpt-1',
      model: 'opus',
      promptFile: './p.md',
      arms: 5,
      path: '../repo',
    })
  })

  it('parses the =value spelling too', () => {
    expect(parseLabForkArgs(['my-lane', '--arms=2', '--model=sonnet'])).toEqual({
      ...forkDefaults,
      arms: 2,
      model: 'sonnet',
    })
  })

  it('parses --launch as a valueless switch that does not swallow the next token', () => {
    expect(parseLabForkArgs(['--launch', 'my-lane'])).toEqual({ ...forkDefaults, launch: true })
    expect(() => parseLabForkArgs(['my-lane', '--launch=yes'])).toThrow(/takes no value/)
  })

  it('throws on a zero, negative or non-integer arm count', () => {
    expect(() => parseLabForkArgs(['my-lane', '--arms', '0'])).toThrow(/invalid --arms/)
    expect(() => parseLabForkArgs(['my-lane', '--arms', '-1'])).toThrow(/invalid --arms/)
    expect(() => parseLabForkArgs(['my-lane', '--arms', '2.5'])).toThrow(/invalid --arms/)
    expect(() => parseLabForkArgs(['my-lane', '--arms', 'three'])).toThrow(/invalid --arms/)
  })

  it('throws on empty --at, --model or --prompt-file values', () => {
    expect(() => parseLabForkArgs(['my-lane', '--at', ''])).toThrow(/invalid --at/)
    expect(() => parseLabForkArgs(['my-lane', '--model', ''])).toThrow(/invalid --model/)
    expect(() => parseLabForkArgs(['my-lane', '--prompt-file', ''])).toThrow(/invalid --prompt-file/)
  })

  it('throws when the lane is missing, and on an unrecognised flag', () => {
    expect(() => parseLabForkArgs([])).toThrow(/missing required argument.*<lane>/is)
    expect(() => parseLabForkArgs(['my-lane', '--foo'])).toThrow(/unknown option.*"--foo"/is)
  })

  it('parses --help without requiring a lane', () => {
    expect(parseLabForkArgs(['--help']).help).toBe(true)
    expect(parseLabForkArgs(['-h']).help).toBe(true)
  })
})

describe('labForkHelpText', () => {
  it('labForkHelpText documents the treatment flags, the arm default and why --launch is opt-in', () => {
    const text = labForkHelpText()
    expect(text).toContain('rhizomorph lab fork <lane>')
    expect(text).toContain('--at <checkpointId>')
    expect(text).toContain('--model')
    expect(text).toContain('--prompt-file')
    expect(text).toContain('--arms <n>')
    expect(text).toContain('default: 3')
    expect(text).toContain('--launch')
    expect(text).toContain('ruling 1')
  })
})
