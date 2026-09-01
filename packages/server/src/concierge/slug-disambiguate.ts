import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * The one piece of evidence that can settle a slug two or more real
 * directories could equally have produced (`repos.ts`'s `reverseProjectSlug`,
 * prd42 w9 / #142, operator ruling 2026-08-28): the transcript Claude Code
 * itself wrote under that slug records its own `cwd` on (most of) its lines.
 * `reverseProjectSlug` walks the real filesystem and never reads a
 * transcript's CONTENTS on its own — this file is the one seam that does,
 * kept apart from `log/transcript-attribution.ts` (which reads transcripts
 * for a different reason entirely: attributing telemetry to a lane) so the
 * concierge never has to import across that boundary. Nothing is shared with
 * that module on purpose — reading one slug's own directory of `*.jsonl`
 * files is a much narrower job than transcript attribution's, and this file
 * defines its own seam (`TranscriptReadFs`) rather than reaching for
 * `repos.ts`'s `DiscoveryFs`, so nothing here imports concierge types back
 * and nothing in `repos.ts` needs to know how a transcript line is shaped.
 *
 * Every read here is `readdir`/`readFile` from `node:fs/promises`, matching
 * this package's rule against ever blocking the event loop (see `repos.ts`'s
 * own module doc) — and it is only ever reached once `reverseProjectSlug`
 * has already found a genuine ambiguity, never on the (overwhelmingly more
 * common) unambiguous walk.
 */

export type TranscriptFileListing = { readable: true; files: string[] } | { readable: false; reason: string }
export type TranscriptFileRead = { readable: true; content: string } | { readable: false; reason: string }

/**
 * The filesystem seam this module reads through, mirroring `repos.ts`'s own
 * `DiscoveryFs` shape (total, async, fixture-friendly) but for file CONTENTS
 * rather than directory listings.
 */
export interface TranscriptReadFs {
  /**
   * Every `*.jsonl` file directly inside `slugDir`, name-sorted, or an
   * honest refusal. A directory that simply doesn't exist yet reads as
   * `{ readable: true, files: [] }` — "no transcript recorded" is not a read
   * failure, the same convention `repos.ts`'s own `DiscoveryFs` uses.
   */
  listTranscriptFiles(slugDir: string): Promise<TranscriptFileListing>
  /** The raw contents of one transcript file, or an honest refusal. */
  readTranscriptFile(filePath: string): Promise<TranscriptFileRead>
}

