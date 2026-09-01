import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

/** The override that aims the data root somewhere other than the default (prd-48 wave 4). */
export const DATA_ROOT_ENV_VAR = 'RHIZOMORPH_DATA_DIR'

/**
 * Session logs live outside the watched repo — the read-only promise means
 * we never write anything into it, not even a gitignored directory.
 *
 * **Precedence: an explicit `dataRoot` argument, then {@link DATA_ROOT_ENV_VAR},
 * then the default below.** The argument stays first because every caller in
 * this package already threads one through its own options (`options.dataRoot ??
 * defaultDataRoot()`), so a caller that was handed a directory must keep using
 * it whatever the environment says — the variable answers "where is the data
 * root when nobody named one", not "override the caller".
 *
 * It exists because prd-48's retention and install spikes have to run against a
 * *copied* data directory: without an override the only way to exercise seal →
 * archive → compact → prune is to aim it at the real one, which the PRD's
 * ruling 2 forbids.
 *
 * `XDG_DATA_HOME` is deliberately NOT consulted. The default below is already
 * the XDG location, so reading the variable would look like a tidy-up and act
 * like a migration: any box that sets it would silently stop finding the logs
 * it wrote yesterday. One explicit name, or the historical path — nothing in
 * between.
 *
 * An empty value is not an override. Unset and empty are different facts about
 * *intent* and the same fact about a *path*: `RHIZOMORPH_DATA_DIR=` names no
 * directory, so it cannot be one, and falling back is the only reading that
 * does not invent a root at the process's cwd.
 *
 * The value is used as given, not resolved — where it points is the operator's
 * act. The read-only promise is unchanged either way: it is a promise about
 * what this code writes into a *watched repo*, and nothing here writes into one
 * at any root.
 */
export function defaultDataRoot(): string {
  const override = process.env[DATA_ROOT_ENV_VAR]
  if (override !== undefined && override !== '') return override
  return path.join(homedir(), '.local', 'share', 'rhizomorph')
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

/**
 * The operator label sidecar's name for a session — a file next to the log,
 * never the log itself (the append-only law: `rhizomorph label` writes here,
 * it never touches `session-<id>.jsonl`). `sessionId` rather than a
 * timestamp because a resumed session's id can outlive the ts a fresh boot
 * would mint, and the id is what every other route already keys on.
 */
export function sessionLabelFileName(sessionId: string): string {
  return `session-${sessionId}.label.json`
}

/**
 * Where a session's collector snapshots live: a directory of its own beside the
 * session logs, keyed by session id. Keyed, not shared, because snapshots are
 * only meaningful *for the session that wrote them* — a resumed session picks up
 * its own byte offsets, and the snapshots of a session nobody resumes are simply
 * never read again. The `snapshots/` level keeps them out of `listSessions`,
 * which only ever matches `session-<ts>.jsonl` in the dir itself.
 */
export function snapshotDirFor(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, 'snapshots', sessionId)
}

/**
 * Where a session's captured transcripts live (prd16 ruling 3): a directory of
 * its own beside the session log, keyed by session id — the same `snapshots/`
 * shape `snapshotDirFor` already uses, and for the same reason: a captured
 * transcript belongs to the recording that captured it, sits BESIDE the
 * append-only log rather than inside it, and is never mistaken for a session
 * file by `listSessions` (which only matches `session-<ts>.jsonl` in the dir
 * itself).
 */
export function transcriptCaptureDir(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, 'transcripts', sessionId)
}

/** One lane's captured copy, named by the Claude Code session id it was tailing. */
export function transcriptCaptureFileName(claudeSessionId: string): string {
  return `${claudeSessionId}.jsonl`
}

/** The manifest sidecar recording what a capture actually got — sizes, gaps, completeness. */
export const TRANSCRIPT_CAPTURE_MANIFEST_FILE_NAME = 'manifest.json'

/** Root of Claude Code's per-project session logs — where transcripts are resolved live from, and captured from at close. */
export function defaultClaudeProjectsRoot(): string {
  return path.join(homedir(), '.claude', 'projects')
}

const SESSION_FILE_PATTERN = /^session-(\d+)\.jsonl$/

/** A session's id is just its start timestamp — stable, sortable, and the filename round-trips it. */
export function sessionIdFromFileName(fileName: string): string | null {
  const match = SESSION_FILE_PATTERN.exec(fileName)
  return match ? (match[1] as string) : null
}
