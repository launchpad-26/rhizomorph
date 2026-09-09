import { mkdir, mkdtemp, readdir, readFile, rename as realRename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cursorPath, shipperDirFor } from './config.js'
import {
  coldActorCursor,
  emptyCursor,
  isBusyError,
  isShipperBusy,
  RENAME_RETRY_DELAYS_MS,
  readCursor,
  writeAtomicJson,
  writeCursor,
  type ShipperCursor,
} from './cursor.js'

/** Every temp root this file made, torn down in `afterEach` — never a home path (`no-personal-paths-law.test.ts`). */
let sessionDir: string

function busy(code = 'EBUSY'): NodeJS.ErrnoException {
  const err = new Error(`${code}: resource busy or locked, rename`) as NodeJS.ErrnoException
  err.code = code
  return err
}

function cursorWith(actors: ShipperCursor['actors']): ShipperCursor {
  return { version: 1, actors }
}

beforeEach(async () => {
  sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-shipper-cursor-'))
})

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true })
})

describe("ruling 7's cursor — one JSON file, offset AND n, tmp-then-rename", () => {
  it('reads an absent cursor as a cold start, with nothing to complain about', async () => {
    const read = await readCursor(sessionDir)
    expect(read.reset).toBeNull()
    expect(read.cursor).toEqual(emptyCursor())
    expect(read.cursor.actors['1785900000000']).toBeUndefined()
    expect(coldActorCursor()).toEqual({ offset: 0, n: 0, lastAckAt: 0, skippedCount: 0, skipped: [] })
  })

  it('round-trips a written cursor byte for byte through its own reader', async () => {
    const cursor = cursorWith({
      '1785900000000': {
        offset: 40961,
        n: 312,
        lastAckAt: 1785900123456,
        skippedCount: 2,
        skipped: [{ n: 88, kind: 'unknown', reason: 'pane.activity: unknown-shape — payload' }],
      },
    })
    await writeCursor(sessionDir, cursor)
    expect((await readCursor(sessionDir)).cursor).toEqual(cursor)
  })

  it('cold-starts on unparseable JSON, names the file, and leaves the corrupt bytes on disk', async () => {
    await mkdir(shipperDirFor(sessionDir), { recursive: true })
    await writeFile(cursorPath(sessionDir), '{ not json')

    const read = await readCursor(sessionDir)
    expect(read.cursor).toEqual(emptyCursor())
    expect(read.reset).toContain(cursorPath(sessionDir))
    expect(read.reset).toContain('not valid JSON')
    // Never repaired in place: the evidence is still there for a human.
    expect(await readFile(cursorPath(sessionDir), 'utf8')).toBe('{ not json')
  })

  it('cold-starts on a version it does not speak, and says which version it found', async () => {
    await mkdir(shipperDirFor(sessionDir), { recursive: true })
    await writeFile(cursorPath(sessionDir), JSON.stringify({ version: 2, actors: {} }))

    const read = await readCursor(sessionDir)
    expect(read.cursor).toEqual(emptyCursor())
    expect(read.reset).toContain('version 2')
  })

  it('cold-starts on a non-object actors field rather than half-believing it', async () => {
    await mkdir(shipperDirFor(sessionDir), { recursive: true })
    await writeFile(cursorPath(sessionDir), JSON.stringify({ version: 1, actors: [] }))

    const read = await readCursor(sessionDir)
    expect(read.cursor).toEqual(emptyCursor())
    expect(read.reset).toContain('no actors object')
  })

  it('resets ONE bad actor and keeps its siblings — a negative offset is not the other sessions\' problem', async () => {
    const good = { offset: 12, n: 3, lastAckAt: 7, skippedCount: 0, skipped: [] }
    await mkdir(shipperDirFor(sessionDir), { recursive: true })
    await writeFile(
      cursorPath(sessionDir),
      JSON.stringify({
        version: 1,
        actors: {
          '1785900000001': { offset: -1, n: 3, lastAckAt: 0, skippedCount: 0, skipped: [] },
          '1785900000002': good,
        },
      }),
    )

    const read = await readCursor(sessionDir)
    expect(read.cursor.actors['1785900000001']).toBeUndefined()
    expect(read.cursor.actors['1785900000002']).toEqual(good)
    expect(read.reset).toContain('1785900000001')
    expect(read.reset).not.toContain('1785900000002')
  })

  it('repetition: three identical writes leave one file, no .tmp residue, and identical bytes', async () => {
    const cursor = cursorWith({ '1785900000000': { offset: 10, n: 1, lastAckAt: 5, skippedCount: 0, skipped: [] } })
    await writeCursor(sessionDir, cursor)
    const first = await readFile(cursorPath(sessionDir), 'utf8')
    await writeCursor(sessionDir, cursor)
    await writeCursor(sessionDir, cursor)

    expect(await readFile(cursorPath(sessionDir), 'utf8')).toBe(first)
    expect((await readdir(shipperDirFor(sessionDir))).sort()).toEqual(['cursor.json'])
  })
})

