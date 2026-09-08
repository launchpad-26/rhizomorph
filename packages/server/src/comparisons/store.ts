import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type ComparisonArtifact,
  ComparisonArtifactError,
  type ComparisonInput,
  parseComparisonArtifact,
  serialiseComparison,
} from './artifact.js'

/**
 * `<sessionDir>/comparisons` — beside the recordings, out of `listSessions`'s
 * sight (it matches only `session-<ts>.jsonl` in the directory itself), the
 * `snapshots/` and `transcripts/` posture (ADR-0041).
 */
export const COMPARISONS_DIR_NAME = 'comparisons'

export function comparisonsDir(sessionDir: string): string {
  return path.join(sessionDir, COMPARISONS_DIR_NAME)
}

export function comparisonFileName(id: string): string {
  return `comparison-${id}.json`
}

export const COMPARISON_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isComparisonId(value: unknown): value is string {
  return typeof value === 'string' && COMPARISON_ID_RE.test(value)
}

export interface SavedComparison {
  id: string
  savedAt: string
}

/** Writes exactly one file and nothing else. `id` exists so a test can pin one; production callers never pass it. */
export async function saveComparison(
  sessionDir: string,
  input: ComparisonInput,
  savedAt: string,
  id: string = randomUUID(),
): Promise<SavedComparison> {
  const dir = comparisonsDir(sessionDir)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, comparisonFileName(id)), serialiseComparison(input, savedAt), 'utf8')
  return { id, savedAt }
}

export type ComparisonRead =
  | { kind: 'found'; id: string; artifact: ComparisonArtifact }
  | { kind: 'missing'; id: string }
  | { kind: 'refused'; id: string; reason: string }

/**
 * Never writes, never deletes, never rewrites the file — an old artifact is
 * refused, not migrated. The id is checked before any filesystem call —
 * defence in depth, so a traversal-shaped id can never reach `path.join`.
 */
export async function readComparison(sessionDir: string, id: string): Promise<ComparisonRead> {
  if (!isComparisonId(id)) throw new TypeError('comparison id must be a UUID')

  let raw: string
  try {
    raw = await readFile(path.join(comparisonsDir(sessionDir), comparisonFileName(id)), 'utf8')
  } catch {
    return { kind: 'missing', id }
  }

  try {
    return { kind: 'found', id, artifact: parseComparisonArtifact(raw) }
  } catch (err) {
    if (err instanceof ComparisonArtifactError) return { kind: 'refused', id, reason: err.message }
    throw err
  }
}

export type ComparisonListing =
  | { id: string; sizeBytes: number; available: true; savedAt: string; arms: number }
  | { id: string; sizeBytes: number; available: false; reason: string }

const COMPARISON_FILE_NAME_RE = /^comparison-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/

/** A missing `comparisons/` directory reads as `[]`, never an error. A stray non-artifact file is ignored, not surfaced. */
export async function listComparisons(sessionDir: string): Promise<ComparisonListing[]> {
  const dir = comparisonsDir(sessionDir)

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const available: Array<{ id: string; sizeBytes: number; available: true; savedAt: string; arms: number }> = []
  const unavailable: Array<{ id: string; sizeBytes: number; available: false; reason: string }> = []

  for (const fileName of entries) {
    const match = COMPARISON_FILE_NAME_RE.exec(fileName)
    if (!match) continue
    const id = match[1] as string
    const info = await stat(path.join(dir, fileName))
    const read = await readComparison(sessionDir, id)
    if (read.kind === 'found') {
      available.push({ id, sizeBytes: info.size, available: true, savedAt: read.artifact.savedAt, arms: read.artifact.input.arms.length })
    } else {
      unavailable.push({ id, sizeBytes: info.size, available: false, reason: read.kind === 'refused' ? read.reason : 'comparison could not be read' })
    }
  }

  available.sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.id.localeCompare(b.id))
  unavailable.sort((a, b) => a.id.localeCompare(b.id))

  return [...available, ...unavailable]
}
