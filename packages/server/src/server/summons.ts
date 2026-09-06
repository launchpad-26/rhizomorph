import { PATHOLOGY_RANK, type PathologyKind } from '@rhizomorph/core'

/**
 * prd17 ruling 5 — the summons raiser's edge-trigger, isolated from the poll
 * loop that drives it. See `docs/adr/` for why this is not a collector: the
 * collector contract hands a collector `repoPath`, `now`, `exec`, `nextId` and
 * `emit`, never the folded state this needs to read.
 *
 * Everything here is a pure function over plain data — no clock read, no I/O,
 * no import of `poll-loop.ts` or of `Fleet`/`Lane` themselves. `poll-loop.ts`
 * is the one place that reads `recorder.foldSoFar()`, calls `buildFleet`, and
 * turns its lanes into the `SummonsCondition[]` this module actually asks
 * for — keeping that translation in the tick is what lets this file's own
 * tests build a three-field fixture instead of a forty-field `Lane`.
 */

/**
 * Which pathology kinds raise a summons at all — the DoD's "first entries of
 * the kind vocabulary", chosen here rather than hand-listed: anything core's
 * own ladder already ranks above `notice` (today: `frozen`, `looping`,
 * `waiting`, `off-fence`) is summons-worthy, and `expensive` — the one
 * `notice`-rank pathology — is deliberately excluded, matching
 * `docs/architecture.md`'s own line that a notice "never escalate[s]... regardless
 * of age". Deriving this from `PATHOLOGY_RANK` instead of a second hardcoded
 * list is the point: the ladder's own judgement of what deserves interruption
 * is asked once, not re-decided here. A future pathology defaults to
 * summons-worthy unless the ladder itself files it under `notice` — this does
 * not close the enum, it just never drifts from the ladder that already
 * answers the question.
 */
export function isSummonsKind(kind: PathologyKind): boolean {
  return PATHOLOGY_RANK[kind] !== 'notice'
}

/**
 * One lane's currently-true alarm condition, as `poll-loop.ts` reads it off
 * `Fleet`'s own `Lane.pathologies` for one tick. `since`/`detail` are carried
 * straight from the pathology core already computed (`Pathology.since`,
 * `evidenceLine(pathology)`) — nothing here re-derives evidence core already
 * has.
 */
export interface SummonsCondition {
  /** `Lane.id` — the alarm point's other half, with `kind` (schema doc on `events/summons.ts`). */
  lane: string
  kind: string
  /**
   * When the underlying condition began (`Pathology.since`), which may
   * predate this tick's own clock reading — the same reason
   * `SummonsRaisedPayload.raisedAt` is a distinct field from the envelope's
   * `ts`. Null falls back to the tick's `now` at raise time: the earliest
   * instant this module can honestly name.
   */
  since: number | null
  /** Straight from `evidenceLine(pathology)` — never re-derived here. */
  detail?: string
}

/** One (lane, kind) pair with a summons currently open. The persisted shape — plain data, JSON in and out, the same contract as a collector's own `SnapshotStore` entry. */
export interface SummonsPoint {
  lane: string
  kind: string
}

export interface SummonsRaise {
  lane: string
  kind: string
  raisedAt: number
  detail?: string
}

export interface SummonsClear {
  lane: string
  kind: string
  clearedAt: number
}

export interface SummonsDiff {
  readonly raised: readonly SummonsRaise[]
  readonly cleared: readonly SummonsClear[]
}

/**
 * Reserved `SnapshotStore` key for the raiser's own edge-state. `SnapshotStore`
 * is keyed by plain string, with no registry of which strings a real
 * collector might use — `'summons'` is not, and is never going to become, one
 * of `git` / `tmux` / `workmux` / `sessionlog` / `pi` / `judge` / `beacon` /
 * `otel` / `codex` (see `docs/adr/`).
 */
export const SUMMONS_SNAPSHOT_KEY = 'summons'

const KEY_SEP = '\u0000'

function keyOf(point: SummonsPoint): string {
  return `${point.lane}${KEY_SEP}${point.kind}`
}

/**
 * The edge-trigger itself. `previous` is whatever the last tick (or the last
 * restart's persisted snapshot) says was open; `current` is this tick's whole
 * judgement, not a diff — the caller never tracks deltas itself. Returns only
 * what CHANGED, plus the next snapshot to persist.
 *
 * **Mutation #1 (DoD):** a condition that is still true this tick is in both
 * `previous` and `current` under the same key, so it produces neither a raise
 * nor a clear — ticking repeatedly with nothing changed returns
 * `{ raised: [], cleared: [] }` every time after the first.
 *
 * **Sibling case (DoD):** `cleared` is built from `previous` alone — every
 * point missing from `current` clears, with no check that this process ever
 * emitted its raise. A condition whose raise predates a restart, or whose
 * whole lifetime fit between two ticks nobody else saw, still clears exactly
 * once: `previous` came from whatever the caller (or a restored snapshot)
 * says was open, never from an in-memory "did I already announce this" flag.
 */
export function diffSummons(
  previous: readonly SummonsPoint[],
  current: readonly SummonsCondition[],
  now: number,
): { diff: SummonsDiff; next: readonly SummonsPoint[] } {
  const seen = new Set<string>()
  const currentPoints: SummonsPoint[] = []
  const raised: SummonsRaise[] = []

  const previousKeys = new Set(previous.map(keyOf))

  for (const condition of current) {
    const point: SummonsPoint = { lane: condition.lane, kind: condition.kind }
    const key = keyOf(point)
    // A lane naming the same kind twice in one tick's fleet is one point, not
    // two — buildFleet never does this today, but the dedupe costs nothing
    // and means this module never has to trust that it never will.
    if (seen.has(key)) continue
    seen.add(key)
    currentPoints.push(point)

    if (!previousKeys.has(key)) {
      raised.push({
        lane: point.lane,
        kind: point.kind,
        raisedAt: condition.since ?? now,
        ...(condition.detail !== undefined ? { detail: condition.detail } : {}),
      })
    }
  }

  const cleared: SummonsClear[] = previous
    .filter((point) => !seen.has(keyOf(point)))
    .map((point) => ({ lane: point.lane, kind: point.kind, clearedAt: now }))

  return { diff: { raised, cleared }, next: currentPoints }
}