describe('ruling 7 on Windows — EBUSY is answered by name, never pretended away', () => {
  it('retries a busy rename and succeeds, waiting exactly the declared backoff', async () => {
    const waited: number[] = []
    let attempts = 0
    const target = path.join(sessionDir, 'retry.json')

    await writeAtomicJson(target, { ok: true }, 0o644, {
      what: 'cursor',
      delay: async (ms) => {
        waited.push(ms)
      },
      rename: async (from, to) => {
        attempts += 1
        if (attempts <= 2) throw busy()
        await realRename(from, to)
      },
    })

    expect(attempts).toBe(3)
    expect(waited).toEqual([RENAME_RETRY_DELAYS_MS[0], RENAME_RETRY_DELAYS_MS[1]])
    expect(waited).toEqual([50, 150])
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ ok: true })
  })

  it('gives up after the declared retries, names EBUSY and the remedy, and leaves the previous value on disk', async () => {
    const previous = cursorWith({ '1785900000000': { offset: 4, n: 1, lastAckAt: 1, skippedCount: 0, skipped: [] } })
    await writeCursor(sessionDir, previous)

    const waited: number[] = []
    let attempts = 0
    const doomed = writeCursor(
      sessionDir,
      cursorWith({ '1785900000000': { offset: 99, n: 9, lastAckAt: 2, skippedCount: 0, skipped: [] } }),
      {
        delay: async (ms) => {
          waited.push(ms)
        },
        rename: async () => {
          attempts += 1
          throw busy()
        },
      },
    )

    await expect(doomed).rejects.toThrow(/EBUSY/)
    await expect(doomed).rejects.toThrow(/rhizomorph connect team --ship/)
    // Four attempts: the first, plus one per declared backoff.
    expect(attempts).toBe(RENAME_RETRY_DELAYS_MS.length + 1)
    expect(waited).toEqual([...RENAME_RETRY_DELAYS_MS])
    expect((await readCursor(sessionDir)).cursor).toEqual(previous)
    // The refusal is branchable without matching message text.
    await doomed.catch((err) => expect(isShipperBusy(err)).toBe(true))
  })

  it('a non-busy rename failure is re-thrown as itself, not dressed up as a lock', async () => {
    const other = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
    other.code = 'ENOSPC'
    const doomed = writeAtomicJson(path.join(sessionDir, 'nospace.json'), {}, 0o644, {
      rename: async () => {
        throw other
      },
    })
    await expect(doomed).rejects.toThrow(/ENOSPC/)
    await doomed.catch((err) => expect(isShipperBusy(err)).toBe(false))
  })

  it('isBusyError fires on the three win32 codes and not on ENOENT', () => {
    expect(isBusyError(busy('EBUSY'))).toBe(true)
    expect(isBusyError(busy('EPERM'))).toBe(true)
    expect(isBusyError(busy('EACCES'))).toBe(true)
    expect(isBusyError(busy('ENOENT'))).toBe(false)
    expect(isBusyError(new Error('plain'))).toBe(false)
    expect(isBusyError(null)).toBe(false)
  })
})
