import { describe, expect, it } from 'vitest'
import { parseArgs } from './args.js'

describe('parseArgs', () => {
  it('defaults to no path and port 4321', () => {
    expect(parseArgs([])).toEqual({ path: undefined, port: 4321 })
  })

  it('takes the first non-flag token as the path', () => {
    expect(parseArgs(['../some-repo'])).toEqual({ path: '../some-repo', port: 4321 })
  })

  it('parses --port as a separate token', () => {
    expect(parseArgs(['../repo', '--port', '5000'])).toEqual({ path: '../repo', port: 5000 })
  })

  it('parses --port=n', () => {
    expect(parseArgs(['--port=5000', '../repo'])).toEqual({ path: '../repo', port: 5000 })
  })

  it('throws on a non-numeric port', () => {
    expect(() => parseArgs(['--port', 'nope'])).toThrow(/invalid --port/)
  })

  it('accepts port 0 (let the OS pick a free port)', () => {
    expect(parseArgs(['--port', '0'])).toEqual({ path: undefined, port: 0 })
  })

  it('throws on a negative port', () => {
    expect(() => parseArgs(['--port', '-1'])).toThrow(/invalid --port/)
  })
})
