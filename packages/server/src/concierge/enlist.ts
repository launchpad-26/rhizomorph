import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isInside } from '../paths/containment.js'
import { harnessById } from './harness/registry.js'
import { HarnessNotImplementedError } from './harness/types.js'
import type { EnlistmentPlan, EnlistmentTarget, HarnessEnlistContext, HarnessId } from './harness/types.js'

/**
 * THE FOURTH HAND — prd-57 ruling 4, licensed by ADR-0053, which amends
 * ADR-0019 clause 1's two powers to a third: **enlist or unenlist a detected
 * harness's user-level configuration, idempotently and reversibly.**
 *
 * ## What this file is, and what it deliberately is not
 *
 * It is the only thing in the concierge that opens a harness's configuration
 * file. Every decision about WHAT to write lives in the adapter
 * (`harness/claude.ts`'s `planEnlistment`), which is a pure function of the
 * file's current text. This module does the four things that need a
 * filesystem — read, back up, write, re-read — and none of the thinking.
 *
 * That split is what makes ruling 4's law checkable. *"Enlist changes exactly
 * the declared keys and unenlist restores the file byte-for-byte except those"*
 * is a claim about a string transform, and it is asserted in
 * `harness/claude.test.ts` against a fixture with unrelated content, on a
 * machine with no `~/.claude/settings.json` and no claude installed. What is
 * left here is the IO, and the IO is what `enlist.test.ts` drives against a
 * real temp directory.
 *
 * ## The grant, and its bounds
 *
 * ADR-0019 clause 4 is *"never inside the watched repo"*. Enlistment writes to
 * `~/.claude/settings.json` — the USER-level file, outside any repository — and
 * {@link assertUserLevelTarget} refuses anything else before a byte moves, so
 * a future adapter naming a repo-local path is stopped by this module rather
 * than trusted not to.
 *
 * ADR-0019 clause 3 and 5 hold as written: a loopback URL and an installation
 * id reach the file, and never a token. That is a property of what the recipe
 * produces, and `claude.test.ts` asserts the key set; there is nothing for this
 * module to enforce beyond writing what it was handed.
 *
 * ## Diff first, then write — and the write can refuse
 *
 * Two acts, never one. {@link planEnlistment} reads and returns the exact diff,
 * writing nothing. {@link applyEnlistment} takes that plan, **re-reads the file
 * immediately before writing**, and refuses if it no longer matches the digest
 * the plan was computed from.
 *
 * That refusal is the point of the digest. An operator who read a diff, went
 * away, edited their settings by hand and came back to accept would otherwise
 * have their edit silently overwritten by a plan computed against the old
 * bytes. This hand would rather do nothing and say so.
 */

/** Where the backup goes, beside the file it copies. ISO, so the sort is chronological. */
export function backupPathFor(target: string, at: Date): string {
  return `${target}.rhizomorph-backup-${at.toISOString().replace(/[:.]/g, '-')}`
}

/**
 * The target must be a user-level file, and never anything inside a repository.
 *
 * ADR-0019 clause 4, enforced here rather than trusted to the adapter. An
 * adapter naming `.claude/settings.local.json` inside the watched repo would
 * put this hand's writes into somebody's working tree — where the instrument
 * would then report them as dirty files, and where a `git clean` would undo an
 * enlistment nobody knew had happened.
 *
 * `home` is passed rather than read so this stays testable without a real one.
 */
