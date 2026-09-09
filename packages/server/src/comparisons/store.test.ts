import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions } from '../log/session-log.js'
import { parseComparisonArtifact } from './artifact.js'
import type { ComparisonInput } from './artifact.js'
import {
  comparisonFileName,
  comparisonsDir,
  isComparisonId,
  listComparisons,
  readComparison,
  saveComparison,
} from './store.js'

const INPUT: ComparisonInput = {
  arms: [
    {
      id: 'a',
      model: 'opus',
      brief: 'brief-x',
      runs: [
        { id: 'r1', status: 'complete', verdict: 'pass', value: 4 },
        { id: 'r2', status: 'pending', note: 'not measured yet — no outcome is invented in its place' },
        { id: 'r3', status: 'complete', verdict: 'fail', value: 2, detail: 'timed out' },
        { id: 'r4', status: 'complete', verdict: 'pass', value: null, note: 'judged, but no cost is booked to its lane yet' },
      ],
    },
  ],
}

describe('comparisons/store', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-comparisons-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('save writes exactly one file where it says, and it never masquerades as a session', async () => {
    const { id, savedAt } = await saveComparison(dir, INPUT, '2026-09-04T10:00:00.000Z')

    const files = await readdir(comparisonsDir(dir))
    expect(files).toEqual([comparisonFileName(id)])

    const raw = await readFile(path.join(comparisonsDir(dir), comparisonFileName(id)), 'utf8')
    expect(parseComparisonArtifact(raw)).toEqual({ version: 1, savedAt, input: INPUT })

    expect(await listSessions(dir)).toEqual([])
  })

  it('repeated saves get distinct ids, and listComparisons orders them oldest first by savedAt', async () => {
    await saveComparison(dir, INPUT, '2026-09-04T10:00:01.000Z')
    await saveComparison(dir, INPUT, '2026-09-04T10:00:03.000Z')
    await saveComparison(dir, INPUT, '2026-09-04T10:00:02.000Z')

    const listing = await listComparisons(dir)
    expect(listing).toHaveLength(3)
    expect(listing.every((entry) => entry.available)).toBe(true)
    expect(listing.map((entry) => (entry.available ? entry.savedAt : undefined))).toEqual([
      '2026-09-04T10:00:01.000Z',
      '2026-09-04T10:00:02.000Z',
      '2026-09-04T10:00:03.000Z',
    ])
    for (const entry of listing) {
      expect(entry.available && entry.arms).toBe(1)
      expect(entry.sizeBytes).toBeGreaterThan(0)
    }
    const ids = new Set(listing.map((entry) => entry.id))
    expect(ids.size).toBe(3)
  })

  it('readComparison on an empty dir is missing; listComparisons with no comparisons/ dir at all is empty', async () => {
    expect(await readComparison(dir, randomUUID())).toEqual({ kind: 'missing', id: expect.any(String) })
    expect(await listComparisons(dir)).toEqual([])
  })

  it("the issue's mutation, on disk: a version-2 rewrite is refused, never migrated or removed", async () => {
    const { id } = await saveComparison(dir, INPUT, '2026-09-04T10:00:00.000Z')
    const filePath = path.join(comparisonsDir(dir), comparisonFileName(id))

    const before = await readFile(filePath, 'utf8')
    const mutated = before.replace('"version": 1', '"version": 2')
    await writeFile(filePath, mutated, 'utf8')

    expect(await readComparison(dir, id)).toEqual({
      kind: 'refused',
      id,
      reason: 'unsupported comparison artifact version: 2',
    })

    const listing = await listComparisons(dir)
    expect(listing).toEqual([{ id, sizeBytes: expect.any(Number), available: false, reason: 'unsupported comparison artifact version: 2' }])

    const after = await readFile(filePath, 'utf8')
    expect(after).toBe(mutated)
    expect((await stat(filePath)).size).toBe(Buffer.byteLength(mutated, 'utf8'))
  })

  it('a file that is not valid JSON is refused, by name', async () => {
    const dirPath = comparisonsDir(dir)
    await mkdir(dirPath, { recursive: true })
    const id = randomUUID()
    await writeFile(path.join(dirPath, comparisonFileName(id)), 'not json', 'utf8')

    expect(await readComparison(dir, id)).toEqual({
      kind: 'refused',
      id,
      reason: 'comparison artifact is not valid JSON',
    })
  })

  it('a stray non-artifact file in comparisons/ is absent from the listing', async () => {
    await saveComparison(dir, INPUT, '2026-09-04T10:00:00.000Z')
    await writeFile(path.join(comparisonsDir(dir), 'notes.txt'), 'hello', 'utf8')

    const listing = await listComparisons(dir)
    expect(listing).toHaveLength(1)
  })

  it('readComparison rejects a traversal-shaped id with a TypeError before any filesystem call', async () => {
    // A real session file sits in `dir`: if the read reached the filesystem
    // it would answer `refused` (the file is JSONL, not an artifact), so a
    // thrown TypeError proves no read happened at all.
    await writeFile(path.join(dir, 'session-1000.jsonl'), '{}\n', 'utf8')

    await expect(readComparison(dir, '../session-1000.jsonl')).rejects.toThrow(TypeError)
    await expect(readComparison(dir, '../session-1000.jsonl')).rejects.toThrow('comparison id must be a UUID')
  })

  it('isComparisonId is false for the empty string, a traversal shape, a non-UUID, and an upper-case UUID', () => {
    expect(isComparisonId('')).toBe(false)
    expect(isComparisonId('../x')).toBe(false)
    expect(isComparisonId('not-a-uuid')).toBe(false)
    expect(isComparisonId(randomUUID().toUpperCase())).toBe(false)
    expect(isComparisonId(randomUUID())).toBe(true)
  })
})
