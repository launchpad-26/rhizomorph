import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createEvent,
  deriveRung,
  honestCapabilities,
  mergeCapabilities,
  reduceAll,
  selectConnection,
  type AdapterCapabilities,
} from '@rhizomorph/core'
import * as core from '@rhizomorph/core'
import { describe, expect, it, vi } from 'vitest'
import { GIT_CAPABILITIES } from '../collectors/git/index.js'
import { JUDGE_CAPABILITIES } from '../collectors/judge/index.js'
import { PI_CAPABILITIES } from '../collectors/pi/index.js'
import { SESSIONLOG_CAPABILITIES } from '../collectors/sessionlog/index.js'
import { TMUX_CAPABILITIES } from '../collectors/tmux/index.js'
import { WORKMUX_CAPABILITIES } from '../collectors/workmux/index.js'
import { RESUME_WINDOW_MS, sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { recordSessionBootMeta } from './meta.js'
import { capabilityHeaders } from './test-support.js'

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
        // The LIVE count now (#592), not a boot snapshot: this recorder has
        // recorded nothing, so the honest answer is 0 — and the fact that a
        // boot snapshot can no longer be injected here at all is the point.
        eventCount: 0,
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
        resumeWindowMs: 60_000,
        lastBootReason: 'resumed',
      })
      const freshRecorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
      recordSessionBootMeta(freshRecorder, {
        resumedCount: 0,
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

      expect(resumedBody).toMatchObject({ sessionId: '1000', resumedCount: 3, resumeWindowMs: 60_000 })
      expect(freshBody).toMatchObject({ sessionId: '2000', resumedCount: 0, lastBootReason: 'first-run' })
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

  /**
   * #592. `eventCount` was `decision.eventCountAtBoot` — recorded once at boot
   * and never updated, so the field's live-sounding name sat over a frozen
   * number. It hid because on a *resumed* session the snapshot is large and
   * plausible; a rotation is what made it legible, pinning /api/meta at 0
   * while the session log grew 434 → 470 → 504 lines.
   *
   * This is the test that would have caught it, and it is written to be unable
   * to pass by accident: the count is read BEFORE and AFTER appending, and the
   * assertion is that it MOVED — by exactly the number of events appended, so
   * a route serving any constant (0, or a boot snapshot, or the wrong fold)
   * fails on the second reading. The recorder here has boot meta recorded for
   * it, which is precisely the shape the old defect lived in: a
   * `recordSessionBootMeta` call is on the stack and cannot supply this number
   * any more.
   */
  it('eventCount tracks the LIVE session — events appended after boot move it (#592)', async () => {
    await setup()
    try {
      const recorder = new SessionRecorder('4100', sessionFilePath(sessionDir, '4100'))
      recordSessionBootMeta(recorder, {
        resumedCount: 0,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'rotated',
      })
      await recorder.record(
        createEvent('session.started', { sessionId: '4100', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 4100 }),
      )
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      const countNow = async () => {
        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as Record<string, unknown>
        return body.eventCount
      }

      expect(await countNow()).toBe(1)

      for (let i = 0; i < 5; i++) {
        await recorder.record(
          createEvent(
            'pane.activity',
            { paneId: '%1', contentHash: `hash-${i}` },
            { id: `evt-live-${i}`, ts: 4200 + i },
          ),
        )
      }

      expect(await countNow()).toBe(6)
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
        // pi (#612) also has real `provided` signals (identity/telemetry/cost),
        // so a lane genuinely on a machine that has never run pi disables it
        // too — `~/.pi/agent/sessions` not existing is exactly this event. A
        // "no collector history" fold (this test's OLD shape) would otherwise
        // read pi's undeclared collector state as ACTIVE by the same default
        // every other collector gets before its first poll tick, and pi's own
        // `cost: provided` alone would carry the merged rung to L1 — which
        // this test is not about and would silently hide the workmux drop.
        await recorder.record(
          createEvent(
            'collector.disabled',
            { collector: 'pi', reason: 'no pi session directory' },
            { id: 'evt-2', ts: 6000 },
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
        // Nothing else active in this fence declares `attention: provided` or
        // any `cost` — so losing workmux (and pi, the other source of a
        // non-absent cost) drops the lane a whole rung, exactly as the
        // direction demands ("a lane whose tmux collector is disabled drops
        // a rung automatically and says so").
        expect(body.rung).toBe('L0')
      } finally {
        await teardown()
      }
    })

    it('pi (#612) is on the same ladder as every other organ: provided when active, absent-with-reason when disabled', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('6500', sessionFilePath(sessionDir, '6500'))
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as {
          capabilities: Record<string, AdapterCapabilitiesForTest>
        }

        // No collector history at all: pi reads its own declared capabilities,
        // same as every other collector in this state (the "no history" test
        // above pins the same default for workmux).
        expect(body.capabilities.pi?.identity).toEqual({ level: 'provided' })
        expect(body.capabilities.pi?.cost).toEqual({ level: 'provided' })
      } finally {
        await teardown()
      }
    })

    it('a disabled pi collector reads absent-with-reason, and never pulls another collector down with it', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('6600', sessionFilePath(sessionDir, '6600'))
        await recorder.record(
          createEvent(
            'collector.disabled',
            { collector: 'pi', reason: 'no pi session directory at /home/x/.pi/agent/sessions' },
            { id: 'evt-1', ts: 6600 },
          ),
        )
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as {
          rung: string
          capabilities: Record<string, AdapterCapabilitiesForTest>
        }

        expect(body.capabilities.pi?.identity).toEqual({
          level: 'absent',
          reason: 'no pi session directory at /home/x/.pi/agent/sessions',
        })
        // workmux is untouched and alone already provides everything.
        expect(body.rung).toBe('L4')
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

  /**
   * prd-40 ruling 2 / success 3 (#5). `buildLadderManifest` used to run
   * `reduceAll(recorder.eventsSoFar())` on every request — O(events in the
   * session) on an ungated route the dashboard polls (113.5 ms at 25k events,
   * 535.3 ms at 55k). It now reads the fold the recorder maintains (#3).
   *
   * **The route class is unchanged and is not re-asserted here.** `/api/meta`
   * stays `read` in `api/index.ts`'s `ROUTE_CLASSES` table, and
   * `api/route-class-law.test.ts`'s gate-presence law already walks the real
   * app and fails if that row's registered route grows or loses a capability
   * gate. A second copy of that law in this file would only be a copy.
   */
  describe('prd40 ruling 2 — the route answers from the maintained fold (#5)', () => {
    it('law: the body is byte-identical to the one the per-request re-fold produced, for the same stream', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('20000', sessionFilePath(sessionDir, '20000'))
        // A collector-status event (the ladder's own input), an entity event
        // that moves `connection`, a refusal (the refusals summary), and a
        // plain activity event — so every fold-derived branch of the body is
        // actually exercised rather than compared while empty.
        await recorder.record(
          createEvent(
            'collector.disabled',
            { collector: 'tmux', reason: 'tmux not found on PATH' },
            { id: 'evt-1', ts: 20_000 },
          ),
        )
        await recorder.record(
          createEvent(
            'worktree.discovered',
            { path: repoPath, branch: 'main', head: 'sha-1', isMain: true },
            { id: 'evt-2', ts: 20_100 },
          ),
        )
        await recorder.record(
          createEvent(
            'telemetry.refused',
            { instance: 'their-rhizomorph', expectedInstance: 'our-instance-id', count: 2 },
            { id: 'evt-3', ts: 20_200 },
          ),
        )
        await recorder.record(
          createEvent('pane.activity', { paneId: '%1', contentHash: 'hash-a' }, { id: 'evt-4', ts: 20_300 }),
        )

        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
        const response = await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })

        expect(response.statusCode).toBe(200)
        // NOT a snapshot: the expected value is recomputed here from
        // `reduceAll(eventsSoFar())` through the same derivation the route
        // runs, so the only thing that can differ between the two sides is
        // the fold itself. A frozen fixture would pass whatever the fold did.
        expect(response.json()).toEqual(metaBodyFromRefold(recorder, repoPath, 'repo'))
      } finally {
        await teardown()
      }
    })

    it('law: fold work per request is O(1) in session length — reduceAll is never reached, at 5 events or at 55', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('21000', sessionFilePath(sessionDir, '21000'))
        await recordActivity(recorder, 0, 5, 21_000)
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        // Installed AFTER the recorder exists on purpose: `new SessionRecorder`
        // folds its (possibly resumed) buffer once in its own constructor, and
        // that call is not on the request path this law speaks about.
        const rebuild = vi.spyOn(core, 'reduceAll')
        try {
          expect((await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })).statusCode).toBe(200)
          expect(rebuild).not.toHaveBeenCalled()

          await recordActivity(recorder, 5, 55, 21_000)

          expect((await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })).statusCode).toBe(200)
          // Two sizes, because a law at one size cannot tell "constant" from
          // "small": a request that re-folded would be caught at 5 events too,
          // but only the second reading proves the cost did not grow with the
          // session between them.
          expect(rebuild).not.toHaveBeenCalled()
        } finally {
          rebuild.mockRestore()
        }
      } finally {
        await teardown()
      }
    })

    it('three requests in a row give the same answer — a fold a reader mutated would drift on the second read', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('22000', sessionFilePath(sessionDir, '22000'))
        await recorder.record(
          createEvent(
            'worktree.discovered',
            { path: repoPath, branch: 'main', head: 'sha-1', isMain: true },
            { id: 'evt-1', ts: 22_000 },
          ),
        )
        await recordActivity(recorder, 0, 3, 22_100)
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const first = (await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })).json()
        const second = (await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })).json()
        const third = (await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })).json()

        // Nothing is recorded between the three, so idempotence is the whole
        // claim — and it is the shape a shared, maintained fold gets wrong.
        expect(second).toEqual(first)
        expect(third).toEqual(first)
      } finally {
        await teardown()
      }
    })

    it('serving the fold does not corrupt it — the recorder still agrees with reduceAll afterwards (#69 contract)', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('23000', sessionFilePath(sessionDir, '23000'))
        await recorder.record(
          createEvent(
            'collector.disabled',
            { collector: 'workmux', reason: 'workmux binary not found' },
            { id: 'evt-1', ts: 23_000 },
          ),
        )
        await recordActivity(recorder, 0, 4, 23_100)
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        expect((await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })).statusCode).toBe(200)

        // This lane's half of the wave-3 contract with #69: the route is handed
        // the recorder's LIVE object, so proving it comes back untouched is
        // what makes a `Readonly` return type or a dev-mode deep freeze safe on
        // the other side.
        expect(recorder.foldSoFar()).toEqual(reduceAll(recorder.eventsSoFar()))
      } finally {
        await teardown()
      }
    })

    it('an empty session answers — the initial fold goes through the same path, no null assumption in the swap', async () => {
      await setup()
      try {
        const recorder = new SessionRecorder('24000', sessionFilePath(sessionDir, '24000'))
        const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

        const response = await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual(metaBodyFromRefold(recorder, repoPath, 'repo'))
        expect((response.json() as Record<string, unknown>).eventCount).toBe(0)
      } finally {
        await teardown()
      }
    })
  })
})

