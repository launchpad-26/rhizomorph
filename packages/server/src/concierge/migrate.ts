import { constants } from 'node:fs'
import { copyFile, mkdir, open, stat } from 'node:fs/promises'
import path from 'node:path'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/worktree-slug.js'
import { candidateTranscriptPaths, findSessionAttribution } from '../log/transcript-attribution.js'
import { canonicalize } from '../paths/containment.js'
import { assertMigrationPaths } from './paths.js'

/**
 * prd-20 ruling 6 / ADR-0020's power, wired for real (#519): a conversation
 * begun somewhere else — another checkout, another machine — comes home, so it
 * can be resumed *here*, instrumented. `assertMigrationPaths` (`paths.ts`)
 * landed ahead of this module as an unwired fence (#514, its own doc says so);
 * this is what finally calls it on the one path a copy can take.
 *
 * The mechanism is file placement and nothing else, which is the whole finding
 * of `research/2026-08-14-cross-host-resume.md`: `claude --resume <id>` looks
 * ONLY in the slug directory of its own cwd (Q1's control failed to resume an
 * id that existed in two other slug directories), the resume appends in place
 * under the preserved sessionId (Q3), and telemetry books under that same id
 * (Q4). No transformation, no path rewriting — Q2 proves mixed and even
 * Windows `cwd` values are tolerated, and ADR-0020 rejected rewriting on that
 * evidence rather than on taste.
 *
 * Two phases, the same shape as `clone.ts` and `launch.ts` and for the same
 * reason: {@link planMigration} answers every question that can be answered
 * before a byte is written — who the session belongs to, where its transcript
 * is, whether it is resumable at all, and whether the fence permits the copy —
 * so `api/concierge.ts` gets a precise, typed failure it can map to a status
 * *before* it has committed to anything. {@link runMigration} only ever runs
 * once planning has succeeded, and it never throws: from there the only
 * failures left are real I/O ones, and they ride the response body the way
 * `runClone`'s terminal `error` event does.
 *
 * **The one design input the spike handed this module, and it is not a
 * nicety.** A metadata-only transcript stub (`ai-title`/`agent-name` lines and
 * nothing else) is refused by the resume with `No conversation found with
 * session ID: <id>` — *the exact error a missing file produces*. A caller
 * cannot tell the two apart from the exit status, so the check has to happen
 * before the copy, here, where the file is open anyway. That is
 * {@link MigrationSourceNotResumableError}, and without it this module would
 * cheerfully copy a file no resume can use and report success.
 *
 * No clock (namespace-law clause 3), no shell and no process (clause 4) — this
 * module reads one file's head, makes one directory, and makes one
 * `COPYFILE_EXCL` copy. That flag is the create-only guarantee clause 6 pins as
 * an obligation on this wave; `assertMigrationPaths`' own create-only clause is
 * a check-then-write and says so in its own doc, so the flag is the thing
 * actually standing between the operator and a lost transcript.
 */

/**
 * Nothing in this session's event log ever attributed `sessionId` — so there is
 * no worktree to resolve a transcript path against, and nothing to migrate.
 * The 404 half of `api/concierge.ts`'s mapping, beside
 * {@link MigrationSourceNotFoundError}: both mean "the thing you named is not
 * something this instrument knows", which is the `/api/lanes` convention
 * `api/session-preview.ts` already follows for the same id space.
 */
export class SessionUnknownError extends Error {
  constructor(sessionId: string) {
    super(
      `NO SUCH SESSION ${JSON.stringify(sessionId)} — nothing in this session's event log ever attributed it, ` +
        'so there is no worktree to resolve its transcript from and nothing to migrate — ' +
        'run: `rhizomorph doctor`',
    )
    this.name = 'SessionUnknownError'
  }
}

/**
 * The session is attributed, but no transcript is on disk at any path its
 * attribution derives. Distinct from {@link SessionUnknownError} on purpose:
 * the log knew this session, so the operator's id was not a typo — the FILE is
 * what is missing, and the paths that were tried are named so they can be
 * checked.
 */
export class MigrationSourceNotFoundError extends Error {
  constructor(sessionId: string, tried: readonly string[]) {
    super(
      `NO TRANSCRIPT for session ${JSON.stringify(sessionId)} — nothing is on disk at any path its attribution ` +
        `derives (${tried.length === 0 ? 'no worktree path was recorded for it' : tried.join(' or ')}), so there is ` +
        'no file to bring home — run: `rhizomorph doctor`',
    )
    this.name = 'MigrationSourceNotFoundError'
  }
}

