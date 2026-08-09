import type { AgentRole } from '../events/index.js'
import type { SessionState } from '../state.js'
import { compareStrings } from './touches.js'

/**
 * prd19 ruling 2 — the connect surface's data layer: **what has actually
 * flowed, per source, and from whom nothing has.**
 *
 * The problem this exists for is one line of the PRD's evidence:
 * `sourceStatus(undefined)` returns `'live'`, so a source that has never
 * produced a single event wears the same calm dot as a healthy one. Ruling 4
 * makes silence never live, and this is the fact that makes that answerable —
 * "data flowed, at these times, this much", never "preconditions passed".
 *
 * **Everything here is DERIVED, and that is a ruling, not a preference.** No new
 * event type, no new recorded field, no schema migration, no era work: the
 * facts a connect page needs are already provable from folded records, so they
 * are computed on read like every other selector in this directory. That is
 * also what makes live view, replay and fixtures agree by construction — one
 * function over one fold, so there is no second answer to keep in step.
 *
 * The first honest limit, stated up front because a reader will otherwise assume
 * otherwise: **{@link SourceFlow.count} counts folded RECORDS, not events.**
 * The fold keeps records; it keeps no per-source event tally, and inventing one
 * would mean recording a fact no event carries — the thing the ruling forbids.
 * A source's count is therefore evidence of flow and a magnitude for display,
 * never an event count: git's poll re-reports a worktree it already discovered,
 * a re-delivered span is idempotent, and cross-collector dedup folds a
 * duplicate request into the record it duplicates. All three make count ≤
 * events, and none of them makes count wrong about the question actually being
 * asked, which is whether anything arrived and when.
 *
 * ---
 *
 * **THE SECOND LIMIT, AND IT IS A REAL TENSION INSIDE RULING 2, NOT A DETAIL:
 * git, tmux and workmux flow facts describe CURRENT ENTITY STATE, so they can
 * REGRESS. The telemetry-backed sources cannot.**
 *
 * The three machine collectors have no record of their own — their flow is read
 * off `worktrees`, `branches`, `commits`, `panes` and `agents`, which are
 * entity maps the fold keeps *up to date* rather than append-only ledgers. Most
 * of those keep a departed entity with a flag (`worktree.removed` sets
 * `present: false` and `removedAt`; `pane.closed` sets `closedAt`), so they do
 * not regress. **One does not:** `branch.removed` DELETES the record outright
 * (`reduce.ts`, and deliberately — the ghost fix, so a dead branch stops
 * colliding with live ones). When that was a source's only evidence, git flips
 * from VERIFIED back to `null`/zero, and the removal's own timestamp is lost
 * with the record, so it cannot even stand as the last thing git proved. A
 * connect page can therefore watch a green row go grey while the log it was
 * derived from only ever grew.
 *
 * `sessionlog` and `otel` are structurally incapable of this: their flow comes
 * from `telemetry.*` and `traces.spans`, which are append-only records with no
 * removal event in the union at all. Which is exactly why this is a tension in
 * the ruling rather than a bug here — "derived, never recorded" is sound over
 * append-only records and lossy over entity maps, and prd-19 ruling 2 applies
 * one sentence to both. **The ruling is the leads' to make, not this selector's.**
 * The candidates, named so nobody has to re-derive them: record a removal
 * timestamp so a departed branch leaves a mark; or make flow monotonic by
 * remembering a high-water mark somewhere; or accept regression and let the UI
 * voice it. All three change either state or a PRD, so none is done here.
 * `connection.test.ts` PINS the current behaviour by name — "pins, not
 * endorses" — so whichever way it is ruled, the baseline it changed from is
 * written down.
 */

/**
 * The five collectors whose flow a connect surface reports, in the order the
 * chain runs: the three that watch the machine, then the two that carry an
 * agent's own telemetry.
 *
 * `system` is deliberately absent. Its events (`session.started`, the four
 * `collector.*` families) are the recorder's own hand and our own resilience
 * policy talking — nothing about them says an external link is wired, so
 * counting them as a source would report the instrument's own pulse as data
 * flowing in. The `lab` and `judge` hands are absent for the same reason: both
 * are explicitly invoked by us.
 */
export const CONNECTION_SOURCES = ['git', 'tmux', 'workmux', 'sessionlog', 'otel'] as const

export type ConnectionSource = (typeof CONNECTION_SOURCES)[number]

/** What one source has proved about itself. */
export interface SourceFlow {
  source: ConnectionSource
  /**
   * Earliest timestamp any folded record attributable to this source carries,
   * or `null` for a source nothing has ever arrived from — the honest answer
   * ruling 4 needs, and never a stand-in for "fine".
   *
   * Against the clock, not against arrival: `min`/`max` over the timestamps
   * themselves, the same rule `LaneAttribution.firstSeenAt` follows. A log
   * whose lines are in timestamp order — every log the recorder writes — cannot
   * tell the two readings apart; a replayed slice with a non-monotonic middle
   * can, and "the first event we happened to fold" is not a fact about when the
   * source started flowing. It also makes the answer independent of fold order
   * outright, which is the strongest form of the refold law below.
   */
  firstEventTs: number | null
  /** Latest such timestamp, `null` under the same condition. */
  lastEventTs: number | null
  /**
   * How many folded records this source is responsible for. Zero exactly when
   * both timestamps are `null`. See this file's header for why this is a count
   * of records and not of events.
   */
  count: number
}

