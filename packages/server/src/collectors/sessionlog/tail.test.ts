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
})
