import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBeaconLine } from './parse-beacon-line.js'

const FIXTURE = readFileSync(path.join(import.meta.dirname, 'fixtures', 'claude-hook.jsonl'), 'utf8')
const FIXTURE_LINES = FIXTURE.split('\n').filter(Boolean)
const atOf = (line: string): number => (JSON.parse(line) as { at: number }).at
// The capture's first `waiting` line — Notification is the only hook the
// table (packages/server/src/cli/env.ts) maps to `waiting`.
const FULL = FIXTURE_LINES.find((line) => line.includes('"kind":"waiting"'))
if (FULL === undefined) throw new Error('fixture has no waiting line')

// The hand-written fixture's lines 2 and 3 before #282 replaced it with a
// capture — kept verbatim so the two contract cases they proved (an extra
// key is digested but not carried; an absent lane reads back as null) still
// have coverage now that the emitter never writes either shape itself.
const EXTRA = '{"v":1,"at":1725000001000,"writer":"claude-hook","kind":"working","lane":"2-core","extra":"ignored but digested"}'
const BARE = '{"v":1,"at":1725000002000,"writer":"claude-hook","kind":"stopped"}'

describe('parseBeaconLine — the v1 line contract (ADR-0036)', () => {
  it('parses a full line, keeping the writer clock and the short detail', () => {
    expect(parseBeaconLine(FULL)).toEqual({
      kind: 'beacon',
      at: atOf(FULL),
      payload: { writer: 'claude-hook', kind: 'waiting', lane: '2-core', detail: 'hook: Notification' },
    })
  })

  it('ignores extra keys — the digest covers them, the payload does not carry them', () => {
    const parsed = parseBeaconLine(EXTRA)
    expect(parsed).toEqual({
      kind: 'beacon',
      at: 1_725_000_001_000,
      payload: { writer: 'claude-hook', kind: 'working', lane: '2-core' },
    })
    expect(parsed).not.toHaveProperty('payload.extra')
  })

  it('reads an absent lane as null and an absent detail as absent', () => {
    expect(parseBeaconLine(BARE)).toEqual({
      kind: 'beacon',
      at: 1_725_000_002_000,
      payload: { writer: 'claude-hook', kind: 'stopped', lane: null },
    })
    expect(parseBeaconLine(BARE)).not.toHaveProperty('payload.detail')
  })

  it('carries any kind — the vocabulary belongs to #218 and #219, not to the door', () => {
    const parsed = parseBeaconLine('{"v":1,"at":7,"writer":"gate","kind":"landed-on-a-tuesday"}')
    expect(parsed.kind).toBe('beacon')
    expect(parsed).toMatchObject({ payload: { kind: 'landed-on-a-tuesday' } })
  })

  it.each<[label: string, line: string, reason: string]>([
    ['not JSON', 'not json', 'beacon line is not valid JSON'],
    ['a blank line', '', 'beacon line is not valid JSON'],
    ['an array', '[1]', 'beacon line is not a JSON object'],
    ['null', 'null', 'beacon line is not a JSON object'],
    ['a version we do not speak', '{"v":2,"at":1,"writer":"hook","kind":"waiting"}', 'unsupported beacon version: 2'],
    ['no version at all', '{"at":1,"writer":"hook","kind":"waiting"}', 'unsupported beacon version: undefined'],
    ['a string timestamp', '{"v":1,"at":"soon","writer":"hook","kind":"waiting"}', 'beacon has no usable "at" timestamp'],
    ['a negative timestamp', '{"v":1,"at":-1,"writer":"hook","kind":"waiting"}', 'beacon has no usable "at" timestamp'],
    ['a fractional timestamp', '{"v":1,"at":1.5,"writer":"hook","kind":"waiting"}', 'beacon has no usable "at" timestamp'],
    ['an empty writer', '{"v":1,"at":1,"writer":"","kind":"waiting"}', 'beacon "writer" is missing or too long'],
    ['a missing kind', '{"v":1,"at":1,"writer":"hook"}', 'beacon "kind" is missing or too long'],
    ['a 65-char kind', `{"v":1,"at":1,"writer":"hook","kind":"${'k'.repeat(65)}"}`, 'beacon "kind" is missing or too long'],
    ['an empty lane', '{"v":1,"at":1,"writer":"hook","kind":"waiting","lane":""}', 'beacon "lane" is empty or too long'],
    ['a 257-char lane', `{"v":1,"at":1,"writer":"hook","kind":"waiting","lane":"${'l'.repeat(257)}"}`, 'beacon "lane" is empty or too long'],
    ['a numeric detail', '{"v":1,"at":1,"writer":"hook","kind":"waiting","detail":5}', 'beacon "detail" is not a short string'],
    ['a 513-char detail', `{"v":1,"at":1,"writer":"hook","kind":"waiting","detail":"${'d'.repeat(513)}"}`, 'beacon "detail" is not a short string'],
  ])('refuses %s by name', (_label, line, reason) => {
    expect(parseBeaconLine(line)).toEqual({ kind: 'malformed', reason })
  })

  it('sits exactly on the caps: 64-char names, a 256-char lane and a 512-char detail are accepted', () => {
    const line = `{"v":1,"at":0,"writer":"${'w'.repeat(64)}","kind":"${'k'.repeat(64)}","lane":"${'l'.repeat(256)}","detail":"${'d'.repeat(512)}"}`
    expect(parseBeaconLine(line).kind).toBe('beacon')
  })

  it('is pure — the same line parses to the same result every time', () => {
    const results = [FULL, FULL, FULL].map(parseBeaconLine)
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
  })

  it('every captured line parses, and no two lines share a digest', () => {
    for (const line of FIXTURE_LINES) {
      expect(parseBeaconLine(line).kind).toBe('beacon')
    }
    // Identical bytes would mean identical at/kind/detail, which two
    // consecutive hooks cannot produce — the cheap form of "no duplicates".
    expect(new Set(FIXTURE_LINES).size).toBe(FIXTURE_LINES.length)
  })
})