/**
 * A session the transcript collector has folded activity for and OTel has
 * produced nothing for — **Gabe's case** (operator report, 2026-08-07: he ran
 * rhizomorph successfully while the Claude instance driving it was never
 * instrumented, and nothing on any surface said so).
 *
 * Named per session rather than "is the conductor instrumented", because the
 * fact is the same fact whichever lane it lands on and the fold has no notion
 * of "the" conductor: {@link roles} is what lets ruling 3's first-class BROKEN
 * state name a conductor as a conductor, and a worker lane in the same
 * condition is the same broken link with a different label.
 *
 * **This cannot distinguish "never instrumented" from "instrumented, awaiting
 * its first batched export".** Both look identical in the fold, because both
 * are the absence of a record. Ruling 3 names transcript-without-otel as
 * first-class BROKEN, so the derivation stands as it is — but a consumer
 * rendering it should weigh the time elapsed since {@link firstEventTs} before
 * calling it broken, since an OTel exporter's first batch can lag the transcript
 * by an export interval. The threshold is the UI's call, not this selector's
 * (#258).
 */
export interface UninstrumentedSession {
  sessionId: string
  /** Lane handles the transcript reported this session under, alphabetical. */
  lanes: string[]
  /** Roles those records carried, alphabetical. `conductor` here is the PRD's evidence case. */
  roles: AgentRole[]
  /** Earliest transcript timestamp for this session — never null; its existence is the fact. */
  firstEventTs: number
  /** Latest transcript timestamp for this session. */
  lastEventTs: number
}

export interface Connection {
  git: SourceFlow
  tmux: SourceFlow
  workmux: SourceFlow
  sessionlog: SourceFlow
  otel: SourceFlow
  /**
   * Earliest transcript sighting first, session id as the only tiebreak — a
   * total order over the state, so a fold and a refold of one log hand back the
   * same list in the same order.
   */
  uninstrumentedSessions: UninstrumentedSession[]
}

/**
 * The whole connection picture, in one pass per slice.
 *
 * Which slice proves which source, written out in full because the mapping is
 * the only thing here that could be wrong quietly:
 *
 * - **git** — `worktrees`, `branches`, `commits`. Timestamps: a worktree's
 *   discovery, removal and dirty-set update; a branch's first sighting and last
 *   update; a commit's `landedAt`, which is the envelope ts of its first
 *   sighting. Never `authoredAt`: that is git reporting the author's own clock,
 *   which can predate this session by months and says nothing about when the
 *   collector reached us.
 * - **tmux** — `panes`, every timestamp a pane record carries.
 * - **workmux** — `agents`, first seen and last updated.
 * - **sessionlog** / **otel** — the money layer's four record arrays, split by
 *   the `origin` the envelope stamped on each record.
 * - **otel**, additionally — `traces.spans`. A span has no `origin` field
 *   because `trace.span` has exactly one possible source: our own `/v1/traces`
 *   receiver. Its envelope `ts` is used, not `startTs`/`endTs`, which are the
 *   exporting process's clock rather than the moment data reached us.
 *
 * **`state.refusals` is deliberately NOT otel flow, and this is the load-bearing
 * exclusion.** A refused export is telemetry that never landed — the receiver
 * records nothing until identity checks out — so counting one as otel flow
 * would render the exact fleet prd19 exists for, a misconfigured one, as otel
 * VERIFIED with a first-event timestamp. That is `sourceStatus(undefined) →
 * 'live'` in a new costume, which ruling 4 removes. A refusal is a BROKEN
 * reason carrying its own remedy (ruling 3), and a surface reads it from
 * `state.refusals` — whole, with the wrong-instance payload intact — rather
 * than from a flow count that would launder it into proof of the opposite.
 */