/**
 * The transcript exists and holds no conversation turn — the stub case
 * `research/2026-08-14-cross-host-resume.md` found the hard way, where
 * `--resume` fails with the same message a missing file gives. A validation
 * failure (400), not a not-found (404): the file is there, it is simply not a
 * conversation, and the operator is the only one who can decide what to do
 * about that.
 */
export class MigrationSourceNotResumableError extends Error {
  constructor(source: string, sessionId: string, detail: string) {
    super(
      `NOT RESUMABLE: the transcript for session ${JSON.stringify(sessionId)} at ${source} holds no conversation ` +
        `turn (${detail}) — a metadata-only stub is refused by \`claude --resume\` with the same ` +
        '"No conversation found with session ID" it gives for a missing file, so copying it here would move a file ' +
        'no resume can use — check whether this is the session you meant',
    )
    this.name = 'MigrationSourceNotResumableError'
  }
}

/**
 * What {@link planMigration} needs, and deliberately all it needs. Note what is
 * NOT here: any path naming a FILE. The source is derived from the event log's
 * own attribution and the destination from the watched repo's own slug — the
 * two roots below are the same two {@link assertMigrationPaths}' own fence
 * takes, so "copy me `/etc/shadow`" is not a request this signature can
 * express. ADR-0020's Decision Outcome point 2, kept at this layer too rather
 * than only at the fence's.
 */
export interface PlanMigrationContext {
  /** The event log this Rhizomorph has recorded so far — the only source of attribution. */
  readonly events: readonly RhizomorphEvent[]
  /** `~/.claude/projects` on this machine. Where the transcript is read from AND where it lands. */
  readonly claudeProjectsRoot: string
  /** The repo this server is watching — the cwd a resumed process will run in, and the slug the copy lands under. */
  readonly watchedRepoPath: string
  /**
   * How much of the source's head the resumability check reads. Defaults to
   * {@link MIGRATION_HEAD_BYTES}; overridable so a test can prove the read is
   * bounded rather than take the comment's word for it.
   */
  readonly headBytes?: number
}

/**
 * Either the transcript is already where a resume in the watched repo looks, or
 * exactly one copy is permitted. `not-needed` is a first-class outcome rather
 * than an error: an operator resuming a session that began in this very repo is
 * on the happy path, and the launch that follows works without any copy at all.
 */
export type MigrationPlan =
  | { readonly kind: 'not-needed'; readonly at: string }
  | { readonly kind: 'migrate'; readonly from: string; readonly to: string }

/**
 * What actually happened on disk. `already-present` is a success, not a
 * failure: session ids are UUIDs, so a file that appeared at the destination
 * between the plan and the copy is *this same transcript* — an earlier attempt,
 * or a concurrent one — and the resume that follows will find exactly what it
 * needed. `copy-failed` is the only outcome where nothing usable is at the
 * destination.
 */
export type MigrationOutcome =
  | { readonly kind: 'not-needed'; readonly at: string }
  | { readonly kind: 'migrated'; readonly at: string }
  | { readonly kind: 'already-present'; readonly at: string }
  | { readonly kind: 'copy-failed'; readonly message: string }

/** What Claude Code names a session transcript — the same suffix `paths.ts`' fence appends. */
const TRANSCRIPT_SUFFIX = '.jsonl'

/**
 * How much of a transcript's head the resumability check reads: enough that a
 * real conversation's first turn is in it many times over (the spike's smallest
 * real transcript was 2 KB, its largest 23 MB with the first user turn in the
 * first few lines), small enough that this is never a whole-file slurp of a
 * multi-megabyte log — the same bounded-head posture `api/session-preview.ts`
 * takes for the same files, for the same reason.
 */
export const MIGRATION_HEAD_BYTES = 256 * 1024

/**
 * The `type` values a real conversation turn carries. Everything else a
 * transcript holds — `ai-title`, `agent-name`, `queue-operation`,
 * `last-prompt`, `mode`, `attachment` — is metadata *about* a session, and the
 * spike's degenerate specimen (278 bytes, `ai-title` + `agent-name`, nothing
 * else) is made of exactly that.
 */
const CONVERSATION_TURN_TYPES: ReadonlySet<string> = new Set(['user', 'assistant'])

interface HeadRead {
  /** Complete lines only — a line cut by the byte cap is dropped rather than half-parsed. */
  lines: string[]
  /** True when the cap was reached, so the file continues past what was read. */
  truncated: boolean
}

