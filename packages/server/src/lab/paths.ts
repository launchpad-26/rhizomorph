import { realpathSync } from 'node:fs'
import path from 'node:path'

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

/** A `realpath`-shaped function: resolves an existing path to its canonical form. */
export type Realpath = (existingPath: string) => string

/**
 * `fs.realpathSync.native` — the OS's own `realpath(3)`, called directly
 * rather than through Node's pure-JS reimplementation (#228). CI showed the
 * two disagreeing with each other: the same macOS host, the same code, the
 * only variable being the Node version, produced a different verdict —
 * `/private` got attached to a resolved `/var/folders/…` path under one Node
 * and not the other. `realpathSync` (no suffix) is a JS walk of the path that
 * has been re-implemented across Node releases; `.native` is a thin wrapper
 * over the C library call, so for a given OS it can only ever answer one way.
 * Falls back to the JS implementation only if `.native` is somehow absent —
 * it has shipped since Node 9, so this is a defensive default, not a path
 * expected to run.
 */
const defaultRealpath: Realpath = realpathSync.native ?? realpathSync

/**
 * `path.resolve`, but symlink-free: walks up to the nearest ancestor that
 * exists, `realpath`s THAT (so a symlinked ancestor resolves to where it
 * actually points), then re-appends whatever tail doesn't exist yet
 * unresolved — a path that hasn't been created cannot itself be a symlink.
 *
 * Every containment check below needs this on both sides, for two symmetric
 * reasons (#217): macOS's `/var/folders/…` is a symlink to
 * `/private/var/folders/…`, so a raw-prefix comparison between the lab's
 * (unresolved) data root and a worktree path git reports (canonicalized —
 * confirmed on Linux, symlink and all, in `paths.test.ts`) sees an escape
 * where there is none. The other direction is the real vulnerability: a symlink placed
 * INSIDE the permitted directory whose target lies outside it would pass a
 * prefix check on its own un-followed spelling while every byte written
 * through it lands wherever the link points. Canonicalizing both sides
 * closes both — PROVIDED the canonicalizer agrees with itself, which is
 * exactly what #228 found `realpathSync` (JS) does not always do; see
 * `defaultRealpath` above and `paths.test.ts`'s simulated-shape tests for the
 * failure this would otherwise reintroduce.
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
 * True when `candidate` is `parent` itself or lies beneath it. Both are
 * canonicalized first, through the SAME `realpath`, so the comparison can
 * only fail to reconcile a symlinked ancestor if that function disagrees with
 * itself across the two calls — which `defaultRealpath` is chosen precisely
 * to rule out (#228).
 *
 * `realpath` is overridable so `paths.test.ts` can simulate a canonicalizer
 * that DOES disagree with itself (the exact macOS-current shape) without
 * needing a macOS host to reproduce it; production code always takes the
 * default.
 */
export function isInside(parent: string, candidate: string, realpath: Realpath = defaultRealpath): boolean {
  const from = canonicalize(parent, realpath)
  const to = canonicalize(candidate, realpath)
  if (to === from) return true
  return to.startsWith(from.endsWith(path.sep) ? from : from + path.sep)
}

/**
 * The write fence, enforced rather than described: refuses any target that is
 * not under `<dataRoot>/lab/worktrees`. Every lab function that creates a
 * worktree calls this first, so a caller — a future subcommand, a test, a
 * mistake — physically cannot point the lab's `git worktree add` at the
 * operator's tree.
 */
export function assertInsideLabWorktrees(
  dataRoot: string,
  candidate: string,
  realpath: Realpath = defaultRealpath,
): void {
  const root = labWorktreesRoot(dataRoot)
  if (!isInside(root, candidate, realpath)) {
    throw new Error(
      `refusing to write outside the lab's namespace: ${path.resolve(candidate)} is not under ${root} ` +
        '(prd12 ruling 1 — the laboratory may only create worktrees it owns)',
    )
  }
}
