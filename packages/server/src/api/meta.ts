import type { FastifyInstance } from 'fastify'
import {
  deriveRung,
  honestCapabilities,
  mergeCapabilities,
  selectConnection,
  type AdapterCapabilities,
  type Connection,
  type RefusalState,
  type Rung,
  type SessionState,
} from '@rhizomorph/core'
import { GIT_CAPABILITIES } from '../collectors/git/index.js'
import { PI_CAPABILITIES } from '../collectors/pi/index.js'
import { SESSIONLOG_CAPABILITIES } from '../collectors/sessionlog/index.js'
import { TMUX_CAPABILITIES } from '../collectors/tmux/index.js'
import { WORKMUX_CAPABILITIES } from '../collectors/workmux/index.js'
import { JUDGE_CAPABILITIES } from '../collectors/judge/index.js'
import { BEACON_CAPABILITIES } from '../collectors/beacon/index.js'
import { RESUME_WINDOW_MS, type SessionBootReason } from '../log/session-log.js'
import type { SessionRecorder } from '../server/recorder.js'
import type { ServerContext } from '../server/context.js'
import { requireCapabilityToken } from './security.js'

/**
 * The boot facts `/api/meta` carries in addition to `startedAt` — #181 (the
 * web half) reads these.
 *
 * **`eventCount` is deliberately not one of them (#592).** It used to be: a
 * snapshot of how many events were already in the session file the moment this
 * boot decided, recorded once and never updated. On a *resumed* session that
 * number is large and plausible, so for its whole life it read as a live
 * count; a rotation is what made the lie legible, because a fresh session
 * starts at 0 and the field then sat at 0 forever while the log grew (434 →
 * 470 → 504 lines across 40 seconds of measurement, `/api/meta` reporting 0
 * throughout).
 *
 * A live-sounding name over a frozen value is the thing to remove, and of the
 * two ways to remove it this endpoint takes the one that keeps the field
 * useful: it reports the LIVE count, off the same per-request fold
 * {@link buildLadderManifest} already runs, rather than renaming the field to
 * advertise a boot snapshot nothing reads. The snapshot is not lost — it is
 * `decideSessionBoot`'s own `eventCountAtBoot`, and the boot line and
 * `rhizomorph doctor` still print it — it simply stops being served under a
 * name that promises something else.
 */
