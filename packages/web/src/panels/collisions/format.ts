import type { BranchTouch, CollisionPair } from '@rhizomorph/core'

const ELLIPSIS = '…'

/**
 * Elide the middle of a path, keeping the basename and as many trailing
 * parent directories as fit within `maxChars`. Never cuts into the basename
 * itself — a long filename is shown in full rather than reduced to an
 * initial.
 */
export function elidePathMiddle(path: string, maxChars = 32): string {
  if (path.length <= maxChars) return path

  const segments = path.split('/').filter((segment) => segment.length > 0)
  let tail = segments[segments.length - 1] ?? path

  for (let i = segments.length - 2; i >= 0; i--) {
    const candidate = `${segments[i]}/${tail}`
    if (candidate.length + ELLIPSIS.length + 1 > maxChars) break
    tail = candidate
  }

  return tail === path ? path : `${ELLIPSIS}/${tail}`
}

/** Display handle for a branch column: last path segment, refs/heads/ stripped. */
export function shortenBranch(name: string): string {
  const stripped = name.replace(/^refs\/heads\//, '')
  const segments = stripped.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? stripped
}

/**
 * A colliding pair's evidence string (ruling 14 / graft g4): names the two
 * branches and the file they're both on, never a bare "2 branches collide"
 * label. `pair.files` is already worst-file-first (it walks `selectCollisions`'
 * own order), so the first entry is the most contended file either branch is
 * touching.
 */
export function formatPairEvidence(pair: CollisionPair): string {
  const [a, b] = pair.branches
  const [worst, ...rest] = pair.files
  const file = worst === undefined ? '' : elidePathMiddle(worst)
  const more = rest.length > 0 ? ` (+${rest.length} more)` : ''
  return `collision: ${shortenBranch(a)} × ${shortenBranch(b)} — ${file}${more}`
}

/**
 * The ambient empty-state line (ruling 14): never bare reassurance, always the
 * count of branches and files actually checked. Deliberately the same formula
 * `buildFleet`'s `calmEvidenceOf` uses over the same `selectTouchesByBranch`
 * output, so the panel needs no dependency on `FleetProvider` to say a number
 * that still cannot disagree with the strip's ALL CLEAR — same selector, same
 * session, same arithmetic.
 */
export function formatCheckedLine(touches: Readonly<Record<string, readonly BranchTouch[]>>): string {
  const files = new Set<string>()
  for (const list of Object.values(touches)) for (const touch of list) files.add(touch.path)

  const branchesChecked = Object.keys(touches).length
  const filesChecked = files.size

  return `collisions: 0 — checked ${branchesChecked} branch${
    branchesChecked === 1 ? '' : 'es'
  } / ${filesChecked} file${filesChecked === 1 ? '' : 's'}`
}
