import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { RESUME_WINDOW_MS, sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { recordSessionBootMeta } from './meta.js'

describe('GET /api/meta', () => {
  let repoPath: string
  let sessionDir: string

  const setup = async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-meta-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-meta-dir-'))
  }

  const teardown = async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  }

  it('carries startedAt (existing) plus the additive boot facts recorded for this recorder', async () => {
    await setup()
    try {
      const recorder = new SessionRecorder('1785739192605', sessionFilePath(sessionDir, '1785739192605'))
      recordSessionBootMeta(recorder, {
        resumedCount: 7,
        eventCount: 55_049,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'resumed',
      })

      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
      const response = await app.inject({ method: 'GET', url: '/api/meta' })

      expect(response.statusCode).toBe(200)
      const body = response.json() as Record<string, unknown>
      expect(body).toMatchObject({
        repoPath,
        repoName: 'repo',
        sessionId: '1785739192605',
        startedAt: 1785739192605,
        resumedCount: 7,
        eventCount: 55_049,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'resumed',
      })
    } finally {
      await teardown()
    }
  })

  it('carries "writer-alive" — the agnosticism spike\'s liveness-guard reason — the same as any other lastBootReason', async () => {
    await setup()
    try {
      const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
      recordSessionBootMeta(recorder, {
        resumedCount: 0,
        eventCount: 0,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'writer-alive',
      })

      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
      const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as Record<string, unknown>

      expect(body).toMatchObject({ lastBootReason: 'writer-alive' })
    } finally {
      await teardown()
    }
  })

  it("law: meta's boot fields agree with the exact recorder instance's recorded state, not a global default", async () => {
    await setup()
    try {
      const resumedRecorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
      recordSessionBootMeta(resumedRecorder, {
        resumedCount: 3,
        eventCount: 42,
        resumeWindowMs: 60_000,
        lastBootReason: 'resumed',
      })
      const freshRecorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
      recordSessionBootMeta(freshRecorder, {
        resumedCount: 0,
        eventCount: 0,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'first-run',
      })

      const resumedApp = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder: resumedRecorder })
      const freshApp = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder: freshRecorder })

      const resumedBody = (await (await resumedApp.inject({ method: 'GET', url: '/api/meta' })).json()) as Record<
        string,
        unknown
      >
      const freshBody = (await (await freshApp.inject({ method: 'GET', url: '/api/meta' })).json()) as Record<
        string,
        unknown
      >

      expect(resumedBody).toMatchObject({ sessionId: '1000', resumedCount: 3, eventCount: 42, resumeWindowMs: 60_000 })
      expect(freshBody).toMatchObject({ sessionId: '2000', resumedCount: 0, eventCount: 0, lastBootReason: 'first-run' })
    } finally {
      await teardown()
    }
  })

  it('falls back to an honest default (never resumed, the stock window) for a recorder no boot ever recorded meta for', async () => {
    await setup()
    try {
      const recorder = new SessionRecorder('3000', sessionFilePath(sessionDir, '3000'))
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      const response = await app.inject({ method: 'GET', url: '/api/meta' })

      expect(response.statusCode).toBe(200)
      const body = response.json() as Record<string, unknown>
      expect(body).toMatchObject({
        sessionId: '3000',
        resumedCount: 0,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'first-run',
      })
    } finally {
      await teardown()
    }
  })

  it('the fallback eventCount matches the recorder\'s own buffer, not a fabricated zero', async () => {
    await setup()
    try {
      const recorder = new SessionRecorder('4000', sessionFilePath(sessionDir, '4000'))
      const { createEvent } = await import('@rhizomorph/core')
      await recorder.record(
        createEvent('session.started', { sessionId: '4000', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 4000 }),
      )
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      const response = await app.inject({ method: 'GET', url: '/api/meta' })
      const body = response.json() as Record<string, unknown>
      expect(body.eventCount).toBe(1)
    } finally {
      await teardown()
    }
  })

  describe('prd15 ladder — capabilities and rung', () => {
    it('a session with no collector history at all sits at L4 — every collector reads its own declared capabilities', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('5000', sessionFilePath(sessionDir, '5000'))
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as {
          rung: string
          capabilities: Record<string, { attention: { level: string } }>
        }

        expect(body.rung).toBe('L4')
        expect(body.capabilities.workmux?.attention.level).toBe('provided')
      } finally {
        await teardown()
      }
    })

    it('law: a disabled collector reads absent-with-reason, never its normal declared capabilities', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('6000', sessionFilePath(sessionDir, '6000'))
        await recorder.record(
          createEvent(
            'collector.disabled',
            { collector: 'workmux', reason: 'workmux binary not found' },
            { id: 'evt-1', ts: 6000 },
          ),
        )
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as {
          rung: string
          capabilities: Record<string, AdapterCapabilitiesForTest>
        }

        for (const signal of ['identity', 'liveness', 'activity', 'attention', 'telemetry', 'cost'] as const) {
          expect(body.capabilities.workmux?.[signal]).toEqual({
            level: 'absent',
            reason: 'workmux binary not found',
          })
        }
        // Nothing else in this fence declares `attention: provided`, so
        // losing workmux drops the lane a whole rung, exactly as the
        // direction demands ("a lane whose tmux collector is disabled drops
        // a rung automatically and says so").
        expect(body.rung).toBe('L0')
      } finally {
        await teardown()
      }
    })

    it('a disabled collector never pulls a signal another still-healthy collector provides', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('7000', sessionFilePath(sessionDir, '7000'))
        await recorder.record(
          createEvent(
            'collector.disabled',
            { collector: 'tmux', reason: 'tmux not found on PATH' },
            { id: 'evt-1', ts: 7000 },
          ),
        )
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as {
          rung: string
          capabilities: Record<string, AdapterCapabilitiesForTest>
        }

        expect(body.capabilities.tmux?.identity).toEqual({ level: 'absent', reason: 'tmux not found on PATH' })
        // workmux is still healthy and alone already provides everything —
        // losing tmux changes nothing about the rung.
        expect(body.rung).toBe('L4')
      } finally {
        await teardown()
      }
    })
  })

  describe('prd19 ruling 2 — connection facts (additive)', () => {
    it('law: every pre-existing meta field is byte-identical to before — `connection` is the only new key', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('8000', sessionFilePath(sessionDir, '8000'))
        recordSessionBootMeta(recorder, {
          resumedCount: 0,
          eventCount: 0,
          resumeWindowMs: RESUME_WINDOW_MS,
          lastBootReason: 'first-run',
        })
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as Record<
          string,
          unknown
        >

        expect(Object.keys(body).sort()).toEqual(
          [
            'repoPath',
            'repoName',
            'sessionId',
            'startedAt',
            'resumedCount',
            'eventCount',
            'resumeWindowMs',
            'lastBootReason',
            'capabilities',
            'rung',
            'connection',
          ].sort(),
        )
        expect(body).toMatchObject({
          repoPath,
          repoName: 'repo',
          sessionId: '8000',
          startedAt: 8000,
          resumedCount: 0,
          eventCount: 0,
          resumeWindowMs: RESUME_WINDOW_MS,
          lastBootReason: 'first-run',
        })
      } finally {
        await teardown()
      }
    })

    it('a session with no events at all reads every connection source honestly empty, never a fabricated flow', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('9000', sessionFilePath(sessionDir, '9000'))
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as {
          connection: {
            git: SourceFlowForTest
            tmux: SourceFlowForTest
            workmux: SourceFlowForTest
            sessionlog: SourceFlowForTest
            otel: SourceFlowForTest
            uninstrumentedSessions: unknown[]
            refusals: { count: number; instance: string | null; expectedInstance: string | null }
          }
        }

        for (const source of ['git', 'tmux', 'workmux', 'sessionlog', 'otel'] as const) {
          expect(body.connection[source]).toEqual({ source, firstEventTs: null, lastEventTs: null, count: 0 })
        }
        expect(body.connection.uninstrumentedSessions).toEqual([])
        expect(body.connection.refusals).toEqual({ count: 0, instance: null, expectedInstance: null })
      } finally {
        await teardown()
      }
    })

    it("reflects the recorder's own folded events — the same fold the ladder already ran, never a second one", async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('10000', sessionFilePath(sessionDir, '10000'))
        await recorder.record(
          createEvent(
            'worktree.discovered',
            { path: repoPath, branch: 'main', head: 'sha-1', isMain: true },
            { id: 'evt-1', ts: 10_000 },
          ),
        )
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as {
          connection: { git: SourceFlowForTest }
        }

        // One `worktree.discovered` record folds into two git-attributed
        // records here — the worktree itself, and the branch it names
        // (`reduce.ts`'s `worktreeDiscovered` upserts `state.branches` too) —
        // exactly what `selectConnection`'s own header states git's mapping to
        // be ("worktrees, branches, commits"). Both carry this event's one
        // timestamp, so the window is a point and the count is 2, not 1.
        expect(body.connection.git).toEqual({ source: 'git', firstEventTs: 10_000, lastEventTs: 10_000, count: 2 })
      } finally {
        await teardown()
      }
    })

    it('law: a recorder whose log holds a telemetry.refused serves connection.refusals.expectedInstance', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('11000', sessionFilePath(sessionDir, '11000'))
        await recorder.record(
          createEvent(
            'telemetry.refused',
            { instance: 'their-rhizomorph', expectedInstance: 'our-instance-id', count: 3 },
            { id: 'evt-1', ts: 11_000 },
          ),
        )
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as {
          connection: { refusals: { count: number; instance: string | null; expectedInstance: string | null } }
        }

        expect(body.connection.refusals).toEqual({
          count: 1,
          instance: 'their-rhizomorph',
          expectedInstance: 'our-instance-id',
        })
      } finally {
        await teardown()
      }
    })

    it('never counts a refused export as otel flow — telemetry turned away never arrived (selectConnection’s own law, restated here)', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('12000', sessionFilePath(sessionDir, '12000'))
        await recorder.record(
          createEvent(
            'telemetry.refused',
            { instance: null, expectedInstance: 'our-instance-id', count: 1 },
            { id: 'evt-1', ts: 12_000 },
          ),
        )
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as {
          connection: { otel: SourceFlowForTest }
        }

        expect(body.connection.otel).toEqual({ source: 'otel', firstEventTs: null, lastEventTs: null, count: 0 })
      } finally {
        await teardown()
      }
    })

    it('the refusals summary reports the most recently arrived record, not the earliest and not the loudest count', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('13000', sessionFilePath(sessionDir, '13000'))
        await recorder.record(
          createEvent(
            'telemetry.refused',
            { instance: 'first-offender', expectedInstance: 'our-instance-id', count: 9 },
            { id: 'evt-1', ts: 13_000 },
          ),
        )
        await recorder.record(
          createEvent(
            'telemetry.refused',
            { instance: 'second-offender', expectedInstance: 'our-instance-id', count: 1 },
            { id: 'evt-2', ts: 14_000 },
          ),
        )
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as {
          connection: { refusals: { count: number; instance: string | null; expectedInstance: string | null } }
        }

        expect(body.connection.refusals).toEqual({
          count: 2,
          instance: 'second-offender',
          expectedInstance: 'our-instance-id',
        })
      } finally {
        await teardown()
      }
    })
  })
})

interface SourceFlowForTest {
  source: string
  firstEventTs: number | null
  lastEventTs: number | null
  count: number
}

interface AdapterCapabilitiesForTest {
  identity: { level: string; reason?: string }
  liveness: { level: string; reason?: string }
  activity: { level: string; reason?: string }
  attention: { level: string; reason?: string }
  telemetry: { level: string; reason?: string }
  cost: { level: string; reason?: string }
}
