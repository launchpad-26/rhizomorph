import { listSessionListings, type SessionListing } from '../log/listing.js'
import { defaultDataRoot, sessionDirFor } from '../log/paths.js'

export interface SessionsOptions {
  repoPath: string
  /** Overrides `~/.local/share/rhizomorph`; tests point this at a temp dir. */
  dataRoot?: string
}

/** Reads every session recorded for a repo — a standalone, read-only listing, no server boot. */
export async function runSessions(options: SessionsOptions): Promise<SessionListing[]> {
  const sessionDir = sessionDirFor(options.repoPath, options.dataRoot ?? defaultDataRoot())
  return listSessionListings(sessionDir)
}

const COLUMNS = ['ID', 'TITLE', 'WHEN', 'DURATION', 'LANES', 'LANDED', 'OUTPUT', 'COST', 'SIZE'] as const

/**
 * Renders `rhizomorph sessions`'s table — newest first, so the recording an
 * operator usually wants (the one they just finished) reads at the top
 * without scrolling. Same padded-column shape `rhizomorph lab compare`
 * already uses, restated here rather than imported: that renderer lives
 * under `server/src/lab/`, and prd12 ruling 1's namespace law confines
 * importers of that directory to `cli/index.ts` alone.
 */
export function renderSessionsReport(listings: readonly SessionListing[]): string {
  if (listings.length === 0) {
    return 'no recorded sessions yet'
  }

  const rows = [...listings]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((listing) => [
      listing.id,
      listing.title,
      formatWhen(listing.startedAt),
      formatDuration(listing.durationMs),
      String(listing.lanes),
      String(listing.landed),
      formatTokens(listing.outputTokens),
      formatCost(listing),
      formatBytes(listing.sizeBytes),
    ])

  const widths = COLUMNS.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => (cell ?? '').padEnd(widths[column] ?? 0)).join('  ').trimEnd()

  return [line(COLUMNS), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n')
}

/** UTC, matching every other wall-clock figure this app prints (the replay banner's own convention) — a stranger's machine must read the same digits. */
function formatWhen(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

const TOKEN_UNITS: readonly [threshold: number, suffix: string][] = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K'],
]

function formatTokens(count: number): string {
  for (const [threshold, suffix] of TOKEN_UNITS) {
    if (count >= threshold) return `${trimTrailingZero((count / threshold).toFixed(1))}${suffix}`
  }
  return String(count)
}

/** `null` (no cost telemetry at all) reads as "—", never a fabricated `$0.00`; a mix of authoritative and estimated dollars is flagged "(est.)" — the same honesty rule `formatSpend` enforces on the web side, restated here since server code cannot import from `packages/web`. */
function formatCost(listing: Pick<SessionListing, 'costUsd' | 'costIsAuthoritative'>): string {
  if (listing.costIsAuthoritative === null) return '—'
  const amount = listing.costUsd > 0 && listing.costUsd < 0.01 ? '<$0.01' : `$${listing.costUsd.toFixed(2)}`
  return listing.costIsAuthoritative ? amount : `${amount} (est.)`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${trimTrailingZero(kb.toFixed(1))}KB`
  return `${trimTrailingZero((kb / 1024).toFixed(1))}MB`
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}
