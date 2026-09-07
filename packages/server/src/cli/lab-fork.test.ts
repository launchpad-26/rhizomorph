import { describe, expect, it } from 'vitest'
import { labForkHelpText, parseLabForkArgs } from './lab-fork.js'

describe('parseLabForkArgs', () => {
  const forkDefaults = {
    lane: 'my-lane',
    at: undefined,
    model: undefined,
    promptFile: undefined,
    arms: 3,
    runs: 1,
    forkId: undefined,
    armNumber: undefined,
    ceilingOverride: undefined,
    path: undefined,
    launch: false,
    help: false,
  }

  it("defaults to three arms — prd12 ruling 4's floor — one run of each, no override, and no launch", () => {
    expect(parseLabForkArgs(['my-lane'])).toEqual(forkDefaults)
  })

  it('parses --at, --model, --prompt-file, --arms and --path', () => {
    expect(
      parseLabForkArgs(['my-lane', '--at', 'ckpt-1', '--model', 'opus', '--prompt-file', './p.md', '--arms', '5', '--path', '../repo']),
    ).toEqual({
      ...forkDefaults,
      at: 'ckpt-1',
      model: 'opus',
      promptFile: './p.md',
      arms: 5,
      path: '../repo',
    })
  })

  it('parses --runs, --fork-id and --arm-number (prd53 ruling 1)', () => {
    expect(parseLabForkArgs(['my-lane', '--arms', '1', '--runs', '3', '--fork-id', 'fork-x', '--arm-number', '2'])).toEqual({
      ...forkDefaults,
      arms: 1,
      runs: 3,
      forkId: 'fork-x',
      armNumber: 2,
    })
  })

  it('parses --ceiling-override as a declared number of spending lanes, and refuses a zero or fractional one (prd53 ruling 6)', () => {
    expect(parseLabForkArgs(['my-lane', '--ceiling-override', '12'])).toEqual({ ...forkDefaults, ceilingOverride: 12 })
    expect(() => parseLabForkArgs(['my-lane', '--ceiling-override', '0'])).toThrow(/invalid --ceiling-override/)
    expect(() => parseLabForkArgs(['my-lane', '--ceiling-override', '2.5'])).toThrow(/invalid --ceiling-override/)
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

  it('throws on a zero, negative or non-integer run count, and on an empty --fork-id', () => {
    expect(() => parseLabForkArgs(['my-lane', '--runs', '0'])).toThrow(/invalid --runs/)
    expect(() => parseLabForkArgs(['my-lane', '--runs', '-2'])).toThrow(/invalid --runs/)
    expect(() => parseLabForkArgs(['my-lane', '--runs', '1.5'])).toThrow(/invalid --runs/)
    expect(() => parseLabForkArgs(['my-lane', '--fork-id', ''])).toThrow(/invalid --fork-id/)
  })

  it('refuses --arm-number unless exactly one arm is being dispatched — the number names THIS arm', () => {
    expect(() => parseLabForkArgs(['my-lane', '--arm-number', '2'])).toThrow(/--arm-number requires --arms 1/)
    expect(() => parseLabForkArgs(['my-lane', '--arms', '2', '--arm-number', '2'])).toThrow(/--arm-number requires --arms 1/)
    expect(() => parseLabForkArgs(['my-lane', '--arms', '1', '--arm-number', '0'])).toThrow(/invalid --arm-number/)
    expect(parseLabForkArgs(['my-lane', '--arms', '1', '--arm-number', '4']).armNumber).toBe(4)
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
  it('labForkHelpText documents the treatment flags, the arm default, the run flags, the ceiling override and why --launch is opt-in', () => {
    const text = labForkHelpText()
    expect(text).toContain('rhizomorph lab fork <lane>')
    expect(text).toContain('--at <checkpointId>')
    expect(text).toContain('--model')
    expect(text).toContain('--prompt-file')
    expect(text).toContain('--arms <n>')
    expect(text).toContain('default: 3')
    expect(text).toContain('--runs <r>')
    expect(text).toContain('--fork-id <id>')
    expect(text).toContain('--arm-number <k>')
    expect(text).toContain('--ceiling-override <n>')
    expect(text).toContain('--launch')
    expect(text).toContain('ruling 1')
  })
})
