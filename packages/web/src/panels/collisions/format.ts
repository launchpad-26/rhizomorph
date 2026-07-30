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
