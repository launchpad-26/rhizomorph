import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createEventFactory, eventsToJsonl, type RhizomorphEvent } from '@rhizomorph/core'
import type { SessionRecord } from '@rhizomorph/core/src/record/index.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  busyRefusal,
  logLaneSets,
  mergeTombstone,
  runArchive,
  verifyArchiveFile,
  type ArchiveSeams,
} from './archive.js'
import { readLaneIndex } from './lane-index.js'
import { repoSlug, sessionDirFor, sessionFileName } from './paths.js'
import { applyRetentionPlan, RetentionAnswerRefused, type RetentionCandidate } from './retention.js'
import { LOCK_STALE_MS, writeSessionLock, type SessionLock } from './session-lock.js'
import {
  readTranscriptCaptureManifest,
  transcriptCaptureManifestPath,
  writeTranscriptCaptureManifest,
  type TranscriptCaptureManifest,
} from './transcript-capture.js'

/**
 * `log/archive.ts` — prd-51 ruling 11 (#432).
 *
 * **The ordering cases (T1–T3) are the spine of this file, and none of them can
 * be a post-hoc assertion.** The tree is byte-identical whether the tombstone
 * was written before or after the prune, so a test that only inspects the end
 * state has not tested ruling 11 at all. All three observe the ordering *while
 * it is happening*: an observation taken INSIDE the prune call, a failing prune
 * leaving the tombstone standing, and a per-candidate call log.
 *
 * **`EBUSY` is injected, and that is the honest way to witness it.** POSIX
 * `unlink` of an open file succeeds, so no runner — Linux, macOS, or the
 * Windows suite — produces a real `EBUSY` here. Injecting the fault through
 * {@link ArchiveSeams.prune} means the branch is exercised on **every**
 * platform, which is why nothing about these cases belongs in
 * `.windows-known-failures` (an expected-FAIL list; a listed file that passes
 * is reported as a removal candidate).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/server/src/log -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages')

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

describe('log/archive.ts — seal, archive, verify, tombstone and prune are one ordered act (prd-51 ruling 11, #432)', () => {
  let dataRoot: string
  let repoPath: string
  let sessionDir: string
  let slug: string
  let nowMs: number

  /** Ages a log into the past with `utimes`. NEVER by pushing `nowMs` forward — a future clock makes every lock read stale and silently disables the live-session law (T17). */
  async function seedSession(ts: number, events: readonly RhizomorphEvent[] | string): Promise<string> {
    await mkdir(sessionDir, { recursive: true })
    const filePath = path.join(sessionDir, sessionFileName(ts))
    await writeFile(filePath, typeof events === 'string' ? events : eventsToJsonl(events), 'utf8')
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

  function archiveOptions(overrides: Record<string, unknown> = {}) {
    return { repoPath, dataRoot, answer: { maxAgeMs: 0 }, nowMs, handle: 'operator', ...overrides }
  }

  function archivePathFor(sessionId: string): string {
    return path.join(sessionDir, `${slug}-${sessionId}.rhizorecord.json.gz`)
  }

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-archive-test-'))
    repoPath = path.join(tmpdir(), 'rhizomorph-archive-repo')
    sessionDir = sessionDirFor(repoPath, dataRoot)
    slug = repoSlug(repoPath)
    nowMs = Date.now()
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  // ── T1–T3 · the ordering, observed while it happens ────────────────────────

  describe('the ordering is the ruling, and the end state cannot witness it', () => {
    it('T1: the tombstone is already on disk, and the log is still there, at the moment the prune is called', async () => {
      const logPath = await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))

      const seen: Array<{ logExists: boolean; tombstoneExists: boolean }> = []
      await runArchive(archiveOptions(), {
        prune: async (dir, plan, options) => {
          const candidate = plan.candidates[0]!
          seen.push({
            logExists: existsSync(path.join(dir, candidate.fileName)),
            tombstoneExists: existsSync(transcriptCaptureManifestPath(dir, candidate.sessionId)),
          })
          // The REAL prune, so the end state below is the real one too.
          return applyRetentionPlan(dir, plan, options)
        },
      })

      // One `toEqual` over both keys on purpose: as two separate `expect`s
      // either could be deleted without the diff making that obvious, and
      // dropping `logExists` would stop the test proving the log was still
      // there — which is the other half of "before the prune".
      expect(seen).toEqual([{ logExists: true, tombstoneExists: true }])
      expect(existsSync(logPath)).toBe(false)
      expect(existsSync(transcriptCaptureManifestPath(sessionDir, '1000'))).toBe(true)
    })

    it('T2: a prune that fails leaves the tombstone standing and the log untouched — the same ordering through a different door', async () => {
      const logPath = await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))

      const result = await runArchive(archiveOptions(), {
        prune: async () => {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY', path: logPath })
        },
      })

      expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(['refused'])
      expect(existsSync(logPath)).toBe(true)
      expect(existsSync(transcriptCaptureManifestPath(sessionDir, '1000'))).toBe(true)
    })

    it('T3: one plan per candidate, and one busy candidate does not cost its siblings their archive', async () => {
      for (const ts of [1000, 2000, 3000]) {
        await seedSession(ts, laneEvents(ts, String(ts), [{ lane: `lane-${ts}`, claudeSessionId: `claude-${ts}` }]))
      }

      const calls: string[][] = []
      const result = await runArchive(archiveOptions(), {
        prune: async (dir, plan, options) => {
          calls.push(plan.candidates.map((candidate) => candidate.sessionId))
          if (plan.candidates[0]?.sessionId === '2000') {
            throw Object.assign(new Error('EBUSY: resource busy or locked'), {
              code: 'EBUSY',
              path: path.join(dir, plan.candidates[0].fileName),
            })
          }
          return applyRetentionPlan(dir, plan, options)
        },
      })

      // A single whole-plan call would read [['1000','2000','3000']] — and the
      // throw would then abandon 3000 as well, so this reddens twice over.
      expect(calls).toEqual([['1000'], ['2000'], ['3000']])
      expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(['archived', 'refused', 'archived'])
      expect(existsSync(path.join(sessionDir, sessionFileName(1000)))).toBe(false)
      expect(existsSync(path.join(sessionDir, sessionFileName(2000)))).toBe(true)
      expect(existsSync(path.join(sessionDir, sessionFileName(3000)))).toBe(false)
      // The refused candidate still got its archive, and it verifies.
      expect(await verifyArchiveFile(archivePathFor('2000'))).toMatchObject({ ok: true })
    })
  })

  // ── T4–T6 · prune is reachable by no other route ───────────────────────────

  describe('prune is reachable by no other route', () => {
    const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

    function walkSourceFiles(dir: string): string[] {
      const out: string[] = []
      const visit = (current: string): void => {
        let entries: string[]
        try {
          entries = readdirSync(current)
        } catch {
          return
        }
        for (const entry of entries) {
          if (entry === 'node_modules' || entry === 'dist') continue
          const full = path.join(current, entry)
          if (statSync(full).isDirectory()) visit(full)
          else if (SOURCE_EXTENSIONS.has(path.extname(full))) out.push(full)
        }
      }
      visit(dir)
      return out
    }

    /** The one predicate both directional checks below run, so the bite proves the mechanism rather than a re-implementation of it. */
    function importsRetention(source: string): boolean {
      return /from '(\.{1,2}\/)+(log\/)?retention\.js'/.test(source)
    }

    function everyPackageSourceFile(): string[] {
      return readdirSync(PACKAGES_DIR)
        .map((pkg) => path.join(PACKAGES_DIR, pkg, 'src'))
        .filter((src) => existsSync(src))
        .flatMap((src) => walkSourceFiles(src))
    }

    function retentionImporters(files: readonly string[]): string[] {
      return files
        .filter((file) => importsRetention(readFileSync(file, 'utf8')))
        .map((file) => path.relative(REPO_ROOT, file))
        .sort()
    }

    it('T4a: among SHIPPED source, exactly one file imports log/retention.js — log/archive.ts', () => {
      const shipped = everyPackageSourceFile().filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      expect(retentionImporters(shipped)).toEqual(['packages/server/src/log/archive.ts'])
    })

    it('T4b: across every package source file, tests included, the importer set is exactly the three files that may hold it', () => {
      expect(retentionImporters(everyPackageSourceFile())).toEqual([
        'packages/server/src/log/archive.test.ts',
        'packages/server/src/log/archive.ts',
        'packages/server/src/log/retention.test.ts',
      ])
    })

    it('T4c: bites — the detector fires on a real import and stays quiet on a near-miss', () => {
      expect(importsRetention(`import { applyRetentionPlan } from '../log/retention.js'\n`)).toBe(true)
      expect(importsRetention(`import { applyRetentionPlan } from './retention.js'\n`)).toBe(true)
      expect(importsRetention(`// retention.js is deliberately not imported here\n`)).toBe(false)
      expect(importsRetention(`import { x } from './retention-policy.js'\n`)).toBe(false)
    })

    it('T5a: an archive that does not verify OFF DISK refuses the candidate — the prune is never called and the log stays', async () => {
      const logPath = await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))

      let pruneCalls = 0
      const seams: ArchiveSeams = {
        // The record handed to disk has one body line altered, so the object
        // this process holds is intact and only the ARCHIVE is broken. A
        // verifier that re-checked the in-memory record would pass here.
        compress: (json) => {
          const record = JSON.parse(json) as SessionRecord
          const first = record.body[0]!
          record.body[0] = { ...first, line: `${first.line} ` }
          return gzipSync(JSON.stringify(record))
        },
        prune: async () => {
          pruneCalls += 1
          throw new Error('the prune must never be reached when the archive did not verify')
        },
      }

      const result = await runArchive(archiveOptions(), seams)

      expect(pruneCalls).toBe(0)
      expect(existsSync(logPath)).toBe(true)
      const [outcome] = result.outcomes
      expect(outcome?.kind).toBe('refused')
      expect(outcome?.kind === 'refused' && outcome.reason).toContain('chain-broken')
      expect(outcome?.kind === 'refused' && outcome.reason).toContain('was NOT')
    })

    it('T5b: an out dir inside the watched repo is refused before any candidate is touched', async () => {
      const logPath = await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))

      let pruneCalls = 0
      await expect(
        runArchive(archiveOptions({ outDir: path.join(repoPath, 'archives') }), {
          prune: async () => {
            pruneCalls += 1
            throw new Error('unreachable')
          },
        }),
      ).rejects.toThrow(/refusing to write the archive inside the watched repo/)

      expect(pruneCalls).toBe(0)
      expect(existsSync(logPath)).toBe(true)
    })

    it('T6: a manifest naming a lane the log never does refuses the candidate, and the manifest is left byte-identical', async () => {
      const logPath = await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))
      const manifestPath = transcriptCaptureManifestPath(sessionDir, '1000')
      await writeTranscriptCaptureManifest(sessionDir, {
        sessionId: '1000',
        capturedAt: 500,
        complete: true,
        totalBytes: 12,
        lanes: [{ lane: 'scratch-408', claudeSessionId: 'claude-408', captured: true, bytes: 12 }],
        attributedFrom: 'recording',
      })
      const before = await readFile(manifestPath)

      let pruneCalls = 0
      const result = await runArchive(archiveOptions(), {
        prune: async () => {
          pruneCalls += 1
          throw new Error('unreachable')
        },
      })

      expect(pruneCalls).toBe(0)
      expect(existsSync(logPath)).toBe(true)
      const [outcome] = result.outcomes
      expect(outcome?.kind === 'refused' && outcome.reason).toContain('scratch-408')
      expect(outcome?.kind === 'refused' && outcome.reason).toContain('conjuring a lane that never ran')
      expect(await readFile(manifestPath)).toEqual(before)
    })

    it('T6 (pure sibling): mergeTombstone reports the conjured lane and refuses to build a manifest', () => {
      const existing: TranscriptCaptureManifest = {
        sessionId: '1000',
        capturedAt: 500,
        complete: true,
        totalBytes: 12,
        lanes: [{ lane: 'scratch-408', claudeSessionId: 'claude-408', captured: true, bytes: 12 }],
      }
      expect(
        mergeTombstone(existing, '1000', { attributed: [{ lane: 'scratch-407', claudeSessionId: 'c' }], gitOnly: [] }, 9),
      ).toEqual({ manifest: null, conjured: ['scratch-408'] })
    })
  })

  // ── T7–T11 · the tombstone itself ──────────────────────────────────────────

  describe('the tombstone', () => {
    it('T7: the silent lane reads as PRUNED, not as never having run (spike scenario B)', async () => {
      await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))

      await runArchive(archiveOptions())

      const index = await readLaneIndex(sessionDir)
      const lane = index.lanes.find((entry) => entry.handle === 'scratch-407')
      expect(lane).toBeDefined()
      expect(lane?.sessions).toHaveLength(1)
      expect(lane?.sessions[0]?.recordingPresent).toBe(false)
      expect(lane?.sessions[0]?.gap).not.toBeNull()
      expect(lane?.partialVoice).not.toBeNull()
      expect(index.unreadableSessionIds).toContain('1000')
    })

    it('T8: a lane git alone knows about is named too — the widening ruling 11 offers first (spike verdict 5)', async () => {
      await seedSession(
        1000,
        laneEvents(
          1000,
          '1000',
          [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }],
          [{ path: '/repo-wt/ghost-lane', branch: 'ghost-lane', isMain: false }],
        ),
      )

      const result = await runArchive(archiveOptions())

      const [outcome] = result.outcomes
      expect(outcome?.kind).toBe('archived')
      const tombstone = outcome?.kind === 'archived' ? outcome.tombstone : null
      expect(tombstone?.attributedLanes).toEqual(['scratch-407'])
      expect(tombstone?.gitOnlyLanes).toEqual(['ghost-lane'])
      expect(tombstone?.written).toBe(true)

      const manifest = await readTranscriptCaptureManifest(sessionDir, '1000')
      expect(manifest?.lanes.map((entry) => entry.lane).sort()).toEqual(['ghost-lane', 'scratch-407'])
      const ghost = manifest?.lanes.find((entry) => entry.lane === 'ghost-lane')
      expect(ghost).toMatchObject({ captured: false, bytes: 0, claudeSessionId: '' })
      expect(ghost?.reason).toContain('named by git alone')

      const index = await readLaneIndex(sessionDir)
      for (const handle of ['scratch-407', 'ghost-lane']) {
        const lane = index.lanes.find((entry) => entry.handle === handle)
        expect(lane, handle).toBeDefined()
        expect(lane?.sessions[0]?.recordingPresent, handle).toBe(false)
      }
    })

    it('T8 (pure sibling): logLaneSets splits the union by how each lane was named', () => {
      const events = laneEvents(
        1000,
        '1000',
        [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }],
        [
          { path: '/repo-wt/ghost-lane', branch: 'ghost-lane', isMain: false },
          { path: '/repo', branch: 'main', isMain: true },
        ],
      )
      expect(logLaneSets(events)).toEqual({
        attributed: [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }],
        gitOnly: ['ghost-lane'],
      })
    })

    it('T9: attributedFrom "tombstone" round-trips through readTranscriptCaptureManifest', async () => {
      await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))
      await runArchive(archiveOptions())
      expect((await readTranscriptCaptureManifest(sessionDir, '1000'))?.attributedFrom).toBe('tombstone')
    })

    it('T10: a real capture is never rewritten, and its capturedAt is never restamped', () => {
      const real = { lane: 'a', claudeSessionId: 'claude-a', captured: true, bytes: 99 }
      const existing: TranscriptCaptureManifest = {
        sessionId: '1000',
        capturedAt: 500,
        complete: true,
        totalBytes: 99,
        lanes: [real],
        attributedFrom: 'recording',
      }

      // 1 — an existing capture already covering every lane: nothing is written.
      expect(mergeTombstone(existing, '1000', { attributed: [{ lane: 'a', claudeSessionId: 'claude-a' }], gitOnly: [] }, 9)).toEqual(
        { manifest: null, conjured: [] },
      )

      // 2 — covering one of two lanes: the kept entry survives byte for byte.
      const merged = mergeTombstone(
        existing,
        '1000',
        { attributed: [{ lane: 'a', claudeSessionId: 'claude-a' }, { lane: 'b', claudeSessionId: 'claude-b' }], gitOnly: [] },
        9,
      )
      expect(merged.manifest?.lanes[0]).toEqual(real)
      expect(merged.manifest?.lanes).toHaveLength(2)
      expect(merged.manifest?.capturedAt).toBe(500)
      expect(merged.manifest?.attributedFrom).toBe('tombstone')
      expect(merged.manifest?.complete).toBe(false)
      expect(merged.manifest?.totalBytes).toBe(99)

      // 3 — no existing manifest: the clock is this run's.
      const fresh = mergeTombstone(null, '1000', { attributed: [{ lane: 'a', claudeSessionId: 'claude-a' }], gitOnly: [] }, 9)
      expect(fresh.manifest?.capturedAt).toBe(9)

      // 4 — a log naming no lane at all: nothing to tombstone, nothing written.
      expect(mergeTombstone(null, '1000', { attributed: [], gitOnly: [] }, 9)).toEqual({ manifest: null, conjured: [] })
    })

    it('T11: three runs over the same directory leave the same tree, the same manifest bytes and the same chain', async () => {
      await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))

      const first = await runArchive(archiveOptions())
      expect(first.outcomes.map((outcome) => outcome.kind)).toEqual(['archived'])
      const afterFirst = await snapshotTree(dataRoot)
      const manifestBytes = await readFile(transcriptCaptureManifestPath(sessionDir, '1000'))
      const chain = first.outcomes[0]?.kind === 'archived' ? first.outcomes[0].chainDigest : ''

      const second = await runArchive(archiveOptions())
      const third = await runArchive(archiveOptions())

      for (const run of [second, third]) {
        expect(run.plan.candidates).toHaveLength(0)
        expect(run.voice[0]).toMatch(/nothing is older than/)
        expect(run.outcomes).toEqual([])
      }
      expect(await snapshotTree(dataRoot)).toEqual(afterFirst)
      expect(await readFile(transcriptCaptureManifestPath(sessionDir, '1000'))).toEqual(manifestBytes)
      expect(await verifyArchiveFile(archivePathFor('1000'))).toEqual({ ok: true, eventCount: 2, chainDigest: chain })
    })
  })

  // ── T12–T13 · EBUSY, named rather than pretended ───────────────────────────

  describe('EBUSY refuses the candidate with the holder named, never by pretending', () => {
    const candidate: RetentionCandidate = {
      sessionId: '1000',
      fileName: 'session-1000.jsonl',
      startedAt: 1000,
      lastAppendedAt: 1000,
      ageMs: 10,
      sizeBytes: 40,
    }
    const busy = (): NodeJS.ErrnoException =>
      Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY', path: '/data/session-1000.jsonl' })

    it('T12: the three holder cases read differently, and a non-busy error is not dressed up as one', () => {
      const at = 1_000_000
      const live = busyRefusal(candidate, busy(), { pid: process.pid, heartbeatMs: at }, at, '/out/a.gz')
      const stale = busyRefusal(candidate, busy(), { pid: process.pid, heartbeatMs: at - LOCK_STALE_MS - 1 }, at, '/out/a.gz')
      const none = busyRefusal(candidate, busy(), null, at, '/out/a.gz')

      expect(live).toContain(`pid ${process.pid}`)
      expect(live).toContain('(live)')
      expect(live).toContain('stop that process')

      expect(stale).toContain('STALE')
      expect(stale).toContain(`pid ${process.pid}`)
      expect(stale).not.toContain('(live)')

      expect(none).toContain('no rhizomorph lock names a holder')
      expect(none).toContain('cannot name it')
      expect(none).not.toMatch(/pid \d+/)

      for (const sentence of [live, stale, none]) {
        expect(sentence).toContain('The archive at /out/a.gz is written and verified; nothing was deleted.')
      }

      // A single constant sentence would satisfy every `toContain` above that
      // touches the shared prefix. This is the assertion it cannot survive.
      expect(new Set([live, stale, none]).size).toBe(3)

      const epermLock: SessionLock | null = null
      expect(
        busyRefusal(candidate, Object.assign(new Error('EPERM'), { code: 'EPERM' }), epermLock, at, '/out/a.gz'),
      ).not.toBeNull()
      expect(busyRefusal(candidate, Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }), null, at, '/out/a.gz')).toBeNull()
    })

    it('T13: the wiring — the refusal the run reports is exactly what busyRefusal composes for the same inputs', async () => {
      const logPath = await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))
      // A STALE lock, not a live one: a live lock would make this session the
      // live session and exclude it from the plan entirely (T17), so the busy
      // branch would never be reached at all.
      const lock: SessionLock = { pid: process.pid, heartbeatMs: nowMs - LOCK_STALE_MS - 1 }
      await writeSessionLock(sessionDir, '1000', lock.pid, lock.heartbeatMs)

      const err = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY', path: logPath })
      const result = await runArchive(archiveOptions(), {
        prune: async () => {
          throw err
        },
      })

      const [outcome] = result.outcomes
      expect(outcome?.kind).toBe('refused')
      expect(outcome?.kind === 'refused' && outcome.reason).toBe(
        busyRefusal(result.plan.candidates[0]!, err, lock, nowMs, archivePathFor('1000')),
      )
      expect(existsSync(logPath)).toBe(true)
      expect(await verifyArchiveFile(archivePathFor('1000'))).toMatchObject({ ok: true })
    })
  })

  // ── T14–T19 · failure and edge paths ───────────────────────────────────────

  describe('failure and edge paths', () => {
    it('T14: no session directory at all is a clean, empty answer — not an error', async () => {
      const result = await runArchive(archiveOptions())
      expect(result.plan.candidates).toEqual([])
      expect(result.voice[0]).toMatch(/nothing is older than/)
      expect(result.outcomes).toEqual([])
      expect(existsSync(sessionDir)).toBe(false)
    })

    it('T15: a log with bytes and no parseable event is refused — an empty record must never buy a deletion', async () => {
      const logPath = await seedSession(1000, 'not json at all\nnor is this\n')

      let pruneCalls = 0
      const result = await runArchive(archiveOptions(), {
        prune: async () => {
          pruneCalls += 1
          throw new Error('unreachable')
        },
      })

      expect(pruneCalls).toBe(0)
      expect(existsSync(logPath)).toBe(true)
      const [outcome] = result.outcomes
      expect(outcome?.kind).toBe('refused')
      expect(outcome?.kind === 'refused' && outcome.reason).toContain('not one line of it parses as an event')
    })

    it('T16: a genuinely 0-byte log IS archived and pruned — the sibling of T15, and why the guard reads sizeBytes > 0', async () => {
      const logPath = await seedSession(1000, '')

      const result = await runArchive(archiveOptions())

      const [outcome] = result.outcomes
      expect(outcome?.kind).toBe('archived')
      expect(outcome?.kind === 'archived' && outcome.eventCount).toBe(0)
      expect(existsSync(logPath)).toBe(false)
      expect(await verifyArchiveFile(archivePathFor('1000'))).toMatchObject({ ok: true, eventCount: 0 })
    })

    it('T17: the session a live writer claims is never a candidate, however old its log looks', async () => {
      await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'a', claudeSessionId: 'claude-a' }]))
      const liveLogPath = await seedSession(2000, laneEvents(2000, '2000', [{ lane: 'b', claudeSessionId: 'claude-b' }]))
      await writeSessionLock(sessionDir, '2000', process.pid, nowMs)

      const result = await runArchive(archiveOptions())

      expect(result.liveSessionId).toBe('2000')
      expect(result.plan.candidates.map((candidate) => candidate.sessionId)).toEqual(['1000'])
      expect(existsSync(liveLogPath)).toBe(true)
      expect(existsSync(path.join(sessionDir, sessionFileName(1000)))).toBe(false)
    })

    it('T18: --dry-run writes nothing at all', async () => {
      await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))
      const before = await snapshotTree(dataRoot)

      const result = await runArchive(archiveOptions({ dryRun: true }))

      expect(await snapshotTree(dataRoot)).toEqual(before)
      expect(result.outcomes).toEqual([])
      expect(result.voice.length).toBeGreaterThan(0)
      expect(result.dryRun).toBe(true)
    })

    it('T19: the refusal to invent a retention age is inherited from retention.ts, never re-implemented here', async () => {
      await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'a', claudeSessionId: 'claude-a' }]))
      await expect(runArchive(archiveOptions({ answer: { maxAgeMs: Number.NaN } }))).rejects.toBeInstanceOf(
        RetentionAnswerRefused,
      )
    })

    it('verifyArchiveFile names every way an archive can fail to be one, rather than throwing', async () => {
      await mkdir(sessionDir, { recursive: true })
      const missing = path.join(sessionDir, 'nothing.gz')
      expect(await verifyArchiveFile(missing)).toMatchObject({ ok: false })

      const notGzip = path.join(sessionDir, 'plain.gz')
      await writeFile(notGzip, 'not gzip')
      expect((await verifyArchiveFile(notGzip)) as { detail: string }).toMatchObject({ ok: false })

      const notJson = path.join(sessionDir, 'bad.gz')
      await writeFile(notJson, gzipSync('{{{'))
      expect(await verifyArchiveFile(notJson)).toMatchObject({ ok: false })

      const notRecord = path.join(sessionDir, 'wrong.gz')
      await writeFile(notRecord, gzipSync(JSON.stringify({ hello: 'world' })))
      const verdict = await verifyArchiveFile(notRecord)
      expect(verdict.ok).toBe(false)
      expect(verdict.ok === false && verdict.detail).toContain('not a session record')
    })

    it('the archive on disk really is the gzipped record, not a name with nothing behind it', async () => {
      await seedSession(1000, laneEvents(1000, '1000', [{ lane: 'scratch-407', claudeSessionId: 'claude-407' }]))
      await runArchive(archiveOptions())

      const raw = await readFile(archivePathFor('1000'))
      const record = JSON.parse(gunzipSync(raw).toString('utf8')) as SessionRecord
      expect(record.manifest.repoSlug).toBe(slug)
      expect(record.manifest.actor).toEqual({ instance: '1000', handle: 'operator', declared: true })
      expect(record.body).toHaveLength(2)
    })
  })
})