export function selectConnection(state: SessionState): Connection {
  const flows: Record<ConnectionSource, Flow> = {
    git: newFlow(),
    tmux: newFlow(),
    workmux: newFlow(),
    sessionlog: newFlow(),
    otel: newFlow(),
  }

  for (const worktree of Object.values(state.worktrees)) {
    fold(flows.git, worktree.discoveredAt, worktree.removedAt, worktree.dirtyUpdatedAt)
  }
  for (const branch of Object.values(state.branches)) {
    fold(flows.git, branch.firstSeenAt, branch.updatedAt)
  }
  for (const commit of Object.values(state.commits)) fold(flows.git, commit.landedAt)

  for (const pane of Object.values(state.panes)) {
    fold(flows.tmux, pane.discoveredAt, pane.closedAt, pane.lastActivityTs, pane.lastContentChangeTs)
  }

  for (const agent of Object.values(state.agents)) {
    fold(flows.workmux, agent.firstSeenAt, agent.updatedAt)
  }

  const telemetry = state.telemetry
  for (const records of [telemetry.usage, telemetry.costs, telemetry.tools, telemetry.activeTime]) {
    // `TelemetryOrigin` is `'sessionlog' | 'otel'` — two of these five names,
    // which is what lets the envelope's own stamp pick the flow with no mapping
    // table to keep in step.
    for (const record of records) fold(flows[record.origin], record.ts)
  }
  for (const span of state.traces.spans) fold(flows.otel, span.ts)

  return {
    git: sourceFlow('git', flows.git),
    tmux: sourceFlow('tmux', flows.tmux),
    workmux: sourceFlow('workmux', flows.workmux),
    sessionlog: sourceFlow('sessionlog', flows.sessionlog),
    otel: sourceFlow('otel', flows.otel),
    uninstrumentedSessions: uninstrumentedSessions(state),
  }
}

/** A source's window and tally while it is being accumulated. */
interface Flow {
  first: number | null
  last: number | null
  count: number
}

function newFlow(): Flow {
  return { first: null, last: null, count: 0 }
}

/**
 * One folded record's whole contribution: it counts once, and every timestamp
 * it carries widens the window. A `null` timestamp is a fact the record simply
 * does not hold (a worktree still present has no `removedAt`) and never a
 * reason to skip counting the record itself.
 */
function fold(flow: Flow, ...stamps: readonly (number | null)[]): void {
  flow.count += 1
  for (const ts of stamps) {
    if (ts === null) continue
    flow.first = flow.first === null ? ts : Math.min(flow.first, ts)
    flow.last = flow.last === null ? ts : Math.max(flow.last, ts)
  }
}

function sourceFlow(source: ConnectionSource, flow: Flow): SourceFlow {
  return { source, firstEventTs: flow.first, lastEventTs: flow.last, count: flow.count }
}

/** What one session's two collectors have each proved about it. */
interface SessionEvidence {
  lanes: Set<string>
  roles: Set<AgentRole>
  first: number
  last: number
  otel: boolean
}

/**
 * The transcript-without-telemetry sweep, over the same slices the flows read.
 * A session is uninstrumented exactly when something `sessionlog` stamped names
 * it and nothing `otel` stamped does — its own records, or a span, since spans
 * are otel's alone. `lanes` is non-empty whenever `otel` is false: every sighting
 * that is not a sessionlog record sets the flag, and every sessionlog record
 * adds its lane, so the two conditions are one condition.
 *
 * **The one shape this cannot see, named rather than hidden.** Cross-collector
 * dedup can retire an OTel usage record into the sessionlog record it
 * duplicates (`reduce.ts`, `foldSessionCoverage`), leaving no otel-origin trace
 * of it — so a session whose *only* OTel evidence was a request-less usage
 * record reads as uninstrumented here. That case does not occur in a real
 * export: an instrumented session's metrics POST carries `llm.cost` and
 * `agent.activeTime` alongside its usage, and neither is ever deduped. And
 * where it did occur, the OTel side contributed nothing to any total either —
 * so "OTel proved nothing about this session" is still the true reading.
 */
function uninstrumentedSessions(state: SessionState): UninstrumentedSession[] {
  const bySession = new Map<string, SessionEvidence>()

  const see = (sessionId: string, ts: number): SessionEvidence => {
    const held = bySession.get(sessionId)
    if (held !== undefined) return held
    const fresh: SessionEvidence = { lanes: new Set(), roles: new Set(), first: ts, last: ts, otel: false }
    bySession.set(sessionId, fresh)
    return fresh
  }

  const telemetry = state.telemetry
  for (const records of [telemetry.usage, telemetry.costs, telemetry.tools, telemetry.activeTime]) {
    for (const record of records) {
      if (record.sessionId === null) continue
      const evidence = see(record.sessionId, record.ts)
      if (record.origin === 'otel') {
        evidence.otel = true
        continue
      }
      evidence.lanes.add(record.lane)
      // `tool.activity` is the one record whose role may be null: the collector
      // saw the call without knowing whose lane it was. Absent, not `main`.
      if (record.role !== null) evidence.roles.add(record.role)
      evidence.first = Math.min(evidence.first, record.ts)
      evidence.last = Math.max(evidence.last, record.ts)
    }
  }
  for (const span of state.traces.spans) {
    if (span.sessionId === null) continue
    see(span.sessionId, span.ts).otel = true
  }

  const uninstrumented: UninstrumentedSession[] = []
  for (const [sessionId, evidence] of bySession) {
    if (evidence.otel) continue
    uninstrumented.push({
      sessionId,
      lanes: [...evidence.lanes].sort(compareStrings),
      roles: [...evidence.roles].sort(compareStrings),
      firstEventTs: evidence.first,
      lastEventTs: evidence.last,
    })
  }

  return uninstrumented.sort(
    (a, b) => a.firstEventTs - b.firstEventTs || compareStrings(a.sessionId, b.sessionId),
  )
}
