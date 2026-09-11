import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FOLD_CURSOR_VERSION, lowWaterMark, readCursor, writeCursor } from './cursor.js'

/**
 * THE FOLD CURSOR, AS A UNIT (prd-51 rulings 4 and 16).
 *
 * `worker.test.ts` exercises the cursor end to end — that a fold self-repairs a garbage file,
 * that F9's death between write and rename leaves the old value. These are the same module's
 * questions asked directly, which is where the format's edges are cheap to state: the bare
 * number a pre-ruling-16 deployment left on disk, a version this build has never seen, and the
 * low-water mark itself.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rz-cursor-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function cursorPath(): string {
  return path.join(dir, 'fold.cursor')
}

describe('the v1 shape round-trips', () => {
  it('a cursor with two actors reads back deep-equal', () => {
    const cursor = { seq: 4, actors: { 'p lane-a': 4, 'p lane-b': 9 } }
    writeCursor(cursorPath(), cursor)
    expect(readCursor(cursorPath())).toEqual(cursor)
  })

  it('the file on disk carries the version, so a later build can refuse it', () => {
    writeCursor(cursorPath(), { seq: 1, actors: { 'p a': 1 } })
    expect(JSON.parse(readFileSync(cursorPath(), 'utf8'))).toEqual({
      version: FOLD_CURSOR_VERSION,
      seq: 1,
      actors: { 'p a': 1 },
    })
  })
})

describe('the formats a cursor file can hold', () => {
  it('A BARE NUMBER — what this module wrote before ruling 16 — reads as that seq', () => {
    // Any deployment that has already folded has one of these on disk. Reading it as garbage
    // would be SAFE (rows dedup on replay) and needlessly slow, and silently so: the operator
    // would see a full re-read after an upgrade with nothing saying why.
    writeFileSync(cursorPath(), '12\n')
    expect(readCursor(cursorPath())).toEqual({ seq: 12, actors: {} })
  })

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['-1', 'negative'],
    ['abc', 'not a number'],
    ['{"version":1,"seq":1', 'truncated JSON'],
    ['[1,2,3]', 'an array'],
    ['{"version":1,"actors":{}}', 'no seq'],
    ['{"version":1,"seq":-1,"actors":{}}', 'a negative seq'],
    ['{"version":1,"seq":1,"actors":[]}', 'a non-object actors'],
  ])('%j (%s) cold-starts rather than throwing', (text) => {
    writeFileSync(cursorPath(), text)
    expect(readCursor(cursorPath())).toEqual({ seq: 0, actors: {} })
  })

  it('a version this build has never seen cold-starts rather than being misread', () => {
    writeFileSync(cursorPath(), JSON.stringify({ version: 2, seq: 99, actors: { 'p a': 99 } }))
    expect(readCursor(cursorPath())).toEqual({ seq: 0, actors: {} })
  })

  it('a missing file cold-starts', () => {
    expect(existsSync(cursorPath())).toBe(false)
    expect(readCursor(cursorPath())).toEqual({ seq: 0, actors: {} })
  })

  it('one bad per-actor value is dropped without invalidating the file', () => {
    writeFileSync(
      cursorPath(),
      JSON.stringify({ version: 1, seq: 3, actors: { 'p a': 3, 'p b': -2, 'p c': 'nope', 'p d': 7 } }),
    )
    expect(readCursor(cursorPath())).toEqual({ seq: 3, actors: { 'p a': 3, 'p d': 7 } })
  })
})

describe('the low-water mark', () => {
  it('is the MINIMUM over the actors, which is what makes a stuck actor safe', () => {
    // The maximum would advance the journal past a stuck actor's records and never read them
    // again — the data loss this cursor shape exists to prevent.
    expect(lowWaterMark({ 'p a': 5, 'p b': 20, 'p c': 12 })).toBe(5)
  })

  it('is 0 when nothing is known, which is a cold start by another name', () => {
    expect(lowWaterMark({})).toBe(0)
  })
})

describe('tmp-then-rename survives a death between the two', () => {
  it('a death before the rename leaves the OLD cursor and no tmp file behind', () => {
    writeCursor(cursorPath(), { seq: 1, actors: { 'p a': 1 } })
    const dies = (): never => {
      throw new Error('process died')
    }

    expect(() =>
      writeCursor(cursorPath(), { seq: 2, actors: { 'p a': 2 } }, { afterCursorWriteBeforeRename: dies }),
    ).toThrow('process died')

    expect(readCursor(cursorPath())).toEqual({ seq: 1, actors: { 'p a': 1 } })
    expect(existsSync(`${cursorPath()}.tmp`)).toBe(false)
  })
})
