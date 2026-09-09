import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crc32Hex, encodeFrame } from './format.js'
import { openJournal } from './journal.js'
import { readJournal } from './read.js'

/**
 * THE JOURNAL, AGAINST A REAL FILE (prd-51 ruling 4).
 *
 * Nothing here is mocked at the syscall boundary. `openSync`, `writeSync` and
 * `fsyncSync` are the real calls, against a real file in a real `mkdtempSync`
 * directory, because the Definition of done says so and because a test that
 * replaced them would be a test of the replacement.
 *
 * The corruption cases work by editing the bytes on disk after the fact —
 * truncation for a torn tail, one flipped byte for a corruption — which is the
 * only way to produce the two states the ruling distinguishes without killing a
 * process mid-write.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rz-journal-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function journalPath(): string {
  return path.join(dir, 'ingest.journal')
}

function entry(n: number) {
  return {
    project: 'acme-widgets',
    actorInstance: 'lane-7',
    receivedAtMs: 1785739192632,
    batch: [{ n, line: `{"n":${n}}` }],
  }
}

/** Opens, appends `count` records, closes. Returns the seqs it was given back. */
function appendRecords(count: number): number[] {
  const opened = openJournal({ path: journalPath() })
  if (!opened.ok) throw new Error(opened.error)
  const seqs: number[] = []
  for (let i = 1; i <= count; i += 1) seqs.push(opened.journal.append(entry(i)).seq)
  opened.journal.close()
  return seqs
}

/** The byte offset each record's header starts at, from a clean read. */
function offsets(): number[] {
  const read = readJournal(journalPath())
  if (!read.ok) throw new Error(read.error)
  return read.records.map((r) => r.offset)
}

describe('the happy path', () => {
  it('three appends produce seqs 1, 2, 3 and read back in order', () => {
    expect(appendRecords(3)).toEqual([1, 2, 3])
    const read = readJournal(journalPath())
    expect(read.ok && read.verdict).toBe('clean')
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(read.ok && read.records.map((r) => r.entry.batch[0]?.n)).toEqual([1, 2, 3])
    expect(read.ok && read.lastSeq).toBe(3)
  })

  it('a reopened journal continues the chain rather than restarting it', () => {
    appendRecords(2)
    expect(appendRecords(1)).toEqual([3])
    const read = readJournal(journalPath())
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([1, 2, 3])
  })

  it('fromSeq returns only what is past the cursor, and the chain is still walked from byte 0', () => {
    appendRecords(3)
    const read = readJournal(journalPath(), 2)
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([3])
    expect(read.ok && read.lastSeq).toBe(3)
  })

  /**
   * The journal is a LOG. Dedup belongs to the fold, against the database's
   * unique index, and a journal that quietly collapsed a repeated batch would
   * take that decision away from the layer that can make it correctly.
   */
  it('the SAME batch appended three times produces three records with distinct seqs', () => {
    const opened = openJournal({ path: journalPath() })
    if (!opened.ok) throw new Error(opened.error)
    const same = entry(1)
    const seqs = [opened.journal.append(same).seq, opened.journal.append(same).seq, opened.journal.append(same).seq]
    opened.journal.close()

    expect(seqs).toEqual([1, 2, 3])
    const read = readJournal(journalPath())
    expect(read.ok && read.records.length).toBe(3)
    expect(read.ok && new Set(read.records.map((r) => r.seq)).size).toBe(3)
  })

  it('an absent file and a zero-byte file both read as zero records, not as an error', () => {
    expect(readJournal(path.join(dir, 'nothing-here')).ok).toBe(true)
    expect(readJournal(path.join(dir, 'nothing-here')).ok && readJournal(path.join(dir, 'nothing-here'))).toMatchObject(
      { verdict: 'clean', records: [] },
    )
    writeFileSync(journalPath(), '')
    const read = readJournal(journalPath())
    expect(read.ok && read.verdict).toBe('clean')
    expect(read.ok && read.records).toEqual([])
  })
})

