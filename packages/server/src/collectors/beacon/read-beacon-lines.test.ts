import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBeaconLines } from './read-beacon-lines.js'

const A = '{"v":1,"at":1,"writer":"hook","kind":"waiting"}'
const B = '{"v":1,"at":2,"writer":"hook","kind":"working","lane":"ü-lane"}' // multi-byte: offsets are bytes, not chars

describe('readBeaconLines — every complete line, at its real byte offset', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'beacon-lines-'))
    file = path.join(dir, 'w.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('pairs each line with the offset of its first byte, in bytes not characters', async () => {
    await writeFile(file, `${A}\n${B}\n`)
    const result = await readBeaconLines(file, 0)
    expect(result.lines).toEqual([
      { text: A, offset: 0 },
      { text: B, offset: Buffer.byteLength(A) + 1 },
    ])
    expect(result.nextOffset).toBe(Buffer.byteLength(`${A}\n${B}\n`))
    expect(result.nextOffset).not.toBe(`${A}\n${B}\n`.length) // ü is two bytes; a char count would be one short
  })

  it('returns a blank line as a line — the #217 verify probe: "\\n{beacon}\\n" puts the beacon at byte 1', async () => {
    await writeFile(file, `\n${A}\n`)
    const result = await readBeaconLines(file, 0)
    expect(result.lines).toEqual([
      { text: '', offset: 0 },
      { text: A, offset: 1 },
    ])
  })

  it('returns a whitespace-only line as a line too, and keeps a trailing carriage return on the text', async () => {
    await writeFile(file, `  \n${A}\r\n${B}\n`)
    const result = await readBeaconLines(file, 0)
    expect(result.lines.map((line) => line.text)).toEqual(['  ', `${A}\r`, B])
    expect(result.lines.map((line) => line.offset)).toEqual([0, 3, 3 + Buffer.byteLength(A) + 2])
  })

  it('leaves a partial trailing line unread and does not advance past it', async () => {
    await writeFile(file, `${A}\n{"v":1,"at":`)
    const result = await readBeaconLines(file, 0)
    expect(result.lines).toEqual([{ text: A, offset: 0 }])
    expect(result.nextOffset).toBe(Buffer.byteLength(A) + 1)

    const again = await readBeaconLines(file, result.nextOffset, result.identity)
    expect(again.lines).toEqual([])
    expect(again.nextOffset).toBe(result.nextOffset)
  })

  it('resumes from the cursor, so an appended line arrives once at its own offset', async () => {
    await writeFile(file, `${A}\n`)
    const first = await readBeaconLines(file, 0)
    await writeFile(file, `${B}\n`, { flag: 'a' })
    const second = await readBeaconLines(file, first.nextOffset, first.identity)
    expect(second.lines).toEqual([{ text: B, offset: Buffer.byteLength(A) + 1 }])
    const third = await readBeaconLines(file, second.nextOffset, second.identity)
    expect(third.lines).toEqual([])
  })

  it('restarts at byte 0 when the path now names a different inode', async () => {
    await writeFile(file, `${A}\n${A}\n`)
    const first = await readBeaconLines(file, 0)
    await unlink(file)
    await writeFile(file, `${B}\n`)
    const second = await readBeaconLines(file, first.nextOffset, first.identity)
    expect(second.lines).toEqual([{ text: B, offset: 0 }])
  })

  it('restarts at byte 0 when the same inode shrank below the cursor', async () => {
    await writeFile(file, `${A}\n${A}\n`)
    const first = await readBeaconLines(file, 0)
    await writeFile(file, `${B}\n`) // truncating write, same inode on every platform we run on
    const second = await readBeaconLines(file, first.nextOffset, first.identity)
    expect(second.lines).toEqual([{ text: B, offset: 0 }])
  })

  it('returns nothing for an empty file and keeps the cursor at 0', async () => {
    await writeFile(file, '')
    expect(await readBeaconLines(file, 0)).toMatchObject({ lines: [], nextOffset: 0 })
  })
})
