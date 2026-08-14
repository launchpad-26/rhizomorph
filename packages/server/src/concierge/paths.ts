import { lstatSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/worktree-slug.js'
import {
  type Attribution,
  candidateTranscriptPaths,
  isPathContained,
  isSafeSessionId,
} from '../log/transcript-attribution.js'
import { canonicalize, isInside, type Realpath } from '../paths/containment.js'

export { isInside, type Realpath }

/**
 * prd-20 ruling 1's fence for the fourth hand's second power — "clone a repo to
 * disk" — expressed as paths, and enforced rather than described.
 *
 * This module exists *before* the concierge's code does, deliberately. It is
 * the minimum true subject the namespace law needs: the hand's footprint on
 * disk and the one predicate every future clone target must pass. It is not a
 * placeholder — `assertCloneTarget` is a runtime refusal the law beside it
 * proves by running rather than by grepping for a comment. What it is not, yet,
 * is unavoidable: see that function's own note.
 *
 * What it deliberately does NOT decide: **where cloned repos live by default.**
 * prd-20 leaves that open ("Where cloned repos live by default. Open, not
 * ruled."), so the fence takes the clone root as an argument rather than
 * hard-coding one. Answering the open question later sets that argument; it
 * does not reopen this law.
 *
 * Since #514 it carries a SECOND fence, the same way and for the same reason:
 * `assertMigrationPaths` is prd-20 ruling 6 / ADR-0020's fence for the fourth
 * hand's third power — copying one attributed session transcript into the
 * watched repo's slug directory under `~/.claude/projects`. It shares this
 * file, and the canonicalize/isInside helpers, deliberately: the two powers are
 * judged by the same containment primitive, and #401's lesson is that a
 * security predicate with two homes gets hardened in one of them.
 *
 * `canonicalize`/`isInside` are imported from `../paths/containment.ts`, not
 * redefined here. This file used to carry its own copy, because borrowing
 * `lab/paths.ts`'s would have breached the second hand's fence (prd12 ruling 1
 * — the laboratory is explicitly-invoked only) to build the fourth hand's. #401
 * removed the dilemma rather than paying it: the containment primitive now
 * lives in a neutral `paths/` module that belongs to no hand, and `lab/paths.ts`
 * imports it from there too. `isInside` and `Realpath` are re-exported so a
 * caller reasoning about the clone fence reads one module, and so #217/#228's
 * hardening lands in one place instead of in whichever copy the next author
 * happened to be looking at.
 */

/**
 * `<dataRoot>/concierge` — the fourth hand's own footprint, a sibling of the
 * event log and of `<dataRoot>/lab`, per ADR-0005's data-directory posture.
 *
 * This is the hand's bookkeeping, not "where clones go" — see the module
 * comment. Its role in the fence is negative: it names the only part of
 * `dataRoot` the concierge may treat as its own, so a clone root cannot be
 * quietly parked inside another hand's namespace (the recorder's per-repo
 * session directories are `dataRoot`'s direct children; the lab's is
 * `<dataRoot>/lab`).
 */
export function conciergeRoot(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), 'concierge')
}

/**
 * `~/rhizomorph/repos` — the default `clonesRoot` (#262), answering prd-20's
 * open question ("where cloned repos live by default") as a comment on that
 * issue rather than silently: a visible, top-level directory, deliberately
 * NOT under `defaultDataRoot()` (`~/.local/share/rhizomorph`, ADR-0005). The
 * data root is this instrument's own bookkeeping — session logs, the lab's
 * worktrees; a cloned repo is the operator's real workspace, something they
 * `cd` into and work in, so it gets a home a shell or file browser finds
 * easily, the same way other dev tools default a project home (e.g.
 * `~/AndroidStudioProjects`) rather than hiding it in an XDG data directory.
 * `assertCloneTarget`'s own fence is unaffected either way — this only sets
 * the argument its `clonesRoot` parameter defaults to when a caller doesn't
 * override it, per ADR-0019's Consequences: "answering the question later
 * sets that argument; it does not reopen this law."
 */
export function defaultClonesRoot(): string {
  return path.join(homedir(), 'rhizomorph', 'repos')
}

