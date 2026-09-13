import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { repoSlug, sessionDirFor, sessionFileName } from '../log/paths.js'
import { transcriptCaptureManifestPath, writeTranscriptCaptureManifest } from '../log/transcript-capture.js'
import { archiveHelpText, parseArchiveArgs, parseOlderThan } from './archive.js'
import { runCli } from './index.js'

/**
 * `rhizomorph archive`'s own surface — prd-51 ruling 11 (#432). The ordering
 * law itself lives in `log/archive.test.ts`; what is tested here is the
 * command: the age nobody may default, the report an operator reads, and the
 * exit code a refusal produces.
 */

/** Thrown by the fake `exit` so a would-be `process.exit` unwinds instead of killing the runner. */
class FakeExit extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`)
  }
}

const AN_HOUR = 3_600_000

function laneEvents(
  ts: number,
  sessionId: string,
  lanes: readonly { lane: string; claudeSessionId: string }[],
  worktrees: readonly { path: string; branch: string; isMain: boolean }[] = [],
): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: ts, stepMs: 1000 })
  f.sessionStarted({ sessionId, repoPath: '/repo', repoName: 'repo' })
  for (const worktree of worktrees) {
    f.worktreeDiscovered({ path: worktree.path, branch: worktree.branch, head: 'sha-0', isMain: worktree.isMain })
  }
  for (const lane of lanes) {
    f.llmUsage({
      lane: lane.lane,
      role: 'worker',
      sessionId: lane.claudeSessionId,
      worktreePath: `/repo-wt/${lane.lane}`,
      branch: lane.lane,
    })
  }
  return f.all()
}

describe('rhizomorph archive — the command (prd-51 ruling 11, #432)', () => {
  let dataRoot: string
  let repoPath: string
  let sessionDir: string
  let slug: string
  let nowMs: number

  async function seedSession(ts: number, events: readonly RhizomorphEvent[]): Promise<string> {
    await mkdir(sessionDir, { recursive: true })
    const filePath = path.join(sessionDir, sessionFileName(ts))
    await writeFile(filePath, eventsToJsonl(events), 'utf8')
    const past = new Date(nowMs - AN_HOUR)
    await utimes(filePath, past, past)
    return filePath
  }

  async function snapshotTree(root: string): Promise<Array<[string, number]>> {
    const out: Array<[string, number]> = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else out.push([path.relative(root, full), (await stat(full)).size])
      }
    }
    await walk(root)
    return out.sort((a, b) => a[0].localeCompare(b[0]))
  }

  async function runArchiveCli(rest: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    const lines: string[] = []
    const log = { log: (line?: unknown) => lines.push(String(line ?? '')), warn: () => {} }
    const stderr: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    })

    let code = -1
    try {
      await runCli(['archive', ...rest], {
        dataRoot,
        log,
        now: () => nowMs,
        exit: ((exitCode: number) => {
          throw new FakeExit(exitCode)
        }) as (code: number) => never,
      })
    } catch (err) {
      if (!(err instanceof FakeExit)) throw err
      code = err.code
    } finally {
      spy.mockRestore()
    }
    return { code, out: lines.join('\n'), err: stderr.join('') }
  }

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-archive-cli-test-'))
    repoPath = path.join(tmpdir(), 'rhizomorph-archive-cli-repo')
    sessionDir = sessionDirFor(repoPath, dataRoot)
    slug = repoSlug(repoPath)
    nowMs = Date.now()
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  describe('T20: parseOlderThan — a bare number is refused because a silent unit is a policy', () => {
    it('accepts <number><unit> for every unit it documents', () => {
      expect(parseOlderThan('30d')).toBe(2_592_000_000)
      expect(parseOlderThan('90m')).toBe(5_400_000)
      expect(parseOlderThan('250ms')).toBe(250)
      expect(parseOlderThan('12h')).toBe(43_200_000)
      expect(parseOlderThan('45s')).toBe(45_000)
      // 0 is legal: retention.ts allows maxAgeMs >= 0, and "everything not
      // being written to" is a coherent thing to ask for.
      expect(parseOlderThan('0d')).toBe(0)
    })

    it('refuses everything else, naming the shape it wanted', () => {
      for (const bad of ['30', '30 d', 'd', '', '-1d', '1w', '1.5d', 'd30']) {
        expect(() => parseOlderThan(bad), bad).toThrow(/must be <number><unit>/)
      }
    })
  })

  describe('T21: parseArchiveArgs', () => {
    it('requires --older-than, and says why there is no default', () => {
      expect(() => parseArchiveArgs([])).toThrow(/--older-than is required/)
      expect(() => parseArchiveArgs(['/repo'])).toThrow(/a policy that reaps a lane nobody thought about/)
    })

    it('--help short-circuits the requirement, because you cannot read the help without it otherwise', () => {
      expect(parseArchiveArgs(['--help'])).toEqual({
        path: undefined,
        olderThanMs: undefined,
        outDir: undefined,
        handle: undefined,
        dryRun: false,
        help: true,
      })
      expect(parseArchiveArgs(['-h']).help).toBe(true)
    })

    it('parses a leading positional path beside every flag', () => {
      expect(
        parseArchiveArgs(['/some/repo', '--older-than', '30d', '--out-dir', '/tmp/out', '--handle', 'ada', '--dry-run']),
      ).toEqual({
        path: '/some/repo',
        olderThanMs: 2_592_000_000,
        outDir: '/tmp/out',
        handle: 'ada',
        dryRun: true,
        help: false,
      })
    })

    it('refuses an empty --out-dir or --handle rather than resolving it to something surprising', () => {
      expect(() => parseArchiveArgs(['--older-than', '1d', '--out-dir', '  '])).toThrow(/--out-dir/)
      expect(() => parseArchiveArgs(['--older-than', '1d', '--handle', ''])).toThrow(/--handle/)
    })
  })

  it('T22: `rhizomorph archive --help` prints this command\'s own usage and exits 0', async () => {
    const { code, out } = await runArchiveCli(['--help'])
    expect(code).toBe(0)
    expect(out).toBe(archiveHelpText())
    expect(out).toContain('--older-than')
  })

  it('T23: the report names the archive, the tombstone, the git-only lanes and the prune — and exits 0', async () => {
    await seedSession(
      1000,
      laneEvents(
        1000,
        '1000',
        [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }],
        [{ path: '/repo-wt/ghost-lane', branch: 'ghost-lane', isMain: false }],
      ),
    )

    const { code, out } = await runArchiveCli([repoPath, '--older-than', '0d'])

    expect(code).toBe(0)
    expect(out).toContain('archived 1000 — 3 events → ')
    expect(out).toContain(path.join(sessionDir, `${slug}-1000.rhizorecord.json.gz`))
    expect(out).toContain(`tombstone ${transcriptCaptureManifestPath(sessionDir, '1000')}`)
    expect(out).toContain('2 lane(s): scratch-407, ghost-lane (1 from telemetry, 1 from git alone)')
    // Ruling 11's either/or: #432 took the widening AND says it out loud.
    expect(out).toContain('1 lane(s) named by git alone and never instrumented (ghost-lane)')
    expect(out).toContain(`pruned ${sessionFileName(1000)} — `)
    expect(out).toMatch(/\n1 archived, 0 refused, \d+ bytes freed$/)
  })

  it('T24: a refusal the CLI can reach with no injection at all exits 1 and prints REFUSED', async () => {
    await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))
    await writeTranscriptCaptureManifest(sessionDir, {
      sessionId: '1000',
      capturedAt: 500,
      complete: true,
      totalBytes: 12,
      lanes: [{ lane: 'scratch-408', claudeSessionId: 'claude-408', captured: true, bytes: 12 }],
      attributedFrom: 'recording',
    })

    const { code, out } = await runArchiveCli([repoPath, '--older-than', '0d'])

    expect(code).toBe(1)
    expect(out).toContain('REFUSED 1000 — ')
    expect(out).toContain('scratch-408')
    expect(out).toMatch(/\n0 archived, 1 refused, 0 bytes freed$/)
  })

  it('T25: --out-dir inside the watched repo is refused on stderr, exits 1, and writes nothing', async () => {
    await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))
    const before = await snapshotTree(dataRoot)

    const { code, err } = await runArchiveCli([repoPath, '--older-than', '0d', '--out-dir', path.join(repoPath, 'archives')])

    expect(code).toBe(1)
    expect(err).toContain('refusing to write the archive inside the watched repo')
    expect(await snapshotTree(dataRoot)).toEqual(before)
  })

  it('--dry-run reports the plan in retention\'s own voice and exits 0 having written nothing', async () => {
    await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))
    const before = await snapshotTree(dataRoot)

    const { code, out } = await runArchiveCli([repoPath, '--older-than', '0d', '--dry-run'])

    expect(code).toBe(0)
    expect(out).toContain('1 recording older than 0 ms would be removed')
    expect(out).toContain('0 archived, 0 refused, 0 bytes freed')
    expect(await snapshotTree(dataRoot)).toEqual(before)
  })

  it('a bad --older-than fails cleanly on stderr with the usage table, and exits 1', async () => {
    const { code, err } = await runArchiveCli([repoPath, '--older-than', '30'])
    expect(code).toBe(1)
    expect(err).toContain('must be <number><unit>')
    expect(err).toContain('rhizomorph archive [path]')
  })
})
