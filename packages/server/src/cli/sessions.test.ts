import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionDirFor, sessionFileName } from '../log/paths.js'
import { renderSessionsReport, runSessions } from './sessions.js'

describe('runSessions', () => {
  let dataRoot: string
  const repoPath = '/repo/rhizomorph'

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-sessions-run-'))
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('returns an empty list for a repo with nothing recorded', async () => {
    expect(await runSessions({ repoPath, dataRoot })).toEqual([])
  })

  it('reads recorded sessions for the given repo, titled from their own events', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await mkdir(sessionDir, { recursive: true })

    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted({ sessionId: '1000', repoPath })
    f.worktreeDiscovered({ path: repoPath, branch: 'main', isMain: true })
    f.worktreeDiscovered({ path: `${repoPath}-wt/9-thing`, branch: '9-thing', isMain: false })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')

    const listings = await runSessions({ repoPath, dataRoot })
    expect(listings).toHaveLength(1)
    expect(listings[0]?.title).toContain('#9')
  })
})

describe('renderSessionsReport', () => {
  it('says plainly when nothing has been recorded', () => {
    expect(renderSessionsReport([])).toBe('no recorded sessions yet')
  })

  it('renders a header and one row per session, newest first', () => {
    const older = {
      id: '1000',
      fileName: 'session-1000.jsonl',
      startedAt: 1000,
      sizeBytes: 512,
      title: '1970-01-01 · no activity recorded',
      label: null,
      lanes: 0,
      landed: 0,
      durationMs: 0,
      outputTokens: 0,
      costUsd: 0,
      costIsAuthoritative: null,
    }
    const newer = {
      ...older,
      id: '2000',
      fileName: 'session-2000.jsonl',
      startedAt: 2000,
      title: 'the scene lands',
      label: 'the scene lands',
      lanes: 3,
      landed: 2,
      durationMs: 65_000,
      outputTokens: 1_700_000,
      costUsd: 12.5,
      costIsAuthoritative: true,
    }

    const report = renderSessionsReport([older, newer])
    const lines = report.split('\n')

    expect(lines[0]).toContain('ID')
    expect(lines[0]).toContain('TITLE')
    expect(lines[0]).toContain('COST')

    // Newest (2000) first, older (1000) after — check relative ordering, not exact index.
    const newerLine = lines.findIndex((line) => line.startsWith('2000'))
    const olderLine = lines.findIndex((line) => line.startsWith('1000'))
    expect(newerLine).toBeGreaterThan(0)
    expect(olderLine).toBeGreaterThan(newerLine)

    expect(report).toContain('the scene lands')
    expect(report).toContain('1.7M')
    expect(report).toContain('$12.50')
  })

  it('flags an estimated cost, and reads a null authority as an honest gap, never $0.00', () => {
    const estimated = {
      id: '1',
      fileName: 'session-1.jsonl',
      startedAt: 1,
      sizeBytes: 10,
      title: 't',
      label: null,
      lanes: 1,
      landed: 0,
      durationMs: 0,
      outputTokens: 10,
      costUsd: 0.5,
      costIsAuthoritative: false,
    }
    const noCost = { ...estimated, id: '2', costUsd: 0, costIsAuthoritative: null }

    const report = renderSessionsReport([estimated, noCost])
    expect(report).toContain('(est.)')
    expect(report).not.toContain('$0.00')
  })
})
