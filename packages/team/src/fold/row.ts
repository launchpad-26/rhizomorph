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
 * An unfoldable line refuses rather than being skipped. Ruling 3's invariant is
 * *no gaps in `n`*, so silently dropping one position and folding the rest
 * would create exactly the gap the invariant forbids — the caller
 * (`worker.ts`) aborts the whole run instead, leaving the cursor where it was.
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
    return {
      ok: false,
      error: `n=${n} carries ${parsed.unknown.type}, which this build cannot fold (${parsed.unknown.reason}): ${parsed.unknown.detail}`,
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