async function realListTranscriptFiles(slugDir: string): Promise<TranscriptFileListing> {
  let entries: string[]
  try {
    entries = await readdir(slugDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { readable: true, files: [] }
    return { readable: false, reason: `could not read ${slugDir}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { readable: true, files: entries.filter((name) => name.endsWith('.jsonl')).sort() }
}

async function realReadTranscriptFile(filePath: string): Promise<TranscriptFileRead> {
  try {
    return { readable: true, content: await readFile(filePath, 'utf8') }
  } catch (err) {
    return { readable: false, reason: `could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export const realTranscriptReadFs: TranscriptReadFs = {
  listTranscriptFiles: realListTranscriptFiles,
  readTranscriptFile: realReadTranscriptFile,
}

export interface RecordedCwdResult {
  cwd: string | null
  /** Present only when `cwd` is `null`: why no record could settle it. */
  reason?: string
}

/**
 * The most recently recorded `cwd` across every transcript file under this
 * slug's own directory (`<claudeProjectsRoot>/<slug>/*.jsonl`) — every line
 * of every file is one JSON record, and most (not all — a real session log
 * measured 940 of 1252) carry a `cwd` field holding the absolute path Claude
 * Code was running in when it wrote that line. Files are read in
 * name-sorted order. WITHIN one file the last line carrying a `cwd` wins —
 * the file is append-only, so line order is time order, and that keeps a
 * stale early `cwd` from outvoting a later one after a session moved.
 * ACROSS files there is no such ordering: real transcripts are UUID-named,
 * so name-sort order says nothing about recency. So the per-file winners
 * must AGREE; if two files record different directories the answer is a
 * refusal naming both, not a guess. An earlier revision took the last cwd
 * across files and returned a different real directory depending on which
 * UUID sorted last (found in review of #142, reproduced by swapping only the
 * filenames).
 *
 * Never throws: an unreadable directory, an unreadable file, a transcript
 * with no line that parses as JSON, and a transcript with no `cwd` field
 * anywhere are four different honest refusals, each with its own `reason` —
 * never collapsed into a bare `null`.
 */
export async function findRecordedCwd(
  slug: string,
  claudeProjectsRoot: string,
  fs: TranscriptReadFs = realTranscriptReadFs,
): Promise<RecordedCwdResult> {
  const slugDir = path.join(claudeProjectsRoot, slug)
  const listing = await fs.listTranscriptFiles(slugDir)
  if (!listing.readable) {
    return { cwd: null, reason: `could not read transcript directory ${slugDir}: ${listing.reason}` }
  }
  if (listing.files.length === 0) {
    return { cwd: null, reason: `no transcript recorded under ${slugDir} — no *.jsonl file to consult` }
  }

  // One winner PER FILE, then agreement ACROSS files. Within a single
  // transcript the last `cwd` genuinely is the latest — the file is
  // append-only, so line order is time order. ACROSS files it is not:
  // `listTranscriptFiles` name-sorts, and real transcripts are UUID-named
  // (`191b6ac9-….jsonl`), so "last in name order" is arbitrary with respect
  // to recency. Taking the last cwd across files therefore returned a
  // DIFFERENT real directory depending on which UUID happened to sort last —
  // EXECUTED with the UUIDs swapped and nothing else changed, the answer
  // flipped between the two candidates. Review of #142 found it.
  const perFileCwd: string[] = []
  let anyFileReadable = false
  let anyLineParsed = false
  const unreadableFiles: string[] = []

  for (const fileName of listing.files) {
    const filePath = path.join(slugDir, fileName)
    const read = await fs.readTranscriptFile(filePath)
    if (!read.readable) {
      unreadableFiles.push(`${filePath} (${read.reason})`)
      continue
    }
    anyFileReadable = true

    let fileCwd: string | null = null
    for (const rawLine of read.content.split('\n')) {
      const line = rawLine.trim()
      if (line.length === 0) continue

      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      anyLineParsed = true

      const cwd = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).cwd : undefined
      if (typeof cwd === 'string' && cwd.length > 0) fileCwd = cwd
    }
    if (fileCwd !== null) perFileCwd.push(fileCwd)
  }

  const distinct = [...new Set(perFileCwd)]
  if (distinct.length === 1) return { cwd: distinct[0] as string }
  if (distinct.length > 1) {
    // Conflicting evidence is not evidence. The ruling says decide from what
    // the transcript records and refuse when it cannot settle it; two
    // sessions under one slug recording different directories is exactly
    // "cannot settle it", and picking one would be the silent wrong answer
    // this module's whole contract refuses.
    return {
      cwd: null,
      reason:
        `transcripts under ${slugDir} disagree about the session's cwd ` +
        `(${distinct.map((c) => `"${c}"`).join(' and ')}) — refusing rather than picking one`,
    }
  }
  if (!anyFileReadable) {
    return { cwd: null, reason: `every transcript file under ${slugDir} was unreadable: ${unreadableFiles.join('; ')}` }
  }
  if (!anyLineParsed) {
    return { cwd: null, reason: `no line under ${slugDir} parsed as JSON — the transcript is malformed` }
  }
  return { cwd: null, reason: `no record under ${slugDir} carries a "cwd" field` }
}

export interface DisambiguateSlugByCwdOptions {
  claudeProjectsRoot: string
  /**
   * Checks whether a path still exists. `repos.ts` passes its own
   * `DiscoveryFs.exists` through here, so this module never opens a second
   * filesystem seam of its own just to check existence.
   */
  pathExists: (target: string) => Promise<boolean>
  transcriptFs?: TranscriptReadFs
}

/**
 * The ruling this file exists to implement (prd42 w9 / #142, operator ruling
 * 2026-08-28): when `reverseProjectSlug`'s walk finds MORE THAN ONE real
 * directory a slug could have come from, decide from the slug's own recorded
 * `cwd` rather than guessing. `candidates` are the full resolved paths the
 * walk already proved are real, distinct directories — this function only
 * ever narrows that set down to one, or refuses naming all of them; it never
 * invents a path outside it.
 *
 * Three ways this can still refuse, each distinct so a caller — or a test —
 * can tell which happened: no evidence at all ({@link findRecordedCwd}'s own
 * `reason` carries the specifics), a recorded `cwd` that names some
 * directory but not one of the candidates, and a recorded `cwd` that no
 * longer exists on disk at all (the directory was since moved or removed).
 * The last two look different enough to a reader of the reason that
 * collapsing them would throw away information the transcript actually gave.
 */
export async function disambiguateSlugByCwd(
  slug: string,
  candidates: readonly string[],
  options: DisambiguateSlugByCwdOptions,
): Promise<{ path: string } | { path: null; reason: string }> {
  const candidateList = candidates.map((candidate) => `"${candidate}"`).join(' and ')
  const preamble = `ambiguous slug "${slug}": ${candidateList} all resolve to real directories, and`

  const recorded = await findRecordedCwd(slug, options.claudeProjectsRoot, options.transcriptFs)
  if (recorded.cwd === null) {
    return { path: null, reason: `${preamble} the transcript could not settle which one Claude Code meant (${recorded.reason})` }
  }

  const normalizedCwd = path.normalize(recorded.cwd)
  const match = candidates.find((candidate) => path.normalize(candidate) === normalizedCwd)
  if (match !== undefined) return { path: match }

  if (!(await options.pathExists(recorded.cwd))) {
    return { path: null, reason: `${preamble} the transcript's recorded cwd "${recorded.cwd}" no longer exists on disk` }
  }
  return { path: null, reason: `${preamble} the transcript's recorded cwd "${recorded.cwd}" names none of them` }
}
