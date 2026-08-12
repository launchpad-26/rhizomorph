import { basename } from 'node:path'
import {
  agentStatusSchema,
  type AdapterCapabilities,
  type AgentStatus,
  type Collector,
  type CollectorContext,
  type ExecResult,
  type RhizomorphEvent,
  type PollResult,
} from '@rhizomorph/core'
import { parseElapsed, parseListTable, parseStatusTable } from './parse.js'

/**
 * prd15 ruling 5's L4 rung: the full rig. `agent.status` is the ladder's
 * *only* non-heuristic live attention signal today (ruling 4's adapter
 * matrix) — everything else on this ladder infers; workmux declares. No
 * telemetry of its own (that's L1's OTLP env, or the sessionlog organ).
 */
export const WORKMUX_CAPABILITIES: AdapterCapabilities = {
  identity: { level: 'provided' },
  liveness: { level: 'provided' },
  activity: { level: 'provided' },
  attention: { level: 'provided' },
  telemetry: {
    level: 'absent',
    reason: 'workmux status carries no token data',
    remedy: 'the sessionlog transcript organ reads tokens from the CLI transcript',
  },
  cost: {
    level: 'absent',
    reason: 'workmux status carries no cost data',
    remedy: 'env vars at launch (`rhizomorph env <lane>`) bring OTLP dollars',
  },
}

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
    capabilities: WORKMUX_CAPABILITIES,

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

      if (statusResult.failed) {
        // Ruling 3, direction 1: a non-ENOENT failure (workmux itself errored —
        // a corrupted session index, a dead server) is a transient, not proof
        // every agent vanished. Carry the roster forward and let withResilience's
        // own degraded/disabled ladder (ruling 2, already wired at the loader
        // seam) decide how many consecutive misses this survives, instead of
        // parsing empty stdout and reading that as "zero agents."
        return {
          nextSnapshot: { ...prevSnapshot, disabled: true },
          events: [
            context.emit('collector.disabled', {
              collector: 'workmux',
              reason:
                statusResult.errorMessage ??
                (statusResult.stderr.trim().length > 0
                  ? statusResult.stderr.trim()
                  : 'workmux status exited non-zero'),
            }),
          ],
        }
      }

      const statusRows = parseStatusTable(statusResult.stdout)

      const listResult = await context.exec('workmux', ['list'])
      const listRows = isMissingBinary(listResult) || listResult.failed
        ? []
        : parseListTable(listResult.stdout)
      // workmux's own name for a worktree is the WORKTREE column in `status` and
      // the basename of the PATH column in `list` — the same identity, since
      // workmux names the directory after the handle. The BRANCH column is the
      // git branch actually checked out there, a different namespace once a
      // branch contains a character (`/`) illegal in a directory name. `(here)`
      // carries no path to take a basename from — it falls back to branch,
      // unchanged from today's behaviour for that one row.
      const listByHandle = new Map(
        listRows.map((row) => [row.path === '(here)' ? row.branch : basename(row.path), row]),
      )

      const nextAgents: WorkmuxSnapshot['agents'] = {}
      const events: RhizomorphEvent[] = []
      const seenHandles = new Set<string>()

      for (const row of statusRows) {
        seenHandles.add(row.handle)
        const statusCheck = agentStatusSchema.safeParse(row.status)
        if (!statusCheck.success) {
          events.push(
            context.emit('collector.error', {
              collector: 'workmux',
              message: `unrecognised agent status '${row.status}' for handle '${row.handle}'`,
            }),
          )
          // Ruling 4 (quarantine one record, never the collector) must not
          // collide with ruling 3: a malformed row is not proof its handle is
          // gone, so carry the last known agent forward if there was one.
          const existingAgent = prevSnapshot.agents[row.handle]
          if (existingAgent) nextAgents[row.handle] = existingAgent
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

      // Ruling 3, direction 2: a handle workmux no longer lists at all, in an
      // otherwise successful, well-formed poll, is genuinely gone — announce it
      // once, the same trailing-diff shape diffWorktrees uses for `worktree.removed`.
      for (const handle of Object.keys(prevSnapshot.agents)) {
        if (!seenHandles.has(handle)) {
          events.push(context.emit('agent.removed', { handle }))
        }
      }

      return { nextSnapshot: { disabled: false, agents: nextAgents }, events }
    },
  }
}

export { parseElapsed, parseListTable, parseStatusTable }
