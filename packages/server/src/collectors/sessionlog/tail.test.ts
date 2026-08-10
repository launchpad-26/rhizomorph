import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
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

  it('resumes reading a rotated/truncated log instead of seeking past it forever', async () => {
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    await writeFile(filePath, 'a\nb\n', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset)
    expect(second.lines).toEqual(['a', 'b'])
    expect(second.nextOffset).toBe(Buffer.byteLength('a\nb\n'))

    await appendFile(filePath, 'c\n', 'utf8')
    const third = await readNewLines(filePath, second.nextOffset)
    expect(third.lines).toEqual(['c'])
  })

  it('resets the cursor to 0 when truncated to empty', async () => {
    await writeFile(filePath, 'one\ntwo\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    await writeFile(filePath, '', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset)
    expect(second.lines).toEqual([])
    expect(second.nextOffset).toBe(0)

    await appendFile(filePath, 'fresh\n', 'utf8')
    const third = await readNewLines(filePath, 0)
    expect(third.lines).toEqual(['fresh'])
  })

  it('does not re-read the same post-rotation content on a second poll', async () => {
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    await writeFile(filePath, 'a\nb\n', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset)
    expect(second.lines).toEqual(['a', 'b'])

    const third = await readNewLines(filePath, second.nextOffset)
    expect(third.lines).toEqual([])
    expect(third.nextOffset).toBe(second.nextOffset)
  })

  it('withholds a trailing incomplete line surviving a rotation reset', async () => {
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8')
    const first = await readNewLines(filePath, 0)

    await writeFile(filePath, 'x\ny\npartial', 'utf8')
    const second = await readNewLines(filePath, first.nextOffset)
    expect(second.lines).toEqual(['x', 'y'])
    expect(second.nextOffset).toBe(Buffer.byteLength('x\ny\n'))
  })
})
