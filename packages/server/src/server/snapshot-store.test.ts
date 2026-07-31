import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileSnapshotStore, snapshotFileName } from './snapshot-store.js'

describe('createFileSnapshotStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'observatory-snapshot-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips a snapshot — the byte offsets a restart resumes from', async () => {
    const store = createFileSnapshotStore(dir)
    const snapshot = {
      disabled: false,
      files: { '/logs/a.jsonl': { offset: 4096, lastUsageRequestId: 'req_1' } },
      erroredExtraSessionDirs: {},
    }

    await store.save('sessionlog', snapshot)

    expect(await store.load('sessionlog')).toEqual({ found: true, snapshot })
  })

  it('reports no snapshot when nothing was ever saved', async () => {
    const store = createFileSnapshotStore(dir)
    expect(await store.load('sessionlog')).toEqual({ found: false })
  })

  it('reports no snapshot for a directory that does not exist, without creating it', async () => {
    const missing = path.join(dir, 'never-created')
    const store = createFileSnapshotStore(missing)

    expect(await store.load('git')).toEqual({ found: false })
    await expect(readdir(missing)).rejects.toThrow()
  })

  it('treats a corrupt file as a fresh start rather than crashing the boot', async () => {
    const store = createFileSnapshotStore(dir)
    await store.save('sessionlog', { offset: 10 })
    // Half a JSON object: what a kill mid-write leaves behind.
    await writeFile(path.join(dir, snapshotFileName('sessionlog')), '{"files": {"/logs/a', 'utf8')

    expect(await store.load('sessionlog')).toEqual({ found: false })
  })

  it('recovers on the next save after a corrupt file', async () => {
    const store = createFileSnapshotStore(dir)
    await writeFile(path.join(dir, snapshotFileName('git')), 'not json at all', 'utf8')

    await store.save('git', { head: 'abc123' })

    expect(await store.load('git')).toEqual({ found: true, snapshot: { head: 'abc123' } })
  })

  it('replaces the previous snapshot and leaves no temp files behind', async () => {
    const store = createFileSnapshotStore(dir)
    await store.save('tmux', { panes: 1 })
    await store.save('tmux', { panes: 2 })

    expect(await store.load('tmux')).toEqual({ found: true, snapshot: { panes: 2 } })
    expect(await readdir(dir)).toEqual([snapshotFileName('tmux')])
  })

  it('creates the storage directory on first save', async () => {
    const nested = path.join(dir, 'snapshots')
    const store = createFileSnapshotStore(nested)

    await store.save('otel', { seen: [] })

    expect(await readdir(nested)).toEqual([snapshotFileName('otel')])
  })

  it('writes readable JSON — a human debugging a stuck offset can just look', async () => {
    const store = createFileSnapshotStore(dir)
    await store.save('sessionlog', { offset: 7 })

    const raw = await readFile(path.join(dir, snapshotFileName('sessionlog')), 'utf8')
    expect(JSON.parse(raw)).toEqual({ offset: 7 })
  })

  it('keeps each collector in its own file', async () => {
    const store = createFileSnapshotStore(dir)
    await store.save('git', { head: 'abc' })
    await store.save('sessionlog', { offset: 1 })

    expect(await store.load('git')).toEqual({ found: true, snapshot: { head: 'abc' } })
    expect(await store.load('sessionlog')).toEqual({ found: true, snapshot: { offset: 1 } })
  })

  it('refuses a snapshot that cannot survive a round trip', async () => {
    const store = createFileSnapshotStore(dir)
    await expect(store.save('git', undefined)).rejects.toThrow(/not JSON-serialisable/)
  })
})

describe('snapshotFileName', () => {
  it('is readable, stable, and never escapes the storage directory', () => {
    expect(snapshotFileName('sessionlog')).toMatch(/^sessionlog-[0-9a-f]{8}\.json$/)
    expect(snapshotFileName('sessionlog')).toBe(snapshotFileName('sessionlog'))
    expect(snapshotFileName('../../etc/passwd')).not.toContain('/')
  })

  it('never lets two collector names share one file', () => {
    expect(snapshotFileName('otel')).not.toBe(snapshotFileName('oTel'))
    expect(snapshotFileName('a/b')).not.toBe(snapshotFileName('a-b'))
  })
})