/** Strictly beneath `parent` — the directory itself does not count. */
function isStrictlyInside(parent: string, candidate: string, realpath?: Realpath): boolean {
  return isInside(parent, candidate, realpath) && canonicalize(candidate, realpath) !== canonicalize(parent, realpath)
}

/**
 * The three paths a clone is judged against: where clones are allowed to land,
 * what the observer is watching, and the data root the other hands own.
 */
export interface CloneFence {
  /**
   * The directory the operator's clones land in. Supplied, not defaulted —
   * prd-20 leaves the default open.
   */
  clonesRoot: string
  /** The repo the observer is watching. Absolutely off-limits to this hand. */
  watchedRepoPath: string
  /** `~/.local/share/rhizomorph` or its test stand-in — the other hands' territory. */
  dataRoot: string
}

/** Thrown when a clone target fails the fence. Carries the clause it failed. */
export class CloneFenceError extends Error {
  constructor(message: string) {
    super(`${message} (prd-20 ruling 1 / ADR-0019 — the concierge clones only into its own namespace)`)
    this.name = 'CloneFenceError'
  }
}

/**
 * The write fence for the clone power, enforced — everywhere it is *called*.
 *
 * Being honest about that limit, because review of #351 caught this comment
 * claiming the opposite: the refusal is **not** structural today. Every caller
 * in the tree is a test; no clone path exists yet, and clause 4 of the namespace
 * law lists a bare `execFile('git', ['clone', url, target])` among the argv
 * spawns the hand may legitimately make — so a lane could build that argv and
 * never ask this function anything. What lands here is therefore an obligation
 * on #262, not a wall #262 cannot walk round.
 *
 * Making it structural needs a law that fails when a `clone` argv is assembled
 * without this call on the path to it. That law belongs with the code it would
 * judge, so it lands with #262 rather than being written against nothing here.
 *
 * Four clauses, in the order a mistake is likely to arrive:
 *
 * 1. The clone root may not overlap the watched repo in EITHER direction. A
 *    root inside the repo would put clones in someone's working tree — prd-20's
 *    "never a write inside the watched repo's working tree". A root that
 *    *contains* the repo is the same trespass wearing a wider hat: every
 *    containment check below would then pass for a target sitting on top of the
 *    operator's work.
 * 2. If the clone root is inside `dataRoot`, it must be inside
 *    `conciergeRoot(dataRoot)`. The recorder's session directories and the
 *    lab's worktrees live under `dataRoot` too, and each is fenced to its own
 *    hand; the concierge writing into them would breach a fence it was never
 *    granted. A root entirely outside `dataRoot` is fine and is what the open
 *    question will most likely choose.
 * 3. The target must be STRICTLY inside the clone root. The root holds clones;
 *    it is not itself one, and `git clone` onto the root would swallow every
 *    sibling.
 * 4. The target may not be, or lie inside, the watched repo. Clauses 1 and 3
 *    already imply this; it is asserted independently because it is the one
 *    clause whose violation is unrecoverable, and defence in depth is cheap.
 */
export function assertCloneTarget(fence: CloneFence, candidate: string, realpath?: Realpath): void {
  const { clonesRoot, watchedRepoPath, dataRoot } = fence

  if (isInside(watchedRepoPath, clonesRoot, realpath) || isInside(clonesRoot, watchedRepoPath, realpath)) {
    throw new CloneFenceError(
      `refusing to clone: the clone root ${path.resolve(clonesRoot)} overlaps the watched repo ` +
        `${path.resolve(watchedRepoPath)}`,
    )
  }

  if (isInside(dataRoot, clonesRoot, realpath) && !isInside(conciergeRoot(dataRoot), clonesRoot, realpath)) {
    throw new CloneFenceError(
      `refusing to clone: the clone root ${path.resolve(clonesRoot)} is inside the data root ` +
        `but outside ${conciergeRoot(dataRoot)} — that space belongs to the other hands`,
    )
  }

  if (!isStrictlyInside(clonesRoot, candidate, realpath)) {
    throw new CloneFenceError(
      `refusing to clone: ${path.resolve(candidate)} is not strictly inside ${path.resolve(clonesRoot)}`,
    )
  }

  if (isInside(watchedRepoPath, candidate, realpath)) {
    throw new CloneFenceError(
      `refusing to clone: ${path.resolve(candidate)} is inside the watched repo ${path.resolve(watchedRepoPath)}`,
    )
  }
}

