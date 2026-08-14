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
import { voiceSkips, type ParseSkip } from '../parse-skip.js'
import { resolveWorktreePath } from '../tmux/worktree.js'

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
  /**
   * Memoises `workdir → worktreePath` for the subdirectory-join fallback
   * (#463): once a workdir's worktree root has *successfully* resolved via
   * git, it is not re-resolved, so a pane parked in the same subdirectory
   * across polls costs one `git` exec total, not one per poll (PRD-22 ruling
   * 1). A failed resolve is not cached and is retried on every later poll
   * (#505). Mirrors `tmux/collector.ts`'s field of the same name and purpose.
   */
  worktreeByPath: Record<string, string | null>
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

/** A skipped status row — `handle` is recovered when possible so a malformed
 * row's prior agent can still be carried forward (ruling 3) instead of
 * reading the quarantine as proof the handle is gone. */
export interface WorkmuxStatusRowSkip {
  handle: string | null
  line: string
  reason: string
}

/**
 * Parses `workmux status --json`. Returns `null` — not `{ rows: [], ... }` —
 * only when the output isn't the array-of-objects shape this collector
 * depends on at all (`JSON.parse` throws, or the value isn't an array), so
 * the caller can tell "no agents" apart from "an older workmux that doesn't
 * support --json and printed its table instead" (#383). A single malformed
 * row *within* a genuine array is a different failure: it quarantines (into
 * `skipped`) rather than invalidating the whole poll (#456, PRD-22 ruling 4)
 * — `list` rows already worked this way; this brings `status` in line.
 */
function parseStatusJson(stdout: string): { rows: WorkmuxStatusJsonRow[]; skipped: WorkmuxStatusRowSkip[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const rows: WorkmuxStatusJsonRow[] = []
  const skipped: WorkmuxStatusRowSkip[] = []
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      skipped.push({ handle: null, line: JSON.stringify(entry), reason: 'row is not an object' })
      continue
    }
    const handle = typeof entry.worktree === 'string' ? entry.worktree : null
    if (handle === null || typeof entry.status !== 'string' || typeof entry.workdir !== 'string') {
      skipped.push({
        handle,
        line: JSON.stringify(entry),
        reason: 'missing required worktree/status/workdir string field',
      })
      continue
    }
    rows.push({
      handle,
      status: entry.status,
      elapsedSeconds: typeof entry.elapsed_secs === 'number' ? entry.elapsed_secs : null,
      detail: typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title : null,
      workdir: entry.workdir,
      branch: typeof entry.branch === 'string' ? entry.branch : null,
    })
  }
  return { rows, skipped }
}

/**
 * Parses `workmux list --json`. A shape mismatch at the top level (unparseable
 * JSON, or not an array) degrades to no rows at all — `list` failing has
 * always been the softer failure of the two (see the `degrades gracefully
 * when list fails` test). A malformed row within a genuine array quarantines
 * into `skipped` (#456) rather than being silently dropped, same policy as
 * `parseStatusJson`.
 */
