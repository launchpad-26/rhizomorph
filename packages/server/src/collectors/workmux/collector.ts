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
import { truncateForVoice, voiceSkips, type ParseSkip } from '../parse-skip.js'
import { resolveWorktreePath } from '../worktree.js'
import { parseListTable, parseStatusTable, type ParsedStatusRow } from './parse.js'

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
  /** Per-handle (or `~unattributed:<reason>`) latch: this identity's malformed
   * status row has already been voiced this incident. Cleared silently when
   * the identity drops out of a poll's skip batch, so a later recurrence
   * re-arms and voices again (#415's shape, generalized — #506). */
  statusSkipVoiced: Record<string, boolean>
  /** Same shape as `statusSkipVoiced`, for malformed `list` rows (#506). */
  listSkipVoiced: Record<string, boolean>
  /** Per-handle latch for an unrecognised `agent.status` value (#506). */
  unrecognisedStatusVoiced: Record<string, boolean>
  /**
   * Latch for "`status --json` emitted no JSON at all, and the text table
   * carried the poll instead" (#587). A workmux too old to know `--json` hits
   * that on every poll forever — the incident this issue came from ran 477 of
   * them — so it voices once and stays silent until a poll parses as JSON
   * again. The missing-field condition needs no field here: its voice rides
   * the per-identity `statusSkipVoiced` latch (#506) it already shares.
   */
  textFallbackVoiced: boolean
}

/** True only when the binary itself could not be run — not for a non-zero exit with real output. */
function isMissingBinary(result: ExecResult): boolean {
  return result.failed && result.errorMessage !== undefined
}

/**
 * One agent row, from whichever source carried this poll — `status --json`
 * normally, `status`'s text table when the JSON contract did not hold (#587).
 * The two sources differ only in what they can fill: the text table has no
 * `workdir` and no `branch` column, so both are `null` there.
 */
