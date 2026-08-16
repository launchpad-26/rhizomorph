/**
 * Pure parsers for `workmux status` and `workmux list` table output.
 *
 * Both commands print a fixed-width, space-padded table (no ANSI colour, no
 * tabs — verified against captured real output). We locate each column by
 * finding its header word in the header row, then slice every data row at
 * those offsets. That is robust to width changes (long handles, long
 * titles) without depending on fields never containing runs of spaces —
 * the TITLE/PATH columns are always last, so they just take the rest of
 * the line.
 */

export interface ParsedStatusRow {
  /** workmux's handle for the agent — its worktree/window name. */
  handle: string
  /** Raw status text from the STATUS column, not yet validated against the schema. */
  status: string
  elapsedSeconds: number | null
  detail: string | null
}

export interface ParsedListRow {
  branch: string
  /** Raw PATH column value. May be the literal `(here)` workmux prints for the cwd's own worktree. */
  path: string
}

/** Locates `WORKTREE STATUS ELAPSED TITLE`; returns [] for "No active agents" or any unrecognised output. */
export function parseStatusTable(stdout: string): ParsedStatusRow[] {
  const lines = stdout.split('\n')
  const headerIndex = lines.findIndex((line) => line.startsWith('WORKTREE'))
  if (headerIndex === -1) return []

  const header = lines[headerIndex] ?? ''
  const starts = columnStarts(header, ['WORKTREE', 'STATUS', 'ELAPSED', 'TITLE'])
  if (!starts) return []
  const [worktreeAt, statusAt, elapsedAt, titleAt] = starts

  const rows: ParsedStatusRow[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim() === '') continue
    const handle = line.slice(worktreeAt, statusAt).trim()
    if (handle === '') continue
    const status = line.slice(statusAt, elapsedAt).trim()
    const elapsedRaw = line.slice(elapsedAt, titleAt).trim()
    const detail = line.slice(titleAt).trim()
    rows.push({
      handle,
      status,
      elapsedSeconds: parseElapsed(elapsedRaw),
      detail: detail === '' ? null : detail,
    })
  }
  return rows
}

/** Locates `BRANCH AGE AGENT MUX UNMERGED PATH`; returns [] for any unrecognised output. */
export function parseListTable(stdout: string): ParsedListRow[] {
  const lines = stdout.split('\n')
  const headerIndex = lines.findIndex((line) => line.startsWith('BRANCH'))
  if (headerIndex === -1) return []

  const header = lines[headerIndex] ?? ''
  const starts = columnStarts(header, ['BRANCH', 'AGE', 'AGENT', 'MUX', 'UNMERGED', 'PATH'])
  if (!starts) return []
  const [branchAt, , , , , pathAt] = starts

  const rows: ParsedListRow[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim() === '') continue
    const branch = line.slice(branchAt, pathAt).split(/\s{2,}/)[0]?.trim() ?? ''
    const path = line.slice(pathAt).trim()
    if (branch === '' || path === '') continue
    rows.push({ branch, path })
  }
  return rows
}

/**
 * Sums duration tokens like `1h2m3s`, `12m`, `43s`. A leading `<` (workmux's
 * "less than a minute" notation) is dropped before matching. Returns `null`
 * for `-` or anything with no recognisable token, rather than throwing.
 */
export function parseElapsed(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '-') return null
  // workmux's "less than a minute" notation — report the floor rather than
  // the number that follows, since "<1m" would otherwise parse as a full 60s.
  if (trimmed.startsWith('<')) return 0

  const unitSeconds: Record<string, number> = { h: 3600, m: 60, s: 1 }
  let total = 0
  let matched = false
  for (const match of trimmed.matchAll(/(\d+)\s*([hms])/g)) {
    const [, value, unit] = match
    if (!value || !unit) continue
    total += Number(value) * unitSeconds[unit]!
    matched = true
  }
  return matched ? total : null
}

/** Returns the start offset of each header name in order, or null if any name is missing. */
function columnStarts(header: string, names: readonly string[]): number[] | null {
  const starts: number[] = []
  for (const name of names) {
    const at = header.indexOf(name)
    if (at === -1) return null
    starts.push(at)
  }
  return starts
}
