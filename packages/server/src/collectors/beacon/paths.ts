import path from 'node:path'
import { defaultDataRoot, sessionDirFor } from '../../log/paths.js'
import { isInside } from '../../paths/containment.js'

export const BEACONS_DIR_NAME = 'beacons'
export const BEACON_FILE_SUFFIX = '.jsonl'

/**
 * `<dataRoot>/<repoSlug>/beacons` — the one rhizomorph-owned directory a
 * beacon writer appends to (ADR-0036; prd-27 ruling 1 / prd-17 ruling 2).
 *
 * Per repo, not instrument-wide: a beacon from one repo's swarm must never
 * fold into another repo's session. The pi collector learned that scoping the
 * hard way (#609) and had to enforce it by header field; a directory keyed by
 * the repo's slug enforces it structurally, and `repoSlug` carries a hash so
 * two repos sharing a basename still get two directories.
 *
 * Beside the recordings, because prd-17 ruling 2 names "the instrument's own
 * data directory" as the door, and `listSessions` matches only
 * `session-<ts>.jsonl` in the session directory itself — so `beacons/` is
 * invisible to it, to retention and to the lane index, the same posture
 * `snapshots/` and `transcripts/` hold.
 *
 * The collector never creates this directory. Creating one's own input is one
 * step from writing into it; the writer that appends is the one that knows the
 * directory has to exist (`collector.ts`).
 */
export function beaconDirFor(repoPath: string, dataRoot: string = defaultDataRoot()): string {
  return path.join(sessionDirFor(repoPath, dataRoot), BEACONS_DIR_NAME)
}

/**
 * `<dataRoot>/beacons` — the door for the whole INSTALLATION, not for one repo.
 *
 * prd-57 ruling 6, licensed by ADR-0055, which amends ADR-0036. The docblock
 * above is left standing rather than rewritten, because its reason is the one
 * that has to be answered rather than waved past: **a beacon from one repo's
 * swarm must never fold into another repo's session.** The pi collector learned
 * that the hard way and had to enforce it by header field.
 *
 * ADR-0055 keeps the guarantee and moves where it is enforced. A per-repo door
 * requires the WRITER to know the slug derivation the READER uses — and a hook
 * fires for whatever repo the agent is sitting in, including one this
 * instrument has never discovered. A writer that must compute a reader's
 * private key is a coupling that breaks silently the first time the derivation
 * changes.
 *
 * So the guarantee becomes a ROUTING RULE with a law: every line carries `cwd`,
 * {@link beaconLineBelongsTo} decides by containment, and a line matching no
 * watched repo is retained and attributed to none.
 *
 * **Not a novel mechanism — the one the pi collector already proved in this
 * tree.** `collectors/pi/collector.ts` declines to assume a slug convention it
 * cannot back, and attributes each session by the `cwd` its own header line
 * reports, skipping out-of-scope sessions (landed `a51b0867`). ADR-0036's own
 * cautionary example is, in its current form, a working implementation of
 * routing-by-cwd rather than scoping-by-directory.
 *
 * The per-repo door is NOT retired: {@link beaconDirFor} still resolves and the
 * collector reads both. A door written before this wave holds lines nobody
 * would otherwise fold, and dropping them silently would lose beacons an
 * operator had already collected.
 */
export function installationBeaconDir(dataRoot: string = defaultDataRoot()): string {
  return path.join(dataRoot, BEACONS_DIR_NAME)
}

/**
 * Whether a beacon line belongs to the repo this server is watching.
 *
 * An absent `cwd` is the honest unknown and is NOT a match: a line that does
 * not say where it came from cannot be attributed by containment, and guessing
 * would be the fold ADR-0036 refuses. Such a line stays in the file and is
 * attributed to nobody, which is what ruling 6 asks for.
 *
 * Containment rather than equality, because an agent runs in a subdirectory far
 * more often than at the repo root — and through `isInside`, which canonicalises
 * both sides, because a repo reached through a symlink is the standing macOS
 * case (#217).
 *
 * **Containment in `repoPath` is NOT enough for a linked worktree**, which this
 * comment used to claim it covered. `git worktree add` puts the tree wherever
 * it is told and the normal answer is OUTSIDE the repo directory — this
 * repository's own lab worktrees live under
 * `~/.local/share/rhizomorph/lab/worktrees/`, and its lanes are siblings of the
 * checkout. So a hook firing in a lane writes a `cwd` that is not inside
 * `repoPath`, and containment alone dropped **every one of them**.
 *
 * Found end to end rather than by reading. prd-57's own end-to-end test put the
 * worktree INSIDE the repo — a fixture chosen, by me, so that `isInside` would
 * pass — and the defect sat under it through a green suite. The first test to
 * lay a worktree out the way `git` actually does found it immediately.
 *
 * So `worktreePaths` joins the question, and they come from the instrument's
 * own fold: the git collector emits `worktree.discovered` for every worktree of
 * the watched repo. That asks something the server has already answered instead
 * of spawning `git` inside a collector whose own tests assert it never execs —
 * a law worth keeping, and the reason the first fix for this was wrong.
 */
export function beaconLineBelongsTo(
  repoPath: string,
  cwd: string | undefined,
  worktreePaths: readonly string[] = [],
): boolean {
  if (cwd === undefined || cwd.length === 0) return false
  try {
    if (isInside(repoPath, cwd)) return true
    // A linked worktree of this repo counts, and containment in `repoPath`
    // cannot see one. The paths come from the instrument's own fold — the git
    // collector emits `worktree.discovered` for every worktree of the watched
    // repo — so this asks a question the server has already answered rather
    // than spawning `git` inside a collector whose own tests forbid it.
    return worktreePaths.some((worktree) => isInside(worktree, cwd))
  } catch {
    // A cwd that cannot be canonicalised (ELOOP, EACCES, a path that no longer
    // exists) is a placement this cannot state. Refused, never guessed — the
    // fail-closed posture `isInside` itself takes for an unresolvable root.
    return false
  }
}

/**
 * The worktrees a fold says are still THERE — the list {@link beaconLineBelongsTo}
 * should be routing against.
 *
 * The fold never deletes a worktree key: `worktree.removed` sets
 * `present: false` and keeps the entry (`packages/core/src/reduce.ts`). So
 * `Object.keys(state.worktrees)` is every worktree this session has ever seen,
 * and routing against it claims lines from lanes that no longer exist for the
 * life of the session.
 *
 * That matters because the door is SHARED. `git worktree add` reuses a path
 * readily, and a path this repo's removed lane once occupied may belong to a
 * different repository an hour later — whose hook lines would then be folded
 * into this colony's recording.
 *
 * `worktreePaths` was made a callback rather than a boot-time list *"because
 * worktrees appear and vanish while the server runs"*. Appearing worked from
 * the start; vanishing is what this function adds, and without it half that
 * sentence was untrue.
 */
export function presentWorktreePaths(worktrees: Readonly<Record<string, { present: boolean }>>): string[] {
  return Object.entries(worktrees)
    .filter(([, worktree]) => worktree.present)
    .map(([worktreePath]) => worktreePath)
}
