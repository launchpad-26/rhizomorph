import {
  agentStatusSchema,
  compareStrings,
  type AgentStatus,
  type RhizomorphEvent,
} from '@rhizomorph/core'
import { IDLE_AFTER_MS, type LaneActivity } from '../fleet/buildFleet.js'

/**
 * THE TIDE'S CONTRACT (issue #167, prd13 wave 1) — a lane's history as a
 * sequence of bands: `ke5 was WORKING 14:00–14:38, WAITING 14:38–14:52, …`.
 *
 * This file computes them and renders nothing. The TIDE is the replay bar's
 * body (prd13 ruling 1) and three later waves draw from exactly this shape;
 * anything that reads a pixel, a DOM node or a React hook has left the lane.
 *
 * ## What the log is allowed to say
 *
 * Two kinds of event carry a state, and they are read the two different ways
 * `buildFleet` already reads them:
 *
 * - **`agent.status` is a level.** workmux *declares* a state, and the
 *   declaration stands until workmux declares another one — the same reading
 *   `Lane.agentStatus` gets, where the last report is the current one.
 * - **`llm.usage` / `llm.cost` / `tool.activity` / `trace.span` are edges.**
 *   Each is one instant of work — precisely the set `buildFleet`'s `lastWorkTs`
 *   folds ("a model request, a tool call, a trace span … Pane activity is
 *   deliberately excluded") — and each attests `working` for
 *   {@link IDLE_AFTER_MS} after itself, which is `activityOf`'s own rule
 *   (`workAgeMs <= IDLE_AFTER_MS ? 'working' : 'idle'`) restated as an
 *   interval instead of a reading against a clock. The constant is imported,
 *   never re-tuned here.
 *
 * When those two disagree — a `tool.activity` lands while workmux says
 * `waiting` — **the declaration wins**, because that is the precedence
 * `activityOf` already applies (it tests `agentStatus` before work age). One
 * mapping, one place, no drift.
 *
 * ## What the log is not allowed to say
 *
 * Everything else is **absence**, and absence is a {@link GapBand} — prd13
 * ruling 8, the honest-gaps law on a new surface. In particular:
 *
 * - `idle` and `unknown` are members of the ladder vocabulary this file
 *   imports, and this file **never emits them**. Both are judgements about a
 *   lane measured against *now*; a region no event attests is not idle, it is
 *   unobserved, and rendering it as a fill "could be mistaken for a state".
 *   An uninstrumented lane comes out of here as one long gap, which is exactly
 *   ruling 8's requirement that it "must not look like an idle one".
 * - `broken` is a {@link import('../fleet/buildFleet.js').LadderRank}, not an
 *   activity: it is FROZEN's alarm, derived from silence against a clock. Here
 *   that silence *is* the gap, so a band never claims it.
 * - `parked` is an operator declaration in `.swarm/lanes.json` (prd4 ruling 5),
 *   read from the manifest and never from the log — `Lane.parked` says so
 *   itself. No event attests it, so no band can.
 *
 * That leaves exactly {@link BAND_STATES}: the three states workmux declares,
 * which are a subset of the ladder vocabulary rather than a new one.
 *
 * ## What a band is keyed by
 *
 * The **telemetry handle the event itself names** — `payload.lane` for the
 * money layer and the trace layer, `payload.handle` for workmux, one shared
 * swarm-handle namespace by construction. Git and tmux facts (a commit, a
 * dirty-set change, a pane repaint) are keyed by branch or path instead, and
 * joining those to a handle is `buildFleet`'s `resolveLaneId` — which is not
 * exported, and copying it here would be drift-by-construction. So this
 * selector reads only the events that attribute themselves, and identity
 * resolution stays in the one place that already does it.
 */

// ── vocabulary ──────────────────────────────────────────────────────────────

/**
 * The states a band may carry: `workmux`'s own enum, taken from the schema so
 * the vocabulary cannot drift from the event contract even by a typo.
 */
export const BAND_STATES = agentStatusSchema.options

export type BandState = AgentStatus

/**
 * Compile-time proof that a band state is a ladder state (prd4 law 9a/9b's
 * vocabulary, `LaneActivity`) rather than a second scale invented here. If the
 * ladder ever renames or drops a member, this stops compiling — which is the
 * point: the failure lands on this file rather than on a surface painting a
 * hue nobody defined.
 */
export const BAND_STATE_IS_LADDER_VOCABULARY: BandState extends LaneActivity ? true : false = true

