import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl, type RhizomorphEvent } from '@rhizomorph/core'
import { verifyRecord } from '@rhizomorph/core/src/record/index.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { repoSlug, sessionDirFor, sessionFileName } from '../log/paths.js'
import { runExportRecord } from './export-record.js'

async function writeSessionFile(sessionDir: string, ts: number, events: readonly RhizomorphEvent[]): Promise<void> {
  await mkdir(sessionDir, { recursive: true })
  await writeFile(path.join(sessionDir, sessionFileName(ts)), eventsToJsonl(events), 'utf8')
}

function sessionEvents(ts: number, sessionId: string): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: ts, stepMs: 1000 })
  f.sessionStarted({ sessionId, repoPath: '/repo', repoName: 'repo' })
  f.agentStatus({ handle: 'worker-1', status: 'working' })
  return f.all()
}

describe('runExportRecord', () => {
  let dataRoot: string
  let repoPath: string

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-export-record-test-'))
    repoPath = path.join(tmpdir(), 'export-record-repo')
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('exports the most recently recorded session by default', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000'))
    await writeSessionFile(sessionDir, 2000, sessionEvents(2000, '2000'))

    const { outPath, record } = await runExportRecord({ repoPath, dataRoot })

    expect(record.manifest.actor.instance).toBe('2000')
    expect(record.manifest.eventCount).toBe(2)
    expect(outPath).toBe(path.join(sessionDir, `${repoSlug(repoPath)}-2000.rhizorecord.json`))
    expect(verifyRecord(record)).toEqual({ ok: true })
  })

  it('honors --session to pick a specific recorded session', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000'))
    await writeSessionFile(sessionDir, 2000, sessionEvents(2000, '2000'))

    const { record } = await runExportRecord({ repoPath, dataRoot, sessionId: '1000' })
    expect(record.manifest.actor.instance).toBe('1000')
  })

  it('throws when there are no recorded sessions', async () => {
    await expect(runExportRecord({ repoPath, dataRoot })).rejects.toThrow(/no recorded sessions/)
  })

  it('throws when --session names a session that does not exist', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000'))

    await expect(runExportRecord({ repoPath, dataRoot, sessionId: '9999' })).rejects.toThrow(
      /no session with id "9999"/,
    )
  })

  it('defaults the actor to the OS username, marked undeclared', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000'))

    const { record } = await runExportRecord({ repoPath, dataRoot })
    expect(record.manifest.actor).toEqual({
      instance: '1000',
      handle: userInfo().username,
      declared: false,
    })
  })

  it('a declared --handle overrides the default and is marked declared', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000'))

    const { record } = await runExportRecord({ repoPath, dataRoot, handle: 'alice' })
    expect(record.manifest.actor).toEqual({ instance: '1000', handle: 'alice', declared: true })
  })

  it('writes to a custom --out path outside the repo', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000'))
    const customOut = path.join(dataRoot, 'custom', 'my-record.json')

    const { outPath } = await runExportRecord({ repoPath, dataRoot, out: customOut })
    expect(outPath).toBe(customOut)
  })

  it('refuses to write the record inside the watched repo', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000'))
    const insideRepo = path.join(repoPath, 'leaked-record.json')

    await expect(runExportRecord({ repoPath, dataRoot, out: insideRepo })).rejects.toThrow(
      /refusing to write.*inside the watched repo/is,
    )
  })
})