/**
 * One bounded read from the head of a file. No stream and no whole-file read:
 * a single `read` of at most `maxBytes` from offset 0, with the final line
 * dropped when the cap was hit, since the cap may have landed mid-line and a
 * half-line is not evidence of anything.
 */
async function readHead(filePath: string, maxBytes: number): Promise<HeadRead> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const truncated = bytesRead >= maxBytes
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (truncated) lines.pop()
    return { lines: lines.filter((line) => line.trim().length > 0), truncated }
  } finally {
    await handle.close()
  }
}

/**
 * Whether the head of `source` holds at least one real conversation turn, and —
 * when it does not — what it held instead, so the refusal can say what the file
 * actually is rather than only what it is not.
 *
 * A line that is not JSON is skipped rather than fatal: a transcript with a
 * torn line is still resumable if a turn survives elsewhere in the head, and
 * this function's job is to find one turn, not to validate the format.
 */
async function findConversationTurn(
  source: string,
  maxBytes: number,
): Promise<{ found: true } | { found: false; detail: string }> {
  const { lines, truncated } = await readHead(source, maxBytes)
  const typesSeen = new Set<string>()

  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      typesSeen.add('<not JSON>')
      continue
    }
    const type = (parsed as { type?: unknown }).type
    if (typeof type !== 'string') {
      typesSeen.add('<no type>')
      continue
    }
    if (CONVERSATION_TURN_TYPES.has(type)) return { found: true }
    typesSeen.add(type)
  }

  const what = lines.length === 0 ? 'the file is empty' : `${lines.length} lines, all of them ${[...typesSeen].sort().join('/')}`
  const scope = truncated ? `the first ${maxBytes} bytes hold ${what}` : what
  return { found: false, detail: scope }
}

/** True when a regular file — following symlinks, exactly as the fence's own clause 4 does. */
async function isRegularFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

/**
 * `<claudeProjectsRoot>/<slug(watchedRepoPath)>/<sessionId>.jsonl` — the ONE
 * path a resume in the watched repo reads, or `null` when the watched repo path
 * cannot be canonicalized.
 *
 * Canonicalize before slugging, for the reason the fence's clause 2 gives:
 * Claude Code slugs its own `process.cwd()`, which Node has already resolved
 * through `realpath(3)`, so on macOS the `/var/…` and `/private/var/…`
 * spellings of one directory produce two DIFFERENT slugs and only one of them
 * is ever read.
 *
 * This exists solely for the `not-needed` comparison — see
 * {@link planMigration} — and is never used as a write target. The path the
 * copy actually uses comes back from {@link assertMigrationPaths}, which
 * derives it the same way and then judges it; a `null` here just defers to that
 * function's own refusal rather than inventing a second one.
 */
function homeTranscriptPath(claudeProjectsRoot: string, watchedRepoPath: string, sessionId: string): string | null {
  try {
    return path.join(
      claudeProjectsRoot,
      worktreePathToProjectSlug(canonicalize(watchedRepoPath)),
      `${sessionId}${TRANSCRIPT_SUFFIX}`,
    )
  } catch {
    return null
  }
}

/** `canonicalize`, or the resolved-but-unresolved spelling when it cannot answer — used only to compare two paths. */
function canonicalOrResolved(candidate: string): string {
  try {
    return canonicalize(candidate)
  } catch {
    return path.resolve(candidate)
  }
}

/**
 * Every check that can be answered before a byte is written, in the order a
 * mistake arrives:
 *
 * 1. **Whose session is this?** `findSessionAttribution` (#516) — the newest
 *    thing the event log ever said about this id. No attribution means no
 *    worktree, which means no derivable path, so this is
 *    {@link SessionUnknownError} and not a filesystem question at all.
 * 2. **Where is its transcript?** The first of `candidateTranscriptPaths`'
 *    offerings that is a regular file — the same two places the collector
 *    itself tails, with the same containment gate applied inside that function.
 *    None on disk is {@link MigrationSourceNotFoundError}.
 * 3. **Can it be resumed at all?** The stub check, and the reason it lives
 *    here: see this module's own doc. This runs BEFORE the `not-needed` branch
 *    on purpose — a stub already sitting in the watched repo's slug directory
 *    needs no copy and still cannot be resumed, and answering "nothing to do"
 *    for it would hand the operator the resume's own indistinguishable error a
 *    moment later. One rule: this function never returns a plan for a
 *    transcript no resume can use.
 * 4. **Is it already home?** If the source and the one path a resume reads are
 *    the same file, this is not a migration — `{kind: 'not-needed'}`. Checked
 *    here rather than left to the fence because the fence's clause 5 REFUSES
 *    that case (correctly: it is not a copy it may make), and a legitimate
 *    happy path must not arrive as an error.
 * 5. **May the copy be made?** {@link assertMigrationPaths}, whose six clauses
 *    are the whole write fence, and whose returned pair is the ONLY source of
 *    `from`/`to`. Throws `MigrationFenceError` — mapped to 403, never conflated
 *    with the 400s and 404s above.
 *
 * Note the deliberate redundancy in steps 2 and 5: both find the source, from
 * the same candidate list, by the same "first regular file" rule. Step 2 exists
 * to distinguish "the file is not there" (a 404 the operator can act on) from
 * every other fence refusal (a 403), which a single `MigrationFenceError`
 * cannot do. The fence's answer is the authoritative one, and if the two ever
 * disagreed the fence's would be the one used.
 */