export function assertUserLevelTarget(target: EnlistmentTarget, home: string, watchedRepoPath?: string): void {
  // Through `isInside`, never a hand-rolled prefix compare. The first version of
  // this function was `resolved.startsWith(path.resolve(home) + path.sep)` and
  // `prefix-comparison-law` convicted it (prd-42 ruling 2, #401) on the run that
  // landed it — correctly, and for two reasons a reviewer would have had to
  // find separately:
  //
  //   * `startsWith` is the containment bug this repo has a law about. It is
  //     right often enough to ship and wrong whenever one directory's name is a
  //     prefix of a sibling's — `…/foo` matching `…/foobar`.
  //   * It compares UNRESOLVED paths. `isInside` canonicalises both sides
  //     through the same `realpath`, which is what reconciles a symlinked
  //     ancestor — macOS's `/tmp` -> `/private/tmp` being the standing example
  //     (#217), and macOS being precisely where an operator's home is reached
  //     through one.
  if (!isInside(home, target.path)) {
    throw new EnlistmentRefusedError(
      `${target.display} is not inside the home directory, and this hand writes nowhere else (ADR-0019 clause 4)`,
    )
  }
  if (watchedRepoPath !== undefined && isInside(watchedRepoPath, target.path)) {
    throw new EnlistmentRefusedError(
      `${target.display} is inside the watched repo. ADR-0019 clause 4 is "never inside the watched repo": a write ` +
        'there would show up as a dirty file this instrument then reports on, and a `git clean` would silently undo it',
    )
  }
}

/** Refused before anything was written. Never thrown after a partial write, because there is no partial write. */
export class EnlistmentRefusedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'EnlistmentRefusedError'
  }
}

/**
 * A name this registry has never heard of.
 *
 * Its own type rather than a `EnlistmentRefusedError`, because the two map to
 * different statuses and a route should not have to read an error message to
 * tell them apart: an unknown name is a 400 the caller can fix by sending a
 * different one, and a refusal is a 409 that no request changes.
 */
export class EnlistmentUnknownHarnessError extends Error {
  constructor(readonly harness: string) {
    super(`no harness named ${harness} is in this registry`)
    this.name = 'EnlistmentUnknownHarnessError'
  }
}

/** The file changed between the diff and the write. Nothing was written. */
export class EnlistmentStaleError extends Error {
  constructor(readonly target: string) {
    super(
      `${target} changed since the diff was taken, so nothing was written. Read the diff again — an enlistment ` +
        'computed against bytes that have moved would overwrite whatever moved them',
    )
    this.name = 'EnlistmentStaleError'
  }
}

export interface EnlistContext {
  readonly harness: HarnessId
  readonly home: string
  /** The repo this server watches, so clause 4 can be enforced rather than assumed. */
  readonly watchedRepoPath?: string
  /** Everything the adapter needs to render its keys. Absent for an unenlist, which removes what it declared. */
  readonly launch?: HarnessEnlistContext
}

/**
 * Whether this registry knows the name at all — the cheapest question, so a
 * caller gets the most useful refusal.
 *
 * Exported so the route can ask it BEFORE anything more expensive. Found by the
 * route tests (review of #573, N3): the runner-resolution guard ran first, so an
 * unknown harness came back 409 "this server was not started through the CLI"
 * when the caller's actual mistake was a name they could fix. Order the gates
 * cheapest-and-most-actionable first, or the status lies about which thing is
 * wrong.
 */
export function isKnownHarness(id: string): boolean {
  return harnessById(id as HarnessId) !== undefined
}

/** What a plan was computed from, so the write can prove the file has not moved. */
export interface PlannedEnlistment {
  readonly plan: EnlistmentPlan
  readonly target: EnlistmentTarget
  /**
   * What the plan was made from, so the write can make it AGAIN rather than
   * re-deriving the digest with its own arithmetic.
   *
   * This module used to carry a second `createHash` implementation beside the
   * adapter's, and the two had to agree forever for the stale check to mean
   * anything — a second truth free to drift, which is the shape this repo has
   * laws about. Found while fixing the review of #573's N4: correcting one
   * digest silently broke the comparison against the other.
   */
  readonly context: EnlistContext
  readonly intent: 'enlist' | 'unenlist'
}

/**
 * Read the harness's configuration and say what enlisting would do. Writes
 * nothing, creates nothing, and returns the plan the operator approves.
 */