describe('a torn tail is legal, and only at EOF', () => {
  it('truncated mid-header: the records before the tear are the whole journal', () => {
    appendRecords(3)
    const thirdAt = offsets()[2] ?? 0
    truncateSync(journalPath(), thirdAt + 6)

    const read = readJournal(journalPath())
    expect(read.ok).toBe(true)
    expect(read.ok && read.verdict).toBe('torn')
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([1, 2])
  })

  it('truncated mid-payload: same verdict, and still no throw', () => {
    appendRecords(3)
    const size = statSync(journalPath()).size
    truncateSync(journalPath(), size - 4)

    const read = readJournal(journalPath())
    expect(read.ok && read.verdict).toBe('torn')
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([1, 2])
  })

  it('truncated by exactly ONE byte — the terminator — is still torn, not clean', () => {
    appendRecords(2)
    truncateSync(journalPath(), statSync(journalPath()).size - 1)
    const read = readJournal(journalPath())
    expect(read.ok && read.verdict).toBe('torn')
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([1])
  })

  it('truncated to exactly a record boundary reads CLEAN — the control for the three above', () => {
    appendRecords(3)
    truncateSync(journalPath(), offsets()[2] ?? 0)
    const read = readJournal(journalPath())
    expect(read.ok && read.verdict).toBe('clean')
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([1, 2])
  })
})

describe('a corruption anywhere earlier aborts loudly', () => {
  /**
   * The pair. The SAME mutation — one flipped byte inside a record's payload —
   * is a corruption at position 2 of 3 and a torn tail at position 3 of 3.
   * That is what makes the rule positional rather than incidental, and it is
   * the assertion an implementation that just "returns what it could parse"
   * fails.
   */
  it('one flipped byte inside record 2 of 3 aborts, naming the offset', () => {
    appendRecords(3)
    const at = offsets()[1] ?? 0
    const bytes = readFileSync(journalPath())
    // Somewhere inside record 2's payload, past its header line.
    const payloadAt = bytes.indexOf(0x0a, at) + 3
    bytes[payloadAt] = (bytes[payloadAt] ?? 0) ^ 0x01
    writeFileSync(journalPath(), bytes)

    const read = readJournal(journalPath())
    expect(read.ok).toBe(false)
    expect(read.ok ? '' : read.error).toContain(`byte offset ${at}`)
    expect(read.ok ? '' : read.error).toContain('crc32')
  })

  it('the same flip inside record 3 of 3 is TORN, and returns records 1 and 2', () => {
    appendRecords(3)
    const at = offsets()[2] ?? 0
    const bytes = readFileSync(journalPath())
    const payloadAt = bytes.indexOf(0x0a, at) + 3
    bytes[payloadAt] = (bytes[payloadAt] ?? 0) ^ 0x01
    writeFileSync(journalPath(), bytes)

    const read = readJournal(journalPath())
    expect(read.ok).toBe(true)
    expect(read.ok && read.verdict).toBe('torn')
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([1, 2])
  })

  it('a broken chain — a repeated seq — aborts even when every crc is right', () => {
    const frame = encodeFrame({ seq: 1, receivedAtMs: 0, project: 'p', actorInstance: 'a', batch: [{ n: 1, line: 'x' }] })
    writeFileSync(journalPath(), Buffer.concat([frame, frame]))
    const read = readJournal(journalPath())
    expect(read.ok).toBe(false)
    expect(read.ok ? '' : read.error).toContain('gapless chain')
  })

  it('a garbled header in the middle aborts by grammar rather than by crc', () => {
    appendRecords(2)
    const bytes = readFileSync(journalPath())
    bytes[0] = 0x58 // 'X', so the magic is XZJ1
    writeFileSync(journalPath(), bytes)
    const read = readJournal(journalPath())
    expect(read.ok).toBe(false)
    expect(read.ok ? '' : read.error).toContain('journal magic')
  })
})

describe('open refuses a file it cannot replay, by name', () => {
  it('a file whose magic is RZJ2 is refused at open', () => {
    writeFileSync(journalPath(), 'RZJ2 1 2 00000000\n{}\n')
    const opened = openJournal({ path: journalPath() })
    expect(opened.ok).toBe(false)
    expect(opened.ok ? '' : opened.error).toContain('RZJ2')
    expect(opened.ok ? '' : opened.error).toContain('refusing to open journal')
  })

  it('a torn tail is NOT a refusal — it is the state a crash legitimately leaves', () => {
    appendRecords(2)
    truncateSync(journalPath(), statSync(journalPath()).size - 3)
    const opened = openJournal({ path: journalPath() })
    expect(opened.ok).toBe(true)
    // …and the next append continues from the last COMPLETE record, so the
    // torn bytes are overwritten by nothing and the chain stays gapless.
    expect(opened.ok && opened.journal.lastSeq()).toBe(1)
    opened.ok && opened.journal.close()
  })
})

