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

interface WorkmuxStatusJsonRow {
  /** workmux's clean handle for the agent (`"worktree"` in `status --json`) — e.g. `"rhizomorph"`, never `"rhizomorph (main)"`. */
  handle: string
  status: string
  elapsedSeconds: number | null
  detail: string | null
  /** Absolute path — the join key against `list --json`'s `path`, used only to resolve `worktreePath` (#455: `branch` no longer depends on this join). */
  workdir: string
  /**
   * workmux's branch for this handle, read directly off the same row — the
   * only source `branch` resolves from (#455). Unlike `workdir`, this is not
   * the pane's live cwd, so a pane sitting in a worktree subdirectory doesn't
   * affect it.
   */
  branch: string | null
}

interface WorkmuxListJsonRow {
  /** Absolute path — no `(here)` sentinel, unlike the table form. Used only to resolve `worktreePath`; `branch` comes from the status row directly (#455). */
  path: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Parses `workmux status --json`. Returns `null` — not `[]` — when the
 * output isn't the array-of-objects shape this collector depends on, so the
 * caller can tell "no agents" apart from "an older workmux that doesn't
 * support --json and printed its table instead."
 */
function parseStatusJson(stdout: string): WorkmuxStatusJsonRow[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const rows: WorkmuxStatusJsonRow[] = []
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.worktree !== 'string' || typeof entry.status !== 'string' || typeof entry.workdir !== 'string') {
      return null
    }
    rows.push({
      handle: entry.worktree,
      status: entry.status,
      elapsedSeconds: typeof entry.elapsed_secs === 'number' ? entry.elapsed_secs : null,
      detail: typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title : null,
      workdir: entry.workdir,
      branch: typeof entry.branch === 'string' ? entry.branch : null,
    })
  }
  return rows
}

/**
 * Parses `workmux list --json`. Unlike {@link parseStatusJson}, a shape
 * mismatch here degrades to `[]` (every status row's branch/worktreePath
 * resolve to `null`) rather than disabling the whole poll — `list` failing
 * has always been the softer failure of the two (see the `degrades
 * gracefully when list fails` test).
 */
function parseListJson(stdout: string): WorkmuxListJsonRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const rows: WorkmuxListJsonRow[] = []
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.path !== 'string') continue
    rows.push({ path: entry.path })
  }
  return rows
}

/**
 * Shells to `workmux status --json` and `workmux list --json`. `branch` is
 * read directly off the `status` row (#455) — it no longer depends on any
 * join. The `list` side is joined on absolute path (`status.workdir` ↔
 * `list.path` — issue #383: the table form's only shared key was a directory
 * basename, which collides whenever two worktrees share a basename under
 * different parents, and was already broken for the main worktree, whose
 * `status` table row is suffixed ` (main)` with no matching `list` basename)
 * and is now used only to resolve `worktreePath`.
 *
 * `workdir` is the pane's live cwd, not the worktree root — workmux rewrites
 * it every poll from `#{pane_current_path}`. A pane sitting in a subdirectory
 * of its worktree (e.g. `cd packages/server`) makes the path join miss:
 * `worktreePath` resolves to `null`, a named absence rather than a guess
 * (PRD-22 ruling 5 rules out a lossy/heuristic join key). `branch` is
 * unaffected, since it comes from the same row's own `branch` field, not the
 * join.
 *
 * Emits `agent.status` only when an agent's status, branch or worktree path
 * actually changes — elapsed alone ticking up every poll is not a state
 * change worth logging.
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

      const statusResult = await context.exec('workmux', ['status', '--json'])
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
                  : 'workmux status --json exited non-zero'),
            }),
          ],
        }
      }

      const statusRows = parseStatusJson(statusResult.stdout)
      if (statusRows === null) {
        // #383's ruling: an older workmux that doesn't support `--json` (and
        // silently printed its table instead, or emitted something else we
        // can't parse) rides this same degraded/disabled ladder — never a
        // fallback to table-parsing.
        return {
          nextSnapshot: { ...prevSnapshot, disabled: true },
          events: [
            context.emit('collector.disabled', {
              collector: 'workmux',
              reason: 'workmux status --json did not return parseable JSON (is --json supported by this version?)',
            }),
          ],
        }
      }

      const listResult = await context.exec('workmux', ['list', '--json'])
      const listRows = isMissingBinary(listResult) || listResult.failed
        ? []
        : parseListJson(listResult.stdout)
      // Resolves `worktreePath` only — `branch` comes straight off the
      // status row (#455). Both sides of the join are absolute paths under
      // `--json` (`status.workdir`, `list.path`), so this can't collide the
      // way basename(path) could — see the collector-level doc comment
      // above. It can still *miss* (soft `null`) when `workdir` is a
      // subdirectory of `list.path` rather than equal to it.
      const listByPath = new Map(listRows.map((row) => [row.path, row]))

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

        const listRow = listByPath.get(row.workdir)
        const branch = row.branch
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