// ── bands ───────────────────────────────────────────────────────────────────

interface BandSpan {
  /** Telemetry handle. Not a `Lane.id` — see the module note on keying. */
  lane: string
  startTs: number
  /**
   * `null` for the last band of a lane, which is still in force: the log's own
   * edge, not a claim that it ends there. Every earlier band is closed.
   */
  endTs: number | null
  /**
   * Observed length. For an open band that is `lastSeenTs - startTs` — how much
   * of it the log has witnessed so far — so that a lane's durations always sum
   * to its observed span, live and in replay alike.
   */
  durationMs: number
}

/** A region the events attest a state for. */
export interface StateBand extends BandSpan {
  kind: 'state'
  state: BandState
}

/**
 * A region the events attest *nothing* for (prd13 ruling 8). Distinct in type,
 * not merely in value: a `kind` discriminant means a renderer cannot read
 * `.state` off absence, however hard it tries.
 */
export interface GapBand extends BandSpan {
  kind: 'gap'
}

export type Band = StateBand | GapBand

/** One lane's whole history: contiguous bands tiling `[firstSeenTs, lastSeenTs]`. */
export interface LaneBands {
  lane: string
  /** First event that named this lane — the session-stable ordering key (ruling 3). */
  firstSeenTs: number
  /** Last event that named it. The open band's right edge is measured to here. */
  lastSeenTs: number
  /** At least one band, always: a lane exists here only because an event named it. */
  bands: readonly [Band, ...Band[]]
}

// ── which events say what ───────────────────────────────────────────────────

/**
 * The work witnesses — `buildFleet`'s `lastWorkTs` set, exactly. `pane.activity`
 * is absent on purpose ("a terminal repainting a prompt is a sign of life, not
 * a sign of progress"), and so is `agent.activeTime`: a metrics POST is
 * exported on a timer whether or not the agent did anything, so it proves the
 * lane exists without attesting a single moment of work.
 */
export const WORK_WITNESS_TYPES = ['llm.usage', 'llm.cost', 'tool.activity', 'trace.span'] as const

const WORK_WITNESSES = new Set<string>(WORK_WITNESS_TYPES)

/** What an event says about its lane, or `null` when it only proves it exists. */
interface Attestation {
  state: BandState
  /** True when workmux said so; false when it was read off a work witness. */
  declared: boolean
}

/**
 * The handle an event files itself under, or `null` when it does not attribute
 * itself to a lane at all. See the module note: a branch or a path is not a
 * handle, and turning one into the other belongs to `buildFleet`.
 */
export function laneOf(event: RhizomorphEvent): string | null {
  switch (event.type) {
    case 'agent.status':
      return event.payload.handle
    case 'llm.usage':
    case 'llm.cost':
    case 'tool.activity':
    case 'trace.span':
    case 'agent.activeTime':
      return event.payload.lane
    default:
      return null
  }
}

function attestationOf(event: RhizomorphEvent): Attestation | null {
  if (event.type === 'agent.status') return { state: event.payload.status, declared: true }
  if (WORK_WITNESSES.has(event.type)) return { state: 'working', declared: false }
  return null
}

// ── the fold ────────────────────────────────────────────────────────────────

type OpenBand =
  | { kind: 'state'; state: BandState; declared: boolean; startTs: number; expiresAt: number }
  | { kind: 'gap'; startTs: number }

interface LaneCursor {
  lane: string
  firstSeenTs: number
  lastSeenTs: number
  closed: Band[]
  open: OpenBand
}

/**
 * Every lane's bands, in one forward pass over the log — O(n) in events, with
 * one `Map` lookup and at most one band pushed per event.
 *
 * Laws this function is the sole author of, each one stated again as a test:
 *
 * 1. **Contiguous and non-overlapping.** Band *i*'s `endTs` is band *i+1*'s
 *    `startTs`, and the run tiles `[firstSeenTs, lastSeenTs]` exactly, so the
 *    durations sum to the lane's observed span. No gaps between the gaps.
 * 2. **A gap never becomes a state.** A state band exists only where an
 *    attestation was in force; nothing widens one to cover silence.
 * 3. **Same selector, live and replay.** Over any time-prefix of the log the
 *    bands are the whole log's bands truncated at that instant — the product's
 *    core law, and the reason the TIDE can be one surface rather than two.
 * 4. **Deterministic.** Same events in, byte-equal bands out; no clock is read
 *    and no `now` is taken, so there is nothing here to be flaky about.
 *
 * The log is expected in non-decreasing `ts` order, as `jsonl` appends it. An
 * event that arrives out of order is clamped to the lane's own cursor rather
 * than rewinding it, so laws 1 and 2 hold for *every* input, not just for
 * well-formed ones.
 */