describe('the write ordering, and what each fault point leaves behind', () => {
  it('the trace is write then fsync, in that order and once each', () => {
    const tape: string[] = []
    const opened = openJournal({ path: journalPath(), trace: (step) => tape.push(step) })
    if (!opened.ok) throw new Error(opened.error)
    opened.journal.append(entry(1))
    opened.journal.close()
    expect(tape).toEqual(['journal.write', 'journal.fsync'])
  })

  it('a throw BEFORE the write leaves the file byte-identical', () => {
    appendRecords(1)
    const before = readFileSync(journalPath())

    const opened = openJournal({
      path: journalPath(),
      hooks: {
        beforeWrite: () => {
          throw new Error('process died')
        },
      },
    })
    if (!opened.ok) throw new Error(opened.error)
    expect(() => opened.journal.append(entry(2))).toThrow('process died')
    opened.journal.close()

    expect(readFileSync(journalPath()).equals(before)).toBe(true)
    expect(readJournal(journalPath()).ok && readJournal(journalPath())).toMatchObject({ verdict: 'clean' })
  })

  it('a throw BETWEEN the write and the fsync still advances the chain, so no seq is ever reused', () => {
    let armed = true
    const opened = openJournal({
      path: journalPath(),
      hooks: {
        afterWriteBeforeFsync: () => {
          if (!armed) return
          armed = false
          throw new Error('process died')
        },
      },
    })
    if (!opened.ok) throw new Error(opened.error)
    expect(() => opened.journal.append(entry(1))).toThrow('process died')
    // The bytes went out, so the position is taken. Reusing seq 1 would produce
    // a file `readJournal` refuses as a broken chain — which is why the counter
    // advances with the WRITE and not with the fsync.
    expect(opened.journal.lastSeq()).toBe(1)
    opened.journal.append(entry(2))
    opened.journal.close()

    const read = readJournal(journalPath())
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([1, 2])
  })

  it('a throw AFTER the fsync leaves the record durably on disk — the asymmetry that locates durability', () => {
    const opened = openJournal({
      path: journalPath(),
      hooks: {
        afterFsync: () => {
          throw new Error('process died')
        },
      },
    })
    if (!opened.ok) throw new Error(opened.error)
    expect(() => opened.journal.append(entry(1))).toThrow('process died')
    opened.journal.close()

    const read = readJournal(journalPath())
    expect(read.ok && read.verdict).toBe('clean')
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([1])
  })

  it('the hooks are undefined on every ordinary append — they are a seam, not a path', () => {
    const opened = openJournal({ path: journalPath() })
    if (!opened.ok) throw new Error(opened.error)
    expect(() => opened.journal.append(entry(1))).not.toThrow()
    opened.journal.close()
    expect(readJournal(journalPath()).ok).toBe(true)
  })
})

describe('the bytes on disk are the frame the format module describes', () => {
  it('a written record is exactly encodeFrame of what was appended', () => {
    const opened = openJournal({ path: journalPath() })
    if (!opened.ok) throw new Error(opened.error)
    const input = entry(1)
    const appended = opened.journal.append({ ...input, receivedAtMs: 1785739192632 })
    opened.journal.close()

    const expected = encodeFrame({
      seq: appended.seq,
      receivedAtMs: 1785739192632,
      project: input.project,
      actorInstance: input.actorInstance,
      batch: input.batch,
    })
    expect(readFileSync(journalPath()).equals(expected)).toBe(true)
    // …and the crc in those bytes is over the payload, not over the frame.
    const at = expected.indexOf(0x0a)
    expect(expected.toString('utf8', 0, at)).toContain(crc32Hex(expected.subarray(at + 1, expected.length - 1)))
  })
})
