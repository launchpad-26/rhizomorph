import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

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
 * `canonicalize`/`isInside` below are a deliberate duplicate of `lab/paths.ts`,
 * not an oversight. The laboratory's own namespace law forbids any server file
 * outside `lab/` from importing it (prd12 ruling 1 — the second hand is
 * explicitly-invoked only), so the fourth hand borrowing the second hand's
 * helper would breach the second hand's fence to build its own. That is the
 * constitution working as intended, and the cost is this comment plus ~30
 * duplicated lines. The `#228`/`#217` reasoning those lines encode is recorded
 * once, in `lab/paths.ts`; the summary here is deliberately short.
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
 * override it, per ADR-0014's Consequences: "answering the question later
 * sets that argument; it does not reopen this law."
 */
export function defaultClonesRoot(): string {
  return path.join(homedir(), 'rhizomorph', 'repos')
}

/** A `realpath`-shaped function: resolves an existing path to its canonical form. */
export type Realpath = (existingPath: string) => string

/**
 * `fs.realpathSync.native` — the OS's own `realpath(3)`, not Node's pure-JS
 * reimplementation, because #228 caught the two disagreeing with each other on
 * one macOS host across two Node versions. Same choice, same reason, as
 * `lab/paths.ts`; the full account lives there.
 */
const defaultRealpath: Realpath = realpathSync.native ?? realpathSync

/**
 * `path.resolve`, but symlink-free: walks up to the nearest ancestor that
 * exists, `realpath`s that, then re-appends the not-yet-existing tail
 * unresolved — a path that has not been created cannot itself be a symlink.
 *
 * Needed on BOTH sides of every containment check, for two symmetric reasons
 * (#217). Benign: macOS's `/var/folders/…` is a symlink to
 * `/private/var/folders/…`, so a raw prefix comparison reports an escape that
 * never happened. Hostile, and the reason this is a fence and not a
 * convenience: a symlink placed *inside* the permitted directory, pointing
 * out of it, passes a raw prefix check on its own un-followed spelling while
 * every byte written through it lands wherever the link points.
 *
 * On a case-insensitive filesystem (macOS's default) this also normalises
 * case for the part of the path that exists, so `…/CLONES/x` and `…/clones/x`
 * cannot be made to disagree — see `paths.test.ts`.
 */
function canonicalize(candidate: string, realpath: Realpath): string {
  const resolved = path.resolve(candidate)
  let current = resolved
  const pendingTail: string[] = []
  while (true) {
    try {
      const real = realpath(current)
      return pendingTail.length === 0 ? real : path.join(real, ...pendingTail.reverse())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = path.dirname(current)
      if (parent === current) return resolved // hit the filesystem root without finding anything real
      pendingTail.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * True when `candidate` is `parent` itself or lies beneath it, both
 * canonicalized first through the SAME `realpath` so a symlinked ancestor
 * cannot make the two sides disagree.
 *
 * `realpath` is overridable so tests can simulate a canonicalizer that
 * disagrees with itself; production always takes the default.
 */
export function isInside(parent: string, candidate: string, realpath: Realpath = defaultRealpath): boolean {
  const from = canonicalize(parent, realpath)
  const to = canonicalize(candidate, realpath)
  if (to === from) return true
  return to.startsWith(from.endsWith(path.sep) ? from : from + path.sep)
}

/** Strictly beneath `parent` — the directory itself does not count. */
function isStrictlyInside(parent: string, candidate: string, realpath: Realpath): boolean {
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
    super(`${message} (prd-20 ruling 1 / ADR-0014 — the concierge clones only into its own namespace)`)
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
export function assertCloneTarget(fence: CloneFence, candidate: string, realpath: Realpath = defaultRealpath): void {
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
