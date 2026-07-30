import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Session logs live outside the watched repo — the read-only promise means
 * we never write anything into it, not even a gitignored directory.
 */
export function defaultDataRoot(): string {
  return path.join(homedir(), '.local', 'share', 'observatory')
}

/** Repo-slug = sanitized basename + short hash of the absolute path, so two repos named the same don't collide. */
export function repoSlug(repoPath: string): string {
  const absolute = path.resolve(repoPath)
  const base = sanitize(path.basename(absolute))
  const hash = createHash('sha1').update(absolute).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

function sanitize(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'repo'
}

export function sessionDirFor(repoPath: string, dataRoot: string = defaultDataRoot()): string {
  return path.join(dataRoot, repoSlug(repoPath))
}

export function sessionFileName(ts: number): string {
  return `session-${ts}.jsonl`
}

const SESSION_FILE_PATTERN = /^session-(\d+)\.jsonl$/

/** A session's id is just its start timestamp — stable, sortable, and the filename round-trips it. */
export function sessionIdFromFileName(fileName: string): string | null {
  const match = SESSION_FILE_PATTERN.exec(fileName)
  return match ? (match[1] as string) : null
}
