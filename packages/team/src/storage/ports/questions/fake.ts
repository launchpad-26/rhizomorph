import type { CollisionRow, LaneRow, QuestionsPort, SpendRow } from './port.js'

export interface QuestionsFake extends QuestionsPort {
  /** `spend_by_project_day` rows the fake will return, in insertion order. */
  readonly spendRows: SpendRow[]
  /** `lane_state` rows. */
  readonly laneRows: LaneRow[]
  /** `collisions` rows. */
  readonly collisionRows: CollisionRow[]
}

/**
 * THE FAKE FILTERS BY PROJECT, AND THAT IS NOT COSMETIC.
 *
 * In the real adapter RLS does the narrowing and the `where project_id =` is a
 * second, narrower fence over a read the policies have already scoped. A fake
 * that ignored `projectId` would let a view test pass while returning another
 * project's rows — the precise failure the whole `rz_viewer` apparatus exists to
 * prevent — so the fake reproduces the narrowing rather than the mechanism.
 *
 * The ordering mirrors `sql.ts`: newest day first, lanes by name, collisions by
 * last seen. A view that depends on order is then testing the same order it
 * will get.
 */
export function createQuestionsFake(calls: string[]): QuestionsFake {
  const spendRows: SpendRow[] = []
  const laneRows: LaneRow[] = []
  const collisionRows: CollisionRow[] = []

  return {
    spendRows,
    laneRows,
    collisionRows,
    async readSpendByDay(projectId: string): Promise<SpendRow[]> {
      calls.push('readSpendByDay')
      return spendRows.filter((r) => r.projectId === projectId).sort((a, b) => b.day.localeCompare(a.day))
    },
    async readLaneState(projectId: string): Promise<LaneRow[]> {
      calls.push('readLaneState')
      return laneRows.filter((r) => r.projectId === projectId).sort((a, b) => a.lane.localeCompare(b.lane))
    },
    async readCollisions(projectId: string): Promise<CollisionRow[]> {
      calls.push('readCollisions')
      return collisionRows.filter((r) => r.projectId === projectId).sort((a, b) => b.lastSeenMs - a.lastSeenMs)
    },
  }
}
