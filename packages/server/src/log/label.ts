import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sessionLabelFileName } from './paths.js'

/**
 * The operator label that wins over the auto-title. Lives in its own sidecar
 * file next to a session's log, never inside it — labelling a recording must
 * never mutate the append-only event log (the law).
 */
export interface SessionLabel {
  label: string
  /** When `rhizomorph label` wrote this. */
  labelledAt: number
}

export function sessionLabelFilePath(dir: string, sessionId: string): string {
  return path.join(dir, sessionLabelFileName(sessionId))
}

/**
 * A session's operator-set label, or `null` when none exists yet — including
 * when the sidecar is missing, unreadable, or malformed. All three read as
 * "unlabelled" rather than an error: the auto-title is always a safe fallback.
 */
export async function readSessionLabel(dir: string, sessionId: string): Promise<string | null> {
  let raw: string
  try {
    raw = await readFile(sessionLabelFilePath(dir, sessionId), 'utf8')
  } catch {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    const label = (parsed as Partial<SessionLabel> | null)?.label
    return typeof label === 'string' && label.trim().length > 0 ? label : null
  } catch {
    return null
  }
}

/**
 * Writes (or overwrites) a session's label sidecar — the only write this
 * feature ever makes, and it never touches `session-<id>.jsonl` itself.
 * `label` is trimmed and must be non-empty; an empty label is a no-op typo,
 * not a way to clear one (there is no "unlabel" — relabelling overwrites).
 */
export async function writeSessionLabel(dir: string, sessionId: string, label: string, now: number): Promise<void> {
  const trimmed = label.trim()
  if (trimmed.length === 0) {
    throw new Error('label must not be empty')
  }
  const record: SessionLabel = { label: trimmed, labelledAt: now }
  await writeFile(sessionLabelFilePath(dir, sessionId), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}
