import { describe, expect, it } from 'vitest'
import { parseReplayArgs, replayHelpText } from './replay.js'

describe('parseReplayArgs', () => {
  it('takes the first positional as the record file', () => {
    expect(parseReplayArgs(['./out.rhizorecord.json'])).toEqual({
      file: './out.rhizorecord.json',
      port: 4321,
      help: false,
    })
  })

  it('parses --port', () => {
    expect(parseReplayArgs(['./out.rhizorecord.json', '--port', '5000'])).toEqual({
      file: './out.rhizorecord.json',
      port: 5000,
      help: false,
    })
  })

  it('throws when the record file is missing', () => {
    expect(() => parseReplayArgs([])).toThrow(/missing required argument.*<record-file>/is)
  })

  it('throws on a non-numeric --port', () => {
    expect(() => parseReplayArgs(['./out.rhizorecord.json', '--port', 'nope'])).toThrow(/invalid --port/)
  })

  it('parses --help without requiring a file', () => {
    expect(parseReplayArgs(['--help']).help).toBe(true)
    expect(parseReplayArgs(['-h']).help).toBe(true)
  })
})

describe('replayHelpText', () => {
  it('documents the record-file argument, --port and --help', () => {
    const text = replayHelpText()
    expect(text).toContain('rhizomorph replay <record-file>')
    expect(text).toContain('--port')
    expect(text).toContain('--help')
  })
})