/* -------------------------------------------------------------------------- */
/* prd-20 ruling 6 / ADR-0020 — the migration fence                           */
/* -------------------------------------------------------------------------- */

/** What Claude Code names a session transcript. */
const TRANSCRIPT_SUFFIX = '.jsonl'

/**
 * The two paths a transcript migration is judged against. Note what is NOT
 * here: a source file. See {@link assertMigrationPaths}.
 */
export interface MigrationFence {
  /**
   * `~/.claude/projects` on THIS machine — the harness state directory the copy
   * lands under. The destination's slug directory is derived from
   * `watchedRepoPath`, never supplied.
   */
  claudeProjectsRoot: string
  /**
   * The repo the observer is watching, and the cwd a resumed process will run
   * in. Its slug is the destination directory; it is also off-limits as a
   * destination, which is the clone fence's own fourth clause reapplied.
   */
  watchedRepoPath: string
  /**
   * Where the transcript is READ FROM, when that is not this machine's own
   * projects root — the mirror of {@link claudeProjectsRoot}, which is where it
   * is written TO. The pair is source-and-destination, and the names are worth
   * reading as that pair (ledger #13): `claudeProjectsRoot` is the older field
   * and kept its name because every caller and every test spells it, but it is
   * the DESTINATION root, and a reader meeting `sourceProjectsRoot` beside it
   * should not have to infer that from the two clauses that use them.
   *
   * The case it exists for is a mounted host's `~/.claude/projects` — the
   * cross-host migration `research/2026-08-14-cross-host-resume.md` Q2 proves,
   * where a Windows-origin transcript is resumed on Linux. Defaults to
   * {@link claudeProjectsRoot}, which is the same-machine case and the common
   * one.
   *
   * It is a ROOT, never a file. The directory beneath it and the filename are
   * still derived from the attribution (clause 4), so widening this widens
   * WHERE the derivation is anchored and never WHAT a caller may name — which
   * is the whole reason the signature takes no `source` at all.
   */
  sourceProjectsRoot?: string
}

/** The one copy the fourth hand's third power may make, once it has passed. */
export interface MigrationPaths {
  /** The transcript to read. Attribution-derived; the origin is never touched. */
  source: string
  /** Where it lands. Create-only — see {@link assertMigrationPaths} clause 6. */
  destination: string
}

/** Thrown when a migration fails the fence. Carries the clause it failed. */
export class MigrationFenceError extends Error {
  constructor(message: string) {
    super(
      `${message} (prd-20 ruling 6 / ADR-0020 — the concierge copies one attributed transcript, ` +
        `create-only, into the watched repo's own slug directory)`,
    )
    this.name = 'MigrationFenceError'
  }
}

/**
 * `isInside`, for a clause that REFUSES on containment rather than requiring
 * it — so a path that cannot be canonicalized must read as *inside*.
 *
 * `isPathContained` (`log/transcript-attribution.ts`) is the fail-closed
 * wrapper for the other direction: a positive containment check, where an
 * ELOOP or EACCES must refuse the path. Fail-closed is a direction, not a
 * value, and using that wrapper here would invert it — an unreadable
 * destination would sail past the one clause that can never be relaxed.
 *
 * Named to stay clear of the `isInside…` / `canonicalize…` prefixes
 * `paths/containment.test.ts` sweeps for (#401 step 5), and this comment is
 * the honest half of that: these two are call-site adapters over the ONE
 * implementation, not a second copy of it. Anything here that actually
 * compared path prefixes would be the violation that law is about, whatever it
 * was called.
 */
function insideOrUnreadable(parent: string, candidate: string): boolean {
  try {
    return isInside(parent, candidate)
  } catch {
    return true
  }
}

/** `canonicalize`, with its errors converted to the fence's own refusal. */
function realPathOrRefuse(candidate: string, what: string): string {
  try {
    return canonicalize(candidate)
  } catch (err) {
    throw new MigrationFenceError(`refusing to migrate: cannot resolve ${what} ${path.resolve(candidate)} — ${err}`)
  }
}

