import { writeSessionLabel } from '../log/label.js'
import { defaultDataRoot, sessionDirFor } from '../log/paths.js'
import { listSessions } from '../log/session-log.js'

export interface RunLabelOptions {
  repoPath: string
  sessionId: string
  label: string
  /** Overrides `~/.local/share/rhizomorph`; tests point this at a temp dir. */
  dataRoot?: string
  /** Injectable clock, so tests get a deterministic `labelledAt`. */
  now?: () => number
}

export interface RunLabelResult {
  sessionDir: string
  sessionId: string
  label: string
}

/**
 * Writes an operator label for one recorded session — a sidecar file beside
 * its log (`<log>.label.json`), never a mutation of the append-only log
 * itself (the law: see `log/label.ts`). Refuses a session id nothing on
 * disk recognises, the same loud, exact refusal `export-record` already
 * gives for the identical mistake, rather than silently creating a sidecar
 * for a session that was never recorded.
 */
export async function runLabel(options: RunLabelOptions): Promise<RunLabelResult> {
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const sessionDir = sessionDirFor(options.repoPath, dataRoot)

  const sessions = await listSessions(sessionDir)
  if (!sessions.some((session) => session.id === options.sessionId)) {
    throw new Error(
      `no session with id "${options.sessionId}" for ${options.repoPath} (looked in ${sessionDir}) — ` +
        'run `rhizomorph sessions` to list recorded session ids',
    )
  }

  const now = options.now ?? Date.now
  const label = options.label.trim()
  await writeSessionLabel(sessionDir, options.sessionId, label, now())

  return { sessionDir, sessionId: options.sessionId, label }
}