/** `count` `pane.activity` events, ids `evt-<i>`, so a law can grow a session cheaply. */
async function recordActivity(recorder: SessionRecorder, from: number, to: number, baseTs: number): Promise<void> {
  for (let i = from; i < to; i++) {
    await recorder.record(
      createEvent('pane.activity', { paneId: '%1', contentHash: `hash-${i}` }, { id: `evt-${i}`, ts: baseTs + i }),
    )
  }
}

const LADDER_COLLECTOR_NAMES_FOR_TEST = ['git', 'sessionlog', 'tmux', 'workmux', 'judge', 'pi'] as const

const DECLARED_CAPABILITIES_FOR_TEST: Record<
  (typeof LADDER_COLLECTOR_NAMES_FOR_TEST)[number],
  AdapterCapabilities
> = {
  git: GIT_CAPABILITIES,
  sessionlog: SESSIONLOG_CAPABILITIES,
  tmux: TMUX_CAPABILITIES,
  workmux: WORKMUX_CAPABILITIES,
  judge: JUDGE_CAPABILITIES,
  pi: PI_CAPABILITIES,
}

/**
 * The whole `/api/meta` body as the OLD, per-request re-fold would have
 * produced it: `reduceAll(recorder.eventsSoFar())` run here, then the same
 * derivation `api/meta.ts` applies to its fold. Deliberately a re-derivation
 * rather than a recorded fixture — a fixture would agree with any fold,
 * including a wrong one, which is exactly the failure this law exists to
 * catch. JSON round-tripped, so the comparison is against what the route
 * actually serialises rather than against in-memory `undefined`s.
 *
 * The boot fields are the honest fallback (`fallbackBootMeta`), so callers
 * must not have called `recordSessionBootMeta` for this recorder.
 */
