import type {
  CollisionDelta,
  EventQuery,
  EventRow,
  EventsPort,
  LaneStateDelta,
  ProjectionDelta,
  SpendDelta,
} from './port.js'

export interface EventsFake extends EventsPort {
  readonly events: EventRow[]
  readonly partitions: string[]
  /** `spend_by_project_day`, keyed `projectId day`. */
  readonly spend: Map<string, SpendDelta>
  /** `lane_state`, keyed `projectId lane`. */
  readonly lanes: Map<string, LaneStateDelta>
  /** `collisions`, keyed `projectId path`. */
  readonly collisions: Map<string, CollisionDelta>
}

export function createEventsFake(calls: string[]): EventsFake {
  const events: EventRow[] = []
  const partitions: string[] = []
  const spend = new Map<string, SpendDelta>()
  const lanes = new Map<string, LaneStateDelta>()
  const collisions = new Map<string, CollisionDelta>()
  /** The unique index each partition carries: `projectId actorInstance n`. */
  const positions = new Set<string>()

  /** The three projections, folded the way the adapter's upserts would. */
  function applyProjections(delta: ProjectionDelta): void {
    for (const entry of delta.spend) {
      const key = `${entry.projectId} ${entry.day}`
      const current = spend.get(key)
      spend.set(key, {
        projectId: entry.projectId,
        day: entry.day,
        costUsd: (current?.costUsd ?? 0) + entry.costUsd,
        events: (current?.events ?? 0) + entry.events,
      })
    }
    for (const lane of delta.lanes) {
      const key = `${lane.projectId} ${lane.lane}`
      const current = lanes.get(key)
      // The adapter's `WHERE EXCLUDED.last_event_ts >= lane_state.last_event_ts`.
      if (current && lane.lastEventTsMs < current.lastEventTsMs) continue
      lanes.set(key, {
        projectId: lane.projectId,
        lane: lane.lane,
        state: lane.state ?? current?.state ?? 'unknown',
        worktree: lane.worktree ?? current?.worktree ?? null,
        lastEventTsMs: lane.lastEventTsMs,
      })
    }
    for (const collision of delta.collisions) {
      const key = `${collision.projectId} ${collision.path}`
      const current = collisions.get(key)
      collisions.set(key, {
        projectId: collision.projectId,
        path: collision.path,
        lanes: [...new Set([...(current?.lanes ?? []), ...collision.lanes])].sort(),
        firstSeenMs: Math.min(current?.firstSeenMs ?? collision.firstSeenMs, collision.firstSeenMs),
        lastSeenMs: Math.max(current?.lastSeenMs ?? collision.lastSeenMs, collision.lastSeenMs),
      })
    }
  }

  return {
    events,
    partitions,
    spend,
    lanes,
    collisions,

    /**
     * Dedups on `(projectId, actorInstance, n)` and maintains the projections,
     * because the adapter does and this double must not be kinder than it.
     *
     * A fake that appended unconditionally would make every replay test above it
     * a lie: the fold's whole rewind story is "a replay costs time, not rows",
     * and against a double that duplicates, a test asserting N rows after two
     * folds would have to assert 2N to pass — i.e. it would certify the defect.
     */
    async appendEvents(
      rows: readonly EventRow[],
      projectionsFor?: (inserted: readonly EventRow[]) => ProjectionDelta,
    ): Promise<number> {
      calls.push('appendEvents')
      const inserted: EventRow[] = []
      for (const row of rows) {
        const key = `${row.projectId} ${row.actorInstance} ${row.n}`
        if (positions.has(key)) continue
        positions.add(key)
        events.push(row)
        inserted.push(row)
      }
      if (projectionsFor) applyProjections(projectionsFor(inserted))
      return inserted.length
    },

    async readEvents(q: EventQuery): Promise<EventRow[]> {
      calls.push('readEvents')
      return events
        .filter(
          (e) =>
            e.projectId === q.projectId &&
            e.actorInstance === q.actorInstance &&
            e.n >= q.fromN &&
            e.n <= q.toN,
        )
        .sort((a, b) => a.n - b.n)
    },

    async ensureMonthlyPartition(month: string): Promise<void> {
      calls.push('ensureMonthlyPartition')
      if (!partitions.includes(month)) partitions.push(month)
    },
  }
}
