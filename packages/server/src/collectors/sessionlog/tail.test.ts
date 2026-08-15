import { mkdtemp, rename, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readNewLines } from './tail.js'

describe('readNewLines', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sessionlog-tail-'))
    filePath = path.join(dir, 'session.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads every complete line from offset 0 on first read', async () => {
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8')

    const result = await readNewLines(filePath, 0)

    expect(result.lines).toEqual(['one', 'two', 'three'])
    expect(result.nextOffset).toBe(Buffer.byteLength('one\ntwo\nthree\n'))
  })

  it('only returns lines appended since the given offset', async () => {
    await writeFile(filePath, 'one\ntwo\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    await appendFile(filePath, 'three\nfour\n', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset)

    expect(second.lines).toEqual(['three', 'four'])
  })

  it('withholds a trailing line with no newline yet, and picks it up once complete', async () => {
    await writeFile(filePath, 'one\ntwo\npartial', 'utf8')

    const first = await readNewLines(filePath, 0)
    expect(first.lines).toEqual(['one', 'two'])

    await appendFile(filePath, ' line\n', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset)
    expect(second.lines).toEqual(['partial line'])
  })

  it('returns nothing when the file has not grown', async () => {
    await writeFile(filePath, 'one\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    const second = await readNewLines(filePath, first.nextOffset)
    expect(second.lines).toEqual([])
    expect(second.nextOffset).toBe(first.nextOffset)
  })

  it('resumes reading a log truncated in place instead of seeking past it forever', async () => {
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    await writeFile(filePath, 'a\nb\n', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset, first.identity)
    expect(second.lines).toEqual(['a', 'b'])
    expect(second.nextOffset).toBe(Buffer.byteLength('a\nb\n'))
    // Same inode, shrunk content — the exact case `isRotated` must NOT treat as
    // a rotation, since collector.ts gates the fold reset on that predicate (#413).
    expect(second.identity).toEqual(first.identity)

    await appendFile(filePath, 'c\n', 'utf8')
    const third = await readNewLines(filePath, second.nextOffset, second.identity)
    expect(third.lines).toEqual(['c'])
  })

  it('resets the cursor to 0 when truncated to empty', async () => {
    await writeFile(filePath, 'one\ntwo\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    await writeFile(filePath, '', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset, first.identity)
    expect(second.lines).toEqual([])
    expect(second.nextOffset).toBe(0)

    await appendFile(filePath, 'fresh\n', 'utf8')
    const third = await readNewLines(filePath, 0)
    expect(third.lines).toEqual(['fresh'])
  })

  it('does not re-read the same post-truncation content on a second poll', async () => {
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    await writeFile(filePath, 'a\nb\n', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset, first.identity)
    expect(second.lines).toEqual(['a', 'b'])

    const third = await readNewLines(filePath, second.nextOffset, second.identity)
    expect(third.lines).toEqual([])
    expect(third.nextOffset).toBe(second.nextOffset)
  })

  it('withholds a trailing incomplete line surviving an in-place truncation reset', async () => {
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    await writeFile(filePath, 'x\ny\npartial', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset, first.identity)
    expect(second.lines).toEqual(['x', 'y'])
    expect(second.nextOffset).toBe(Buffer.byteLength('x\ny\n'))
  })

  it('detects a same-path rotation via inode even when the replacement already grew past the old offset', async () => {
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    // A real rotation: write the replacement under a different name, then
    // rename it over the old path — the path keeps its name but gets a new
    // inode, the same mechanism rename-based log rotation (and a fresh
    // session reusing a path) uses. The replacement is deliberately made
    // bigger than `first.nextOffset` so a size-only comparison (`size <
    // offset`) would see growth, not rotation, and wrongly keep the stale
    // cursor — reading garbage from the middle of this unrelated content.
    const padding = 'p'.repeat(first.nextOffset + 50)
    const replacementPath = path.join(dir, 'session.jsonl.new')
    await writeFile(replacementPath, `${padding}\nafter\n`, 'utf8')
    await rename(replacementPath, filePath)

    const second = await readNewLines(filePath, first.nextOffset, first.identity)
    expect(second.lines).toEqual([padding, 'after'])
    expect(second.nextOffset).toBe(Buffer.byteLength(`${padding}\nafter\n`))
    expect(second.identity).not.toEqual(first.identity)

    // Continuity: the next poll reads forward from the rotated file, using
    // the identity this call just returned — not stuck resetting forever.
    await appendFile(filePath, 'more\n', 'utf8')
    const third = await readNewLines(filePath, second.nextOffset, second.identity)
    expect(third.lines).toEqual(['more'])
  })

  it('does not reset on ordinary growth of the same file (no identity given)', async () => {
    // Guards the fallback path: when no prior identity is available (a file
    // seen for the very first time, or a snapshot from before this field
    // existed), ordinary growth must not be mistaken for a rotation.
    await writeFile(filePath, 'one\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    await appendFile(filePath, 'two\n', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset)
    expect(second.lines).toEqual(['two'])
  })
})