/** True when `candidate` is a regular file, following symlinks. */
function isRegularFile(candidate: string): boolean {
  try {
    // `statSync`, not `lstatSync`: a symlink to a real transcript is a real
    // transcript. Where the link POINTS is already fenced —
    // `candidateTranscriptPaths` canonicalizes each candidate through
    // `isPathContained` before offering it, so a link out of the source root
    // never reaches this function.
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** True when anything at all exists at `candidate`, a dangling symlink included. */
function somethingExistsAt(candidate: string): boolean {
  try {
    // `lstatSync`, not `existsSync`: `existsSync` follows the link and answers
    // FALSE for a dangling one, while `copyFile` would happily write through
    // it and create the target. The create-only clause has to see the link.
    lstatSync(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * The write fence for the migration power — prd-20 ruling 6, ADR-0020.
 *
 * The fourth hand gains one further write and only one: it may COPY a session
 * transcript into the harness state directory for the watched repo, so that a
 * conversation begun somewhere else can be resumed *here*, instrumented.
 * `research/2026-08-14-cross-host-resume.md` is the evidence that this works
 * at all, and that placing the file IS the whole mechanism: resume lookup is
 * scoped to the slug directory of the current working directory (Q1's
 * control), the resume appends in place under the preserved sessionId (Q3),
 * and telemetry books under that same id (Q4). Verified on Claude Code
 * `2.1.232`, whose session-log format is explicitly free to change.
 *
 * **The signature is the fence's first clause.** There is no `source`
 * parameter, because a fence that validates a caller-supplied path can only
 * ever refuse the spellings its author thought of. Both paths are DERIVED
 * from an {@link Attribution} the event log itself produced — the source
 * through `candidateTranscriptPaths`, the destination from the watched repo's
 * own slug — so "copy me `/etc/shadow`" is not a request this function can be
 * asked. That is why an `assert…` returns a value: the only way to make an
 * arbitrary source unrepresentable is to not accept one.
 *
 * It deliberately takes no injectable `realpath`, unlike
 * {@link assertCloneTarget}. The derivation runs through
 * `candidateTranscriptPaths`, which canonicalizes with `realpath(3)` and takes
 * no such argument; a fence that honoured an injected canonicalizer in three
 * clauses and ignored it in the fourth would be worse than one that never
 * claims to. The tests use real temp directories instead.
 *
 * Six clauses, in the order a mistake arrives:
 *
 * 1. The session id passes `isSafeSessionId` BEFORE any path is built — an
 *    absolute path, a `/` and a NUL byte are all refused while they are still
 *    a string, not after they have become a directory — **and** it is not `.`
 *    or `..`. That second half is not redundant, which is worth stating rather
 *    than leaving for the next reader to rediscover: `path.basename('..')` is
 *    `'..'`, so the shared shape check admits both dot ids. This fence appends
 *    `.jsonl`, so `'..'` would land as a file called `...jsonl` rather than
 *    escaping anywhere — but an id that names a directory is not a session id,
 *    and a later caller that builds a filename some other way must not inherit
 *    an admitted `..` from here.
 * 2. The destination is exactly
 *    `<claudeProjectsRoot>/<slug(watchedRepoPath)>/<sessionId>.jsonl`, and it
 *    must still be contained by `claudeProjectsRoot` once canonicalized — the
 *    slug directory itself can be a symlink pointing anywhere.
 * 3. The destination is never inside the watched repo's working tree. Clause 2
 *    implies it for any ordinary layout; it is asserted independently because
 *    prd-20's non-goal ("never a write inside the watched repo's working
 *    tree") is the one line this instrument cannot cross, and defence in depth
 *    is cheap — the clone fence's own fourth clause, reapplied.
 * 4. The source is one of `candidateTranscriptPaths`' offerings, and is a
 *    regular file. Nothing else can be named.
 * 5. Source and destination are different files once canonicalized — a
 *    transcript already where a resume would find it is not a migration.
 * 6. Create-only: nothing may exist at the destination. **This clause is
 *    advisory, and saying so is the point.** It is a check-then-write, so it
 *    is a TOCTOU by construction; the guarantee is `COPYFILE_EXCL` on the
 *    `copyFile` itself, which the namespace law's clause 6 pins as an
 *    obligation on the wave that writes it. This clause exists to give the
 *    operator a legible refusal, not to be the thing standing between them
 *    and a lost transcript.
 *
 * ## The residual this fence does NOT close, named (ledger #9)
 *
 * Every clause above canonicalizes, and canonicalizing is a READ that happens
 * before the write. A **parent directory swapped between the two** — the slug
 * directory replaced with a symlink after clause 2 has resolved it and before
 * `copyFile` opens the path — lands the copy wherever the new link points, and
 * no amount of resolving at check time can prevent it. The same is true of the
 * clone fence's clauses one file up, and it is the *class* clause 6's own
 * sentence already admits, stated once for the whole module rather than only
 * for the destination-exists case.
 *
 * It is recorded rather than closed because of who the actor would have to be.
 * Winning that race means write access to the parent of a directory under
 * `~/.claude` at the moment of the copy — an attacker who already owns the
 * operator's harness state directory, which the threat model names and accepts
 * as out of scope (they need no race to read or replace transcripts; they
 * already have them). What would close it structurally is opening the parent
 * directory once and writing relative to that descriptor (`openat`-style), so
 * the check and the write name the same inode rather than the same string —
 * real, and a different shape of change from this fence.
 *
 * So the posture here is deliberate and matches clause 6's: **advisory, and
 * legible.** A reader must not come away thinking canonicalization makes these
 * paths race-free. It makes them honestly resolved at the moment they were
 * read, which is a smaller and true claim.
 */
export function assertMigrationPaths(fence: MigrationFence, attribution: Attribution): MigrationPaths {
  const { claudeProjectsRoot, watchedRepoPath } = fence
  const sourceProjectsRoot = fence.sourceProjectsRoot ?? claudeProjectsRoot

  // 1 — the shape of the id, while it is still a string. See the doc comment
  // for why `.`/`..` need naming separately: `path.basename` returns them
  // unchanged, so `isSafeSessionId` alone admits both.
  if (!isSafeSessionId(attribution.sessionId) || attribution.sessionId === '.' || attribution.sessionId === '..') {
    throw new MigrationFenceError(
      `refusing to migrate: ${JSON.stringify(attribution.sessionId)} is not a bare session id`,
    )
  }

  // 2 — the destination, derived. `canonicalize` before slugging because
  // Claude Code slugs its own `process.cwd()`, which Node has already resolved
  // through `realpath(3)`: on macOS a `/var/…` repo path and the `/private/var/…`
  // the CLI actually sees produce two DIFFERENT slugs, so an unresolved
  // spelling would place the file in a directory no resume ever reads.
  const watchedRepoReal = realPathOrRefuse(watchedRepoPath, 'the watched repo')
  const destination = path.join(
    claudeProjectsRoot,
    worktreePathToProjectSlug(watchedRepoReal),
    `${attribution.sessionId}${TRANSCRIPT_SUFFIX}`,
  )
  if (!isPathContained(claudeProjectsRoot, destination)) {
    throw new MigrationFenceError(
      `refusing to migrate: ${destination} does not resolve inside ${path.resolve(claudeProjectsRoot)}`,
    )
  }

  // 3 — never a write inside the watched repo's working tree.
  if (insideOrUnreadable(watchedRepoReal, destination)) {
    throw new MigrationFenceError(`refusing to migrate: ${destination} is inside the watched repo ${watchedRepoReal}`)
  }

  // 4 — the source, derived. The event log's attribution decides it; a caller
  // cannot name a file, only the root the attributed path is resolved against.
  const candidates = candidateTranscriptPaths(attribution, sourceProjectsRoot)
  const source = candidates.find(isRegularFile)
  if (source === undefined) {
    throw new MigrationFenceError(
      `refusing to migrate: no transcript for session ${attribution.sessionId} at any path its attribution derives ` +
        `(looked in ${candidates.length === 0 ? '<no candidate path passed containment>' : candidates.join(', ')})`,
    )
  }

  // 5 — a transcript already where a resume would find it is not a migration.
  if (realPathOrRefuse(source, 'the source') === realPathOrRefuse(destination, 'the destination')) {
    throw new MigrationFenceError(`refusing to migrate: ${source} is already where a resume in the watched repo looks`)
  }

  // 6 — create-only. Advisory; `COPYFILE_EXCL` is the guarantee.
  if (somethingExistsAt(destination)) {
    throw new MigrationFenceError(`refusing to migrate: ${destination} already exists — this hand never overwrites`)
  }

  return { source, destination }
}