export interface SessionBootMeta {
  /** How many earlier boots already continued this exact session, before this one. */
  resumedCount: number
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
 * default: never resumed, the stock window, and `first-run` (the closest true
 * statement: this process didn't make a resume decision for it either).
 *
 * It takes no recorder any more, because the one field that needed one —
 * `eventCount` — is no longer a boot fact and is served live by the route
 * itself (see {@link SessionBootMeta}).
 */
function fallbackBootMeta(): SessionBootMeta {
  return {
    resumedCount: 0,
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
 *
 * **Seven names, not six (#283).** `beacon` joins the list here so the
 * instrument's own manifest stops omitting a collector that exists (the verify
 * note on #217). It moves no rung, and that is deliberate rather than an
 * oversight: `BEACON_CAPABILITIES` is all-`absent` but for a `partial`
 * identity, because prd-27 ruling 3's carve-out says `attention` reads
 * `provided` only once a beacon has actually arrived *for that lane* — a
 * per-lane reading a static manifest cannot make. This wave folds declared
 * attention into `SessionState.declared`; the rung that tells a declaring
 * beacon from tmux (L2 versus L4) is w4's, and until then the honest static
 * answer is the absent one, with the reason said.
 *
 * **`pi` (#612).** Its collector registers under its own name (`collector.ts`'s
 * `COLLECTOR_NAME = 'pi'`), so `folded.collectors.pi` is already a real,
 * independent entry the fold has kept since #609 — this ladder was simply not
 * reading it. Before this it was invisible to the one surface that exists to
 * describe organs: pi could emit real `llm.usage`/`llm.cost`/`tool.activity`
 * (`PI_CAPABILITIES`, five signals `provided`) and `/api/meta` would report
 * nothing about it at all.
 *
 * **Named, not fixed here — prd-19's open question.** This ladder has no
 * `otel` entry, so `rung` below never reflects it, while the CLI's own
 * `doctor` command's ladder does — two different answers to "what rung am I
 * at" that this fence does not reconcile. `connection.otel` (below) is the
 * honest, otel-aware flow fact in the meantime; whoever rules the asymmetry
 * owns both files in one fence.
 */
const LADDER_COLLECTOR_NAMES = ['git', 'sessionlog', 'tmux', 'workmux', 'judge', 'pi', 'beacon'] as const

const DECLARED_CAPABILITIES: Record<(typeof LADDER_COLLECTOR_NAMES)[number], AdapterCapabilities> = {
  git: GIT_CAPABILITIES,
  sessionlog: SESSIONLOG_CAPABILITIES,
  tmux: TMUX_CAPABILITIES,
  workmux: WORKMUX_CAPABILITIES,
  judge: JUDGE_CAPABILITIES,
  pi: PI_CAPABILITIES,
  beacon: BEACON_CAPABILITIES,
}

export interface LadderManifest {
  capabilities: Record<string, AdapterCapabilities>
  rung: Rung
  /**
   * The fold this manifest was built from. Exposed so `/api/meta`'s
   * connection facts (prd-19 ruling 2, below) can reuse it instead of folding
   * the recorder's log a second time — one fold per request, so live view,
   * this ladder and the connection facts can never disagree with each other
   * about the same request.
   */
  folded: SessionState
}

/**
 * The honest, *live* picture behind the static declarations above: each
 * collector's capabilities, unless this session's own fold says it is
 * currently disabled — then an absent-with-reason override instead (the
 * law: "a disabled collector's signals read `absent` with a reason, never
 * silently `provided`"). `ctx.recorder` is already threaded through
 * `ServerContext` for the boot-facts fallback above, so reading the fold it
 * maintains needs no new wiring outside this fence, exactly like that trick.
 */
export function buildLadderManifest(recorder: SessionRecorder): LadderManifest {
  // prd40 ruling 2: the recorder maintains this fold (#3), so the route reads
  // it rather than rebuilding it. `reduceAll(eventsSoFar())` was O(events in
  // the session) on an ungated route the dashboard polls — 113.5 ms at 25k
  // events, 535.3 ms at 55k, from the repo's own published figures. Read-only:
  // this is the recorder's live object, not a copy (#69 owns that contract).
  const folded = recorder.foldSoFar()

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
  return { capabilities, rung, folded }
}

/**
 * The refusals slice's shape for a connect surface: how many standing
 * `telemetry.refused` facts this log holds, and the most recent one's
 * identity — the two facts ruling 3's folded-refusal BROKEN state renders
 * (a reason and the wrong-instance remedy from the payload itself). `null`
 * on both identity fields is the honest "nothing yet" reading (ruling 4's
 * law, applied to this slice) for a log with no refusal at all — never a
 * stand-in for "fine".
 */
export interface RefusalsSummary {
  /** `state.refusals.records.length` — how many refusal facts this log holds. */
  count: number
  /** The most recent refusal's declared instance, or `null` when none has arrived. */
  instance: string | null
  /**
   * The most recent refusal's `expectedInstance` — our own instance id, the
   * fact ruling 3's wrong-instance remedy is built from — or `null` when none
   * has arrived. A recorder whose log holds a `telemetry.refused` always
   * serves this non-null.
   */
  expectedInstance: string | null
}

/**
 * `records` is kept in arrival order (`state.ts`, `refusalStateWith`), never
 * re-sorted by timestamp, so "most recent" here means the last one this
 * recorder's log folded — the same reading `RefusalRecord.count` already
 * gives for "is the fault still standing".
 */
function summarizeRefusals(refusals: RefusalState): RefusalsSummary {
  const latest = refusals.records[refusals.records.length - 1]
  return {
    count: refusals.records.length,
    instance: latest?.instance ?? null,
    expectedInstance: latest?.expectedInstance ?? null,
  }
}

/**
 * prd-19 ruling 2's connect-surface data, additive on `/api/meta`:
 * `selectConnection` over the same fold `buildLadderManifest` already ran
 * (reused via {@link LadderManifest.folded}, never re-folded), plus the
 * refusals summary above.
 *
 * Two things `selectConnection`'s own header already rules on, restated here
 * only as a pointer so this endpoint does not relitigate them: (1) the
 * git/tmux/workmux flow facts below are read off lossy entity state and CAN
 * regress (a `branch.removed` erases git's) — that tension is prd-19's open
 * leads' ruling, not a compensation this endpoint invents, so the facts are
 * served exactly as the selector gives them; (2) `uninstrumentedSessions`
 * cannot distinguish "never instrumented" from "instrumented, awaiting its
 * first batched export" — served as-is, the elapsed-time judgment is the
 * UI's call (#258).
 */
export interface MetaConnection extends Connection {
  refusals: RefusalsSummary
}

function buildConnection(folded: SessionState): MetaConnection {
  return { ...selectConnection(folded), refusals: summarizeRefusals(folded.refusals) }
}

export function registerMetaRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/meta', { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') }, async () => {
    const bootMeta = bootMetaByRecorder.get(ctx.recorder) ?? fallbackBootMeta()
    const ladder = buildLadderManifest(ctx.recorder)
    return {
      repoPath: ctx.repoPath,
      repoName: ctx.repoName,
      sessionId: ctx.recorder.sessionId,
      startedAt: Number(ctx.recorder.sessionId),
      ...bootMeta,
      // The LIVE count, off the fold this request already built (#592) — never
      // a boot snapshot. `folded.eventCount` is `core`'s own envelope counter,
      // so it is the same number every surface reads, and it moves with the
      // log rather than with the process. See {@link SessionBootMeta}.
      eventCount: ladder.folded.eventCount,
      capabilities: ladder.capabilities,
      rung: ladder.rung,
      connection: buildConnection(ladder.folded),
    }
  })
}