function metaBodyFromRefold(recorder: SessionRecorder, repoPath: string, repoName: string): unknown {
  const folded = reduceAll(recorder.eventsSoFar())
  const capabilities: Record<string, AdapterCapabilities> = {}
  for (const name of LADDER_COLLECTOR_NAMES_FOR_TEST) {
    const collectorState = folded.collectors[name]
    capabilities[name] = honestCapabilities({
      capabilities: DECLARED_CAPABILITIES_FOR_TEST[name],
      active: collectorState?.status !== 'disabled',
      inactiveReason: collectorState?.disabledReason ?? undefined,
    })
  }
  const latestRefusal = folded.refusals.records[folded.refusals.records.length - 1]
  return JSON.parse(
    JSON.stringify({
      repoPath,
      repoName,
      sessionId: recorder.sessionId,
      startedAt: Number(recorder.sessionId),
      resumedCount: 0,
      resumeWindowMs: RESUME_WINDOW_MS,
      lastBootReason: 'first-run',
      eventCount: folded.eventCount,
      capabilities,
      rung: deriveRung(mergeCapabilities(Object.values(capabilities))),
      connection: {
        ...selectConnection(folded),
        refusals: {
          count: folded.refusals.records.length,
          instance: latestRefusal?.instance ?? null,
          expectedInstance: latestRefusal?.expectedInstance ?? null,
        },
      },
    }),
  )
}

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
