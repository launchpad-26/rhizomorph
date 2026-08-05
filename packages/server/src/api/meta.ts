import type { FastifyInstance } from 'fastify'
import {
  deriveRung,
  honestCapabilities,
  mergeCapabilities,
  reduceAll,
  type AdapterCapabilities,
  type Rung,
} from '@rhizomorph/core'
import { GIT_CAPABILITIES } from '../collectors/git/index.js'
import { SESSIONLOG_CAPABILITIES } from '../collectors/sessionlog/index.js'
import { TMUX_CAPABILITIES } from '../collectors/tmux/index.js'
import { WORKMUX_CAPABILITIES } from '../collectors/workmux/index.js'
import { JUDGE_CAPABILITIES } from '../collectors/judge/index.js'
import { RESUME_WINDOW_MS, type SessionBootReason } from '../log/session-log.js'
import type { SessionRecorder } from '../server/recorder.js'
import type { ServerContext } from '../server/context.js'

/** The boot facts `/api/meta` carries in addition to `startedAt` — #181 (the web half) reads these. */
export interface SessionBootMeta {
  /** How many earlier boots already continued this exact session, before this one. */
  resumedCount: number
  /** Events already in the session file the moment this boot decided — 0 for a fresh session. */
  eventCount: number
  /** The resume window this boot's decision was measured against. */
  resumeWindowMs: number
  lastBootReason: SessionBootReason
}

/**
 * `registerMetaRoute` only ever receives a `ServerContext`, which is built
 * and typed outside this fence (`server/context.ts`, `server/build-app.ts`)
 * — so the boot facts can't travel as a new context field without touching
 * files this issue doesn't own. A `WeakMap` keyed by the recorder instance
 * already threaded through `ServerContext` carries them instead: `cli/index.ts`
 * (also in this fence) calls this once, right after `decideSessionBoot`
 * resolves, and `/api/meta` reads it back for that same recorder. No
 * `context.ts` edit, no leak (a recorder that's garbage collected drops its
 * entry with it).
 */
export function recordSessionBootMeta(recorder: SessionRecorder, meta: SessionBootMeta): void {
  bootMetaByRecorder.set(recorder, meta)
}

/**
 * The boot facts already recorded for `recorder`, or null. Rotation
 * (`api/rotate.ts`) reads them back so the facts it *doesn't* change — the
 * resume window this run measures against — carry across the boundary instead
 * of silently reverting to the stock default. The recorder object survives a
 * rotation, which is exactly why this keying still works afterwards.
 */
export function sessionBootMetaFor(recorder: SessionRecorder): SessionBootMeta | null {
  return bootMetaByRecorder.get(recorder) ?? null
}

const bootMetaByRecorder = new WeakMap<SessionRecorder, SessionBootMeta>()

/**
 * A recorder nobody called `recordSessionBootMeta` for — `rhizomorph replay`,
 * or a test that builds a bare `SessionRecorder` — reports the honest
 * default: never resumed, nothing recorded yet, the stock window, and
 * `first-run` (the closest true statement: this process didn't make a resume
 * decision for it either).
 */
function fallbackBootMeta(recorder: SessionRecorder): SessionBootMeta {
  return {
    resumedCount: 0,
    eventCount: recorder.eventsSoFar().length,
    resumeWindowMs: RESUME_WINDOW_MS,
    lastBootReason: 'first-run',
  }
}

/**
 * prd15 ruling 5's honesty layer, server side. Every collector this fence
 * owns, keyed by its own registered name — `judge` is included for
 * completeness ("every collector declares") but never moves the rung: it is
 * all-`absent` by design (a structural corroborator across lanes, not an
 * adapter for one), and `mergeCapabilities` never lets an absent contributor
 * pull a signal another collector already provides.
 */
const LADDER_COLLECTOR_NAMES = ['git', 'sessionlog', 'tmux', 'workmux', 'judge'] as const

const DECLARED_CAPABILITIES: Record<(typeof LADDER_COLLECTOR_NAMES)[number], AdapterCapabilities> = {
  git: GIT_CAPABILITIES,
  sessionlog: SESSIONLOG_CAPABILITIES,
  tmux: TMUX_CAPABILITIES,
  workmux: WORKMUX_CAPABILITIES,
  judge: JUDGE_CAPABILITIES,
}

export interface LadderManifest {
  capabilities: Record<string, AdapterCapabilities>
  rung: Rung
}

/**
 * The honest, *live* picture behind the static declarations above: each
 * collector's capabilities, unless this session's own fold says it is
 * currently disabled — then an absent-with-reason override instead (the
 * law: "a disabled collector's signals read `absent` with a reason, never
 * silently `provided`"). `ctx.recorder` is already threaded through
 * `ServerContext` for the boot-facts fallback above, so reading its events
 * back here needs no new wiring outside this fence, exactly like that trick.
 */
export function buildLadderManifest(recorder: SessionRecorder): LadderManifest {
  const folded = reduceAll(recorder.eventsSoFar())

  const capabilities: Record<string, AdapterCapabilities> = {}
  for (const name of LADDER_COLLECTOR_NAMES) {
    const collectorState = folded.collectors[name]
    capabilities[name] = honestCapabilities({
      capabilities: DECLARED_CAPABILITIES[name],
      active: collectorState?.status !== 'disabled',
      inactiveReason: collectorState?.disabledReason ?? undefined,
    })
  }

  const rung = deriveRung(mergeCapabilities(Object.values(capabilities)))
  return { capabilities, rung }
}

export function registerMetaRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/meta', async () => {
    const bootMeta = bootMetaByRecorder.get(ctx.recorder) ?? fallbackBootMeta(ctx.recorder)
    const ladder = buildLadderManifest(ctx.recorder)
    return {
      repoPath: ctx.repoPath,
      repoName: ctx.repoName,
      sessionId: ctx.recorder.sessionId,
      startedAt: Number(ctx.recorder.sessionId),
      ...bootMeta,
      capabilities: ladder.capabilities,
      rung: ladder.rung,
    }
  })
}