interface WorkmuxStatusRow {
  /** workmux's clean handle for the agent (`"worktree"` in `status --json`) — e.g. `"rhizomorph"`, never `"rhizomorph (main)"`. */
  handle: string
  status: string
  elapsedSeconds: number | null
  detail: string | null
  /** Absolute path — the join key against `list --json`'s `path`, used only to resolve `worktreePath` (#455: `branch` no longer depends on this join). `null` only on the text fallback, which has no such column (#587). */
  workdir: string | null
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
  /**
   * Which required fields this row was missing, named rather than summarised
   * (#587). The incident that opened that issue was diagnosed as "did not
   * return parseable JSON" when the truth was "`workdir` is absent because
   * this workmux predates it" — a person cannot act on the first sentence and
   * can act on the second, so the field names have to survive to the voice.
   */
  missingFields: string[]
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
 *
 * The distinction still matters under #587's text fallback: `null` and "an
 * array whose every row was skipped" both send the caller to the text table,
 * but they are different sentences to a human, so they stay different values
 * here rather than collapsing into one.
 */
function parseStatusJson(stdout: string): { rows: WorkmuxStatusRow[]; skipped: WorkmuxStatusRowSkip[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const rows: WorkmuxStatusRow[] = []
  const skipped: WorkmuxStatusRowSkip[] = []
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      skipped.push({ handle: null, line: JSON.stringify(entry), reason: 'row is not an object', missingFields: [] })
      continue
    }
    const handle = typeof entry.worktree === 'string' ? entry.worktree : null
    const status = typeof entry.status === 'string' ? entry.status : null
    const workdir = typeof entry.workdir === 'string' ? entry.workdir : null
    if (handle === null || status === null || workdir === null) {
      const missingFields: string[] = []
      if (handle === null) missingFields.push('worktree')
      if (status === null) missingFields.push('status')
      if (workdir === null) missingFields.push('workdir')
      skipped.push({
        handle,
        line: JSON.stringify(entry),
        reason: 'missing required worktree/status/workdir string field',
        missingFields,
      })
      continue
    }
    rows.push({
      handle,
      status,
      elapsedSeconds: typeof entry.elapsed_secs === 'number' ? entry.elapsed_secs : null,
      detail: typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title : null,
      workdir,
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

// ── #587: the two ways the JSON contract stops holding, and the text safety net ──

/**
 * Which of #587's two "the JSON contract did not hold" conditions a poll hit.
 * They are kept apart because their remedies are different, and the incident
 * that opened the issue was 477 polls of being told the wrong one: the output
 * *was* JSON, it just lacked `workdir`, and "did not return parseable JSON"
 * sent a human looking for a broken pipe rather than an old binary.
 */
type StatusDrift =
  /** `JSON.parse` threw, or the value was not an array — an older workmux printing its table. */
  | { kind: 'not-json' }
  /** A genuine array whose every row failed the shape check, so the poll has no usable rows. */
  | { kind: 'missing-field'; fields: string[] }

/** The union of every required field the skipped rows were missing, named so the voice can say which. */
function driftFields(skipped: readonly WorkmuxStatusRowSkip[]): string[] {
  const fields = new Set<string>()
  for (const skip of skipped) for (const field of skip.missingFields) fields.add(field)
  return [...fields].sort()
}

/**
 * Voices the missing-field condition: names the fields, says the binary is
 * likely too old, and says whether the text table covered the gap — the third
 * distinguishable condition of #587 is exactly "the fallback failed too", and
 * it is the difference between "you have a stale roster" and "you have none".
 */
function missingFieldMessage(fields: readonly string[], usedText: boolean): string {
  const named = fields.map((field) => `\`${field}\``).join(', ')
  const noun = fields.length === 1 ? 'field' : 'fields'
  const diagnosis = `status --json parsed, but no row carried the required ${noun} ${named} — this workmux is likely too old (0.1.231 omits \`workdir\`; 0.1.236 emits it)`
  return usedText
    ? `${diagnosis}. Read \`workmux status\`'s text table instead this poll — upgrade workmux to restore the JSON contract.`
    : `${diagnosis}. The \`workmux status\` text table could not be read either — run both by hand, and upgrade workmux.`
}

/** Voices the not-JSON condition when the text table carried the poll anyway. */
const NOT_JSON_TEXT_MESSAGE =
  'status --json returned no JSON at all (an older workmux prints its table instead). Read `workmux status`\'s text table this poll — upgrade workmux so `--json` is supported.'

/** Voices the not-JSON condition when nothing carried the poll — the only disabling case of the three. */
const NOT_JSON_DISABLED_MESSAGE =
  'workmux status --json returned no JSON at all, and its `workmux status` text table could not be read either — run both by hand; upgrade workmux if `--json` is unsupported.'

/**
 * Reads `workmux status`'s text table, and `workmux list`'s if the status
 * table had rows worth joining. JSON stays the contract (#383's ruling that
 * `--json` is what this collector depends on is unchanged); this is only what
 * happens once that contract has already failed, so the collector degrades
 * loudly and keeps working instead of going quiet for 477 polls (#587).
 */
async function readTextFallback(
  exec: CollectorContext['exec'],
): Promise<{ rows: ParsedStatusRow[]; worktreePathByHandle: Map<string, string> }> {
  const statusResult = await exec('workmux', ['status'])
  const rows = parseStatusTable(statusResult.stdout)
  const worktreePathByHandle = new Map<string, string>()
  if (rows.length === 0) return { rows, worktreePathByHandle }

  const listResult = await exec('workmux', ['list'])
  for (const listRow of parseListTable(listResult.stdout)) {
    // `(here)` is workmux's sentinel for "the worktree this command ran in".
    // The collector's exec sets no cwd, so it cannot honestly resolve that to
    // a path — a null worktreePath is the truthful answer, not a guess.
    if (listRow.path === '(here)') continue
    worktreePathByHandle.set(listRow.branch, listRow.path)
  }
  return { rows, worktreePathByHandle }
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
 * poll (#505). If `list` itself failed, returned unparseable output, or
 * returned zero rows,
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
 * the whole poll — never for one bad row inside a genuine array (#456).
 *
 * When the JSON path yields *no* usable rows — the output was not JSON at
 * all, or every row failed the shape check — the text table is read instead
 * (#587). JSON stays the contract: text is consulted only after JSON has
 * already failed, and its rows carry no `workdir` or `branch`, so identity is
 * thinner there by construction. The collector-wide disable now needs *both*
 * to fail, and each of the three conditions gets its own message: output was
 * not JSON; JSON parsed but no row carried a required field (named, with the
 * version remedy); the text fallback failed too. That third distinction is
 * why #587 exists — for 477 consecutive polls this collector reported a
 * version mismatch as unparseable JSON, and a human acted on the wrong one.
 */
export function createWorkmuxCollector(): Collector<WorkmuxSnapshot> {
  return {
    name: 'workmux',
    capabilities: WORKMUX_CAPABILITIES,

    initialSnapshot(): WorkmuxSnapshot {
      return {
        disabled: false,
        agents: {},
        worktreeByPath: {},
        statusSkipVoiced: {},
        listSkipVoiced: {},
        unrecognisedStatusVoiced: {},
        textFallbackVoiced: false,
      }
    },

    async poll(prevSnapshot, context: CollectorContext): Promise<PollResult<WorkmuxSnapshot>> {
      if (prevSnapshot.disabled) {
        return { nextSnapshot: prevSnapshot, events: [] }
      }

      const statusResult = await context.exec('workmux', ['status', '--json'])
      if (isMissingBinary(statusResult)) {
        return {
          nextSnapshot: {
            disabled: true,
            agents: {},
            worktreeByPath: {},
            statusSkipVoiced: {},
            listSkipVoiced: {},
            unrecognisedStatusVoiced: {},
            textFallbackVoiced: false,
          },
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
      // #587: the JSON contract can stop holding in two distinguishable ways,
      // and only one of them was ever voiced. `not-json` is #383's older-
      // workmux case. `missing-field` is the 2026-08-15 incident: a genuine
      // array whose every row failed the shape check, which the old code
      // reported as a parse failure — the message a human then acted on for
      // 477 polls. A *partly* malformed array is neither: those rows still
      // quarantine per-row (#456) and never reach here.
      let drift: StatusDrift | null = null
      if (statusParsed === null) {
        drift = { kind: 'not-json' }
      } else if (statusParsed.rows.length === 0 && statusParsed.skipped.length > 0) {
        drift = { kind: 'missing-field', fields: driftFields(statusParsed.skipped) }
      }

      // JSON first, text as the safety net — the text table is only consulted
      // once the JSON path has already produced nothing usable, never before.
      const textFallback = drift === null ? null : await readTextFallback(context.exec)
      const usedText = textFallback !== null && textFallback.rows.length > 0
      const textFallbackVoiced = prevSnapshot.textFallbackVoiced ?? false

      if (drift?.kind === 'not-json' && !usedText) {
        // Nothing this poll could read — the one condition of the three that
        // still disables. The reason now names both failures, so it can't be
        // mistaken for either one alone.
        return {
          nextSnapshot: { ...prevSnapshot, disabled: true },
          events: [
            context.emit('collector.disabled', { collector: 'workmux', reason: NOT_JSON_DISABLED_MESSAGE }),
          ],
        }
      }

      const statusRows: WorkmuxStatusRow[] = usedText
        ? textFallback.rows.map((row) => ({
            handle: row.handle,
            status: row.status,
            elapsedSeconds: row.elapsedSeconds,
            detail: row.detail,
            // The text table carries neither column; the join below reads
            // `worktreePathByHandle` instead of the absolute-path join.
            workdir: null,
            branch: null,
          }))
        : (statusParsed?.rows ?? [])
      // The JSON skips are still voiced even when the text table carried the
      // poll — that voice is *how* a person learns their workmux is stale.
      const statusSkipped = statusParsed?.skipped ?? []
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
      // Resume-safety: a snapshot persisted by a pre-#506 build has none of
      // these fields at all, so `prevSnapshot.statusSkipVoiced` is
      // `undefined`, not `{}` — never read it without this default.
      const statusSkipVoiced = prevSnapshot.statusSkipVoiced ?? {}
      const nextStatusSkipVoiced: Record<string, boolean> = {}
      const listSkipVoiced = prevSnapshot.listSkipVoiced ?? {}
      const nextListSkipVoiced: Record<string, boolean> = {}
      const unrecognisedStatusVoiced = prevSnapshot.unrecognisedStatusVoiced ?? {}
      const nextUnrecognisedStatusVoiced: Record<string, boolean> = {}

      if (drift?.kind === 'not-json' && !textFallbackVoiced) {
        // Latched separately from the skip batch below because this condition
        // produces no skips at all — there was no array to skip rows out of.
        // Without the latch this is the 477-poll message all over again.
        events.push(context.emit('collector.error', { collector: 'workmux', message: NOT_JSON_TEXT_MESSAGE }))
      }

      if (statusSkipped.length > 0) {
        // Per-identity latch (#506, #415's shape generalized): voice only
        // when at least one of this batch's keys wasn't already latched;
        // `nextStatusSkipVoiced` is built fresh from just this poll's keys,
        // so any key absent from a later poll silently re-arms.
        const skipKeys = statusSkipped.map((skip) => skip.handle ?? `~unattributed:${skip.reason}`)
        const hasNewIncident = skipKeys.some((key) => !statusSkipVoiced[key])
        if (hasNewIncident) {
          events.push(
            context.emit('collector.error', {
              collector: 'workmux',
              // #587: when *every* row failed the shape check the honest
              // report is the version diagnosis, not a row count — a count
              // says "some data was bad", which is what sent a human hunting
              // for a bad row that did not exist. A partly-malformed array
              // keeps the count: there, the count is the true story.
              message:
                drift?.kind === 'missing-field'
                  ? missingFieldMessage(drift.fields, usedText)
                  : `skipped ${statusSkipped.length} malformed status row${statusSkipped.length === 1 ? '' : 's'}`,
              detail: voiceSkips(statusSkipped),
            }),
          )
        }
        for (const key of skipKeys) nextStatusSkipVoiced[key] = true
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
        // No per-row identity survives a malformed `list` row (it only ever
        // carries `path`), so every skip's key is its failure reason —
        // still bounds the incident to "per distinct failure mode," not
        // "per poll forever" (#506).
        const skipKeys = listSkipped.map((skip) => `~unattributed:${skip.reason}`)
        const hasNewIncident = skipKeys.some((key) => !listSkipVoiced[key])
        if (hasNewIncident) {
          events.push(
            context.emit('collector.error', {
              collector: 'workmux',
              message: `skipped ${listSkipped.length} malformed list row${listSkipped.length === 1 ? '' : 's'}`,
              detail: voiceSkips(listSkipped),
            }),
          )
        }
        for (const key of skipKeys) nextListSkipVoiced[key] = true
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
          // This branch is already per-row, unlike the two skip-batch sites
          // above, so its latch needs no batch/hasNewIncident reduction — a
          // handle that parses fine this poll simply never re-enters
          // `nextUnrecognisedStatusVoiced`, so recovery is silent (#506).
          if (!unrecognisedStatusVoiced[row.handle]) {
            events.push(
              context.emit('collector.error', {
                collector: 'workmux',
                message: `unrecognised agent status '${truncateForVoice(row.status)}' for handle '${row.handle}'`,
              }),
            )
          }
          nextUnrecognisedStatusVoiced[row.handle] = true
          // Ruling 4 (quarantine one record, never the collector) must not
          // collide with ruling 3: a malformed row is not proof its handle is
          // gone, so carry the last known agent forward if there was one.
          const existingAgent = prevSnapshot.agents[row.handle]
          if (existingAgent) nextAgents[row.handle] = existingAgent
          continue
        }
        const status = statusCheck.data

        const listRow = row.workdir === null ? undefined : listByPath.get(row.workdir)
        const branch = row.branch
        let worktreePath: string | null
        if (row.workdir === null) {
          // Text fallback (#587). The text tables share no absolute path — the
          // only key across them is the worktree/branch name, which is exactly
          // the lossy join #383 removed from the JSON path. It is accepted
          // *here* because the alternative is no worktree path at all, and it
          // is one more reason JSON stays the contract: an unmatched or
          // `(here)` row nulls rather than guesses.
          worktreePath = textFallback?.worktreePathByHandle.get(row.handle) ?? null
        } else if (listRow) {
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

      return {
        nextSnapshot: {
          disabled: false,
          agents: nextAgents,
          worktreeByPath,
          statusSkipVoiced: nextStatusSkipVoiced,
          listSkipVoiced: nextListSkipVoiced,
          unrecognisedStatusVoiced: nextUnrecognisedStatusVoiced,
          // Re-armed the moment a poll parses as JSON again, so a workmux
          // upgraded mid-session voices the next incident instead of staying
          // latched shut forever.
          textFallbackVoiced: drift?.kind === 'not-json',
        },
        events,
      }
    },
  }
}
