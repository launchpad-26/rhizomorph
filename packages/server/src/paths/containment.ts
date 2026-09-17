import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * THE SYMLINK-ESCAPE CONTAINMENT PRIMITIVE (#217/#228, #299, #401).
 *
 * The shared home for "is this path inside that one, even through a
 * symlink" — previously duplicated between `lab/paths.ts` (the fix for
 * #217/#228, the lab's own worktree fence) and `cli/export-record.ts`'s
 * `canonicalizeExistingAncestor` (#299, the export-record repo-escape
 * check). Both did the same three things: resolve, walk up to the nearest
 * existing ancestor, `realpath` that ancestor, re-append the unresolved
 * tail — because a path that hasn't been created cannot itself be a
 * symlink. Duplicated security primitives fail in a specific way: the next
 * hardening lands in whichever copy the author was looking at, and the
 * other one keeps the hole (#401).
 *
 * A refactor that quietly weakens this is worse than the duplication it
 * replaces, so the merge keeps BOTH halves that #217/#228 and #299
 * separately fixed:
 *
 * - `defaultRealpath` calls `fs.realpathSync.native` — the OS's own
 *   `realpath(3)` — rather than Node's pure-JS reimplementation. #228 found
 *   the JS version disagreeing with itself across Node versions on the
 *   same macOS host, which turns a genuinely-contained path into a false
 *   escape when the two sides of a comparison canonicalize differently. See
 *   `containment.test.ts` for the simulated reproduction.
 * - `canonicalize` chases a DANGLING symlink's own target, not just an
 *   ordinary nonexistent path. `export-record.ts`'s original
 *   `canonicalizeExistingAncestor` needed this for `--out` pointing at a
 *   not-yet-written file behind a symlink (the exploit #299 fixes: a
 *   symlink whose target does not exist yet still resolves inside the
 *   watched repo). `lab/paths.ts`'s original `canonicalize` never needed
 *   this — the lab never resolves a caller-supplied symlink — so folding
 *   the two without this case would have silently dropped #299's coverage:
 *   a dangling symlink's own (unresolved) path would walk up to its
 *   existing parent directory and stop there, never reaching the target it
 *   actually points at.
 */

/** A `realpath`-shaped function: resolves an existing path to its canonical form. */
export type Realpath = (existingPath: string) => string

const defaultRealpath: Realpath = realpathSync.native ?? realpathSync

/** `candidate`'s resolved link target, if `candidate` exists and is a symlink — `undefined` otherwise (including "does not exist at all"). */
function danglingSymlinkTarget(candidate: string): string | undefined {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(candidate)
  } catch {
    return undefined
  }
  if (!stat.isSymbolicLink()) return undefined
  return path.resolve(path.dirname(candidate), readlinkSync(candidate))
}

/**
 * `path.resolve`, but symlink-free: walks up to the nearest ancestor that
 * exists, `realpath`s THAT (so a symlinked ancestor resolves to where it
 * actually points), then re-appends whatever tail doesn't exist yet
 * unresolved — a path that hasn't been created cannot itself be a symlink.
 * If an ancestor along the way is itself a DANGLING symlink (exists, but its
 * target doesn't), that target is chased instead of walking past it, so a
 * symlink is never mistaken for an ordinary missing path.
 *
 * Every containment check below needs this on both sides, for two symmetric
 * reasons (#217): macOS's `/var/folders/…` is a symlink to
 * `/private/var/folders/…`, so a raw-prefix comparison between an
 * unresolved parent and a candidate path some other tool already
 * canonicalized (confirmed on Linux, symlink and all, in
 * `lab/paths.test.ts`) sees an escape where there is none. The other
 * direction is the real vulnerability: a symlink placed INSIDE the
 * permitted directory whose target lies outside it would pass a prefix
 * check on its own un-followed spelling while every byte written through it
 * lands wherever the link points. Canonicalizing both sides closes both —
 * PROVIDED the canonicalizer agrees with itself, which is exactly what #228
 * found `realpathSync` (JS) does not always do; see `defaultRealpath` above
 * and `containment.test.ts`'s simulated-shape tests for the failure this
 * would otherwise reintroduce.
 */
/**
 * The chase bound. `realpath(3)` gives up at `SYMLOOP_MAX` (40 on Linux) and
 * raises `ELOOP`; this walk has to do the same, because the cases it handles
 * are exactly the ones the OS could NOT resolve — so the OS's own loop
 * detection never ran on them.
 *
 * The case that made this necessary is narrower than a plain `a -> b -> a`
 * cycle, which `realpath` catches for us as `ELOOP`: a link whose target
 * traverses a MISSING directory back to itself, e.g. `x/link -> ./missing/../link`.
 * `realpath` fails that as **ENOENT**, not `ELOOP` — it stats `x/missing` and
 * stops before any loop is detectable — so the chase below treats it as a
 * dangling symlink, resolves it back to itself, and spins. Verified: the loop
 * is synchronous, so it blocks the event loop and a test timeout cannot even
 * fire on it.
 */
const MAX_SYMLINK_HOPS = 40

export function canonicalize(candidate: string, realpath: Realpath = defaultRealpath): string {
  const resolved = path.resolve(candidate)
  let current = resolved
  const pendingTail: string[] = []
  let hops = 0
  while (true) {
    try {
      const real = realpath(current)
      return pendingTail.length === 0 ? real : path.join(real, ...pendingTail.reverse())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const linkTarget = danglingSymlinkTarget(current)
      if (linkTarget !== undefined) {
        hops += 1
        if (hops > MAX_SYMLINK_HOPS) {
          const loop: NodeJS.ErrnoException = new Error(
            `ELOOP: too many symbolic links encountered, canonicalize '${resolved}'`,
          )
          loop.code = 'ELOOP'
          throw loop
        }
        current = linkTarget
        continue
      }
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
 * `realpath` is overridable so tests can simulate a canonicalizer that DOES
 * disagree with itself (the exact macOS-current shape) without needing a
 * macOS host to reproduce it; production code always takes the default.
 */
export function isInside(parent: string, candidate: string, realpath: Realpath = defaultRealpath): boolean {
  const from = canonicalize(parent, realpath)
  const to = canonicalize(candidate, realpath)
  if (to === from) return true
  return to.startsWith(from.endsWith(path.sep) ? from : from + path.sep)
}

/**
 * A repo path in the spelling every other reader of it uses.
 *
 * `path.resolve` does not follow symlinks and {@link canonicalize} does, so the
 * two are different names for one repository whenever a symlink is in the way —
 * unconditionally on macOS, where `os.tmpdir()` is `/var/...` →
 * `/private/var/...`. A pin in one spelling against a resolver answering in the
 * other makes ONE repository into TWO colonies: two recorders, two poll loops,
 * two recordings, two rows in the selector.
 *
 * It lives here rather than beside its callers for two reasons. `cli/run.ts`,
 * `cli/doctor.ts` and `api/retarget.ts` all need it and must not disagree —
 * `doctor` reporting a different watched set from the server it is diagnosing
 * is the defect that check exists to make visible. And this file is the one
 * place a `canonicalize*` symbol may be defined (`containment.test.ts`, #401
 * step 5): a variant of the primitive belongs beside the primitive, so a
 * reader grepping the name finds every spelling in one file.
 *
 * `canonicalize` throws on anything that is not `ENOENT` — a permission error
 * part-way up the tree, an `ELOOP`. Neither a boot nor a diagnosis may die for
 * that: the answer is then the resolved path, which is what this value was
 * before prd-58 and is still correct for every layout without a symlink in it.
 */
export function canonicalizeRepoPath(resolved: string): string {
  try {
    return canonicalize(resolved)
  } catch {
    return resolved
  }
}