export function bandsFor(events: readonly RhizomorphEvent[]): readonly LaneBands[] {
  const cursors = new Map<string, LaneCursor>()

  for (const event of events) {
    const lane = laneOf(event)
    if (lane === null) continue

    const attestation = attestationOf(event)
    const cursor = cursors.get(lane)

    if (cursor === undefined) {
      cursors.set(lane, {
        lane,
        firstSeenTs: event.ts,
        lastSeenTs: event.ts,
        closed: [],
        open:
          attestation === null
            ? { kind: 'gap', startTs: event.ts }
            : openStateAt(event.ts, attestation),
      })
      continue
    }

    // Never rewind: a lane's timeline only moves forward, whatever the log's
    // ordering. (A well-formed log makes this a no-op.)
    const ts = Math.max(event.ts, cursor.lastSeenTs)

    // 1. A witness's horizon may have run out before this event arrived. The
    //    moment it did is where coverage stopped, so the gap starts *there*
    //    and not at the event that happened to notice.
    if (cursor.open.kind === 'state' && cursor.open.expiresAt <= ts) {
      const lapsedAt = cursor.open.expiresAt
      close(cursor, lapsedAt)
      cursor.open = { kind: 'gap', startTs: lapsedAt }
    }

    // 2. Then apply whatever this event attests.
    if (attestation !== null) {
      const open = cursor.open
      if (open.kind === 'state' && open.declared && !attestation.declared) {
        // A standing declaration outranks an inference — `activityOf`'s own
        // precedence. A declaration has no horizon to refresh, so: nothing.
      } else if (open.kind === 'state' && open.state === attestation.state) {
        // The same state continuing is one band, not two abutting ones.
        open.declared = open.declared || attestation.declared
        open.expiresAt = attestation.declared
          ? Number.POSITIVE_INFINITY
          : Math.max(open.expiresAt, ts + IDLE_AFTER_MS)
      } else {
        close(cursor, ts)
        cursor.open = openStateAt(ts, attestation)
      }
    }

    cursor.lastSeenTs = ts
  }

  return [...cursors.values()]
    .map((cursor): LaneBands => {
      // The open band is emitted last and left open: it is in force at the
      // log's edge, and only the caller knows where "now" is. There is always
      // at least this one, which is what makes the run non-empty.
      const bands: Band[] = cursor.closed.concat(bandOf(cursor, cursor.open, null))
      return {
        lane: cursor.lane,
        firstSeenTs: cursor.firstSeenTs,
        lastSeenTs: cursor.lastSeenTs,
        bands: bands as [Band, ...Band[]],
      }
    })
    .sort((a, b) => a.firstSeenTs - b.firstSeenTs || compareStrings(a.lane, b.lane))
}

function openStateAt(ts: number, attestation: Attestation): OpenBand {
  return {
    kind: 'state',
    state: attestation.state,
    declared: attestation.declared,
    startTs: ts,
    // A declaration stands until the next one; a witness only speaks for the
    // window `activityOf` would still have called it `working` in.
    expiresAt: attestation.declared ? Number.POSITIVE_INFINITY : ts + IDLE_AFTER_MS,
  }
}

/**
 * Seals the open band at `endTs`. A band of no duration is not a band — two
 * facts landing on the same millisecond leave one of them nothing to cover —
 * and dropping it preserves the tiling exactly, because its start and end are
 * the same instant.
 */
function close(cursor: LaneCursor, endTs: number): void {
  if (endTs > cursor.open.startTs) cursor.closed.push(bandOf(cursor, cursor.open, endTs))
}

function bandOf(cursor: LaneCursor, open: OpenBand, endTs: number | null): Band {
  const durationMs = (endTs ?? cursor.lastSeenTs) - open.startTs
  return open.kind === 'gap'
    ? { kind: 'gap', lane: cursor.lane, startTs: open.startTs, endTs, durationMs }
    : { kind: 'state', lane: cursor.lane, state: open.state, startTs: open.startTs, endTs, durationMs }
}

/** Sums a run of bands. The number every law about duration is stated against. */
export function totalDurationMs(bands: readonly Band[]): number {
  return bands.reduce((sum, band) => sum + band.durationMs, 0)
}