export async function planMigration(sessionId: string, context: PlanMigrationContext): Promise<MigrationPlan> {
  const { events, claudeProjectsRoot, watchedRepoPath } = context
  const headBytes = context.headBytes ?? MIGRATION_HEAD_BYTES

  const attribution = findSessionAttribution(events, sessionId)
  if (attribution === null) throw new SessionUnknownError(sessionId)

  const candidates = candidateTranscriptPaths(attribution, claudeProjectsRoot)
  let source: string | undefined
  for (const candidate of candidates) {
    if (await isRegularFile(candidate)) {
      source = candidate
      break
    }
  }
  if (source === undefined) throw new MigrationSourceNotFoundError(sessionId, candidates)

  const turn = await findConversationTurn(source, headBytes)
  if (!turn.found) throw new MigrationSourceNotResumableError(source, sessionId, turn.detail)

  const home = homeTranscriptPath(claudeProjectsRoot, watchedRepoPath, attribution.sessionId)
  if (home !== null && canonicalOrResolved(source) === canonicalOrResolved(home)) {
    return { kind: 'not-needed', at: home }
  }

  const { source: from, destination: to } = assertMigrationPaths({ claudeProjectsRoot, watchedRepoPath }, attribution)
  return { kind: 'migrate', from, to }
}

/**
 * The copy {@link planMigration} already approved — one directory, one file,
 * never a throw. Only ever called after planning succeeded, so its failures
 * from here are real I/O ones the operator's own machine reported, and they
 * ride the caller's 200 body rather than a status line (the same plan/runtime
 * split `clone.ts` makes for `runClone`).
 *
 * Three things worth stating, because each is a place a sibling case hides:
 *
 * - **`COPYFILE_EXCL` is the create-only guarantee**, not the fence's clause 6.
 *   That clause is a check-then-write and therefore a TOCTOU by construction
 *   (its own doc says so); this flag is what makes the copy refuse rather than
 *   clobber, and namespace-law clause 6 pins it as this wave's obligation.
 * - **`EEXIST` means different things to the two calls, and only one of them is
 *   good news.** From `copyFile` it means the destination appeared after the
 *   plan — which, ids being UUIDs, is this same transcript, so the resume can
 *   proceed and nothing is overwritten. From `mkdir` it means something that is
 *   NOT a directory is sitting where the slug directory belongs, which is a
 *   real failure. They are caught separately for exactly that reason; one
 *   `catch` around both would report a broken destination as success.
 * - **`recursive: true` creates at most the slug directory and the projects
 *   root above it**, both of which are legitimately absent on a machine whose
 *   Claude Code has never run in this repo — and `assertMigrationPaths` has
 *   already proved the destination resolves inside that root, so recursion
 *   cannot walk anywhere else.
 */
export async function runMigration(plan: MigrationPlan): Promise<MigrationOutcome> {
  if (plan.kind === 'not-needed') return plan

  try {
    await mkdir(path.dirname(plan.to), { recursive: true })
  } catch (err) {
    return { kind: 'copy-failed', message: `could not create ${path.dirname(plan.to)}: ${errorMessage(err)}` }
  }

  try {
    await copyFile(plan.from, plan.to, constants.COPYFILE_EXCL)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { kind: 'already-present', at: plan.to }
    return { kind: 'copy-failed', message: `could not copy ${plan.from} to ${plan.to}: ${errorMessage(err)}` }
  }

  return { kind: 'migrated', at: plan.to }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