export async function planEnlistment(context: EnlistContext, intent: 'enlist' | 'unenlist'): Promise<PlannedEnlistment> {
  const adapter = harnessById(context.harness)
  if (adapter === undefined) throw new EnlistmentUnknownHarnessError(context.harness)
  let target: EnlistmentTarget
  try {
    target = adapter.enlistmentTarget(context.home)
  } catch (error) {
    // A declared harness, or an implemented one with no captured config file.
    // Surfaced as this module's own refusal so a caller has one error type to
    // handle rather than two.
    if (error instanceof HarnessNotImplementedError) throw new EnlistmentRefusedError(error.message)
    throw error
  }
  assertUserLevelTarget(target, context.home, context.watchedRepoPath)

  if (intent === 'enlist' && context.launch === undefined) {
    throw new EnlistmentRefusedError('an enlist needs a launch context to render its keys from; none was supplied')
  }

  const current = await readIfPresent(target.path)
  const plan =
    intent === 'enlist'
      ? adapter.planEnlistment(current, target, { kind: 'enlist', context: context.launch as HarnessEnlistContext })
      : adapter.planEnlistment(current, target, { kind: 'unenlist' })

  return { plan, target, context, intent }
}

export interface EnlistmentOutcome {
  readonly target: EnlistmentTarget
  /** Absent when the file did not exist — there was nothing to back up. */
  readonly backupPath: string | null
  readonly changedKeys: readonly string[]
}

/**
 * Apply a plan the operator approved, after proving the file has not moved.
 *
 * The order is deliberate and each step earns its place:
 *
 * 1. **Re-read and compare the digest.** A file that changed since the diff is
 *    refused, not overwritten.
 * 2. **Copy to `<file>.rhizomorph-backup-<iso>`** — beside the file, because a
 *    backup somewhere else is a backup nobody finds. Skipped only when the file
 *    did not exist, where there is nothing to preserve.
 * 3. **Create the directory, then write.** `~/.claude` may not exist on a first
 *    run; `mkdir` is the smallest write this hand does and it is inside the
 *    home directory the target was already checked against.
 *
 * Not atomic, and saying so plainly: this writes in place rather than
 * temp-file-and-rename, because a rename would replace the file's inode and
 * lose whatever the operator's own tooling had attached to it. The backup is
 * what makes the non-atomic write recoverable, which is why step 2 is not
 * optional.
 */
export async function applyEnlistment(
  planned: PlannedEnlistment,
  now: () => Date = () => new Date(),
): Promise<EnlistmentOutcome> {
  const { plan, target } = planned
  if (plan.kind !== 'ready') {
    throw new EnlistmentRefusedError(
      plan.kind === 'already-settled'
        ? `nothing to do: ${plan.why}`
        : `refused: ${plan.reason}`,
    )
  }

  // Re-PLANNED, not re-hashed. The digest is the adapter's to compute, and
  // asking it again is what keeps one implementation rather than two that must
  // agree forever.
  const fresh = await planEnlistment(planned.context, planned.intent)
  if (fresh.plan.kind !== 'ready' || fresh.plan.sourceDigest !== plan.sourceDigest) {
    throw new EnlistmentStaleError(target.display)
  }
  const current = await readIfPresent(target.path)

  let backupPath: string | null = null
  if (current !== null) {
    backupPath = backupPathFor(target.path, now())
    // `COPYFILE_EXCL` — create-only, and the concierge namespace law pins it
    // for every `copyFile` in this module. It caught this line on the run that
    // added it, which is the law working: the timestamp makes a collision
    // near-impossible and near-impossible is not the same as refused. Two
    // enlists inside the same second would otherwise have the second silently
    // overwrite the first's backup, and the backup is the only thing making a
    // non-atomic write recoverable.
    await copyFile(target.path, backupPath, constants.COPYFILE_EXCL)
  }

  await mkdir(path.dirname(target.path), { recursive: true })
  await writeFile(target.path, plan.next, 'utf8')

  return { target, backupPath, changedKeys: plan.changes.map((change) => change.keyPath.join('.')) }
}

/** `null` for a file that is not there — a first run, never an error. */
async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}


