import path from 'node:path'
import { isInside, type Realpath } from '../paths/containment.js'

export { isInside, type Realpath }

/**
 * prd12 ruling 1's namespaces, expressed as paths.
 *
 * The amendment lets the laboratory write in exactly three places: refs under
 * `refs/rhizomorph/` (checkpoint.ts owns that one), worktrees the lab itself
 * creates, and artifacts OUTSIDE the watched repo, "the same data-directory
 * posture as the event log". This module is the second and third of those,
 * and it is the ONLY place a lab-owned path is constructed — so a reader can
 * see the whole write surface in one screen, and `assertInsideLabWorktrees`
 * can turn the law into a runtime refusal rather than a comment.
 *
 * Everything hangs off `dataRoot` (`~/.local/share/rhizomorph` by default),
 * so a lab worktree is a sibling of the event log and never lands inside the
 * repo being watched.
 *
 * The symlink-escape containment check itself — `isInside`, the `canonicalize`
 * it depends on, and the `Realpath` seam — lives in `../paths/containment.ts`
 * (#401): it was duplicated here and in `cli/export-record.ts` until this
 * issue merged the two. `isInside` and `Realpath` are re-exported so every
 * existing import of this module keeps working unchanged.
 */

/** `<dataRoot>/lab` — the laboratory's whole footprint on disk. */
export function labRoot(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), 'lab')
}

/** `<dataRoot>/lab/worktrees` — every workspace the lab restores lives under here. */
export function labWorktreesRoot(dataRoot: string): string {
  return path.join(labRoot(dataRoot), 'worktrees')
}

/**
 * `<dataRoot>/lab/worktrees/<forkId>-arm-<n>` — one arm's restored workspace.
 *
 * Flat, with the fork id in the leaf, rather than nested `<forkId>/arm-<n>`:
 * git names each worktree's bookkeeping directory in `.git/worktrees/` after
 * the leaf basename, so a nested layout would give every fork's first arm the
 * same `arm-1` id and leave git to disambiguate them. The fork id belongs in
 * the name that git actually reads.
 */
export function armWorktreePath(dataRoot: string, forkId: string, arm: number): string {
  return path.join(labWorktreesRoot(dataRoot), `${forkId}-arm-${arm}`)
}

/**
 * The write fence, enforced rather than described: refuses any target that is
 * not under `<dataRoot>/lab/worktrees`. Every lab function that creates a
 * worktree calls this first, so a caller — a future subcommand, a test, a
 * mistake — physically cannot point the lab's `git worktree add` at the
 * operator's tree.
 */
export function assertInsideLabWorktrees(dataRoot: string, candidate: string, realpath?: Realpath): void {
  const root = labWorktreesRoot(dataRoot)
  if (!isInside(root, candidate, realpath)) {
    throw new Error(
      `refusing to write outside the lab's namespace: ${path.resolve(candidate)} is not under ${root} ` +
        '(prd12 ruling 1 — the laboratory may only create worktrees it owns)',
    )
  }
}
