import {
  agentStatusSchema,
  type AgentStatus,
  type Collector,
  type CollectorContext,
  type ExecResult,
  type ObservatoryEvent,
  type PollResult,
} from '@observatory/core'
import { parseElapsed, parseListTable, parseStatusTable } from './parse.js'

interface WorkmuxAgentSnapshot {
  status: AgentStatus
  branch: string | null
  worktreePath: string | null
}

export interface WorkmuxSnapshot {
  /** Set once the binary is confirmed missing, so we stop shelling out. */
  disabled: boolean
  agents: Record<string, WorkmuxAgentSnapshot>
}

/** True only when the binary itself could not be run — not for a non-zero exit with real output. */
function isMissingBinary(result: ExecResult): boolean {
  return result.failed && result.errorMessage !== undefined
}

/**
 * Shells to `workmux status` (handle/status/elapsed/title) and `workmux list`
 * (branch/path), joining on handle. Emits `agent.status` only when an
 * agent's status, branch or worktree path actually changes — elapsed alone
 * ticking up every poll is not a state change worth logging.
 */
export function createWorkmuxCollector(): Collector<WorkmuxSnapshot> {
  return {
    name: 'workmux',

    initialSnapshot(): WorkmuxSnapshot {
      return { disabled: false, agents: {} }
    },

    async poll(prevSnapshot, context: CollectorContext): Promise<PollResult<WorkmuxSnapshot>> {
      if (prevSnapshot.disabled) {
        return { nextSnapshot: prevSnapshot, events: [] }
      }

      const statusResult = await context.exec('workmux', ['status'])
      if (isMissingBinary(statusResult)) {
        return {
          nextSnapshot: { disabled: true, agents: {} },
          events: [
            context.emit('collector.disabled', {
              collector: 'workmux',
              reason: statusResult.errorMessage ?? 'workmux binary not found',
            }),
          ],
        }
      }

      const statusRows = parseStatusTable(statusResult.stdout)

      const listResult = await context.exec('workmux', ['list'])
      const listRows = isMissingBinary(listResult) || listResult.failed
        ? []
        : parseListTable(listResult.stdout)
      const listByHandle = new Map(listRows.map((row) => [row.branch, row]))

      const nextAgents: WorkmuxSnapshot['agents'] = {}
      const events: ObservatoryEvent[] = []

      for (const row of statusRows) {
        const statusCheck = agentStatusSchema.safeParse(row.status)
        if (!statusCheck.success) {
          events.push(
            context.emit('collector.error', {
              collector: 'workmux',
              message: `unrecognised agent status '${row.status}' for handle '${row.handle}'`,
            }),
          )
          continue
        }
        const status = statusCheck.data

        const listRow = listByHandle.get(row.handle)
        const branch = listRow?.branch ?? null
        const worktreePath = listRow?.path ?? null

        const prevAgent: WorkmuxAgentSnapshot | undefined = prevSnapshot.agents[row.handle]
        const changed =
          !prevAgent ||
          prevAgent.status !== status ||
          prevAgent.branch !== branch ||
          prevAgent.worktreePath !== worktreePath

        if (changed) {
          events.push(
            context.emit('agent.status', {
              handle: row.handle,
              status,
              branch,
              worktreePath,
              elapsedSeconds: row.elapsedSeconds,
              detail: row.detail ?? undefined,
            }),
          )
        }

        nextAgents[row.handle] = { status, branch, worktreePath }
      }

      return { nextSnapshot: { disabled: false, agents: nextAgents }, events }
    },
  }
}

export { parseElapsed, parseListTable, parseStatusTable }
