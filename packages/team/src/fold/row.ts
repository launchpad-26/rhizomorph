import { readEventLineLenient } from '@rhizomorph/core/src/events/index.js'
import type { EventRow } from '../storage/contract.js'

/**
 * ONE WIRE LINE -> ONE EVENT ROW.
 *
 * The fold's only parse. It uses `packages/core`'s own lenient reader rather
 * than a second one, for the reason `packages/core/src/wire/reserialize.ts`
 * gives one layer over: a second parser is a second allowlist, and two
 * allowlists is how a dropped field finds its way back.
 *
 * **`line` is stored VERBATIM — the input bytes, not a re-serialization.** The
 * shipper already re-serialized through the current schema (ruling 6), and
 * ruling 5 rests the whole re-export-and-re-verify claim on these bytes
 * reaching storage untouched. Re-serializing here would be a second
 * transformation of something already canonical, and the failure would be
 * invisible: the row would still parse.
 *
 * ## An unfoldable line LANDS; a malformed one still refuses (ruling 16)
 *
 * Ruling 3's invariant is *no gaps in `n`*, so this function may not silently drop a position
 * and fold the rest. It does not have to: an `unknown` line has an intact envelope, so the row
 * lands with its `type` recorded, its `line` untouched and its payload whatever the line
 * carries, and there is no gap to forbid. That is why ruling 16 beat a quarantine table — the
 * bytes were already in the fold's hand.
 *
 * `malformed` is unchanged and still refuses loudly. A corrupt line in a journal the ingest
 * fsynced is a fault in the journal, not skew between two builds, and `parseEventLenient`'s own
 * words are *"calling that 'a newer era' would be a lie"*.
 *
 * **The derived columns are nulled at source on an unfoldable row.** `laneOf` and `worktreeOf`
 * would read a payload this build refused to validate, and a marker read downstream in
 * `projections.ts` cannot see a derivation that already happened — a projection reads a column,
 * it does not derive a value. EXECUTED in the review of #417: the downstream-guard-only remedy
 * closed the money leak and left `lane_state` receiving both a lane and a worktree from that
 * payload. The cost is `events.lane`/`events.worktree` null on that row, which is recoverable
 * precisely because `line` is preserved verbatim.
 */

export type ToEventRowResult = { ok: true; row: EventRow } | { ok: false; error: string }

/** A payload field read defensively: the schema union is wide and a fold must not narrow it. */
function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The lane an event belongs to, or `null`.
 *
 * `payload.lane` is the telemetry attribution field every `llm.*`, `tool.*` and
 * trace payload carries. `payload.handle` is workmux's name for the same thing
 * on `agent.status` — the schema calls it *"workmux's handle for the agent — its
 * window/worktree name"*, which is a lane by another name, and reading only
 * `lane` would leave `lane_state` with nothing to key on for the one event type
 * that carries a state at all.
 *
 * Nothing further is tried. An event with neither field genuinely has no lane;
 * inventing one from `branch` or from the worktree path would put a fact in the
 * column that no collector asserted.
 */
export function laneOf(payload: unknown): string | null {
  return stringField(payload, 'lane') ?? stringField(payload, 'handle')
}

/**
 * The worktree an event belongs to, or `null`.
 *
 * Fed from `payload.worktreePath` and nothing else: no event schema in
 * `packages/core/src/events/` declares a top-level `worktree`, so an event
 * whose payload has no `worktreePath` has no worktree, and the column is null.
 */
export function worktreeOf(payload: unknown): string | null {
  return stringField(payload, 'worktreePath')
}

export function toEventRow(
  projectId: string,
  actorInstance: string,
  n: number,
  line: string,
): ToEventRowResult {
  const parsed = readEventLineLenient(line)
  if (parsed.kind === 'malformed') {
    return { ok: false, error: `n=${n} is not an event line: ${parsed.error}` }
  }
  if (parsed.kind === 'unknown') {
    const { unknown } = parsed
    return {
      ok: true,
      row: {
        projectId,
        actorInstance,
        n,
        eventId: unknown.id,
        tsMs: unknown.ts,
        type: unknown.type,
        source: unknown.source,
        // Nulled at source, not guarded downstream — see this module's docblock.
        lane: null,
        worktree: null,
        payload: unknown.payload,
        // The caller's own bytes, not `unknown.line`. They are equal here, and routing them
        // through a second hop would make that equality something a reader has to re-establish.
        line,
        unfoldable: unknown.reason,
      },
    }
  }

  const event = parsed.event
  return {
    ok: true,
    row: {
      projectId,
      actorInstance,
      n,
      eventId: event.id,
      tsMs: event.ts,
      type: event.type,
      source: event.source,
      lane: laneOf(event.payload),
      worktree: worktreeOf(event.payload),
      payload: event.payload,
      line,
    },
  }
}