function parseListJson(stdout: string): { rows: WorkmuxListJsonRow[]; skipped: ParseSkip[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { rows: [], skipped: [] }
  }
  if (!Array.isArray(parsed)) return { rows: [], skipped: [] }

  const rows: WorkmuxListJsonRow[] = []
  const skipped: ParseSkip[] = []
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.path !== 'string') {
      skipped.push({ line: JSON.stringify(entry), reason: 'missing required path string field' })
      continue
    }
    rows.push({ path: entry.path })
  }
  return { rows, skipped }
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
 * of its worktree (e.g. `cd packages/server`) makes the exact-path join miss.
 * When that happens and `list` itself is healthy (succeeded, returned rows —
 * just none matching this `workdir`), `worktreePath` is resolved instead by
 * asking git directly (`resolveWorktreePath`, #463): authoritative, not a
 * guess, so PRD-22 ruling 5's ban on a lossy/heuristic join key does not
 * apply. The resolution is memoised per `workdir` (`worktreeByPath`) once it
 * has succeeded, so a pane parked in the same subdirectory only pays the
 * extra `exec` once — a failed resolve is not memoised and is retried every
 * poll (#505). If
 * `list` itself failed, returned unparseable output, or returned zero rows,
 * `worktreePath` still soft-nulls — the fallback only fires once `list` has
 * proven it can join something. `branch` is unaffected either way, since it
 * comes from the same row's own `branch` field, not the join (#455).
 *
 * Emits `agent.status` only when an agent's status, branch or worktree path
 * actually changes — elapsed alone ticking up every poll is not a state
 * change worth logging.
 *
 * A malformed `status` or `list` row quarantines just that row (counted and
 * voiced via a `collector.error`, per PRD-22 ruling 4) rather than disabling
 * the whole poll — the collector-wide disable is reserved for `status
 * --json` not returning the array-of-objects shape at all (#383's older-
 * workmux case), never for one bad row inside a genuine array (#456).
 */
export function createWorkmuxCollector(): Collector<WorkmuxSnapshot> {
  return {
    name: 'workmux',
    capabilities: WORKMUX_CAPABILITIES,

    initialSnapshot(): WorkmuxSnapshot {
      return { disabled: false, agents: {}, worktreeByPath: {} }
    },

    async poll(prevSnapshot, context: CollectorContext): Promise<PollResult<WorkmuxSnapshot>> {
      if (prevSnapshot.disabled) {
        return { nextSnapshot: prevSnapshot, events: [] }
      }

      const statusResult = await context.exec('workmux', ['status', '--json'])
      if (isMissingBinary(statusResult)) {
        return {
          nextSnapshot: { disabled: true, agents: {}, worktreeByPath: {} },
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

      const statusParsed = parseStatusJson(statusResult.stdout)
      if (statusParsed === null) {
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
      const { rows: statusRows, skipped: statusSkipped } = statusParsed
      // A row that lost its `worktree` field entirely can't be attributed to
      // any handle, so this poll can't tell an unseen handle apart from that
      // row's own handle gone missing from the JSON. Ruling 3 direction 2
      // conditions `agent.removed` on "an otherwise successful, well-formed
      // poll" — this one isn't, for the row(s) it can't name — so the
      // trailing removal diff is skipped entirely this poll and the whole
      // roster carries forward instead (#456 follow-up).
      const unattributableSkip = statusSkipped.some((skip) => skip.handle === null)

      const nextAgents: WorkmuxSnapshot['agents'] = {}
      const events: RhizomorphEvent[] = []
      const seenHandles = new Set<string>()
      const worktreeByPath = { ...prevSnapshot.worktreeByPath }

      if (statusSkipped.length > 0) {
        events.push(
          context.emit('collector.error', {
            collector: 'workmux',
            message: `skipped ${statusSkipped.length} malformed status row${statusSkipped.length === 1 ? '' : 's'}`,
            detail: voiceSkips(statusSkipped),
          }),
        )
        // Ruling 4 (quarantine one record, never the collector) must not
        // collide with ruling 3: a malformed row is not proof its handle is
        // gone, so carry the last known agent forward when the row's handle
        // could still be recovered (#456).
        for (const skip of statusSkipped) {
          if (skip.handle === null) continue
          seenHandles.add(skip.handle)
          const existingAgent = prevSnapshot.agents[skip.handle]
          if (existingAgent) nextAgents[skip.handle] = existingAgent
        }
      }

      const listResult = await context.exec('workmux', ['list', '--json'])
      const { rows: listRows, skipped: listSkipped } = isMissingBinary(listResult) || listResult.failed
        ? { rows: [], skipped: [] }
        : parseListJson(listResult.stdout)
      if (listSkipped.length > 0) {
        events.push(
          context.emit('collector.error', {
            collector: 'workmux',
            message: `skipped ${listSkipped.length} malformed list row${listSkipped.length === 1 ? '' : 's'}`,
            detail: voiceSkips(listSkipped),
          }),
        )
      }
      // Resolves `worktreePath` only — `branch` comes straight off the
      // status row (#455). Both sides of the join are absolute paths under
      // `--json` (`status.workdir`, `list.path`), so this can't collide the
      // way basename(path) could — see the collector-level doc comment
      // above. It can still *miss* when `workdir` is a subdirectory of
      // `list.path` rather than equal to it, in which case the loop below
      // falls back to `resolveWorktreePath` (#463) rather than soft-nulling.
      const listByPath = new Map(listRows.map((row) => [row.path, row]))

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
        let worktreePath: string | null
        if (listRow) {
          worktreePath = listRow.path
        } else if (listRows.length > 0) {
          // `list` is healthy and joined at least one row, just not this
          // one — a subdirectory `workdir` (#463). Ask git directly rather
          // than soft-nulling; memoise so a pane parked in the same
          // subdirectory across polls only pays the `exec` once.
          const cached = worktreeByPath[row.workdir]
          if (cached !== undefined && cached !== null) {
            worktreePath = cached
          } else {
            worktreePath = await resolveWorktreePath(row.workdir, context.exec)
            if (worktreePath !== null) {
              worktreeByPath[row.workdir] = worktreePath
            }
          }
        } else {
          worktreePath = null
        }

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
      // Skipped when this poll had an unattributable row (above): the roster
      // carries forward unannounced instead, since we can't tell a truly-gone
      // handle from the one that just lost its `worktree` field.
      for (const handle of Object.keys(prevSnapshot.agents)) {
        if (seenHandles.has(handle)) continue
        const existingAgent = prevSnapshot.agents[handle]
        if (unattributableSkip) {
          if (existingAgent) nextAgents[handle] = existingAgent
        } else {
          events.push(context.emit('agent.removed', { handle }))
        }
      }

      return { nextSnapshot: { disabled: false, agents: nextAgents, worktreeByPath }, events }
    },
  }
}
